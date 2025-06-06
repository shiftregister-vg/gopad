import React, { useEffect, useRef, useState } from 'react';
import './App.css';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  useNavigate,
  useParams
} from 'react-router-dom';
import MonacoEditor, { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// ResizeObserver polyfill
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;
    private elements: Set<Element>;
    private timeoutId: number | null;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      this.elements = new Set();
      this.timeoutId = null;
    }

    observe(element: Element) {
      this.elements.add(element);
      this.scheduleCallback();
    }

    unobserve(element: Element) {
      this.elements.delete(element);
    }

    disconnect() {
      this.elements.clear();
      if (this.timeoutId) {
        window.clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
    }

    private scheduleCallback() {
      if (this.timeoutId) return;
      this.timeoutId = window.setTimeout(() => {
        const entries = Array.from(this.elements).map(element => ({
          target: element,
          contentRect: element.getBoundingClientRect(),
          borderBoxSize: [{ inlineSize: element.clientWidth, blockSize: element.clientHeight }],
          contentBoxSize: [{ inlineSize: element.clientWidth, blockSize: element.clientHeight }],
          devicePixelContentBoxSize: [{ inlineSize: element.clientWidth, blockSize: element.clientHeight }]
        }));
        this.callback(entries, this);
        this.timeoutId = null;
      }, 100);
    }
  };
}

// Suppress ResizeObserver errors
const suppressResizeObserverErrors = () => {
  const originalError = window.console.error;
  window.console.error = (...args) => {
    if (args[0]?.includes?.('ResizeObserver loop')) return;
    originalError.apply(window.console, args);
  };
};

suppressResizeObserverErrors();

interface UserInfo {
  uuid: string;
  name: string;
  color: string;
  disconnected?: boolean;
}

interface Tab {
  id: string;
  name: string;
  content: string;
}

interface CursorMessage {
  type: 'cursor';
  uuid: string;
  name: string;
  color: string;
  position: number;
}

interface UserListMessage {
  type: 'userList';
  users: { [key: string]: UserInfo };
}

interface LanguageMessage {
  type: 'language';
  language: string;
}

interface UpdateMessage {
  type: 'update';
  tabId: string;
  content: string;
}

interface TabFocusMessage {
  type: 'tabFocus';
  tabId: string;
}

interface TabCreateMessage {
  type: 'tabCreate';
  tab: Tab;
}

interface TabRenameMessage {
  type: 'tabRename';
  tabId: string;
  name: string;
}

interface FullStateMessage {
  type: 'fullState' | 'init';
  tabs: Tab[];
  activeTabId: string;
  language: string;
  users: { [key: string]: UserInfo };
  lastModified: number;
}

interface TabUpdateMessage {
  type: 'tabUpdate';
  tabs: Tab[];
  activeTabId: string;
}

type WebSocketMessage = UpdateMessage | UserListMessage | LanguageMessage | CursorMessage | TabFocusMessage | TabCreateMessage | TabRenameMessage | FullStateMessage | TabUpdateMessage;

function generateRoomId() {
  return Math.random().toString(36).substring(2, 10);
}

function generateUUID() {
  if (window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getOrCreateUUID() {
  const stored = localStorage.getItem('gopad-uuid');
  if (stored) return stored;
  const uuid = generateUUID();
  localStorage.setItem('gopad-uuid', uuid);
  return uuid;
}

function getStoredName() {
  return localStorage.getItem('gopad-name') || '';
}

function setStoredName(name: string) {
  localStorage.setItem('gopad-name', name);
}

function RedirectToRoom() {
  const navigate = useNavigate();
  useEffect(() => {
    const roomId = generateRoomId();
    navigate(`/room/${roomId}`, { replace: true });
  }, [navigate]);
  return null;
}

function getRoomStorageKey(roomId: string) {
  return `gopad-room-${roomId}`;
}

function saveRoomContent(roomId: string, content: string, timestamp: number) {
  localStorage.setItem(getRoomStorageKey(roomId), JSON.stringify({ content, timestamp }));
}

function loadRoomContent(roomId: string): { content: string; timestamp: number } | null {
  const raw = localStorage.getItem(getRoomStorageKey(roomId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getRoomLanguageKey(roomId: string) {
  return `gopad-room-lang-${roomId}`;
}

function saveRoomLanguage(roomId: string, language: string) {
  localStorage.setItem(getRoomLanguageKey(roomId), language);
}

function loadRoomLanguage(roomId: string): string | null {
  return localStorage.getItem(getRoomLanguageKey(roomId));
}

function getRoomFullStateKey(roomId: string) {
  return `gopad-room-fullstate-${roomId}`;
}

function injectCursorStyles(uuid: string, color: string) {
  const styleId = `remote-cursor-style-${uuid}`;
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.innerHTML = `
    .monaco-editor .remote-cursor.remote-cursor-${uuid} {
      border-left: 2px solid ${color} !important;
      margin-left: -1px;
      pointer-events: none;
      z-index: 10;
    }
    .monaco-editor .remote-cursor-label-${uuid} {
      color: ${color} !important;
      background: #23272e !important;
      padding: 0 6px;
      border-radius: 4px;
      margin-left: 4px;
      font-size: 0.85em;
      font-weight: bold;
      position: relative;
      top: -1.3em;
      left: 2px;
      z-index: 20;
      white-space: nowrap;
      box-shadow: 0 2px 8px #0008;
      pointer-events: none;
    }
    .monaco-editor .remote-selection.remote-selection-${uuid} {
      background: ${color} !important;
      opacity: 0.18 !important;
      border-radius: 2px !important;
    }
  `;
  document.head.appendChild(style);
}

function getTabStorageKey(roomId: string, tabId: string) {
  return `gopad-room-${roomId}-tab-${tabId}`;
}

function RoomEditor() {
  const { roomId } = useParams();
  const [name, setName] = useState(getStoredName());
  const [showNamePrompt, setShowNamePrompt] = useState(!name);
  const [language, setLanguage] = useState('plaintext');
  const [users, setUsers] = useState<{ [key: string]: UserInfo }>({});
  const [tabs, setTabs] = useState<Tab[]>([{
    id: '1',
    name: 'Untitled',
    content: '',
  }]);
  const [activeTabId, setActiveTabId] = useState('1');
  const wsRef = useRef<WebSocket | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
  const [remoteCursors, setRemoteCursors] = useState<{ [uuid: string]: CursorMessage }>({});
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const handleInit = (data: FullStateMessage) => {
    if (data.tabs && Array.isArray(data.tabs)) {
      setTabs(data.tabs);
      setActiveTabId(data.activeTabId || data.tabs[0]?.id || '1');
    }
    if (data.language) {
      setLanguage(data.language);
    }
    if (data.users) {
      setUsers(data.users);
    }
    setIsInitialized(true);
  };

  const connectWebSocket = React.useCallback(() => {
    if (!roomId || !name.trim()) return;
    setReconnecting(false);
    let wsHost: string;
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      wsHost = `ws://${window.location.hostname}:3030/ws?doc=${roomId}`;
    } else {
      wsHost = `ws://${window.location.host}/ws?doc=${roomId}`;
    }
    const ws = new WebSocket(wsHost);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket opened', wsHost);
      setIsConnected(true);
      setReconnecting(false);
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      ws.send(JSON.stringify({ type: 'setName', uuid: getOrCreateUUID(), name: name.trim() }));
    };

    ws.onclose = (event) => {
      console.log('WebSocket closed', event);
      setIsConnected(false);
      setIsInitialized(false);
      setReconnecting(true);
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = setTimeout(() => {
        console.log('Attempting reconnect...');
        connectWebSocket();
      }, 2000);
    };

    ws.onerror = (event) => {
      console.log('WebSocket error', event);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        if (typeof data === 'object' && data !== null && 'type' in data) {
          const msgType = (data as { type: string }).type;
          switch (msgType) {
            case 'init':
            case 'fullState':
              handleInit(data as FullStateMessage);
              break;
            case 'update':
              setTabs(prevTabs => prevTabs.map(tab =>
                tab.id === (data as UpdateMessage).tabId ? { ...tab, content: (data as UpdateMessage).content } : tab
              ));
              break;
            case 'userList':
              setUsers((data as UserListMessage).users);
              break;
            case 'language':
              setLanguage((data as LanguageMessage).language);
              break;
            case 'cursor':
              const msg = data as CursorMessage;
              setRemoteCursors((prev) => ({ ...prev, [msg.uuid]: msg }));
              break;
            case 'tabCreate':
              setTabs(prevTabs => {
                if (prevTabs.some(tab => tab.id === (data as TabCreateMessage).tab.id)) return prevTabs;
                return [...prevTabs, (data as TabCreateMessage).tab];
              });
              setActiveTabId((data as TabCreateMessage).tab.id);
              break;
            case 'tabFocus':
              setActiveTabId((data as TabFocusMessage).tabId);
              break;
            case 'tabRename':
              setTabs(prevTabs => prevTabs.map(tab =>
                tab.id === (data as TabRenameMessage).tabId ? { ...tab, name: (data as TabRenameMessage).name } : tab
              ));
              break;
            case 'tabUpdate':
              const updateData = data as TabUpdateMessage;
              setTabs(updateData.tabs);
              setActiveTabId(updateData.activeTabId);
              break;
          }
        }
      } catch (e) {
        console.error('Error processing message:', e);
      }
    };
  }, [roomId, name]);

  useEffect(() => {
    if (!showNamePrompt && name.trim()) {
      connectWebSocket();
    }
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
    };
  }, [connectWebSocket, showNamePrompt, name]);

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      setStoredName(name.trim());
      setShowNamePrompt(false);
    }
  };

  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const handleEditorChange = (value: string | undefined) => {
    if (!value || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    // Update local state immediately
    setTabs(prevTabs => prevTabs.map(tab =>
      tab.id === activeTabId ? { ...tab, content: value } : tab
    ));

    // Then send to server
    wsRef.current.send(JSON.stringify({
      type: 'update',
      tabId: activeTabId,
      content: value,
    }));
  };

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLanguage = e.target.value;
    setLanguage(newLanguage);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'language',
        language: newLanguage,
      }));
    }
  };

  const handleCopyRoomUrl = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleNewTab = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'tabCreate',
        tab: {
          id: generateUUID(),
          name: 'Untitled',
          content: '',
        },
      }));
    }
  };

  const handleTabClick = (tabId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Update local state first
      setActiveTabId(tabId);
      // Then notify other clients
      wsRef.current.send(JSON.stringify({
        type: 'tabFocus',
        tabId,
      }));
    }
  };

  const handleTabClose = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return;
    
    setTabs(prevTabs => prevTabs.filter(tab => tab.id !== tabId));
    if (activeTabId === tabId) {
      const remainingTabs = tabs.filter(tab => tab.id !== tabId);
      setActiveTabId(remainingTabs[remainingTabs.length - 1].id);
    }
  };

  const handleTabDoubleClick = (tabId: string, currentName: string) => {
    setRenamingTabId(tabId);
    setRenameValue(currentName);
  };

  const handleRenameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRenameValue(e.target.value);
  };

  const handleRenameBlurOrEnter = (tabId: string) => {
    if (renameValue.trim() && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'tabRename',
        tabId,
        name: renameValue.trim(),
      }));
    }
    setRenamingTabId(null);
  };

  // Add effect to update editor content when active tab changes
  useEffect(() => {
    if (editorRef.current) {
      const activeTab = tabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const currentContent = editorRef.current.getValue();
        if (currentContent !== activeTab.content) {
          editorRef.current.setValue(activeTab.content);
        }
      }
    }
  }, [activeTabId, tabs]);

  if (showNamePrompt) {
    return (
      <div className="name-prompt">
        <form onSubmit={handleNameSubmit}>
          <h2>Enter your name</h2>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            required
            autoFocus
          />
          <button type="submit">Join</button>
        </form>
      </div>
    );
  }

  return (
    <div className="App">
      <header className="App-header">
        <h1>GoPad</h1>
        <div className="connection-status">
          {copied && <span className="copy-tooltip">Copied!</span>}
          Room: <span
            className="room-id"
            style={{ fontWeight: 600, cursor: 'pointer', color: '#61dafb', textDecoration: 'underline dotted' }}
            title="Click to copy room URL"
            onClick={handleCopyRoomUrl}
          >
            {roomId}
          </span>
          {' | Status: '}
          {isConnected ? 'Connected' : reconnecting ? 'Reconnecting…' : 'Disconnected'}
          {!isInitialized && isConnected && ' (Initializing...)'}
        </div>
      </header>
      <main>
        <div className="user-list">
          <div className="language-select">
            <label htmlFor="language">Syntax:</label>
            <select
              id="language"
              value={language}
              onChange={handleLanguageChange}
            >
              <option value="plaintext">Plain Text</option>
              <option value="javascript">JavaScript</option>
              <option value="typescript">TypeScript</option>
              <option value="python">Python</option>
              <option value="java">Java</option>
              <option value="c">C</option>
              <option value="cpp">C++</option>
              <option value="csharp">C#</option>
              <option value="go">Go</option>
              <option value="rust">Rust</option>
              <option value="php">PHP</option>
              <option value="ruby">Ruby</option>
              <option value="swift">Swift</option>
              <option value="kotlin">Kotlin</option>
              <option value="json">JSON</option>
              <option value="markdown">Markdown</option>
              <option value="shell">Shell/Bash</option>
              <option value="sql">SQL</option>
              <option value="html">HTML</option>
              <option value="css">CSS</option>
              <option value="xml">XML</option>
              <option value="powershell">PowerShell</option>
              <option value="perl">Perl</option>
              <option value="r">R</option>
              <option value="dart">Dart</option>
              <option value="scala">Scala</option>
              <option value="objective-c">Objective-C</option>
              <option value="vb">Visual Basic</option>
              <option value="lua">Lua</option>
              <option value="matlab">MATLAB</option>
              <option value="groovy">Groovy</option>
              <option value="yaml">YAML</option>
            </select>
          </div>
          <h3>Connected Users</h3>
          <ul>
            {Object.entries(users || {}).map(([uuid, user]) => {
              const isDisconnected = user.disconnected;
              return (
                <li
                  key={uuid}
                  style={{
                    color: user.color,
                    opacity: isDisconnected ? 0.5 : 1,
                    fontStyle: isDisconnected ? 'italic' : 'normal',
                  }}
                >
                  {user.name}
                  {isDisconnected && <span style={{ color: '#bdbdbd', marginLeft: 6 }}>(disconnected)</span>}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="editor-container">
          <div className="editor-header">
            <div className="tab-bar">
              {(tabs || []).map(tab => (
                <div
                  key={tab.id}
                  className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
                  onClick={() => handleTabClick(tab.id)}
                >
                  {renamingTabId === tab.id ? (
                    <input
                      type="text"
                      value={renameValue}
                      autoFocus
                      onChange={handleRenameChange}
                      onBlur={() => handleRenameBlurOrEnter(tab.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRenameBlurOrEnter(tab.id);
                      }}
                      style={{ width: '90px', fontSize: 'inherit', background: '#23272e', color: '#e0e0e0', border: '1px solid #444', borderRadius: 3, padding: '2px 6px' }}
                    />
                  ) : (
                    <span onDoubleClick={() => handleTabDoubleClick(tab.id, tab.name)}>{tab.name}</span>
                  )}
                  <button
                    className="tab-close"
                    onClick={(e) => handleTabClose(tab.id, e)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button className="new-tab-button" onClick={handleNewTab}>
                +
              </button>
            </div>
          </div>
          <MonacoEditor
            height="calc(100vh - 100px)"
            language={language}
            value={tabs.find(tab => tab.id === activeTabId)?.content || ''}
            onChange={handleEditorChange}
            onMount={handleEditorDidMount}
            theme="vs-dark"
            key={activeTabId}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              wordWrap: 'on',
              lineNumbers: 'on',
              renderWhitespace: 'selection',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              trimAutoWhitespace: false,
            }}
          />
        </div>
      </main>
    </div>
  );
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<RedirectToRoom />} />
        <Route path="/room/:roomId" element={<RoomEditor />} />
      </Routes>
    </Router>
  );
}

export default App; 