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
import ReactMarkdown from 'react-markdown';
import Modal from 'react-modal';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

Modal.setAppElement('#root');

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
  notes: string;
}

interface CursorMessage {
  type: 'cursor';
  uuid: string;
  name: string;
  color: string;
  position: number;
  selection?: {
    start: number;
    end: number;
  };
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

interface TabNotesUpdateMessage {
  type: 'tabNotesUpdate';
  tabId: string;
  notes: string;
}

type WebSocketMessage = UpdateMessage | UserListMessage | LanguageMessage | CursorMessage | TabFocusMessage | TabCreateMessage | TabRenameMessage | FullStateMessage | TabUpdateMessage | TabNotesUpdateMessage;

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

// Markdown renderers for syntax highlighting
const markdownComponents = {
  code({node, inline, className, children, ...props}: any) {
    const match = /language-(\w+)/.exec(className || '');
    return !inline && match ? (
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={match[1]}
        PreTag="div"
        {...props}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }
};

function RoomEditor() {
  const { roomId } = useParams();
  const [name, setName] = useState(getStoredName());
  const [showNamePrompt, setShowNamePrompt] = useState(!name);
  const [language, setLanguage] = useState('plaintext');
  const [users, setUsers] = useState<{ [key: string]: UserInfo }>({});
  const [currentUserUuid, setCurrentUserUuid] = useState(getOrCreateUUID());
  const [editingName, setEditingName] = useState(false);
  const [nameEditValue, setNameEditValue] = useState('');
  const [tabs, setTabs] = useState<Tab[]>([{
    id: '1',
    name: 'Untitled',
    content: '',
    notes: '',
  }]);
  const [activeTabId, setActiveTabId] = useState('1');
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [notesContent, setNotesContent] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
  const reconnectStartTime = useRef<number | null>(null);
  const [remoteCursors, setRemoteCursors] = useState<{ [uuid: string]: CursorMessage }>({});
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [notesPanelOpen, setNotesPanelOpen] = useState(true);
  const centerPanelRef = useRef<HTMLDivElement>(null);
  const reconnectInterval = useRef<NodeJS.Timeout | null>(null);

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
    // Only reset reconnecting/disconnected if not already in those states
    if (!reconnecting && !isDisconnected) {
      setReconnecting(false);
      setIsDisconnected(false);
      reconnectStartTime.current = null;
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
        reconnectTimeout.current = null;
      }
      if (reconnectInterval.current) {
        clearInterval(reconnectInterval.current);
        reconnectInterval.current = null;
      }
    }
    let wsHost: string;
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      wsHost = `ws://${window.location.hostname}:3030/ws?doc=${roomId}`;
    } else {
      wsHost = `ws://${window.location.host}/ws?doc=${roomId}`;
    }
    const ws = new WebSocket(wsHost);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setReconnecting(false);
      setIsDisconnected(false);
      reconnectStartTime.current = null;
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
        reconnectTimeout.current = null;
      }
      if (reconnectInterval.current) {
        clearInterval(reconnectInterval.current);
        reconnectInterval.current = null;
      }
      const uuid = getOrCreateUUID();
      setCurrentUserUuid(uuid);
      ws.send(JSON.stringify({ type: 'setName', uuid, name: name.trim() }));
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      setIsInitialized(false);
      // Only set reconnecting/disconnected and timers on first transition
      if (!reconnecting && !isDisconnected) {
        setReconnecting(true);
        reconnectStartTime.current = Date.now();
        // Only set timers if not already set
        if (!reconnectTimeout.current) {
          reconnectTimeout.current = setTimeout(() => {
            setReconnecting(false);
            setIsDisconnected(true);
            // Now only try to reconnect every 30 seconds
            if (reconnectInterval.current) {
              clearInterval(reconnectInterval.current);
              reconnectInterval.current = null;
            }
            if (!reconnectInterval.current) {
              reconnectInterval.current = setInterval(() => {
                connectWebSocket();
              }, 30000);
            }
          }, 60000);
        }
        if (!reconnectInterval.current) {
          reconnectInterval.current = setInterval(() => {
            if (!isDisconnected) {
              connectWebSocket();
            }
          }, 2000);
        }
      }
      // Otherwise, do not change reconnecting/disconnected state or timers
    };

    ws.onerror = (event) => {
      // Optionally handle error
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
            case 'tabNotesUpdate':
              const notesMsg = data as TabNotesUpdateMessage;
              setTabs(prevTabs =>
                prevTabs.map(tab =>
                  tab.id === notesMsg.tabId ? { ...tab, notes: notesMsg.notes } : tab
                )
              );
              break;
          }
        }
      } catch (e) {
        // Optionally handle error
      }
    };
  }, [roomId, name, isDisconnected, reconnecting]);

  useEffect(() => {
    if (!showNamePrompt && name.trim()) {
      connectWebSocket();
    }
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      if (reconnectInterval.current) clearInterval(reconnectInterval.current);
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

    // Add cursor position change listener
    editor.onDidChangeCursorPosition((e) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      
      const position = editor.getModel()?.getOffsetAt(e.position) || 0;
      wsRef.current.send(JSON.stringify({
        type: 'cursor',
        uuid: currentUserUuid,
        name: name,
        color: users[currentUserUuid]?.color || '#e57373',
        position: position,
      }));
    });

    // Add selection change listener
    editor.onDidChangeCursorSelection((e) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      
      const model = editor.getModel();
      if (!model) return;

      const startPosition = model.getOffsetAt(e.selection.getStartPosition());
      const endPosition = model.getOffsetAt(e.selection.getEndPosition());
      
      wsRef.current.send(JSON.stringify({
        type: 'cursor',
        uuid: currentUserUuid,
        name: name,
        color: users[currentUserUuid]?.color || '#e57373',
        position: endPosition,
        selection: {
          start: startPosition,
          end: endPosition
        }
      }));
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    if (!value || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    const oldValue = tabs.find(tab => tab.id === activeTabId)?.content || '';
    const newValue = value;

    // Calculate the change position and length
    let changeStart = 0;
    let changeEnd = 0;
    let changeLength = 0;

    // Find the first position where the content differs
    while (changeStart < oldValue.length && changeStart < newValue.length && oldValue[changeStart] === newValue[changeStart]) {
      changeStart++;
    }

    // Find the last position where the content differs
    let oldEnd = oldValue.length - 1;
    let newEnd = newValue.length - 1;
    while (oldEnd >= changeStart && newEnd >= changeStart && oldValue[oldEnd] === newValue[newEnd]) {
      oldEnd--;
      newEnd--;
    }

    // Calculate the change length
    changeLength = newEnd - changeStart + 1;
    changeEnd = oldEnd + 1;

    // Transform remote cursor positions
    const transformedCursors = Object.entries(remoteCursors).reduce((acc, [uuid, cursor]) => {
      if (uuid === currentUserUuid) {
        acc[uuid] = cursor;
        return acc;
      }

      let newPosition = cursor.position;
      let newSelection = cursor.selection;

      // If cursor is after the change, adjust its position
      if (cursor.position > changeStart) {
        const offset = changeLength - (changeEnd - changeStart);
        newPosition = cursor.position + offset;
      }

      // If there's a selection, transform it too
      if (cursor.selection) {
        newSelection = {
          start: cursor.selection.start > changeStart ? cursor.selection.start + (changeLength - (changeEnd - changeStart)) : cursor.selection.start,
          end: cursor.selection.end > changeStart ? cursor.selection.end + (changeLength - (changeEnd - changeStart)) : cursor.selection.end
        };
      }

      acc[uuid] = {
        ...cursor,
        position: newPosition,
        selection: newSelection
      };
      return acc;
    }, {} as typeof remoteCursors);

    setRemoteCursors(transformedCursors);
    
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
          notes: '',
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
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'tabDelete',
        tabId,
      }));
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

  const handleNotesEdit = (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      setEditingNotes(tabId);
      setNotesContent(tab.notes);
    }
  };

  const handleNotesSave = (tabId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'tabNotesUpdate',
        tabId,
        notes: notesContent,
      }));
      setTabs(prevTabs => prevTabs.map(tab =>
        tab.id === tabId ? { ...tab, notes: notesContent } : tab
      ));
    }
    setEditingNotes(null);
  };

  const handleNotesCancel = () => {
    setEditingNotes(null);
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

  useEffect(() => {
    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.layout();
      }
    }, 50);
  }, [notesPanelOpen]);

  const handleNameDoubleClick = () => {
    setEditingName(true);
    setNameEditValue(name);
  };

  const handleNameEditChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNameEditValue(e.target.value);
  };

  const handleNameEditBlurOrEnter = () => {
    if (nameEditValue.trim() && wsRef.current?.readyState === WebSocket.OPEN) {
      const newName = nameEditValue.trim();
      setName(newName);
      setStoredName(newName);
      wsRef.current.send(JSON.stringify({
        type: 'setName',
        uuid: currentUserUuid,
        name: newName,
      }));
    }
    setEditingName(false);
  };

  const handleNameEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleNameEditBlurOrEnter();
    } else if (e.key === 'Escape') {
      setEditingName(false);
    }
  };

  // Update status logic for rendering
  const showReconnecting = reconnecting && !isDisconnected;
  const showDisconnected = isDisconnected;

  // Add effect to update remote cursors
  useEffect(() => {
    if (!editorRef.current) return;

    const decorations = Object.entries(remoteCursors)
      .map(([uuid, cursor]): monaco.editor.IModelDeltaDecoration[] => {
        if (uuid === currentUserUuid) return [];

        const model = editorRef.current?.getModel();
        if (!model) return [];

        const position = model.getPositionAt(cursor.position);
        if (!position) return [];

        const user = users[uuid];
        if (!user) return [];

        // Inject cursor styles if not already present
        injectCursorStyles(uuid, user.color);

        const decoration: monaco.editor.IModelDeltaDecoration = {
          range: new monaco.Range(
            position.lineNumber,
            position.column,
            position.lineNumber,
            position.column
          ),
          options: {
            className: `remote-cursor remote-cursor-${uuid}`,
            glyphMarginClassName: `remote-cursor-label-${uuid}`,
            glyphMarginHoverMessage: { value: user.name },
          }
        };

        // Add selection decoration if present
        if (cursor.selection) {
          const startPosition = model.getPositionAt(cursor.selection.start);
          const endPosition = model.getPositionAt(cursor.selection.end);
          if (startPosition && endPosition) {
            const selectionDecoration: monaco.editor.IModelDeltaDecoration = {
              range: new monaco.Range(
                startPosition.lineNumber,
                startPosition.column,
                endPosition.lineNumber,
                endPosition.column
              ),
              options: {
                className: `remote-selection remote-selection-${uuid}`,
                hoverMessage: { value: user.name },
              }
            };
            return [decoration, selectionDecoration];
          }
        }

        return [decoration];
      })
      .flat();

    decorationsRef.current = editorRef.current.deltaDecorations(
      decorationsRef.current,
      decorations
    );
  }, [remoteCursors, users, currentUserUuid]);

  return (
    <div className="App">
      {showNamePrompt ? (
        <div className="name-prompt">
          <form onSubmit={handleNameSubmit}>
            <h2>Enter your name</h2>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              autoFocus
            />
            <button type="submit">Join</button>
          </form>
        </div>
      ) : (
        <>
          <main>
            <div className="sidebar">
              <div className="user-list">
                <div className="language-select">
                  <label htmlFor="language">Language:</label>
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
                    const isCurrentUser = uuid === currentUserUuid;
                    return (
                      <li
                        key={uuid}
                        style={{
                          color: user.color,
                          opacity: isDisconnected ? 0.5 : 1,
                          fontStyle: isDisconnected ? 'italic' : 'normal',
                        }}
                      >
                        {isCurrentUser && editingName ? (
                          <input
                            type="text"
                            value={nameEditValue}
                            onChange={handleNameEditChange}
                            onBlur={handleNameEditBlurOrEnter}
                            onKeyDown={handleNameEditKeyDown}
                            style={{
                              background: '#23272e',
                              border: '1px solid #444',
                              borderRadius: '4px',
                              padding: '2px 6px',
                              color: user.color,
                              fontSize: 'inherit',
                              fontFamily: 'inherit',
                              width: '100%',
                            }}
                            autoFocus
                          />
                        ) : (
                          <>
                            <span
                              onDoubleClick={isCurrentUser ? handleNameDoubleClick : undefined}
                              style={{ cursor: isCurrentUser ? 'text' : 'default' }}
                            >
                              {user.name}
                            </span>
                            {isCurrentUser && <span style={{ color: '#e0e0e0', marginLeft: 6, fontSize: '0.9em' }}>(me)</span>}
                            {isDisconnected && <span style={{ color: '#bdbdbd', marginLeft: 6 }}>(disconnected)</span>}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
            <div className="main-content">
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
              <div className="editor-notes-row">
                <div className="center-panel" ref={centerPanelRef} style={{ position: 'relative', height: '100%' }}>
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
                  <button
                    className="notes-panel-toggle"
                    onClick={() => setNotesPanelOpen(open => !open)}
                    title={notesPanelOpen ? 'Collapse Notes Panel' : 'Expand Notes Panel'}
                  >
                    {notesPanelOpen ? (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M10 6L16 12L10 18" stroke="#d0d0d0" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    ) : (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M14 6L8 12L14 18" stroke="#d0d0d0" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>
                </div>
                <div className={`notes-panel${notesPanelOpen ? ' open' : ' closed'}`}> 
                  {notesPanelOpen && (
                    <div className="notes-panel-content">
                      <div className="notes-panel-header">
                        <div className="notes-header-group">
                          <span className="tab-notes-label">Notes</span>
                        </div>
                        <div className="notes-header-actions">
                          <button
                            onClick={() => handleNotesEdit(activeTabId)}
                            className="add-notes-icon"
                            title={tabs.find(t => t.id === activeTabId)?.notes ? "Edit Notes" : "Add Notes"}
                          >
                            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <path d="M15.232 2.232a2.5 2.5 0 0 1 3.536 3.536l-11.25 11.25a2 2 0 0 1-.707.464l-4 1.333a.5.5 0 0 1-.632-.632l1.333-4a2 2 0 0 1 .464-.707l11.25-11.25zm2.122 1.414a1.5 1.5 0 0 0-2.122 0l-1.086 1.086 2.122 2.122 1.086-1.086a1.5 1.5 0 0 0 0-2.122zM3.5 15.793l10.25-10.25 2.122 2.122-10.25 10.25-2.122-2.122zm-.707 1.414l1.415 1.415-2.122.707.707-2.122z" fill="currentColor"/>
                            </svg>
                          </button>
                        </div>
                      </div>
                      <div className="tab-notes">
                        <div className="notes-display">
                          <div className="notes-content">
                            <ReactMarkdown components={markdownComponents}>
                              {tabs.find(t => t.id === activeTabId)?.notes || ''}
                            </ReactMarkdown>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </main>
          <div className="footer">
            <div className="footer-left">
              <div className={`connection-status ${isConnected ? 'connected' : showReconnecting ? 'reconnecting' : showDisconnected ? 'disconnected' : ''}`}
                title={isConnected ? 'Connected' : showReconnecting ? 'Reconnecting…' : 'Disconnected'}>
                {isConnected ? (
                  // Wifi icon (connected)
                  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 18c.552 0 1 .448 1 1s-.448 1-1 1-1-.448-1-1 .448-1 1-1zm-4.243-2.828a6 6 0 0 1 8.486 0 1 1 0 0 1-1.414 1.414 4 4 0 0 0-5.657 0 1 1 0 1 1-1.415-1.414zm-2.828-2.829a10 10 0 0 1 14.142 0 1 1 0 1 1-1.415 1.415 8 8 0 0 0-11.313 0 1 1 0 1 1-1.414-1.415zm-2.829-2.829a14 14 0 0 1 19.798 0 1 1 0 1 1-1.415 1.415 12 12 0 0 0-16.97 0 1 1 0 1 1-1.414-1.415z" fill="currentColor"/>
                  </svg>
                ) : showReconnecting ? (
                  // Sync/refresh icon (reconnecting)
                  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" fill="currentColor"/>
                  </svg>
                ) : (
                  // Wifi-off icon (disconnected)
                  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2.1 3.51a1 1 0 0 1 1.41 0l16.98 16.98a1 1 0 0 1-1.41 1.41l-2.13-2.13A13.93 13.93 0 0 1 12 21c-3.31 0-6.36-1.14-8.77-3.05a1 1 0 1 1 1.28-1.54A11.95 11.95 0 0 0 12 19c1.7 0 3.33-.33 4.8-.93l-2.13-2.13a6 6 0 0 0-8.49-8.49L3.51 4.92a1 1 0 0 1 0-1.41zm16.36 2.12a1 1 0 0 1 1.41 1.41l-1.43 1.43a13.93 13.93 0 0 1 3.05 8.77c0 1.7-.33 3.33-.93 4.8l-2.13-2.13a6 6 0 0 0-8.49-8.49L4.92 3.51a1 1 0 0 1 1.41-1.41l1.43 1.43A13.93 13.93 0 0 1 12 3c3.31 0 6.36 1.14 8.77 3.05z" fill="currentColor"/>
                  </svg>
                )}
              </div>
              <span className="room-id" onClick={handleCopyRoomUrl}>
                room: {roomId}
                {copied && <span className="copy-tooltip">Copied!</span>}
              </span>
            </div>
          </div>
          <Modal
            isOpen={editingNotes === activeTabId}
            onRequestClose={handleNotesCancel}
            contentLabel="Edit Notes"
            className="notes-modal"
            overlayClassName="notes-modal-overlay"
          >
            <h2 className="notes-modal-title">Edit Notes</h2>
            <textarea
              value={notesContent}
              onChange={(e) => setNotesContent(e.target.value)}
              placeholder="Enter notes in markdown format..."
              className="notes-modal-textarea"
              autoFocus
            />
            <div className="notes-modal-actions">
              <button onClick={() => handleNotesSave(activeTabId)} className="save-button">Save</button>
              <button onClick={handleNotesCancel} className="cancel-button">Cancel</button>
            </div>
          </Modal>
        </>
      )}
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