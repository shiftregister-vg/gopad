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
  tabId: string;
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

interface Tab {
  id: string;
  name: string;
  content: string;
}

interface TabFocusMessage {
  type: 'tabFocus';
  tabId: string;
}

interface TabCreateMessage {
  type: 'tabCreate';
  tab: { id: string; name: string; content: string };
}

interface TabRenameMessage {
  type: 'tabRename';
  tabId: string;
  name: string;
}

interface FullStateMessage {
  type: 'fullState';
  tabs: Tab[];
  activeTabId: string;
  language: string;
}

type WebSocketMessage = InitMessage | UpdateMessage | UserListMessage | LanguageMessage | CursorMessage | TabFocusMessage | TabCreateMessage | TabRenameMessage | FullStateMessage;

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
  const [copied, setCopied] = useReactState(false);
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
  const [remoteCursors, setRemoteCursors] = useState<{ [uuid: string]: CursorMessage }>({});
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

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
      setTabs(prevTabs => prevTabs.map(tab => 
        tab.id === activeTabId ? { ...tab, content: local.content } : tab
      ));
      setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'update', content: local.content }));
        }
      }, 100);
    } else {
      setTabs(prevTabs => prevTabs.map(tab => 
        tab.id === activeTabId ? { ...tab, content: data.content } : tab
      ));
      saveRoomContent(roomId!, data.content, data.lastModified || 0);
    }
  }, [roomId]);

  // Reconnect logic
  const connectWebSocket = React.useCallback(() => {
    if (!roomId || !name.trim()) return;
    setReconnecting(false);
    // Always use port 3030 for WebSocket in development
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
        console.log('Attempting reconnect... isInitialized:', isInitialized);
        connectWebSocket();
      }, 2000);
    };
    ws.onerror = (event) => {
      console.log('WebSocket error', event);
    };
    ws.onmessage = (event) => {
      console.log('WebSocket message', event.data);
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        if (typeof data === 'object' && data !== null && 'type' in data) {
          const msgType = (data as { type: string }).type;
          if (msgType === 'init') {
            handleInit(data);
          } else if (msgType === 'update') {
            setTabs(prevTabs => prevTabs.map(tab =>
              tab.id === (data as any).tabId ? { ...tab, content: (data as any).content } : tab
            ));
          } else if (msgType === 'userList') {
            setUsers((data as any).users);
          } else if (msgType === 'language') {
            setLanguage((data as any).language);
          } else if (msgType === 'cursor') {
            const msg = data as CursorMessage;
            setRemoteCursors((prev) => ({ ...prev, [msg.uuid]: msg }));
          } else if (msgType === 'tabCreate') {
            setTabs(prevTabs => {
              if (prevTabs.some(tab => tab.id === (data as any).tab.id)) return prevTabs;
              return [...prevTabs, { id: (data as any).tab.id, name: (data as any).tab.name, content: (data as any).tab.content || '' }];
            });
            setActiveTabId((data as any).tab.id);
          } else if (msgType === 'tabFocus') {
            setActiveTabId((data as any).tabId);
          } else if (msgType === 'tabRename') {
            setTabs(prevTabs => prevTabs.map(tab =>
              tab.id === (data as any).tabId ? { ...tab, name: (data as any).name } : tab
            ));
          } else if (msgType === 'requestState') {
            // Send full state to server, prefer localStorage if available
            let stateToSend = { tabs, activeTabId, language };
            if (roomId) {
              const saved = localStorage.getItem(getRoomFullStateKey(roomId));
              if (saved) {
                try {
                  const parsed = JSON.parse(saved);
                  if (parsed && parsed.tabs && parsed.activeTabId && parsed.language) {
                    stateToSend = parsed;
                  }
                } catch {}
              }
            }
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: 'fullState',
                ...stateToSend,
              }));
            }
          } else if (msgType === 'fullState' || msgType === 'init') {
            console.log('Received init/fullState', data);
            if ('tabs' in data && 'activeTabId' in data && 'language' in data) {
              setTabs((data as any).tabs);
              setActiveTabId((data as any).activeTabId);
              setLanguage((data as any).language);
              // Save to localStorage
              if (roomId) {
                localStorage.setItem(getRoomFullStateKey(roomId), JSON.stringify({
                  tabs: (data as any).tabs,
                  activeTabId: (data as any).activeTabId,
                  language: (data as any).language,
                }));
              }
              setIsInitialized(true);
              console.log('Initialization complete (tabs, activeTabId, language set, isInitialized=true)');
            } else {
              // fallback for old init
              if ('content' in data && (data as any).content) {
                setTabs([{ id: '1', name: 'Untitled', content: (data as any).content }]);
                setActiveTabId('1');
              }
              if ('language' in data && (data as any).language) setLanguage((data as any).language);
              setIsInitialized(true);
              console.log('Initialization complete (fallback, isInitialized=true)');
            }
          }
        }
      } catch (e) {
        // ignore
      }
    };
  }, [roomId, name, getOrCreateUUID]);

  // Only connect when name prompt is dismissed and name is set
  useEffect(() => {
    if (!showNamePrompt && name.trim()) {
      connectWebSocket();
    }
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
    };
  }, [connectWebSocket, showNamePrompt, name, handleInit]);

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      setStoredName(name.trim());
      setShowNamePrompt(false);
    }
  };

  const handleEditorChange = (value: string | undefined) => {
    if (!value || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setTabs(prevTabs => prevTabs.map(tab =>
      tab.id === activeTabId ? { ...tab, content: value } : tab
    ));
    wsRef.current.send(JSON.stringify({
      type: 'update',
      tabId: activeTabId,
      content: value
    }));
  };

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLanguage = e.target.value;
    setLanguage(newLanguage);
    localStorage.setItem(getRoomLanguageKey(roomId!), newLanguage);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'language',
        language: newLanguage
      }));
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
        uuid: getOrCreateUUID(),
        name,
        color: users[getOrCreateUUID()]?.color || '#fff',
        position: editorRef.current.getModel()?.getOffsetAt(position) ?? 0,
        selection: { start, end },
      } as CursorMessage)
    );
  }, [name, users, getOrCreateUUID]);

  // Handle remote cursor messages
  useEffect(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    Object.values(remoteCursors).forEach((cursor) => {
      if (cursor.uuid === getOrCreateUUID()) return;
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
  }, [remoteCursors, getOrCreateUUID]);

  // Listen for local cursor changes
  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.onDidChangeCursorSelection(() => {
      sendCursorUpdate();
    });
    sendCursorUpdate();
  };

  const createNewTab = () => {
    const newTab: Tab = {
      id: Date.now().toString(),
      name: 'Untitled',
      content: '',
    };
    setTabs(prevTabs => [...prevTabs, newTab]);
    setActiveTabId(newTab.id);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'tabCreate',
        tab: { id: newTab.id, name: newTab.name, content: newTab.content },
      }));
      wsRef.current.send(JSON.stringify({
        type: 'tabFocus',
        tabId: newTab.id,
      }));
    }
  };

  const handleTabClick = (tabId: string) => {
    setActiveTabId(tabId);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'tabFocus',
        tabId: tabId
      }));
    }
  };

  const handleTabClose = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return; // Don't close the last tab
    
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

  // Restore tab content from localStorage on mount or tab switch
  useEffect(() => {
    if (!roomId) return;
    const tab = tabs.find(tab => tab.id === activeTabId);
    if (!tab) return;
    const saved = localStorage.getItem(getTabStorageKey(roomId, activeTabId));
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setTabs(prevTabs => prevTabs.map(t => t.id === activeTabId ? { ...t, content: parsed.content } : t));
      } catch {}
    }
  }, [roomId, activeTabId]);

  // Save tab content to localStorage on change
  useEffect(() => {
    if (!roomId) return;
    const tab = tabs.find(tab => tab.id === activeTabId);
    if (!tab) return;
    localStorage.setItem(getTabStorageKey(roomId, activeTabId), JSON.stringify({ content: tab.content }));
  }, [roomId, activeTabId, tabs]);

  // On mount, restore language from localStorage if available
  useEffect(() => {
    if (!roomId) return;
    const savedLang = loadRoomLanguage(roomId);
    if (savedLang) setLanguage(savedLang);
  }, [roomId]);

  // Save full state to localStorage on every change
  useEffect(() => {
    if (!roomId) return;
    const state = { tabs, activeTabId, language };
    localStorage.setItem(getRoomFullStateKey(roomId), JSON.stringify(state));
  }, [roomId, tabs, activeTabId, language]);

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
          <div className="editor-header">
            <div className="tab-bar">
              {tabs.map(tab => (
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
              <button className="new-tab-button" onClick={createNewTab}>
                +
              </button>
            </div>
            <div className="editor-controls">
              {/* Removed Copy Room URL button from here */}
            </div>
          </div>
          <MonacoEditor
            height="calc(100vh - 100px)"
            language={language}
            value={tabs.find(tab => tab.id === activeTabId)?.content || ''}
            onChange={handleEditorChange}
            onMount={handleEditorDidMount}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              wordWrap: 'on',
              lineNumbers: 'on',
              renderWhitespace: 'selection',
              scrollBeyondLastLine: false,
              automaticLayout: true,
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