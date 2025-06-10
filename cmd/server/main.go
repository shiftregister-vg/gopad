package main

import (
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/shiftregister-vg/gopad/pkg/storage"
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
	Tabs            []Tab
	ActiveTabId     string
	usedColors      map[string]bool // Track used colors in this document
}

type Tab struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Notes   string `json:"notes"`
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
	store     *storage.Storage
)

func main() {
	// Initialize Redis storage
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379/0"
	}
	var err error
	store, err = storage.New(redisURL)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	defer store.Close()

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

// ensureMinimumTabs ensures there is always at least one tab in the document
func (doc *Document) ensureMinimumTabs() {
	if len(doc.Tabs) == 0 {
		doc.Tabs = []Tab{
			{
				ID:      "1",
				Name:    "Untitled",
				Content: "",
				Notes:   "",
			},
		}
		doc.ActiveTabId = "1"
	}
}

func getOrCreateDocument(docID string) *Document {
	doc, exists := documents[docID]
	if !exists {
		// Try to load from storage
		state, err := store.LoadDocument(docID)
		if err != nil {
			log.Printf("Error loading document state: %v", err)
			state = &storage.DocumentState{
				Content:      "",
				Language:     "plaintext",
				LastModified: time.Now().UnixMilli(),
				Users:        make(map[string]string),
				Version:      0,
				Tabs: []storage.Tab{
					{
						ID:      "1",
						Name:    "Untitled",
						Content: "",
						Notes:   "",
					},
				},
				ActiveTabId: "1",
			}
		}

		doc = &Document{
			ID:           docID,
			Content:      state.Content,
			Language:     state.Language,
			Users:        make(map[string]*Client),
			clients:      make(map[*Client]bool),
			broadcast:    make(chan BroadcastMessage),
			register:     make(chan *Client),
			unregister:   make(chan *Client),
			lastModified: state.LastModified,
			Tabs:         make([]Tab, len(state.Tabs)),
			ActiveTabId:  state.ActiveTabId,
			usedColors:   make(map[string]bool),
		}
		// Convert storage.Tabs to Document.Tabs
		for i, t := range state.Tabs {
			doc.Tabs[i] = Tab{
				ID:      t.ID,
				Name:    t.Name,
				Content: t.Content,
				Notes:   t.Notes,
			}
		}
		doc.ensureMinimumTabs() // Ensure minimum tabs after loading
		documents[docID] = doc
		go doc.broadcastMessages()

		// Subscribe to Redis updates for this document
		go func() {
			err := store.SubscribeToUpdates(docID, func(update *storage.DocumentState) {
				doc.mu.Lock()
				// Only apply update if it's newer than our current state
				if update.Version > doc.lastModified {
					doc.Content = update.Content
					doc.Language = update.Language
					doc.lastModified = update.LastModified
					doc.ActiveTabId = update.ActiveTabId

					// Update tabs
					doc.Tabs = make([]Tab, len(update.Tabs))
					for i, t := range update.Tabs {
						doc.Tabs[i] = Tab{
							ID:      t.ID,
							Name:    t.Name,
							Content: t.Content,
							Notes:   t.Notes,
						}
					}

					// Update users
					for uuid, name := range update.Users {
						if client, exists := doc.Users[uuid]; exists {
							client.name = name
						}
					}
					doc.mu.Unlock()

					// Broadcast update to all clients
					updateMsg := map[string]interface{}{
						"type":         "update",
						"tabs":         doc.Tabs,
						"activeTabId":  doc.ActiveTabId,
						"language":     update.Language,
						"lastModified": update.LastModified,
					}
					jsonMsg, err := json.Marshal(updateMsg)
					if err == nil {
						doc.broadcast <- BroadcastMessage{Sender: nil, Message: jsonMsg}
					}
				} else {
					doc.mu.Unlock()
				}
			})
			if err != nil {
				log.Printf("Error subscribing to updates for doc %s: %v", docID, err)
			}
		}()
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
			"tabs":         doc.Tabs,
			"activeTabId":  doc.ActiveTabId,
			"language":     doc.Language,
			"users":        doc.Users,
			"lastModified": doc.lastModified,
		}
		doc.mu.Unlock()
		log.Printf("Sending initial state to client: %+v", initialState)
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
			// Remove the color from used colors if this is the last client using it
			if c.color != "" {
				stillInUse := false
				for _, otherClient := range c.doc.Users {
					if otherClient != c && otherClient.color == c.color {
						stillInUse = true
						break
					}
				}
				if !stillInUse {
					delete(c.doc.usedColors, c.color)
				}
			}
		}
		c.doc.mu.Unlock()
		c.doc.broadcastUserList()
		go func(client *Client) {
			time.Sleep(2 * time.Minute)
			client.doc.mu.Lock()
			// Only remove if still disconnected and no reconnection has occurred
			if client.disconnected && time.Since(client.disconnectedAt) >= 2*time.Minute {
				// Check if this client is still in the Users map and hasn't reconnected
				if existingClient, exists := client.doc.Users[client.uuid]; exists && existingClient == client {
					delete(client.doc.Users, client.uuid)
					client.doc.mu.Unlock()
					client.doc.broadcastUserList()
				} else {
					client.doc.mu.Unlock()
				}
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
						// Get a new color for this client
						c.color = c.doc.getNextAvailableColor()
						log.Printf("Assigned color %v to user %v", c.color, name)
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
						c.doc.mu.Lock()
						// Update the tab content
						for i, tab := range c.doc.Tabs {
							if tab.ID == tabId {
								c.doc.Tabs[i].Content = content
								break
							}
						}
						c.doc.mu.Unlock()

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

						// Save state after update
						if err := c.doc.saveState(); err != nil {
							log.Printf("Error saving document state: %v", err)
						}
					}
				}
			case "cursor":
				// Broadcast cursor/selection update to all other clients
				c.doc.broadcast <- BroadcastMessage{Sender: c, Message: message}
			case "tabCreate":
				if tab, ok := jsonMsg["tab"].(map[string]interface{}); ok {
					c.doc.mu.Lock()
					newTab := Tab{
						ID:      tab["id"].(string),
						Name:    tab["name"].(string),
						Content: tab["content"].(string),
						Notes:   tab["notes"].(string),
					}
					c.doc.Tabs = append(c.doc.Tabs, newTab)
					c.doc.mu.Unlock()

					msg := map[string]interface{}{
						"type": "tabCreate",
						"tab":  newTab,
					}
					jsonMsg, err := json.Marshal(msg)
					if err != nil {
						log.Printf("Error marshaling tabCreate message: %v", err)
						continue
					}
					c.doc.broadcast <- BroadcastMessage{Sender: nil, Message: jsonMsg}

					// Also broadcast tabFocus for the new tab
					focusMsg := map[string]interface{}{
						"type":  "tabFocus",
						"tabId": newTab.ID,
					}
					focusJson, err := json.Marshal(focusMsg)
					if err == nil {
						c.doc.broadcast <- BroadcastMessage{Sender: nil, Message: focusJson}
					}

					// Save state after creating tab
					if err := c.doc.saveState(); err != nil {
						log.Printf("Error saving document state: %v", err)
					}
				}
			case "tabDelete":
				if tabId, ok := jsonMsg["tabId"].(string); ok {
					c.doc.mu.Lock()
					// Find and remove the tab
					for i, tab := range c.doc.Tabs {
						if tab.ID == tabId {
							c.doc.Tabs = append(c.doc.Tabs[:i], c.doc.Tabs[i+1:]...)
							break
						}
					}
					// If we deleted the active tab, set active tab to the first tab
					if c.doc.ActiveTabId == tabId {
						if len(c.doc.Tabs) > 0 {
							c.doc.ActiveTabId = c.doc.Tabs[0].ID
						}
					}
					c.doc.ensureMinimumTabs() // Ensure we still have at least one tab
					c.doc.mu.Unlock()

					// Broadcast the updated tab list and active tab
					updateMsg := map[string]interface{}{
						"type":        "tabUpdate",
						"tabs":        c.doc.Tabs,
						"activeTabId": c.doc.ActiveTabId,
					}
					jsonMsg, err := json.Marshal(updateMsg)
					if err == nil {
						c.doc.broadcast <- BroadcastMessage{Sender: nil, Message: jsonMsg}
					}

					// Save state after deleting tab
					if err := c.doc.saveState(); err != nil {
						log.Printf("Error saving document state: %v", err)
					}
				}
			case "tabFocus":
				if tabId, ok := jsonMsg["tabId"].(string); ok {
					c.doc.mu.Lock()
					c.doc.ActiveTabId = tabId
					c.doc.mu.Unlock()

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

					// Save state after changing active tab
					if err := c.doc.saveState(); err != nil {
						log.Printf("Error saving document state: %v", err)
					}
				}
			case "tabRename":
				if tabId, ok := jsonMsg["tabId"].(string); ok {
					if name, ok := jsonMsg["name"].(string); ok {
						c.doc.mu.Lock()
						// Update the tab name
						for i, tab := range c.doc.Tabs {
							if tab.ID == tabId {
								c.doc.Tabs[i].Name = name
								break
							}
						}
						c.doc.mu.Unlock()

						// Send a tabUpdate message with the complete tab state
						updateMsg := map[string]interface{}{
							"type":        "tabUpdate",
							"tabs":        c.doc.Tabs,
							"activeTabId": c.doc.ActiveTabId,
						}
						jsonMsg, err := json.Marshal(updateMsg)
						if err != nil {
							log.Printf("Error marshaling tabUpdate message: %v", err)
							continue
						}
						c.doc.broadcast <- BroadcastMessage{Sender: nil, Message: jsonMsg}

						// Save state after renaming tab
						if err := c.doc.saveState(); err != nil {
							log.Printf("Error saving document state: %v", err)
						}
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
			case "tabNotesUpdate":
				if tabId, ok := jsonMsg["tabId"].(string); ok {
					if notes, ok := jsonMsg["notes"].(string); ok {
						c.doc.mu.Lock()
						for i, tab := range c.doc.Tabs {
							if tab.ID == tabId {
								c.doc.Tabs[i].Notes = notes
								break
							}
						}
						c.doc.mu.Unlock()

						// Broadcast to all clients
						broadcastMsg := map[string]interface{}{
							"type":  "tabNotesUpdate",
							"tabId": tabId,
							"notes": notes,
						}
						jsonMsg, err := json.Marshal(broadcastMsg)
						if err == nil {
							c.doc.broadcast <- BroadcastMessage{Sender: c, Message: jsonMsg}
						}

						// Save state after update
						if err := c.doc.saveState(); err != nil {
							log.Printf("Error saving document state: %v", err)
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
				"tabs":         doc.Tabs,
				"activeTabId":  doc.ActiveTabId,
				"language":     doc.Language,
				"lastModified": doc.lastModified,
				"users":        doc.Users,
			}
			doc.mu.RUnlock()
			client.conn.WriteJSON(initialState)
			log.Printf("Client registered in doc %s, total clients: %d", doc.ID, len(doc.clients))
		case client := <-doc.unregister:
			doc.mu.Lock()
			if client.uuid != "" {
				client.disconnected = true
				client.disconnectedAt = time.Now()
				// Remove the color from used colors if this is the last client using it
				if client.color != "" {
					stillInUse := false
					for _, otherClient := range doc.Users {
						if otherClient != client && otherClient.color == client.color {
							stillInUse = true
							break
						}
					}
					if !stillInUse {
						delete(doc.usedColors, client.color)
					}
				}
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

			// Save state after certain message types
			if msgType == "update" || msgType == "language" {
				if err := doc.saveState(); err != nil {
					log.Printf("Error saving document state: %v", err)
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

func (doc *Document) saveState() error {
	state := &storage.DocumentState{
		Content:      doc.Content,
		Language:     doc.Language,
		LastModified: doc.lastModified,
		Users:        make(map[string]string),
		Tabs:         make([]storage.Tab, len(doc.Tabs)),
		ActiveTabId:  doc.ActiveTabId,
	}

	doc.mu.RLock()
	for uuid, client := range doc.Users {
		state.Users[uuid] = client.name
	}
	// Convert Document.Tabs to storage.Tabs
	for i, t := range doc.Tabs {
		state.Tabs[i] = storage.Tab{
			ID:      t.ID,
			Name:    t.Name,
			Content: t.Content,
			Notes:   t.Notes,
		}
	}
	doc.mu.RUnlock()

	return store.SaveDocument(doc.ID, state)
}

// getNextAvailableColor returns a random available color from the palette that isn't used in this document
// Note: Caller must hold doc.mu.Lock()
func (doc *Document) getNextAvailableColor() string {
	log.Printf("getNextAvailableColor: current used colors: %v", doc.usedColors)
	log.Printf("getNextAvailableColor: current users: %v", doc.Users)

	// First, check which colors are actually in use by active users
	activeColors := make(map[string]bool)
	for _, client := range doc.Users {
		if client.color != "" {
			activeColors[client.color] = true
		}
	}
	log.Printf("getNextAvailableColor: active colors: %v", activeColors)

	// Create a slice of available colors
	var availableColors []string
	for _, color := range colorPalette {
		if !activeColors[color] {
			availableColors = append(availableColors, color)
		}
	}

	// If we have available colors, randomly select one
	if len(availableColors) > 0 {
		selectedColor := availableColors[rand.Intn(len(availableColors))]
		doc.usedColors[selectedColor] = true
		log.Printf("getNextAvailableColor: randomly selected color %v", selectedColor)
		return selectedColor
	}

	// If all colors are used, randomly select from all colors
	// This is a fallback that should rarely happen
	log.Printf("getNextAvailableColor: all colors used, randomly selecting from all colors")
	selectedColor := colorPalette[rand.Intn(len(colorPalette))]
	doc.usedColors[selectedColor] = true
	log.Printf("getNextAvailableColor: randomly selected reused color %v", selectedColor)
	return selectedColor
}

func init() {
	// Initialize random seed
	rand.Seed(time.Now().UnixNano())
}
