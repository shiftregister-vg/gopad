package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for development
	},
}

var colorPalette = []string{
	"#e57373", // Red
	"#64b5f6", // Blue
	"#81c784", // Green
	"#ffd54f", // Yellow
	"#ba68c8", // Purple
	"#4db6ac", // Teal
	"#ffb74d", // Orange
	"#a1887f", // Brown
	"#90a4ae", // Gray
}
var colorIndex = 0
var colorMu sync.Mutex

type Document struct {
	ID           string
	Content      string
	Language     string
	Users        map[string]*Client
	clients      map[*Client]bool
	broadcast    chan BroadcastMessage
	register     chan *Client
	unregister   chan *Client
	lastModified int64 // unix timestamp (ms)
	mu           sync.RWMutex
	// Peer recovery additions:
	waitingForState []*Client // clients waiting for state
	// TODO: add tab support
}

type Client struct {
	conn           *websocket.Conn
	docID          string
	uuid           string
	name           string
	color          string
	send           chan []byte
	doc            *Document
	disconnected   bool
	disconnectedAt time.Time
}

type BroadcastMessage struct {
	Sender  *Client
	Message []byte
}

type UserListMessage struct {
	Type  string                            `json:"type"`
	Users map[string]map[string]interface{} `json:"users"` // name -> {name, color, disconnected}
}

var (
	documents = make(map[string]*Document)
)

func main() {
	r := gin.Default()

	// Check if we're in development mode
	isDev := os.Getenv("GO_ENV") == "development"

	if isDev {
		// In development, proxy all non-WebSocket requests to the React dev server
		r.Use(func(c *gin.Context) {
			if strings.ToLower(c.Request.Header.Get("Upgrade")) == "websocket" || c.Request.URL.Path == "/ws" {
				if c.Request.URL.Path == "/ws" {
					log.Println("WebSocket request correctly handled by backend:", c.Request.URL.Path)
				}
				c.Next()
				return
			}
			log.Println("Proxying request to React dev server:", c.Request.URL.Path)
			// Proxy to React dev server
			proxy := &http.Client{
				Timeout: 10 * time.Second,
			}
			req, err := http.NewRequest(c.Request.Method, "http://localhost:3000"+c.Request.URL.Path, c.Request.Body)
			if err != nil {
				c.AbortWithError(http.StatusInternalServerError, err)
				return
			}
			req.Header = c.Request.Header
			resp, err := proxy.Do(req)
			if err != nil {
				c.AbortWithError(http.StatusInternalServerError, err)
				return
			}
			defer resp.Body.Close()

			// Copy response headers
			for k, v := range resp.Header {
				c.Writer.Header()[k] = v
			}
			c.Writer.WriteHeader(resp.StatusCode)
			c.Writer.Write([]byte{}) // Flush headers
			c.Writer.Flush()
		})
	} else {
		// In production, serve static files
		r.Static("/static", "./web/dist/static")
		r.StaticFile("/", "./web/dist/index.html")
		r.StaticFile("/index.html", "./web/dist/index.html")
	}

	// Debug endpoint to check document state
	r.GET("/debug/doc/:id", func(c *gin.Context) {
		docID := c.Param("id")
		if doc, exists := documents[docID]; exists {
			doc.mu.RLock()
			content := doc.Content
			users := make(map[string]string)
			for name, client := range doc.Users {
				users[name] = client.name
			}
			doc.mu.RUnlock()
			c.JSON(200, gin.H{
				"id":      docID,
				"content": content,
				"users":   users,
			})
		} else {
			c.JSON(404, gin.H{"error": "document not found"})
		}
	})

	// WebSocket endpoint
	r.GET("/ws", handleWebSocket)

	// SPA fallback: serve index.html for all other routes (only in production)
	if !isDev {
		r.NoRoute(func(c *gin.Context) {
			c.File("./web/dist/index.html")
		})
	}

	// Start the server
	log.Fatal(r.Run(":3030"))
}

func getOrCreateDocument(docID string) *Document {
	doc, exists := documents[docID]
	if !exists {
		doc = &Document{
			ID:           docID,
			Content:      "",
			Language:     "plaintext",
			Users:        make(map[string]*Client),
			clients:      make(map[*Client]bool),
			broadcast:    make(chan BroadcastMessage),
			register:     make(chan *Client),
			unregister:   make(chan *Client),
			lastModified: time.Now().UnixMilli(),
		}
		documents[docID] = doc
		go doc.broadcastMessages()
	}
	return doc
}

func handleWebSocket(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Println(err)
		return
	}
	docID := c.Query("doc")
	if docID == "" {
		docID = "default"
	}
	log.Printf("New client connected to document: %s", docID)
	doc := getOrCreateDocument(docID)
	client := &Client{
		conn:  conn,
		docID: docID,
		send:  make(chan []byte, 256),
		doc:   doc,
	}
	// Peer recovery: if doc has no state, queue client and request state from others
	doc.mu.Lock()
	noState := doc.Content == "" && len(doc.Users) == 0
	if noState && len(doc.clients) > 0 {
		doc.waitingForState = append(doc.waitingForState, client)
		doc.mu.Unlock()
		// Ask existing clients for state
		requestMsg := map[string]interface{}{"type": "requestState"}
		jsonMsg, _ := json.Marshal(requestMsg)
		for c := range doc.clients {
			c.send <- jsonMsg
		}
	} else {
		// Send initial document state to the new client
		initialState := map[string]interface{}{
			"type":         "init",
			"content":      doc.Content,
			"users":        doc.Users,
			"language":     doc.Language,
			"lastModified": doc.lastModified,
		}
		doc.mu.Unlock()
		log.Printf("Sending initial state to client: %s", doc.Content)
		if err := conn.WriteJSON(initialState); err != nil {
			log.Printf("error sending initial state: %v", err)
			conn.Close()
			return
		}
	}
	doc.register <- client
	// Start goroutines for reading and writing
	go client.writePump()
	go client.readPump()
}

func (c *Client) readPump() {
	defer func() {
		// Mark as disconnected, broadcast, and schedule removal
		c.doc.mu.Lock()
		if c.uuid != "" {
			c.disconnected = true
			c.disconnectedAt = time.Now()
		}
		c.doc.mu.Unlock()
		c.doc.broadcastUserList()
		go func(client *Client) {
			time.Sleep(2 * time.Minute)
			client.doc.mu.Lock()
			if client.disconnected && time.Since(client.disconnectedAt) >= 2*time.Minute {
				delete(client.doc.Users, client.uuid)
				client.doc.mu.Unlock()
				client.doc.broadcastUserList()
			} else {
				client.doc.mu.Unlock()
			}
		}(c)
		c.doc.unregister <- c
		c.conn.Close()
		log.Printf("Client disconnected from document: %s", c.docID)
	}()
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			log.Printf("WebSocket read error for doc %s: %v", c.docID, err)
			break
		}
		log.Printf("Received message from client: %s", string(message))
		// Try to parse the message as JSON
		var jsonMsg map[string]interface{}
		if err := json.Unmarshal(message, &jsonMsg); err != nil {
			log.Printf("Error parsing message as JSON: %v", err)
			continue
		}
		// Handle different message types
		if msgType, ok := jsonMsg["type"].(string); ok {
			switch msgType {
			case "setName":
				if name, ok := jsonMsg["name"].(string); ok {
					uuid, _ := jsonMsg["uuid"].(string)
					c.doc.mu.Lock()
					c.uuid = uuid
					oldClient, exists := c.doc.Users[uuid]
					if exists && oldClient != c {
						// If old client is disconnected, replace with new client
						if oldClient.disconnected {
							c.color = oldClient.color
						}
						// Remove old client from clients map and close its send channel
						if _, ok := c.doc.clients[oldClient]; ok {
							delete(c.doc.clients, oldClient)
							close(oldClient.send)
						}
					}
					c.name = name
					if c.color == "" {
						colorMu.Lock()
						c.color = colorPalette[colorIndex%len(colorPalette)]
						colorIndex++
						colorMu.Unlock()
					}
					c.disconnected = false
					c.disconnectedAt = time.Time{}
					c.doc.Users[uuid] = c
					c.doc.mu.Unlock()
					c.doc.broadcastUserList()
				}
			case "setLanguage":
				if lang, ok := jsonMsg["language"].(string); ok {
					c.doc.mu.Lock()
					c.doc.Language = lang
					c.doc.mu.Unlock()
					langMsg := map[string]interface{}{
						"type":     "language",
						"language": lang,
					}
					jsonMsg, err := json.Marshal(langMsg)
					if err != nil {
						log.Printf("Error marshaling language message: %v", err)
						continue
					}
					c.doc.broadcast <- BroadcastMessage{Sender: nil, Message: jsonMsg}
				}
			case "language":
				if lang, ok := jsonMsg["language"].(string); ok {
					c.doc.mu.Lock()
					c.doc.Language = lang
					c.doc.mu.Unlock()
					langMsg := map[string]interface{}{
						"type":     "language",
						"language": lang,
					}
					jsonMsg, err := json.Marshal(langMsg)
					if err != nil {
						log.Printf("Error marshaling language message: %v", err)
						continue
					}
					c.doc.broadcast <- BroadcastMessage{Sender: nil, Message: jsonMsg}
				}
			case "update":
				if tabId, ok := jsonMsg["tabId"].(string); ok {
					if content, ok := jsonMsg["content"].(string); ok {
						broadcastMsg := map[string]interface{}{
							"type":    "update",
							"tabId":   tabId,
							"content": content,
						}
						jsonMsg, err := json.Marshal(broadcastMsg)
						if err != nil {
							log.Printf("Error marshaling broadcast message: %v", err)
							continue
						}
						c.doc.broadcast <- BroadcastMessage{Sender: c, Message: jsonMsg}
					}
				}
			case "cursor":
				// Broadcast cursor/selection update to all other clients
				c.doc.broadcast <- BroadcastMessage{Sender: c, Message: message}
			case "tabCreate":
				if tab, ok := jsonMsg["tab"].(map[string]interface{}); ok {
					msg := map[string]interface{}{
						"type": "tabCreate",
						"tab": map[string]interface{}{
							"id":      tab["id"],
							"name":    tab["name"],
							"content": tab["content"],
						},
					}
					jsonMsg, err := json.Marshal(msg)
					if err != nil {
						log.Printf("Error marshaling tabCreate message: %v", err)
						continue
					}
					c.doc.broadcast <- BroadcastMessage{Sender: nil, Message: jsonMsg}
					// Also broadcast tabFocus for the new tab
					if tabId, ok := tab["id"].(string); ok {
						focusMsg := map[string]interface{}{
							"type":  "tabFocus",
							"tabId": tabId,
						}
						focusJson, err := json.Marshal(focusMsg)
						if err == nil {
							c.doc.broadcast <- BroadcastMessage{Sender: nil, Message: focusJson}
						}
					}
				}
			case "tabFocus":
				if tabId, ok := jsonMsg["tabId"].(string); ok {
					msg := map[string]interface{}{
						"type":  "tabFocus",
						"tabId": tabId,
					}
					jsonMsg, err := json.Marshal(msg)
					if err != nil {
						log.Printf("Error marshaling tabFocus message: %v", err)
						continue
					}
					c.doc.broadcast <- BroadcastMessage{Sender: nil, Message: jsonMsg}
				}
			case "tabRename":
				if tabId, ok := jsonMsg["tabId"].(string); ok {
					if name, ok := jsonMsg["name"].(string); ok {
						msg := map[string]interface{}{
							"type":  "tabRename",
							"tabId": tabId,
							"name":  name,
						}
						jsonMsg, err := json.Marshal(msg)
						if err != nil {
							log.Printf("Error marshaling tabRename message: %v", err)
							continue
						}
						c.doc.broadcast <- BroadcastMessage{Sender: nil, Message: jsonMsg}
					}
				}
			case "requestState":
				// Ignore: only sent by server
			case "fullState":
				// Only accept if there are clients waiting for state
				doc := c.doc
				doc.mu.Lock()
				waiting := doc.waitingForState
				doc.waitingForState = nil
				doc.mu.Unlock()
				if len(waiting) > 0 {
					// Change type to 'init' before sending
					var state map[string]interface{}
					if err := json.Unmarshal(message, &state); err == nil {
						state["type"] = "init"
						initMsg, _ := json.Marshal(state)
						for _, waitingClient := range waiting {
							if waitingClient.conn != nil {
								waitingClient.conn.WriteMessage(websocket.TextMessage, initMsg)
							}
						}
					}
				}
			}
		}
	}
}

func (c *Client) writePump() {
	defer func() {
		c.conn.Close()
	}()
	for message := range c.send {
		w, err := c.conn.NextWriter(websocket.TextMessage)
		if err != nil {
			log.Printf("WebSocket write error for doc %s: %v", c.docID, err)
			return
		}
		if _, err := w.Write(message); err != nil {
			log.Printf("WebSocket write error for doc %s: %v", c.docID, err)
			return
		}
		if err := w.Close(); err != nil {
			log.Printf("WebSocket write error for doc %s: %v", c.docID, err)
			return
		}
	}
}

func (doc *Document) broadcastMessages() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("Recovered from panic in broadcastMessages: %v", r)
		}
	}()
	for {
		select {
		case client := <-doc.register:
			doc.clients[client] = true
			doc.mu.RLock()
			initialState := map[string]interface{}{
				"type":         "init",
				"content":      doc.Content,
				"users":        doc.Users,
				"language":     doc.Language,
				"lastModified": doc.lastModified,
			}
			doc.mu.RUnlock()
			client.conn.WriteJSON(initialState)
			log.Printf("Client registered in doc %s, total clients: %d", doc.ID, len(doc.clients))
		case client := <-doc.unregister:
			// Only remove from doc.Users and mark as disconnected, do not close channel here
			doc.mu.Lock()
			if client.uuid != "" {
				client.disconnected = true
				client.disconnectedAt = time.Now()
				// Removal from doc.Users after 2 minutes is handled elsewhere
			}
			doc.mu.Unlock()
			log.Printf("Client unregistered in doc %s, total clients: %d", doc.ID, len(doc.clients))
		case bmsg := <-doc.broadcast:
			var msgType string
			var msgObj map[string]interface{}
			if err := json.Unmarshal(bmsg.Message, &msgObj); err == nil {
				if t, ok := msgObj["type"].(string); ok {
					msgType = t
				}
			}
			for client := range doc.clients {
				if client == bmsg.Sender && msgType == "update" {
					log.Printf("Skipping sender for update message")
					continue
				}
				select {
				case client.send <- bmsg.Message:
					log.Printf("Message sent to client")
				default:
					log.Printf("Client buffer full or dead, removing client")
					delete(doc.clients, client)
					close(client.send)
				}
			}
		}
	}
}

func (doc *Document) broadcastUserList() {
	userList := make(map[string]map[string]interface{})
	doc.mu.RLock()
	for uuid, client := range doc.Users {
		userList[uuid] = map[string]interface{}{
			"uuid":         client.uuid,
			"name":         client.name,
			"color":        client.color,
			"disconnected": client.disconnected,
		}
	}
	doc.mu.RUnlock()
	userListMsg := UserListMessage{
		Type:  "userList",
		Users: userList,
	}
	jsonMsg, err := json.Marshal(userListMsg)
	if err != nil {
		log.Printf("Error marshaling user list: %v", err)
		return
	}
	doc.broadcast <- BroadcastMessage{Sender: nil, Message: jsonMsg}
}
