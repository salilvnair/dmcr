import React, { useState, useEffect } from 'react';
import { BookOpenIcon, CodeIcon, DatabaseTableIcon, SettingsIcon } from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import { McpIcon } from './icons';
import { StyledSelect } from './shared';

/* ── Types ── */
type McpTransport = 'STDIO' | 'HTTP' | 'SSE';
type McpCategory = 'database' | 'general' | 'docs' | 'code';

interface McpServer {
  id: string;
  name: string;
  description?: string;
  transport: McpTransport;
  category?: McpCategory;
  command?: string;
  args?: string | string[];
  env?: string | Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: string | Record<string, string>;
}

interface McpTool { name: string; description?: string; }

type McpForm = {
  id: string; name: string; description: string; transport: McpTransport;
  category: McpCategory; command: string; args: string; env: string; cwd: string; url: string; headers: string;
};

const MCP_EMPTY: McpForm = { id: '', name: '', description: '', transport: 'STDIO', category: 'general', command: '', args: '', env: '', cwd: '', url: '', headers: '' };

function configToForm(cfg: McpServer): McpForm {
  return {
    id: cfg.id || '',
    name: cfg.name || '',
    description: cfg.description || '',
    transport: (cfg.transport || 'STDIO') as McpTransport,
    category: (cfg.category || 'general') as McpCategory,
    command: (cfg.command as string) || '',
    args: Array.isArray(cfg.args) ? cfg.args.join('\n') : (cfg.args as string) || '',
    env: cfg.env && typeof cfg.env === 'object'
      ? Object.entries(cfg.env as Record<string,string>).map(([k,v]) => `${k}=${v}`).join('\n')
      : (cfg.env as string) || '',
    url: cfg.url || '',
    cwd: cfg.cwd || '',
    headers: cfg.headers && typeof cfg.headers === 'object'
      ? Object.entries(cfg.headers as Record<string,string>).map(([k,v]) => `${k}: ${v}`).join('\n')
      : (cfg.headers as string) || '',
  };
}

function formToConfig(form: McpForm): McpServer {
  const cfg: McpServer = { id: form.id || ('mcp_' + Date.now()), name: form.name.trim(), description: form.description.trim() || undefined, transport: form.transport, category: form.category };
  if (form.transport === 'STDIO') {
    cfg.command = form.command.trim();
    cfg.args = (form.args || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (form.cwd.trim()) cfg.cwd = form.cwd.trim();
    const env: Record<string,string> = {};
    for (const line of (form.env || '').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (Object.keys(env).length) cfg.env = env;
  } else {
    cfg.url = form.url.trim();
    const headers: Record<string,string> = {};
    for (const line of (form.headers || '').split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (Object.keys(headers).length) cfg.headers = headers;
  }
  return cfg;
}

export function McpPanel() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [toolsFor, setToolsFor] = useState<string | null>(null);
  const [toolsByServer, setToolsByServer] = useState<Record<string, McpTool[] | null>>({});
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [restartingId, setRestartingId] = useState<string | null>(null);
  const [dbValidation, setDbValidation] = useState<Record<string, { compliant: boolean; supported: string[]; missing: string[]; error?: string }>>({});
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    postMsg({ type: 'getMcpServers' });
    const handler = (e: MessageEvent) => {
      const msg = e.data as { type: string; payload?: unknown };
      if (!msg) return;
      if (msg.type === 'mcpServers') {
        const srvs = (msg.payload as McpServer[]) ?? [];
        setServers(srvs);
        setLoading(false);
        const ids = new Set(srvs.map(s => s.id));
        setConnectingIds(ids);
        for (const s of srvs) {
          postMsg({ type: 'getMcpTools', payload: { id: s.id } });
          if (s.category === 'database') {
            postMsg({ type: 'validateDbMcpServer', payload: { id: s.id, name: s.name } });
          }
        }
      }
      if (msg.type === 'mcpTools') {
        const { id, tools, error: err } = msg.payload as { id: string; tools?: McpTool[]; error?: string };
        setToolsByServer(prev => ({ ...prev, [id]: err ? null : (tools ?? []) }));
        setConnectingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      }
      if (msg.type === 'mcpRestarted') {
        const { id, tools, error: err } = msg.payload as { id: string; tools?: McpTool[]; error?: string };
        setToolsByServer(prev => ({ ...prev, [id]: err ? null : (tools ?? []) }));
        setRestartingId(null);
        setConnectingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      }
      if (msg.type === 'dbMcpValidation') {
        const v = msg.payload as { serverId: string; serverName?: string; compliant: boolean; supported: string[]; missing: string[]; error?: string };
        setDbValidation(prev => ({ ...prev, [v.serverId]: { compliant: v.compliant, supported: v.supported, missing: v.missing, error: v.error } }));
        setValidatingId(null);
        if (!v.compliant && v.error) {
          setError(v.error);
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  function refresh() {
    setLoading(true); setError(null);
    postMsg({ type: 'getMcpServers' });
  }

  async function handleSave() {
    if (!editing) return;
    if (!editing.name.trim()) { setError('Name is required.'); return; }
    if (editing.transport === 'STDIO' && !editing.command.trim()) { setError('Command is required.'); return; }
    if ((editing.transport === 'HTTP' || editing.transport === 'SSE') && !editing.url.trim()) { setError('URL is required.'); return; }
    setBusy(true);
    setError(null);
    try {
      const cfg = formToConfig(editing);
      if (editing.category === 'database') {
        setValidatingId(cfg.id);
      }
      postMsg({ type: 'upsertMcpServer', payload: cfg });
      if (editing.category !== 'database') {
        setServers(prev => editing.id
          ? prev.map(s => s.id === editing.id ? cfg : s)
          : [...prev, cfg]);
      }
      setEditing(null);
    } finally { setBusy(false); }
  }

  function handleDelete(id: string) { setPendingDelete(id); }

  function confirmDelete() {
    if (!pendingDelete) return;
    postMsg({ type: 'deleteMcpServer', payload: { id: pendingDelete } });
    setServers(prev => prev.filter(s => s.id !== pendingDelete));
    setPendingDelete(null);
  }

  async function handleShowTools(id: string) {
    if (toolsFor === id) { setToolsFor(null); return; }
    setToolsFor(id);
    if (!toolsByServer[id]) postMsg({ type: 'getMcpTools', payload: { id } });
  }

  function up<K extends keyof McpForm>(k: K, v: McpForm[K]) {
    setEditing(prev => prev ? { ...prev, [k]: v } : prev);
  }

  return (
    <div className="bs-mcp-panel">
      <div className="bs-mcp-panel-head">
        <McpIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3">MCP Servers</h3>
        <div className="bs-mcp-panel-actions">
          <button className="bs-icon-btn" onClick={refresh} disabled={loading} title="Refresh list">
            <span className={`bs-refresh-glyph${loading ? ' is-spinning' : ''}`}>&#x27F3;</span>
          </button>
          <button className="bs-btn-sm bs-btn-accent" onClick={() => { setEditing({ ...MCP_EMPTY }); setError(null); }}>
            <span>+</span><span>Add server</span>
          </button>
        </div>
      </div>

      {error && <div className="bs-mcp-error">{error}</div>}

      {servers.length === 0 && !loading && !editing && (
        <div className="bs-hint">
          No MCP servers configured yet. Click <b>Add server</b> to connect one.
          (stdio spawns a subprocess like <code>npx -y @modelcontextprotocol/server-filesystem /tmp</code>,
          HTTP hits a JSON-RPC endpoint.)
        </div>
      )}

      <ul className="bs-mcp-list">
        {servers.map(s => {
          const tools = toolsByServer[s.id];
          const isConnecting = connectingIds.has(s.id) || restartingId === s.id;
          const connStatus = isConnecting ? 'connecting' : tools === undefined ? 'unknown' : tools === null ? 'error' : 'connected';
          return (
            <li key={s.id} className="bs-mcp-row">
              <div className="bs-mcp-row-main">
                <div className="bs-mcp-row-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {connStatus === 'connecting' ? (
                    <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', border: '1.5px solid #6366f1', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} title="Connecting…" />
                  ) : connStatus === 'connected' ? (
                    <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} title={`Connected — ${(tools as McpTool[]).length} tool${(tools as McpTool[]).length !== 1 ? 's' : ''}`} />
                  ) : connStatus === 'error' ? (
                    <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} title="Server not reachable" />
                  ) : null}
                  {s.name || s.id}
                </div>
                <div className="bs-mcp-row-meta">
                  <span className="bs-mcp-badge bs-mcp-badge--transport">{(s.transport || 'STDIO').toLowerCase()}</span>
                  {s.category && s.category !== 'general' && (
                    <span className={`bs-mcp-badge bs-mcp-badge--${s.category}`}>
                      {s.category}
                    </span>
                  )}
                  {s.category === 'database' && validatingId === s.id && (
                    <span className="bs-mcp-badge bs-mcp-badge--validating">Validating…</span>
                  )}
                  {s.category === 'database' && dbValidation[s.id] && !validatingId && (
                    dbValidation[s.id].compliant ? (
                      <span className="bs-mcp-badge bs-mcp-badge--compliant">✓ Compliant</span>
                    ) : (
                      <span className="bs-mcp-badge bs-mcp-badge--noncompliant" title={`Missing: ${dbValidation[s.id].missing.join(', ')}`}>✗ Non-compliant</span>
                    )
                  )}
                  <code className="bs-mcp-row-endpoint">
                    {s.transport === 'STDIO'
                      ? `${s.command || '?'} ${Array.isArray(s.args) ? s.args.join(' ') : (s.args || '')}`
                      : s.url || '?'}
                  </code>
                </div>
              </div>
              <div className="bs-mcp-row-actions">
                <button className="bs-btn-ghost" onClick={() => handleShowTools(s.id)}>
                  {toolsFor === s.id ? 'Hide tools' : 'Tools'}
                </button>
                <button
                  className="bs-btn-ghost"
                  title="Restart server process (pick up app_mcp.yml changes)"
                  disabled={restartingId === s.id}
                  onClick={() => {
                    setRestartingId(s.id);
                    setToolsByServer(prev => ({ ...prev, [s.id]: null }));
                    postMsg({ type: 'restartMcpServer', payload: { id: s.id } });
                  }}
                >
                  {restartingId === s.id ? 'Restarting…' : 'Restart'}
                </button>
                <button className="bs-btn-ghost" onClick={() => { setEditing(configToForm(s)); setError(null); }}>Edit</button>
                <button className="bs-btn-ghost bs-danger" onClick={() => handleDelete(s.id)} title="Delete server">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
                  </svg>
                </button>
              </div>
              {toolsFor === s.id && (
                <div className="bs-mcp-tools">
                  {tools == null ? (
                    <div className="bs-hint">Loading tools…</div>
                  ) : tools.length === 0 ? (
                    <div className="bs-hint">No tools advertised (or server not reachable).</div>
                  ) : (
                    <ul className="bs-mcp-tools-list" style={{listStyle: 'none', padding: 0, margin: '8px 0 0 0'}}>
                      {tools.map(t => (
                        <li key={t.name} style={{display: 'flex', alignItems: 'center', padding: '3px 0', gap: '8px'}}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{flexShrink: 0}}>
                            <path d="M14.187 8.096L15 5.25L15.813 8.096C16.072 8.965 16.535 9.758 17.163 10.408C17.792 11.059 18.567 11.547 19.424 11.833L22.25 12.75L19.424 13.667C18.567 13.953 17.792 14.441 17.163 15.092C16.535 15.742 16.072 16.535 15.813 17.404L15 20.25L14.187 17.404C13.928 16.535 13.465 15.742 12.837 15.092C12.208 14.441 11.433 13.953 10.576 13.667L7.75 12.75L10.576 11.833C11.433 11.547 12.208 11.059 12.837 10.408C13.465 9.758 13.928 8.965 14.187 8.096Z" fill="url(#mcpToolGrad)"/>
                            <path d="M6 3L6.482 4.627C6.636 5.145 6.917 5.614 7.299 5.993C7.682 6.372 8.154 6.647 8.673 6.791L10.25 7.25L8.673 7.709C8.154 7.853 7.682 8.128 7.299 8.507C6.917 8.886 6.636 9.355 6.482 9.873L6 11.5L5.518 9.873C5.364 9.355 5.083 8.886 4.701 8.507C4.318 8.128 3.846 7.853 3.327 7.709L1.75 7.25L3.327 6.791C3.846 6.647 4.318 6.372 4.701 5.993C5.083 5.614 5.364 5.145 5.518 4.627L6 3Z" fill="url(#mcpToolGrad2)"/>
                            <defs>
                              <linearGradient id="mcpToolGrad" x1="7.75" y1="5.25" x2="22.25" y2="20.25"><stop offset="0%" stopColor="#a78bfa"/><stop offset="100%" stopColor="#38bdf8"/></linearGradient>
                              <linearGradient id="mcpToolGrad2" x1="1.75" y1="3" x2="10.25" y2="11.5"><stop offset="0%" stopColor="#c4b5fd"/><stop offset="100%" stopColor="#67e8f9"/></linearGradient>
                            </defs>
                          </svg>
                          <code style={{fontWeight: 600, whiteSpace: 'nowrap'}}>{t.name}</code>
                          {t.description && <span style={{
                            color: 'var(--vscode-descriptionForeground, #888)',
                            fontFamily: "'Segoe UI', 'Inter', 'SF Pro Text', system-ui, sans-serif",
                            fontSize: '12.5px',
                            fontStyle: 'italic',
                            letterSpacing: '0.2px',
                          }}>{t.description}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {editing && (
        <div className="bs-mcp-form">
          <div className="bs-mcp-form-title">{editing.id ? 'Edit MCP server' : 'New MCP server'}</div>

          <label className="bs-custom-provider-label">
            Name
            <input className="bs-custom-provider-input" value={editing.name}
              onChange={e => up('name', e.target.value)}
              placeholder="Filesystem (local)" />
          </label>

          <label className="bs-custom-provider-label">
            Description <span className="bs-optional-hint">(optional — used as LLM hint)</span>
            <input className="bs-custom-provider-input" value={editing.description}
              onChange={e => up('description', e.target.value)}
              placeholder="PostgreSQL schema introspection and query tools" />
          </label>

          <label className="bs-custom-provider-label">
            Transport
            <StyledSelect
              value={editing.transport}
              onChange={(v) => up('transport', v as McpTransport)}
              options={[
                { id: 'STDIO', label: 'stdio (spawn subprocess)' },
                { id: 'HTTP',  label: 'http (JSON-RPC POST)' },
                { id: 'SSE',   label: 'sse (server-sent events)' },
              ]}
            />
          </label>

          <label className="bs-custom-provider-label">
            Category <span className="bs-optional-hint">(determines which UI features are enabled)</span>
            <StyledSelect
              value={editing.category}
              onChange={(v) => up('category', v as McpCategory)}
              options={[
                { id: 'database', label: 'Database — enables Schema Explorer', icon: <DatabaseTableIcon size={13} /> },
                { id: 'general',  label: 'General — tool-calling only', icon: <SettingsIcon size={13} /> },
                { id: 'docs',     label: 'Docs — documentation retrieval', icon: <BookOpenIcon size={13} /> },
                { id: 'code',     label: 'Code — code analysis tools', icon: <CodeIcon size={13} /> },
              ]}
            />
          </label>

          {editing.transport === 'STDIO' ? (<>
            <label className="bs-custom-provider-label">
              Command
              <input className="bs-custom-provider-input" value={editing.command}
                onChange={e => up('command', e.target.value)}
                placeholder="npx" />
            </label>
            <label className="bs-custom-provider-label">
              Arguments (one per line)
              <textarea className="bs-custom-provider-textarea" rows={4} value={editing.args}
                onChange={e => up('args', e.target.value)}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'} />
            </label>
            <label className="bs-custom-provider-label">
              Environment <span className="bs-optional-hint">(KEY=value per line, optional)</span>
              <textarea className="bs-custom-provider-textarea" rows={3} value={editing.env}
                onChange={e => up('env', e.target.value)}
                placeholder="GITHUB_TOKEN=ghp_xxx" />
            </label>
            <label className="bs-custom-provider-label">
              Working Directory <span className="bs-optional-hint">(optional — for finding config files like app_mcp.yml)</span>
              <input className="bs-custom-provider-input" value={editing.cwd}
                onChange={e => up('cwd', e.target.value)}
                placeholder="C:\\path\\to\\project" />
            </label>
          </>) : (<>
            <label className="bs-custom-provider-label">
              URL
              <input className="bs-custom-provider-input" value={editing.url}
                onChange={e => up('url', e.target.value)}
                placeholder="https://example.com/mcp" />
            </label>
            <label className="bs-custom-provider-label">
              Headers <span className="bs-optional-hint">(KEY: value per line, optional)</span>
              <textarea className="bs-custom-provider-textarea" rows={3} value={editing.headers}
                onChange={e => up('headers', e.target.value)}
                placeholder="Authorization: Bearer xxx" />
            </label>
          </>)}

          <div className="bs-mcp-form-actions">
            <button className="bs-btn-sm bs-btn-secondary--danger" onClick={() => { setEditing(null); setError(null); }} disabled={busy}>Cancel</button>
            <button className="bs-btn-sm bs-btn-primary" onClick={handleSave} disabled={busy}>
              {busy ? 'Saving\u2026' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="bs-mcp-confirm-overlay">
          <div className="bs-mcp-confirm">
            <div className="bs-mcp-form-title">Delete MCP server?</div>
            <p>This server and its configuration will be removed. This cannot be undone.</p>
            <div className="bs-mcp-form-actions">
              <button className="bs-btn-sm bs-btn-secondary" onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="bs-btn-sm bs-btn-danger" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
