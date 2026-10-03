import { useRef, useState, useEffect, useCallback } from 'react';
import { ConvEngineChat, ConvEngineChatConfig } from '@salilvnair/convengine-chat';
import '@salilvnair/convengine-chat/style.css';
import { dmcrChangeRendererProvider } from '../chat-renderers/DmcrChangeRenderer';
import { dmcrErrorRendererProvider } from '../chat-renderers/DmcrErrorRenderer';
import { defaultDmcrRendererProvider } from '../chat-renderers/DefaultConversationalDMCRRenderer';
import { dmcrHelpRendererProvider } from '../chat-renderers/DmcrHelpRenderer';
import { dmcrMetadataFormRendererProvider } from '../chat-renderers/DmcrMetadataFormRenderer';
import { dmcrSchemaServerPickerRenderer } from '../chat-renderers/DmcrSchemaServerPickerRenderer';
import StyledDropdown from '../components/StyledDropdown';
import { getVsCodeApi } from '../vscode';
import { matchGreeting } from '../utils/greetingMatcher';
import type { FormSnapshot } from '../types';

// ─── Suggestion chips (shown as landing hints) ───────────────────────────────

const DMCR_CHIPS = [
  { chipText: '🏗️ Add column',      chatText: 'Add a nullable email varchar(320) column to the public.users table' },
  { chipText: '📋 New table',        chatText: 'Create a new table public.audit_log with id bigserial, event_type text, created_at timestamptz' },
  { chipText: '⚡ Add index',        chatText: 'Add an index on public.orders(customer_id) concurrently' },
  { chipText: '🌱 Seed data',        chatText: 'Seed initial config rows into public.app_config (key text, value text)' },
  { chipText: '🧪 Seed test data',   chatText: 'Seed test data for public.users — generate 15 realistic INSERT rows that respect all column types, NOT NULL constraints, and foreign keys' },
];

// ─── VS Code postMessage ↔ fetch bridge ──────────────────────────────────────
//
// convengine-chat talks to a backend via:
//   1. fetch(/api/v1/conversation/message) → intercepted, routed via postMessage
//   2. new EventSource(/api/v1/conversation/stream/{id}) → intercepted, replaced
//      with a fake EventSource that receives window.postMessage events from the
//      extension and re-dispatches them as proper SSE events.
//
// Extension → webview message protocol:
//   { type: 'reply',    msgId, text }  — final chat response
//   { type: 'error',    msgId, text }  — chat error
//   { type: 'sseEvent', stage, data }  — SSE stage event (e.g. VERBOSE)
//

/**
 * Minimal fake EventSource.
 * The library calls: source.onopen, source.addEventListener(stage, fn), source.onerror, source.close()
 * We listen on window for { type: 'sseEvent', stage, data } and dispatch to the registered handlers.
 */
class VsCodeEventSource {
  private _listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  private _msgHandler: (evt: MessageEvent) => void;
  onopen:   (() => void) | null = null;
  onerror:  ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  readyState = 1; // OPEN

  constructor(_url: string) {
    this._msgHandler = (evt: MessageEvent) => {
      const msg = evt.data;
      if (!msg || msg.type !== 'sseEvent') return;
      const stage: string = msg.stage ?? '';
      const fakeEvent = new MessageEvent(stage, {
        data: typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data ?? {}),
      });
      (this._listeners[stage] ?? []).forEach(fn => fn(fakeEvent));
      this.onmessage?.(fakeEvent);
    };
    window.addEventListener('message', this._msgHandler);
    // Signal connected on next tick so the library's onopen fires
    setTimeout(() => this.onopen?.(), 0);
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }

  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(f => f !== fn);
  }

  close() {
    window.removeEventListener('message', this._msgHandler);
    this._listeners = {};
    this.readyState = 2; // CLOSED
  }
}

function installVsCodeBridges() {
  const vscode = getVsCodeApi();
  const originalFetch = window.fetch.bind(window);

  // ── Intercept fetch ────────────────────────────────────────────────────────
  (window as any).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);

    if (url.includes('/api/v1/conversation/message')) {
      return new Promise<Response>((resolve) => {
        const msgId = Math.random().toString(36).slice(2);
        let body: any = {};
        try { body = init?.body ? JSON.parse(init.body as string) : {}; } catch { /* ignore */ }

        // ── Local greeting intercept: resolve fetch + fire ENGINE_RETURN so library exits loading state
        if (!body.reset) {
          // /help intercept — return dmcrHelp envelope without any LLM call
          const helpRe = /^(\/help|help)$/i;
          const helpHintRe = /\b(dmcr\s+commands?|what\s+commands?|list\s+commands?|show\s+commands?|available\s+commands?|all\s+commands?)\b/i;
          const msgTxt: string = body.message ?? '';
          if (helpRe.test(msgTxt.trim()) || helpHintRe.test(msgTxt)) {
            const envelope = JSON.stringify({ type: 'dmcrHelp' });
            resolve(new Response(JSON.stringify({ payload: { value: envelope } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }));
            setTimeout(() => {
              window.postMessage({ type: 'sseEvent', stage: 'ENGINE_RETURN', data: '{}' }, '*');
            }, 50);
            return;
          }

          const greetingReply = matchGreeting(body.message ?? '');
          if (greetingReply) {
            // Wrap in { type:'text', rawText } JSON envelope so the library can parse it
            // and our DefaultConversationalDMCRRenderer receives payload.rawText correctly.
            // resolveAssistantRenderer only sets payload for custom renderers when it's valid JSON.
            const envelope = JSON.stringify({ type: 'text', rawText: greetingReply });
            resolve(new Response(JSON.stringify({ payload: { value: envelope } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }));
            // Library opens EventSource after fetch resolves; give it a tick then signal done.
            setTimeout(() => {
              window.postMessage({ type: 'sseEvent', stage: 'ENGINE_RETURN', data: '{}' }, '*');
            }, 50);
            return;
          }
        }

        // ── Attach conversation history to inputParams ──────────────────────
        const HISTORY_KEY = 'dmcr_conv_history';
        const MAX_HISTORY_ENTRIES = 10; // 5 turns × 2 (user + assistant)
        let enrichedInputParams = body.inputParams ?? {};
        if (body.reset) {
          sessionStorage.removeItem(HISTORY_KEY);
          // Signal extension to reset audit session scope, then resolve immediately
          // so the library clears chat UI and generates a fresh conversationId.
          vscode.postMessage({ type: 'conversationSessionStart' });
          resolve(new Response(JSON.stringify({ payload: { value: '' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
          return;
        }
        try {
          const raw = sessionStorage.getItem(HISTORY_KEY);
          const history: Array<{ role: string; content: string }> = raw ? JSON.parse(raw) : [];
          if (history.length > 0) {
            enrichedInputParams = { ...enrichedInputParams, conversationHistory: history.slice(-MAX_HISTORY_ENTRIES) };
          }
        } catch { /* sessionStorage unavailable — proceed without history */ }

        // Use the library's conversationId so all audit entries for this chat share it
        const convId = body.conversationId ?? crypto.randomUUID();

        vscode.postMessage({ type: 'chat', msgId, payload: { text: body.message, inputParams: enrichedInputParams, reset: false, conversationId: convId } });
        window.postMessage({ type: '__dmcr_chatBusy', busy: true }, '*');

        function handler(evt: MessageEvent) {
          const msg = evt.data;
          if (!msg || (msg.type !== 'reply' && msg.type !== 'error') || msg.msgId !== msgId) return;
          window.removeEventListener('message', handler);
          window.postMessage({ type: '__dmcr_chatBusy', busy: false }, '*');

          let responseText = msg.type === 'error'
            ? JSON.stringify({ type: 'dmcrError', message: msg.text ?? 'Unknown error' })
            : (msg.text ?? '');

          if (msg.type === 'reply' && responseText) {
            try {
              const parsed = JSON.parse(responseText);
              if (
                parsed &&
                typeof parsed === 'object' &&
                typeof parsed.error === 'string' &&
                !parsed.type
              ) {
                responseText = JSON.stringify({ type: 'dmcrError', message: parsed.error });
              }
            } catch {
              // non-JSON reply; leave as-is
            }
          }

          // ── Save turn to sessionStorage for dialogue intent ─────────────
          if (msg.type === 'reply' && !body.reset) {
            try {
              const raw = sessionStorage.getItem(HISTORY_KEY);
              const history: Array<{ role: string; content: string }> = raw ? JSON.parse(raw) : [];
              history.push({ role: 'user', content: body.message ?? '' });
              // Store a plain-text summary of the response (strip JSON envelope if present)
              let assistantContent = responseText;
              try {
                const parsed = JSON.parse(responseText);
                // For table descriptions and text responses, extract the readable part
                if (parsed?.rawText) assistantContent = parsed.rawText;
                else if (parsed?.type === 'DmcrChange') assistantContent = `Generated DMCR change: ${parsed.changeName}`;
                else if (typeof parsed === 'object') assistantContent = JSON.stringify(parsed).slice(0, 800);
              } catch { /* responseText is plain text */ }
              history.push({ role: 'assistant', content: assistantContent.slice(0, 800) });
              sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_HISTORY_ENTRIES)));
            } catch { /* ignore sessionStorage errors */ }
          }

          const responseJson = { payload: { value: responseText } };

          resolve(new Response(JSON.stringify(responseJson), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }

        window.addEventListener('message', handler);
      });
    }

    // Audit endpoint — proxy through postMessage to get ce_audit entries
    // Extract the library's conversationId from the URL and pass it so we filter by it.
    if (url.match(/\/api\/v1\/conversation\/audit\//)) {
      const auditConvId = url.split('/api/v1/conversation/audit/')[1]?.split('?')[0] ?? '';
      return new Promise<Response>((resolve) => {
        const timelineRequestId = `conv-audit-${auditConvId}-${Date.now()}`;
        vscode.postMessage({ type: 'getAuditTimeline', payload: { conversationId: auditConvId, requestId: timelineRequestId } });

        function handler(evt: MessageEvent) {
          const msg = evt.data;
          if (!msg || msg.type !== 'auditTimeline' || msg.payload?.requestId !== timelineRequestId) return;
          window.removeEventListener('message', handler);

          // Map our CeAuditEntry[] → library format: [{ stage, payloadJson }]
          const entries = (msg.payload?.entries ?? []).map((e: any) => ({
            stage: e.stage ?? 'UNKNOWN',
            payloadJson: JSON.stringify({
              model: e.model,
              system_prompt: e.system_prompt,
              user_prompt: e.user_prompt,
              request: e.request_payload,
              response: e.response_payload,
              duration_ms: e.duration_ms,
              created_at: e.created_at,
              error: e.error,
            }, null, 2),
          }));

          resolve(new Response(JSON.stringify(entries), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }

        window.addEventListener('message', handler);
        // Timeout fallback — return empty if no response in 3s
        setTimeout(() => {
          window.removeEventListener('message', handler);
          resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }, 3000);
      });
    }

    // Feedback / other endpoints — no-op in VS Code context
    if (url.includes('/api/v1/conversation/')) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return originalFetch(input, init);
  };

  // ── Intercept EventSource (SSE) ────────────────────────────────────────────
  // The library creates: new EventSource(`${apiHost}/api/v1/conversation/stream/${conversationId}`)
  // We replace EventSource globally with our fake that receives window.postMessage events.
  (window as any).EventSource = VsCodeEventSource;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ConversationPage({ isDark = true, availableSchemas = [], initialState, onStateChange }: { isDark?: boolean; availableSchemas?: string[]; initialState?: FormSnapshot['conversation']; onStateChange?: (p: FormSnapshot['conversation']) => void }) {
  const [schemaCtx, setSchemaCtx] = useState(initialState?.schemaCtx || availableSchemas[0] || '');
  useEffect(() => { if (availableSchemas.length > 0 && !schemaCtx) setSchemaCtx(availableSchemas[0]); }, [availableSchemas]);
  const [changeNameHint, setChangeNameHint] = useState(initialState?.changeNameHint || '');
  const bridgeInstalledRef = useRef(false);
  const chatRootRef = useRef<HTMLDivElement>(null);

  /* Report key field changes to parent for snapshot persistence */
  useEffect(() => {
    onStateChange?.({ schemaCtx, changeNameHint });
  }, [schemaCtx, changeNameHint]);

  // Schema Explorer state — lazy tree (DBeaver-style), multi-server
  const [schemaExplorerOpen, setSchemaExplorerOpen] = useState(false);
  // Server list (top level)
  const [serverList, setServerList] = useState<Array<{ id: string; name: string }>>([]);
  const [serversLoading, setServersLoading] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  // Per-server schemas (keyed by serverId)
  const [schemasByServer, setSchemasByServer] = useState<Record<string, string[] | null>>({});
  const [schemasErrorByServer, setSchemasErrorByServer] = useState<Record<string, string>>({});
  const [schemasLoadingServers, setSchemasLoadingServers] = useState<Set<string>>(new Set());
  // Per-server+schema objects (keyed by `${serverId}:${schema}`)
  const [objectsByKey, setObjectsByKey] = useState<Record<string, { tables: string[]; views: string[]; functions: string[]; sequences: string[] }>>({});
  const [objectsLoadingKeys, setObjectsLoadingKeys] = useState<Set<string>>(new Set());
  // Per-server+schema+table columns (keyed by `${serverId}:${schema}.${table}`)
  const [columnsByKey, setColumnsByKey] = useState<Record<string, Array<{ name: string; type: string; nullable?: boolean; default_value?: string }>>>({});
  const [columnsLoadingKeys, setColumnsLoadingKeys] = useState<Set<string>>(new Set());
  // Expanded nodes (all keyed with serverId prefix)
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  // Whether at least one database-category MCP server is configured
  const [hasDbMcp, setHasDbMcp] = useState(false);
  // Custom suggestion chips (D5.4)
  const [chips, setChips] = useState<typeof DMCR_CHIPS>(DMCR_CHIPS);
  // Conversation history browser (D5.1)
  const [historyOpen, setHistoryOpen] = useState(false);
  type ConvSession = { conversation_id: string; first_change: string; change_count: number; first_at: string; last_at: string };
  const [historySessions, setHistorySessions] = useState<ConvSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDetail, setHistoryDetail] = useState<{ conversationId: string; entries: { change_name: string; deploy_sql: string; created_at: string }[] } | null>(null);
  // Conversation message count badge (D5.3)
  const [msgCount, setMsgCount] = useState(() => {
    try {
      const raw = sessionStorage.getItem('dmcr_conv_history');
      return raw ? (JSON.parse(raw) as unknown[]).length : 0;
    } catch { return 0; }
  });

  // Install fetch + EventSource bridges once, before any render triggers a fetch
  if (!bridgeInstalledRef.current) {
    bridgeInstalledRef.current = true;
    installVsCodeBridges();
  }

  // Signal session start so audit timeline is scoped to this session
  useEffect(() => {
    getVsCodeApi().postMessage({ type: 'conversationSessionStart' });
    getVsCodeApi().postMessage({ type: 'getDbMcpStatus' });
    getVsCodeApi().postMessage({ type: 'getConvChips' });
  }, []);

  // Listen for MCP schema data (lazy tree messages)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'dbMcpStatus') {
        setHasDbMcp(!!msg.payload?.hasDbMcp);
      }
      if (msg?.type === 'convChips' && msg.payload) {
        setChips(msg.payload);
      }
      if (msg?.type === 'conversationHistory') {
        setHistoryLoading(false);
        setHistorySessions(msg.payload?.sessions ?? []);
      }
      if (msg?.type === 'conversationSessionDetail') {
        setHistoryDetail({ conversationId: msg.payload?.conversationId, entries: msg.payload?.entries ?? [] });
      }
      if (msg?.type === 'reply') {
        try {
          const raw = sessionStorage.getItem('dmcr_conv_history');
          setMsgCount(raw ? (JSON.parse(raw) as unknown[]).length : 0);
        } catch { /* ignore */ }
      }
      if (msg?.type === 'dbMcpServers') {
        setServersLoading(false);
        const servers = (msg.payload?.servers as Array<{ id: string; name: string }>) ?? [];
        setServerList(servers);
        // Auto-expand + load schemas if only one server
        if (servers.length === 1) {
          const sid = servers[0].id;
          setExpandedServers(new Set([sid]));
          setSchemasLoadingServers(prev => { const n = new Set(prev); n.add(sid); return n; });
          getVsCodeApi().postMessage({ type: 'discoverMcpSchemas', payload: { serverId: sid } });
        }
      }
      if (msg?.type === 'mcpSchemas') {
        const sid = (msg.payload?.serverId as string | undefined) ?? '';
        setSchemasLoadingServers(prev => { const n = new Set(prev); n.delete(sid); return n; });
        if (msg.payload?.connected) {
          setSchemasByServer(prev => ({ ...prev, [sid]: msg.payload.schemas as string[] }));
          setSchemasErrorByServer(prev => { const n = { ...prev }; delete n[sid]; return n; });
        } else {
          setSchemasErrorByServer(prev => ({ ...prev, [sid]: msg.payload?.error || 'MCP server not connected' }));
          setSchemasByServer(prev => ({ ...prev, [sid]: null }));
        }
      }
      if (msg?.type === 'mcpObjects') {
        const { schema, serverId: objSid, objects, error: err } = msg.payload as { schema: string; serverId?: string; objects: { tables: string[]; views: string[]; functions: string[]; sequences: string[] } | null; error?: string };
        const key = `${objSid ?? ''}:${schema}`;
        setObjectsLoadingKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
        if (objects && !err) {
          setObjectsByKey(prev => ({ ...prev, [key]: objects }));
        }
      }
      if (msg?.type === 'mcpTableDesc') {
        const { schema, table, serverId: tSid, columns, error: err } = msg.payload as { schema: string; table: string; serverId?: string; columns: Array<{ name: string; type: string; nullable?: boolean; default_value?: string }> | null; error?: string };
        const key = `${tSid ?? ''}:${schema}.${table}`;
        setColumnsLoadingKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
        if (columns && !err) {
          setColumnsByKey(prev => ({ ...prev, [key]: columns }));
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleDiscoverSchemas = useCallback(() => {
    if (schemaExplorerOpen) {
      setSchemaExplorerOpen(false);
      return;
    }
    setSchemaExplorerOpen(true);
    if (serverList.length === 0) {
      setServersLoading(true);
      getVsCodeApi().postMessage({ type: 'getDbMcpServers' });
    }
  }, [schemaExplorerOpen, serverList]);

  // Expand/collapse a server — lazy-load its schemas on first expand
  const toggleServerExpand = useCallback((sid: string) => {
    setExpandedServers(prev => {
      const next = new Set(prev);
      if (next.has(sid)) {
        next.delete(sid);
      } else {
        next.add(sid);
        if (!schemasByServer[sid] && !schemasLoadingServers.has(sid)) {
          setSchemasLoadingServers(p => { const n = new Set(p); n.add(sid); return n; });
          getVsCodeApi().postMessage({ type: 'discoverMcpSchemas', payload: { serverId: sid } });
        }
      }
      return next;
    });
  }, [schemasByServer, schemasLoadingServers]);

  // Expand/collapse a schema — lazy-load objects on first expand
  const toggleSchemaExpand = useCallback((sid: string, schema: string) => {
    const sKey = `${sid}:${schema}`;
    setExpandedSchemas(prev => {
      const next = new Set(prev);
      if (next.has(sKey)) {
        next.delete(sKey);
      } else {
        next.add(sKey);
        if (!objectsByKey[sKey] && !objectsLoadingKeys.has(sKey)) {
          setObjectsLoadingKeys(p => { const n = new Set(p); n.add(sKey); return n; });
          getVsCodeApi().postMessage({ type: 'discoverMcpObjects', payload: { schema, serverId: sid } });
        }
      }
      return next;
    });
  }, [objectsByKey, objectsLoadingKeys]);

  // Expand/collapse a group (Tables, Views, etc.)
  const toggleGroupExpand = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // Expand/collapse a table — lazy-load columns on first expand
  const toggleTableExpand = useCallback((sid: string, schema: string, table: string) => {
    const key = `${sid}:${schema}.${table}`;
    setExpandedTables(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        if (!columnsByKey[key] && !columnsLoadingKeys.has(key)) {
          setColumnsLoadingKeys(p => { const n = new Set(p); n.add(key); return n; });
          getVsCodeApi().postMessage({ type: 'describeMcpTable', payload: { schema, table, serverId: sid } });
        }
      }
      return next;
    });
  }, [columnsByKey, columnsLoadingKeys]);

  // Sync external theme to ConvEngineChat's data-ce-theme attribute
  useEffect(() => {
    const root = chatRootRef.current?.querySelector('.ce-chat-root');
    if (root) root.setAttribute('data-ce-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  const enrichment = (schemaCtx.trim() || changeNameHint.trim())
    ? { mode: 'json', props: { ...(schemaCtx.trim() ? { schemaCtx: schemaCtx.trim() } : {}), ...(changeNameHint.trim() ? { changeNameHint: changeNameHint.trim() } : {}) } }
    : undefined;

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* Schema + Change Name Hint context bar */}
      <div className="dmcr-ctx-bar">
        {hasDbMcp && (
          <button
            className="dmcr-ctx-bar__db-btn"
            onClick={handleDiscoverSchemas}
            title="Discover schemas & tables from MCP"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
          </button>
        )}
        <label htmlFor="dmcr-schema-ctx" className="dmcr-ctx-bar__label" style={{ marginLeft: 10 }}>Schema</label>
        {availableSchemas.length > 0 ? (
          <StyledDropdown
            items={availableSchemas.map(s => ({ value: s, label: s }))}
            value={schemaCtx}
            onChange={setSchemaCtx}
            className="dmcr-ctx-bar__dropdown"
          />
        ) : (
          <input
            id="dmcr-schema-ctx"
            className="dmcr-ctx-bar__input"
            style={{ flex: '0 1 140px', minWidth: 80 }}
            placeholder="e.g. public, zp_st"
            value={schemaCtx}
            onChange={e => setSchemaCtx(e.target.value)}
          />
        )}
        <div className="dmcr-ctx-bar__spacer" />
        <label htmlFor="dmcr-change-hint" className="dmcr-ctx-bar__label">Change Name Hint</label>
        <input
          id="dmcr-change-hint"
          className="dmcr-ctx-bar__input"
          style={{ flex: '0 1 200px', minWidth: 120 }}
          placeholder="e.g. add_threshold_level_cols"
          value={changeNameHint}
          onChange={e => setChangeNameHint(e.target.value)}
        />
        <button
          className="dmcr-ctx-bar__db-btn"
          onClick={() => {
            try {
              const raw = sessionStorage.getItem('dmcr_conv_history');
              const history: Array<{ role: string; content: string }> = raw ? JSON.parse(raw) : [];
              if (history.length === 0) return;
              const md = history.map(h => {
                const role = h.role === 'user' ? '**You**' : '**DMCR Assistant**';
                let content = h.content;
                try {
                  const parsed = JSON.parse(content);
                  if (parsed?.rawText) content = parsed.rawText;
                  else if (parsed?.message) content = parsed.message;
                } catch { /* leave as-is */ }
                return `${role}\n\n${content}`;
              }).join('\n\n---\n\n');
              const content = `# DMCR Conversation Export\n\n${md}\n`;
              const filename = `dmcr-conversation-${new Date().toISOString().slice(0, 10)}.md`;
              getVsCodeApi().postMessage({ type: 'saveTextFile', payload: { content, filename } });
            } catch { /* ignore */ }
          }}
          title="Export conversation as Markdown"
          style={{ marginLeft: 6 }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
        {msgCount > 0 && (
          <span
            title={`${msgCount} messages in context`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 6,
              fontSize: 10, padding: '2px 6px', borderRadius: 999,
              background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)',
              color: '#818cf8', fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap',
            }}
          >
            {msgCount} msg{msgCount !== 1 ? 's' : ''}
          </span>
        )}
        {/* History button (D5.1) */}
        <button
          className="dmcr-ctx-bar__db-btn"
          onClick={() => {
            setHistoryOpen(true);
            setHistoryLoading(true);
            setHistoryDetail(null);
            getVsCodeApi().postMessage({ type: 'getConversationHistory' });
          }}
          title="Browse conversation history"
          style={{ marginLeft: 4 }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
        </button>
      </div>

      {/* Schema Explorer flyout — lazy DBeaver-style tree (only if database MCP configured) */}
      {hasDbMcp && schemaExplorerOpen && (
        <div className="dmcr-schema-explorer">
          <div className="dmcr-schema-explorer__header">
            <span className="dmcr-schema-explorer__title">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
              </svg>
              MCP Schema Explorer
            </span>
            <button className="dmcr-schema-explorer__close" onClick={() => setSchemaExplorerOpen(false)} title="Close">×</button>
          </div>
          {serversLoading && (
            <div className="dmcr-schema-explorer__loading">
              <div className="prompt-lib-loading-spinner" style={{ width: 14, height: 14 }} />
              Loading database servers…
            </div>
          )}
          {!serversLoading && serverList.length === 0 && (
            <div className="dmcr-schema-explorer__empty">No database MCP servers configured. Add one in Settings → MCP.</div>
          )}
          {serverList.length > 0 && (
            <div className="dmcr-schema-explorer__list">
              {serverList.map(srv => {
                const srvOpen = expandedServers.has(srv.id);
                const schemas = schemasByServer[srv.id];
                const schemasLoading = schemasLoadingServers.has(srv.id);
                const schemasError = schemasErrorByServer[srv.id];
                return (
                  <div key={srv.id} className="dmcr-schema-explorer__schema">
                    {/* ── Server row ── */}
                    <button className="dmcr-schema-explorer__schema-btn" onClick={() => toggleServerExpand(srv.id)}>
                      <svg className={`dmcr-schema-explorer__chevron${srvOpen ? '' : ' collapsed'}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                      </svg>
                      <span className="dmcr-schema-explorer__schema-name">{srv.name}</span>
                    </button>

                    {srvOpen && (
                      <div className="dmcr-schema-explorer__objects">
                        {schemasLoading && (
                          <div className="dmcr-schema-explorer__loading" style={{ padding: '4px 8px' }}>
                            <div className="prompt-lib-loading-spinner" style={{ width: 12, height: 12 }} /> Discovering schemas…
                          </div>
                        )}
                        {schemasError && !schemasLoading && (
                          <div className="dmcr-schema-explorer__error" style={{ padding: '4px 8px', fontSize: 11 }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                            {schemasError}
                          </div>
                        )}
                        {schemas && !schemasLoading && schemas.map(schema => {
                          const sKey = `${srv.id}:${schema}`;
                          const isOpen = expandedSchemas.has(sKey);
                          const objects = objectsByKey[sKey];
                          const loadingObj = objectsLoadingKeys.has(sKey);
                          return (
                            <div key={schema} className="dmcr-schema-explorer__schema">
                              {/* ── Schema row ── */}
                              <button className="dmcr-schema-explorer__schema-btn" onClick={() => { toggleSchemaExpand(srv.id, schema); setSchemaCtx(schema); }}>
                                <svg className={`dmcr-schema-explorer__chevron${isOpen ? '' : ' collapsed'}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="6 9 12 15 18 9"/>
                                </svg>
                                <span className="dmcr-schema-explorer__obj-icon" style={{ color: '#f59e0b', fontSize: 11 }}>S</span>
                                <span className="dmcr-schema-explorer__schema-name">{schema}</span>
                                {objects && <span className="dmcr-schema-explorer__count">{objects.tables.length + objects.views.length + objects.functions.length + objects.sequences.length}</span>}
                              </button>

                              {isOpen && (
                                <div className="dmcr-schema-explorer__objects">
                                  {loadingObj && (
                                    <div className="dmcr-schema-explorer__loading" style={{ padding: '4px 8px' }}>
                                      <div className="prompt-lib-loading-spinner" style={{ width: 12, height: 12 }} /> Loading…
                                    </div>
                                  )}
                                  {objects && (
                                    <>
                                      {/* Tables group */}
                                      {objects.tables.length > 0 && (() => {
                                        const gKey = `${sKey}::tables`;
                                        const gOpen = expandedGroups.has(gKey);
                                        return (
                                          <div className="dmcr-schema-explorer__group">
                                            <button className="dmcr-schema-explorer__schema-btn" style={{ paddingLeft: 4, fontSize: 11 }} onClick={() => toggleGroupExpand(gKey)}>
                                              <svg className={`dmcr-schema-explorer__chevron${gOpen ? '' : ' collapsed'}`} width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                                              <span className="dmcr-schema-explorer__group-label" style={{ padding: 0 }}>Tables ({objects.tables.length})</span>
                                            </button>
                                            {gOpen && objects.tables.map(t => {
                                              const tKey = `${srv.id}:${schema}.${t}`;
                                              const tOpen = expandedTables.has(tKey);
                                              const cols = columnsByKey[tKey];
                                              const loadingCols = columnsLoadingKeys.has(tKey);
                                              return (
                                                <div key={t}>
                                                  <div className="dmcr-schema-explorer__obj" onClick={() => toggleTableExpand(srv.id, schema, t)}>
                                                    <svg className={`dmcr-schema-explorer__chevron${tOpen ? '' : ' collapsed'}`} width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                                                    <span className="dmcr-schema-explorer__obj-icon" style={{ color: '#6366f1' }}>T</span>
                                                    {t}
                                                  </div>
                                                  {tOpen && (
                                                    <div style={{ paddingLeft: 24 }}>
                                                      {loadingCols && (
                                                        <div className="dmcr-schema-explorer__loading" style={{ padding: '2px 4px', fontSize: 10 }}>
                                                          <div className="prompt-lib-loading-spinner" style={{ width: 10, height: 10 }} /> Loading columns…
                                                        </div>
                                                      )}
                                                      {cols && cols.map(c => (
                                                        <div key={c.name} className="dmcr-schema-explorer__obj" style={{ cursor: 'default', fontSize: 10, gap: 4, opacity: 0.85 }}>
                                                          <span className="dmcr-schema-explorer__obj-icon" style={{ color: '#94a3b8', fontSize: 8 }}>●</span>
                                                          <span style={{ fontWeight: 600 }}>{c.name}</span>
                                                          <span style={{ color: '#64748b', marginLeft: 2 }}>{c.type}{c.nullable === false ? ' NOT NULL' : ''}</span>
                                                        </div>
                                                      ))}
                                                      {cols && cols.length === 0 && <div style={{ fontSize: 10, color: '#64748b', padding: '2px 8px' }}>No columns</div>}
                                                    </div>
                                                  )}
                                                </div>
                                              );
                                            })}
                                          </div>
                                        );
                                      })()}
                                      {/* Views group */}
                                      {objects.views.length > 0 && (() => {
                                        const gKey = `${sKey}::views`;
                                        const gOpen = expandedGroups.has(gKey);
                                        return (
                                          <div className="dmcr-schema-explorer__group">
                                            <button className="dmcr-schema-explorer__schema-btn" style={{ paddingLeft: 4, fontSize: 11 }} onClick={() => toggleGroupExpand(gKey)}>
                                              <svg className={`dmcr-schema-explorer__chevron${gOpen ? '' : ' collapsed'}`} width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                                              <span className="dmcr-schema-explorer__group-label" style={{ padding: 0 }}>Views ({objects.views.length})</span>
                                            </button>
                                            {gOpen && objects.views.map(v => (
                                              <div key={v} className="dmcr-schema-explorer__obj">
                                                <span className="dmcr-schema-explorer__obj-icon" style={{ color: '#22c55e' }}>V</span>
                                                {v}
                                              </div>
                                            ))}
                                          </div>
                                        );
                                      })()}
                                      {/* Functions group */}
                                      {objects.functions.length > 0 && (() => {
                                        const gKey = `${sKey}::functions`;
                                        const gOpen = expandedGroups.has(gKey);
                                        return (
                                          <div className="dmcr-schema-explorer__group">
                                            <button className="dmcr-schema-explorer__schema-btn" style={{ paddingLeft: 4, fontSize: 11 }} onClick={() => toggleGroupExpand(gKey)}>
                                              <svg className={`dmcr-schema-explorer__chevron${gOpen ? '' : ' collapsed'}`} width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                                              <span className="dmcr-schema-explorer__group-label" style={{ padding: 0 }}>Functions ({objects.functions.length})</span>
                                            </button>
                                            {gOpen && objects.functions.map(f => (
                                              <div key={f} className="dmcr-schema-explorer__obj">
                                                <span className="dmcr-schema-explorer__obj-icon" style={{ color: '#f59e0b' }}>ƒ</span>
                                                {f}
                                              </div>
                                            ))}
                                          </div>
                                        );
                                      })()}
                                      {/* Sequences group */}
                                      {objects.sequences.length > 0 && (() => {
                                        const gKey = `${sKey}::sequences`;
                                        const gOpen = expandedGroups.has(gKey);
                                        return (
                                          <div className="dmcr-schema-explorer__group">
                                            <button className="dmcr-schema-explorer__schema-btn" style={{ paddingLeft: 4, fontSize: 11 }} onClick={() => toggleGroupExpand(gKey)}>
                                              <svg className={`dmcr-schema-explorer__chevron${gOpen ? '' : ' collapsed'}`} width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                                              <span className="dmcr-schema-explorer__group-label" style={{ padding: 0 }}>Sequences ({objects.sequences.length})</span>
                                            </button>
                                            {gOpen && objects.sequences.map(s => (
                                              <div key={s} className="dmcr-schema-explorer__obj">
                                                <span className="dmcr-schema-explorer__obj-icon" style={{ color: '#06b6d4' }}>S</span>
                                                {s}
                                              </div>
                                            ))}
                                          </div>
                                        );
                                      })()}
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {schemas && schemas.length === 0 && !schemasLoading && (
                          <div className="dmcr-schema-explorer__empty" style={{ paddingLeft: 20 }}>No schemas discovered.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Conversation History Modal (D5.1) */}
      {historyOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--vscode-sideBar-background, #1e293b)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, width: 560, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.5)' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--vscode-foreground, #e2e8f0)' }}>Conversation History</span>
              {historyDetail && (
                <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#818cf8', fontSize: 12, padding: '2px 8px' }} onClick={() => setHistoryDetail(null)}>
                  ← Back
                </button>
              )}
              <button onClick={() => { setHistoryOpen(false); setHistoryDetail(null); }} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 18, lineHeight: 1 }}>×</button>
            </div>
            {/* Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }}>
              {historyLoading && (
                <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: 12 }}>Loading…</div>
              )}
              {!historyLoading && !historyDetail && historySessions.length === 0 && (
                <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: 12 }}>No conversation history yet. Start chatting to build history.</div>
              )}
              {!historyLoading && !historyDetail && historySessions.map(s => (
                <div key={s.conversation_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'default' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--vscode-foreground, #e2e8f0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={s.first_change}>{s.first_change}</div>
                    <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2 }}>
                      {s.change_count} change{s.change_count !== 1 ? 's' : ''} ·{' '}
                      {new Date(s.last_at).toLocaleDateString()} {new Date(s.last_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace', marginTop: 2 }}>{s.conversation_id.slice(0, 18)}…</div>
                  </div>
                  <button
                    style={{ background: 'none', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 5, color: '#818cf8', fontSize: 11, padding: '3px 8px', cursor: 'pointer', flexShrink: 0 }}
                    onClick={() => {
                      getVsCodeApi().postMessage({ type: 'getConversationSessionDetail', payload: { conversationId: s.conversation_id } });
                    }}
                  >View</button>
                  <button
                    style={{ background: 'none', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 5, color: '#f87171', fontSize: 11, padding: '3px 8px', cursor: 'pointer', flexShrink: 0 }}
                    onClick={() => {
                      getVsCodeApi().postMessage({ type: 'deleteConversationSession', payload: { conversationId: s.conversation_id } });
                      setHistoryLoading(true);
                    }}
                  >Delete</button>
                </div>
              ))}
              {/* Detail view */}
              {historyDetail && (
                <div style={{ padding: '0 18px 18px' }}>
                  <p style={{ fontSize: 11, color: '#64748b', margin: '8px 0 12px' }}>
                    {historyDetail.entries.length} change{historyDetail.entries.length !== 1 ? 's' : ''} — conversation {historyDetail.conversationId.slice(0, 18)}…
                  </p>
                  {historyDetail.entries.map((e, i) => (
                    <div key={i} style={{ marginBottom: 14, background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#818cf8' }}>{e.change_name}</span>
                        <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>{new Date(e.created_at).toLocaleString()}</span>
                      </div>
                      <pre style={{ margin: 0, padding: '10px 12px', fontSize: 11, fontFamily: 'ui-monospace,monospace', color: '#94a3b8', overflowX: 'auto', maxHeight: 150, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{e.deploy_sql.slice(0, 600)}{e.deploy_sql.length > 600 ? '…' : ''}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ConvEngineChat — fullscreen */}
      <div ref={chatRootRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <ConvEngineChat
          mode="fullscreen"
          config={{
            apiHost: '',
            title: 'DMCR Assistant',
            subtitle: "Describe your database change.",
            placeholder: 'Describe your database change… (Shift+Enter for newline)',
            showFeedback: false,
            showAudit: true,
            showEngineStatus: false,
            showDarkModeLightMode: false,
            defaultDark: true,
            showNewChat: true,
            showLayoutPicker: false,
            showMaximize: false,
            showMinimize: false,
            showHeaderDot: true,
            showLandingAvatar: true,
            showLandingSubtitle: true,
            composerShape: 'round',
            messageEnrichment: enrichment,
            landingChips: chips,
            renderers: [
              dmcrHelpRendererProvider,
              dmcrChangeRendererProvider,
              dmcrErrorRendererProvider,
              dmcrMetadataFormRendererProvider,
              dmcrSchemaServerPickerRenderer,
              defaultDmcrRendererProvider,
            ],
            stream: { enabled: true, transport: 'sse' },
          } as ConvEngineChatConfig}
          theme={{ 'color-accent': '#6366f1' } as any}
        />
      </div>
    </div>
  );
}
