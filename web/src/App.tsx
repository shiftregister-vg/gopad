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
import { useState as useReactState } from 'react';
import * as monaco from 'monaco-editor';

interface UserInfo {
  uuid: string;
  name: string;
  color: string;
  disconnected?: boolean;
}

interface InitMessage {
  type: 'init';
  content: string;
  users: { [key: string]: UserInfo };
  language?: string;
}

interface UpdateMessage {
  type: 'update';
  content: string;
}

interface UserListMessage {
  type: 'userList';
  users: { [key: string]: UserInfo };
}

interface LanguageMessage {
  type: 'language';
  language: string;
}

interface CursorMessage {
  type: 'cursor';
  uuid: string;
  name: string;
  color: string;
  position: number;
  selection: { start: number; end: number };
}

type WebSocketMessage = InitMessage | UpdateMessage | UserListMessage | LanguageMessage | CursorMessage;

// Monaco supported languages (common set, can be expanded)
const MONACO_LANGUAGES = [
  { id: 'plaintext', label: 'Plain Text' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'swift', label: 'Swift' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'json', label: 'JSON' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'shell', label: 'Shell/Bash' },
  { id: 'sql', label: 'SQL' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'xml', label: 'XML' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'perl', label: 'Perl' },
  { id: 'r', label: 'R' },
  { id: 'dart', label: 'Dart' },
  { id: 'scala', label: 'Scala' },
  { id: 'objective-c', label: 'Objective-C' },
  { id: 'vb', label: 'Visual Basic' },
  { id: 'lua', label: 'Lua' },
  { id: 'matlab', label: 'MATLAB' },
  { id: 'groovy', label: 'Groovy' },
  { id: 'yaml', label: 'YAML' },
];

function generateRoomId() {
  // Simple random string, e.g. 8 chars
  return Math.random().toString(36).substring(2, 10);
}

function generateUUID() {
  if (window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }
  // Fallback for older browsers
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

function RoomEditor() {
  const { roomId } = useParams();
  const [content, setContent] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [showNamePrompt, setShowNamePrompt] = useState(getStoredName() === '');
  const [userName, setUserName] = useState(getStoredName());
  const [users, setUsers] = useState<{ [uuid: string]: UserInfo }>({});
  const [uuid] = useState(() => getOrCreateUUID());
  const [language, setLanguage] = useState(() => loadRoomLanguage(roomId!) || 'plaintext');
  const [reconnecting, setReconnecting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [copied, setCopied] = useReactState(false);
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
  const [remoteCursors, setRemoteCursors] = useState<{ [uuid: string]: CursorMessage }>({});
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const handleInit = React.useCallback((data: any) => {
    setUsers(data.users);
    setIsInitialized(true);
    const localLang = loadRoomLanguage(roomId!);
    // If server's language is 'plaintext' and client has a different language, send it to server and use it
    if (data.language === 'plaintext' && localLang && localLang !== 'plaintext') {
      setLanguage(localLang);
      saveRoomLanguage(roomId!, localLang);
      setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'setLanguage', language: localLang }));
        }
      }, 100);
    } else if (data.language) {
      setLanguage(data.language);
      saveRoomLanguage(roomId!, data.language);
    }
    const local = loadRoomContent(roomId!);
    const serverContentEmpty = !data.content || !data.content.trim();
    if ((local && local.content && serverContentEmpty) || (local && local.timestamp > (data.lastModified || 0))) {
      setContent(local.content);
      setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'update', content: local.content }));
        }
      }, 100);
    } else {
      setContent(data.content);
      saveRoomContent(roomId!, data.content, data.lastModified || 0);
    }
  }, [roomId]);

  // Reconnect logic
  const connectWebSocket = React.useCallback(() => {
    if (!roomId || !userName.trim()) return;
    setReconnecting(false);
    const ws = new WebSocket(`ws://localhost:3030/ws?doc=${roomId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setReconnecting(false);
      ws.send(JSON.stringify({ type: 'setName', uuid, name: userName.trim() }));
    };
    ws.onclose = () => {
      setIsConnected(false);
      setIsInitialized(false);
      setReconnecting(true);
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = setTimeout(connectWebSocket, 2000);
    };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        if (data.type === 'init') {
          handleInit(data);
        } else if (data.type === 'update') {
          setContent(data.content);
          const now = Date.now();
          saveRoomContent(roomId!, data.content, now);
        } else if (data.type === 'userList') {
          setUsers(data.users);
        } else if (data.type === 'language') {
          setLanguage(data.language);
        } else if (data.type === 'cursor') {
          const msg = data as CursorMessage;
          setRemoteCursors((prev) => ({ ...prev, [msg.uuid]: msg }));
        }
      } catch (e) {
        // ignore
      }
    };
  }, [roomId, userName, uuid]);

  // Only connect when name prompt is dismissed and userName is set
  useEffect(() => {
    if (!showNamePrompt && userName.trim()) {
      connectWebSocket();
    }
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
    };
  }, [connectWebSocket, showNamePrompt, userName, handleInit]);

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (userName.trim()) {
      setStoredName(userName.trim());
      setShowNamePrompt(false);
    }
  };

  const handleEditorChange = (value: string | undefined) => {
    if (!isInitialized) return;
    const newContent = value ?? '';
    setContent(newContent);
    const now = Date.now();
    saveRoomContent(roomId!, newContent, now);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message = {
        type: 'update',
        content: newContent
      };
      wsRef.current.send(JSON.stringify(message));
    }
  };

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLang = e.target.value;
    setLanguage(newLang);
    saveRoomLanguage(roomId!, newLang);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'setLanguage', language: newLang }));
    }
  };

  const handleCopyRoomUrl = () => {
    if (!roomId) return;
    const url = window.location.origin + `/room/${roomId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  

  // Send local cursor/selection to server
  const sendCursorUpdate = React.useCallback(() => {
    if (!editorRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const selection = editorRef.current.getSelection();
    if (!selection) return;
    const position = editorRef.current.getPosition();
    if (!position) return;
    const start = editorRef.current.getModel()?.getOffsetAt(selection.getStartPosition()) ?? 0;
    const end = editorRef.current.getModel()?.getOffsetAt(selection.getEndPosition()) ?? 0;
    wsRef.current.send(
      JSON.stringify({
        type: 'cursor',
        uuid,
        name: userName,
        color: users[uuid]?.color || '#fff',
        position: editorRef.current.getModel()?.getOffsetAt(position) ?? 0,
        selection: { start, end },
      } as CursorMessage)
    );
  }, [uuid, userName, users]);

  // Handle remote cursor messages
  useEffect(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    Object.values(remoteCursors).forEach((cursor) => {
      if (cursor.uuid === uuid) return;
      injectCursorStyles(cursor.uuid, cursor.color);
      const model = editor.getModel();
      if (!model) return;
      const startPos = model.getPositionAt(cursor.selection.start);
      const endPos = model.getPositionAt(cursor.selection.end);
      const isSelection = cursor.selection.start !== cursor.selection.end;
      if (isSelection) {
        decorations.push({
          range: new monaco.Range(
            startPos.lineNumber,
            startPos.column,
            endPos.lineNumber,
            endPos.column
          ),
          options: {
            className: `remote-selection remote-selection-${cursor.uuid}`,
            inlineClassName: `remote-selection-${cursor.uuid}`,
            isWholeLine: false,
            overviewRuler: {
              color: cursor.color,
              position: monaco.editor.OverviewRulerLane.Full,
            },
            minimap: { color: cursor.color, position: 1 },
            inlineClassNameAffectsLetterSpacing: true,
          },
        });
      } else {
        decorations.push({
          range: new monaco.Range(
            startPos.lineNumber,
            startPos.column,
            startPos.lineNumber,
            startPos.column
          ),
          options: {
            className: `remote-cursor remote-cursor-${cursor.uuid}`,
            inlineClassName: `remote-cursor-${cursor.uuid}`,
            before: {
              content: cursor.name,
              inlineClassName: `remote-cursor-label remote-cursor-label-${cursor.uuid}`,
            },
            overviewRuler: {
              color: cursor.color,
              position: monaco.editor.OverviewRulerLane.Full,
            },
            hoverMessage: { value: cursor.name },
          },
        });
      }
    });
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
  }, [remoteCursors, uuid]);

  // Listen for local cursor changes
  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.onDidChangeCursorSelection(() => {
      sendCursorUpdate();
    });
    sendCursorUpdate();
  };

  if (showNamePrompt) {
    return (
      <div className="name-prompt">
        <form onSubmit={handleNameSubmit}>
          <h2>Enter your name</h2>
          <input
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
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
              {MONACO_LANGUAGES.map(lang => (
                <option key={lang.id} value={lang.id}>{lang.label}</option>
              ))}
            </select>
          </div>
          <h3>Connected Users</h3>
          <ul>
            {users && Object.entries(users).map(([uuid, user]) => {
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
          <MonacoEditor
            height="80vh"
            language={language}
            value={content}
            onChange={handleEditorChange}
            theme="vs-dark"
            onMount={handleEditorDidMount}
            options={{
              fontSize: 15,
              minimap: { enabled: false },
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              lineNumbers: 'on',
            }}
          />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/room/:roomId" element={<RoomEditor />} />
        <Route path="/" element={<RedirectToRoom />} />
      </Routes>
    </Router>
  );
} 