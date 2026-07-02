import { useState, useEffect, useCallback, useRef } from 'react';
import { Tree, NodeRendererProps } from 'react-arborist';
import { ModalView, MarkdownView } from '@salilvnair/dui';
import { getVsCodeApi } from '../vscode';
import './SchemaExplorerPage.css';

/**
 * Full-page Schema Explorer — production-quality tree view using react-arborist.
 * Shows: MCP Server → Schema → Object Groups (Tables/Views/Functions/Sequences) → Objects → Columns
 */

// ─── Node types ──────────────────────────────────────────────────────────────

type NodeType = 'server' | 'schema' | 'group' | 'table' | 'view' | 'function' | 'sequence' | 'column';

interface TreeNode {
  id: string;
  name: string;
  nodeType: NodeType;
  children?: TreeNode[] | null; // null = not-yet-loaded (async placeholder)
  meta?: Record<string, string>; // column type info etc.
}

// ─── Context Menu State ──────────────────────────────────────────────────────

interface ContextMenu {
  x: number;
  y: number;
  node: TreeNode;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SchemaExplorerPage() {
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(500);
  // D18.3 — AI Schema Documenter
  const [docProgress, setDocProgress] = useState<string | null>(null);
  const [docMarkdown, setDocMarkdown] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [docSchema, setDocSchema] = useState<string | null>(null);

  // Track loaded state per node to avoid duplicate requests
  const loadedRef = useRef<Set<string>>(new Set());

  // ── Initial load: get database MCP servers
  useEffect(() => {
    getVsCodeApi().postMessage({ type: 'getDbMcpServers' });
  }, []);

  // ── Resize observer for container height
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Listen for messages
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;

      if (msg?.type === 'deadColumnProgress') {
        setDeadColProgress(msg.payload?.text ?? null);
        setDeadColFindings(null);
        setDeadColError(null);
      }
      if (msg?.type === 'deadColumnResult') {
        setDeadColProgress(null);
        if (msg.payload?.error) {
          setDeadColError(msg.payload.error);
        } else {
          setDeadColFindings(msg.payload?.findings ?? []);
        }
      }

      if (msg?.type === 'schemaDocProgress') {
        setDocProgress(msg.payload?.text ?? null);
        setDocMarkdown(null);
        setDocError(null);
      }
      if (msg?.type === 'schemaDocResult') {
        setDocProgress(null);
        if (msg.payload?.error) {
          setDocError(msg.payload.error);
        } else {
          setDocMarkdown(msg.payload?.markdown ?? '');
        }
      }

      // Server list response
      if (msg?.type === 'dbMcpServers') {
        const servers = msg.payload?.servers as Array<{ id: string; name: string }> ?? [];
        if (servers.length === 0) {
          setLoading(false);
          setError('No database MCP servers configured. Add one in Settings → MCP Servers.');
          return;
        }
        const nodes: TreeNode[] = servers.map(s => ({
          id: `server:${s.id}`,
          name: s.name,
          nodeType: 'server' as const,
          children: null, // lazy — loaded when expanded
        }));
        setTreeData(nodes);
        setLoading(false);
        // Auto-expand if only one server
        if (servers.length === 1) {
          loadedRef.current.add(`server:${servers[0].id}`);
          getVsCodeApi().postMessage({ type: 'discoverMcpSchemas', payload: { serverId: servers[0].id } });
        }
      }

      // Schemas response — scoped to a specific server
      if (msg?.type === 'mcpSchemas') {
        const sid = msg.payload?.serverId as string | undefined;
        if (msg.payload?.connected) {
          const schemas = msg.payload.schemas as string[];
          setTreeData(prev => prev.map(server => {
            // If serverId present, only update that server; otherwise update first server node
            if (server.nodeType === 'server' && (sid ? server.id === `server:${sid}` : true)) {
              return {
                ...server,
                children: schemas.map(s => ({
                  id: `schema:${server.id}:${s}`,
                  name: s,
                  nodeType: 'schema' as const,
                  children: null,
                })),
              };
            }
            return server;
          }));
        } else {
          setError(msg.payload?.error || 'Failed to connect to MCP server');
        }
      }

      // Objects response — scoped by serverId + schema
      if (msg?.type === 'mcpObjects') {
        const { schema, serverId: objSid, objects, error: err } = msg.payload as {
          schema: string;
          serverId?: string;
          objects: { tables: string[]; views: string[]; functions: string[]; sequences: string[] } | null;
          error?: string;
        };
        if (err || !objects) return;

        setTreeData(prev => deepUpdateNode(prev, (node) => {
          // Match schema node: must match schema name AND belong to correct server (if objSid provided)
          if (node.nodeType === 'schema' && node.name === schema && (!objSid || node.id.includes(`server:${objSid}`))) {
            const groups: TreeNode[] = [];
            if (objects.tables.length > 0) {
              groups.push({
                id: `group:${node.id}:tables`,
                name: `Tables (${objects.tables.length})`,
                nodeType: 'group',
                children: objects.tables.map(t => ({
                  id: `table:${node.id}:${t}`,
                  name: t,
                  nodeType: 'table',
                  children: null,
                })),
              });
            }
            if (objects.views.length > 0) {
              groups.push({
                id: `group:${node.id}:views`,
                name: `Views (${objects.views.length})`,
                nodeType: 'group',
                children: objects.views.map(v => ({
                  id: `view:${node.id}:${v}`,
                  name: v,
                  nodeType: 'view',
                  children: [],
                })),
              });
            }
            if (objects.functions.length > 0) {
              groups.push({
                id: `group:${node.id}:functions`,
                name: `Functions (${objects.functions.length})`,
                nodeType: 'group',
                children: objects.functions.map(f => ({
                  id: `fn:${node.id}:${f}`,
                  name: f,
                  nodeType: 'function',
                  children: [],
                })),
              });
            }
            if (objects.sequences.length > 0) {
              groups.push({
                id: `group:${node.id}:sequences`,
                name: `Sequences (${objects.sequences.length})`,
                nodeType: 'group',
                children: objects.sequences.map(s => ({
                  id: `seq:${node.id}:${s}`,
                  name: s,
                  nodeType: 'sequence',
                  children: [],
                })),
              });
            }
            return { ...node, children: groups };
          }
          return null;
        }));
      }

      // Table description response
      if (msg?.type === 'mcpTableDesc') {
        const { schema, table, columns, error: err } = msg.payload as {
          schema: string;
          table: string;
          columns: Array<{ name: string; type: string; nullable?: boolean; default_value?: string }> | null;
          error?: string;
        };
        if (err || !columns) return;

        setTreeData(prev => deepUpdateNode(prev, (node) => {
          if (node.nodeType === 'table' && node.name === table && node.id.includes(schema)) {
            return {
              ...node,
              children: columns.map(c => ({
                id: `col:${node.id}:${c.name}`,
                name: c.name,
                nodeType: 'column' as const,
                meta: {
                  type: c.type,
                  nullable: c.nullable === false ? 'NOT NULL' : '',
                  default: c.default_value || '',
                },
              })),
            };
          }
          return null;
        }));
      }
      // Refresh command from extension host
      if (msg?.type === 'schemaExplorerRefresh') {
        loadedRef.current.clear();
        setTreeData([]);
        setLoading(true);
        setError(null);
        getVsCodeApi().postMessage({ type: 'getDbMcpServers' });
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── Handle node toggle (expand) — lazy loading
  const handleToggle = useCallback((id: string) => {
    if (loadedRef.current.has(id)) return;

    // Find the node in tree
    const node = findNode(treeData, id);
    if (!node) return;

    loadedRef.current.add(id);

    if (node.nodeType === 'server') {
      // Extract raw server ID from node.id (format: "server:<id>")
      const rawId = node.id.replace(/^server:/, '');
      getVsCodeApi().postMessage({ type: 'discoverMcpSchemas', payload: { serverId: rawId } });
    } else if (node.nodeType === 'schema') {
      // Extract serverId from parent path in the ID (format: "schema:server:<id>:<schemaName>")
      const serverIdFromSchema = extractServerIdFromNodeId(node.id);
      getVsCodeApi().postMessage({ type: 'discoverMcpObjects', payload: { schema: node.name, serverId: serverIdFromSchema } });
    } else if (node.nodeType === 'table') {
      const schemaName = extractSchemaFromId(node.id);
      const serverIdFromTable = extractServerIdFromNodeId(node.id);
      if (schemaName) {
        getVsCodeApi().postMessage({ type: 'describeMcpTable', payload: { schema: schemaName, table: node.name, serverId: serverIdFromTable } });
      }
    }
  }, [treeData]);

  const handleRefresh = () => {
    loadedRef.current.clear();
    setTreeData([]);
    setError(null);
    setLoading(true);
    getVsCodeApi().postMessage({ type: 'getDbMcpServers' });
  };

  // D18.3 — document schema
  const documentSchema = useCallback((node: TreeNode) => {
    const match = node.id.match(/^schema:server:([^:]+):(.+)$/);
    const serverId = match?.[1] ?? '';
    const schema = node.name;
    setDocSchema(schema);
    setDocMarkdown(null);
    setDocError(null);
    setDocProgress('Starting…');
    setCtxMenu(null);
    getVsCodeApi().postMessage({ type: 'documentSchema', payload: { serverId, schema } });
  }, []);

  // D18.7 — detect dead columns
  const [deadColProgress, setDeadColProgress] = useState<string | null>(null);
  const [deadColFindings, setDeadColFindings] = useState<Array<{ table: string; column: string; confidence: string; reason: string }> | null>(null);
  const [deadColError, setDeadColError] = useState<string | null>(null);
  const [deadColSchema, setDeadColSchema] = useState<string | null>(null);
  const [showDeadColPopup, setShowDeadColPopup] = useState(false);
  const [showDocPopup, setShowDocPopup] = useState(false);

  useEffect(() => { if (deadColFindings !== null || deadColError) setShowDeadColPopup(true); }, [deadColFindings, deadColError]);
  useEffect(() => { if (docMarkdown || docError) setShowDocPopup(true); }, [docMarkdown, docError]);

  const detectDeadColumns = useCallback((node: TreeNode) => {
    const match = node.id.match(/^schema:server:([^:]+):(.+)$/);
    const serverId = match?.[1] ?? '';
    const schema = node.name;
    setDeadColSchema(schema);
    setDeadColFindings(null);
    setDeadColError(null);
    setDeadColProgress('Starting…');
    setCtxMenu(null);
    getVsCodeApi().postMessage({ type: 'detectDeadColumns', payload: { serverId, schema } });
  }, []);

  // ── Context menu actions
  const handleContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    if (['table', 'view', 'function', 'sequence', 'column', 'schema'].includes(node.nodeType)) {
      setCtxMenu({ x: e.clientX, y: e.clientY, node });
    }
  }, []);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const copyName = useCallback(() => {
    if (ctxMenu) {
      navigator.clipboard.writeText(ctxMenu.node.name);
      setCtxMenu(null);
    }
  }, [ctxMenu]);

  const copyDefinition = useCallback(() => {
    if (ctxMenu) {
      const node = ctxMenu.node;
      const schema = extractSchemaFromId(node.id);
      const serverId = extractServerIdFromNodeId(node.id);
      getVsCodeApi().postMessage({
        type: 'getObjectDefinition',
        payload: { schema, name: node.name, nodeType: node.nodeType, serverId },
      });
      setCtxMenu(null);
    }
  }, [ctxMenu]);

  const openInsertForm = useCallback(() => {
    if (ctxMenu) {
      const schema = extractSchemaFromId(ctxMenu.node.id);
      const colNodes = (ctxMenu.node.children ?? []).filter(c => c.nodeType === 'column');
      const columns = colNodes.length > 0 ? colNodes.map(c => ({ name: c.name, type: c.meta?.type ?? 'text' })) : undefined;
      getVsCodeApi().postMessage({
        type: 'openFormWithPrefill',
        payload: { form: 'insert', table: ctxMenu.node.name, schema, ...(columns ? { columns } : {}) },
      });
      setCtxMenu(null);
    }
  }, [ctxMenu]);

  const openDdlForm = useCallback(() => {
    if (ctxMenu) {
      const schema = extractSchemaFromId(ctxMenu.node.id);
      const colNodes = (ctxMenu.node.children ?? []).filter(c => c.nodeType === 'column');
      const columns = colNodes.length > 0 ? colNodes.map(c => ({ name: c.name, type: c.meta?.type ?? 'text' })) : undefined;
      getVsCodeApi().postMessage({
        type: 'openFormWithPrefill',
        payload: { form: 'ddl', table: ctxMenu.node.name, schema, ...(columns ? { columns } : {}) },
      });
      setCtxMenu(null);
    }
  }, [ctxMenu]);

  // Close context menu on click elsewhere
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  return (
    <div className="schema-page">
      {/* Header */}
      <div className="schema-page__header">
        <div className="schema-page__title-row">
          <svg className="schema-page__title-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
          <h2 className="schema-page__title">Schema Explorer</h2>
          <button className="schema-page__refresh" onClick={handleRefresh} title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
        <input
          className="schema-page__filter"
          type="text"
          placeholder="Search tables, views, columns..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      {/* Body */}
      <div className="schema-page__body" ref={containerRef}>
        {loading && (
          <div className="schema-page__status">
            <div className="schema-page__spinner" />
            Discovering database servers…
          </div>
        )}
        {error && !loading && (
          <div className="schema-page__status schema-page__status--error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
            {error}
          </div>
        )}
        {!loading && !error && treeData.length > 0 && (
          <Tree<TreeNode>
            data={treeData}
            width="100%"
            height={containerHeight}
            rowHeight={30}
            indent={18}
            openByDefault={false}
            disableDrag={true}
            disableDrop={true}
            disableEdit={true}
            disableMultiSelection={true}
            searchTerm={filter}
            searchMatch={(node, term) => node.data.name.toLowerCase().includes(term.toLowerCase())}
            onToggle={handleToggle}
            idAccessor="id"
            childrenAccessor={(d) => d.children ?? null}
          >
            {(props) => <NodeRow {...props} onContextMenu={handleContextMenu} />}
          </Tree>
        )}
      </div>

      {/* Context Menu */}
      {ctxMenu && (
        <div className="schema-ctx-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }} onClick={closeCtxMenu}>
          <button className="schema-ctx-menu__item" onClick={copyName}>📋 Copy Name</button>
          {['table', 'view', 'function', 'sequence'].includes(ctxMenu.node.nodeType) && (
            <button className="schema-ctx-menu__item" onClick={copyDefinition}>📄 Copy DDL</button>
          )}
          {ctxMenu.node.nodeType === 'schema' && (
            <>
              <button className="schema-ctx-menu__item" onClick={() => documentSchema(ctxMenu.node)}>✦ Document Schema</button>
              <button className="schema-ctx-menu__item" onClick={() => detectDeadColumns(ctxMenu.node)}>🔍 Detect Dead Columns</button>
            </>
          )}
          {ctxMenu.node.nodeType === 'table' && (
            <>
              <div className="schema-ctx-menu__divider" />
              <button className="schema-ctx-menu__item" onClick={openInsertForm}>📥 Generate INSERT rows</button>
              <button className="schema-ctx-menu__item" onClick={openDdlForm}>🔧 Generate ALTER TABLE</button>
            </>
          )}
        </div>
      )}

      {/* Dead Column Detector progress indicator */}
      {deadColProgress && !showDeadColPopup && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '8px 14px', background: 'rgba(251,191,36,0.08)', borderTop: '1px solid rgba(251,191,36,0.2)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#fbbf24', zIndex: 49 }}>
          <span style={{ display: 'inline-block', width: 10, height: 10, border: '2px solid transparent', borderTopColor: '#fbbf24', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          {deadColProgress}
        </div>
      )}

      {/* Schema Documenter progress indicator */}
      {docProgress && !showDocPopup && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '8px 14px', background: 'rgba(99,102,241,0.08)', borderTop: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#818cf8', zIndex: 50 }}>
          <span style={{ display: 'inline-block', width: 10, height: 10, border: '2px solid transparent', borderTopColor: '#818cf8', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          {docProgress}
        </div>
      )}

      {/* Dead Column Detector popup */}
      <ModalView
        open={showDeadColPopup}
        onClose={() => setShowDeadColPopup(false)}
        title={`Dead Column Detector${deadColSchema ? ` — ${deadColSchema}` : ''}`}
        headerColor="#fbbf24"
        size="lg"
      >
        <div style={{ fontSize: 11.5 }}>
          {deadColError && <div style={{ color: '#f87171', marginBottom: 8 }}>✗ {deadColError}</div>}
          {deadColFindings !== null && deadColFindings.length === 0 && <div style={{ color: '#4ade80' }}>✓ No dead columns detected</div>}
          {deadColFindings && deadColFindings.length > 0 && deadColFindings.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>{f.table}.<strong style={{ color: '#fbbf24' }}>{f.column}</strong></span>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 9999, background: f.confidence === 'high' ? 'rgba(239,68,68,0.12)' : f.confidence === 'medium' ? 'rgba(251,191,36,0.12)' : 'rgba(148,163,184,0.12)', color: f.confidence === 'high' ? '#f87171' : f.confidence === 'medium' ? '#fbbf24' : '#94a3b8', border: `1px solid ${f.confidence === 'high' ? 'rgba(239,68,68,0.3)' : f.confidence === 'medium' ? 'rgba(251,191,36,0.3)' : 'rgba(148,163,184,0.2)'}` }}>{f.confidence}</span>
              <span style={{ color: '#64748b', flex: 1 }}>{f.reason}</span>
            </div>
          ))}
        </div>
      </ModalView>

      {/* Schema Documenter popup */}
      <ModalView
        open={showDocPopup}
        onClose={() => setShowDocPopup(false)}
        title={`Schema Documenter${docSchema ? ` — ${docSchema}` : ''}`}
        headerColor="#818cf8"
        size="xl"
        footerRight={docMarkdown ? (
          <button
            style={{ fontSize: 11, padding: '4px 12px', borderRadius: 4, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.1)', color: '#818cf8', cursor: 'pointer' }}
            onClick={() => getVsCodeApi().postMessage({ type: 'saveTextFile', payload: { content: docMarkdown, filename: `${docSchema ?? 'schema'}_data_dictionary.md` } })}
          >↓ Export .md</button>
        ) : undefined}
      >
        {docError && <div style={{ color: '#f87171', fontSize: 11.5 }}>✗ {docError}</div>}
        {docMarkdown && <MarkdownView content={docMarkdown} />}
      </ModalView>
    </div>
  );
}

// ─── Custom Node Renderer ────────────────────────────────────────────────────

function NodeRow({ node, style, dragHandle, onContextMenu }: NodeRendererProps<TreeNode> & { onContextMenu: (e: React.MouseEvent, node: TreeNode) => void }) {
  const data = node.data;
  const indent = node.level * 18;

  return (
    <div
      ref={dragHandle}
      style={{ ...style, paddingLeft: indent }}
      className={`schema-node schema-node--${data.nodeType}${node.isSelected ? ' is-selected' : ''}`}
      onClick={() => node.toggle()}
      onContextMenu={(e) => onContextMenu(e, data)}
    >
      {/* Expand/collapse chevron (only for expandable nodes — not leaf items) */}
      {data.children !== undefined && !['column', 'view', 'function', 'sequence'].includes(data.nodeType) && (
        <span className={`schema-node__chevron${node.isOpen ? ' is-open' : ''}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </span>
      )}
      {['column', 'view', 'function', 'sequence'].includes(data.nodeType) && <span className="schema-node__spacer" />}

      {/* Icon */}
      <span className={`schema-node__icon schema-node__icon--${data.nodeType}`}>
        {getNodeIcon(data.nodeType)}
      </span>

      {/* Name */}
      <span className="schema-node__name">{data.name}</span>

      {/* Column metadata */}
      {data.nodeType === 'column' && data.meta && (
        <span className="schema-node__meta">
          <span className="schema-node__type">{data.meta.type}</span>
          {data.meta.nullable && <span className="schema-node__nullable">{data.meta.nullable}</span>}
        </span>
      )}

      {/* Loading indicator for null children (not-yet-loaded) */}
      {data.children === null && node.isOpen && (
        <span className="schema-node__loading">
          <div className="schema-page__spinner schema-page__spinner--sm" />
        </span>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getNodeIcon(type: NodeType): React.ReactNode {
  switch (type) {
    case 'server':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
        </svg>
      );
    case 'schema':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      );
    case 'group':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'table':
      return <span className="schema-node__letter">T</span>;
    case 'view':
      return <span className="schema-node__letter">V</span>;
    case 'function':
      return <span className="schema-node__letter">ƒ</span>;
    case 'sequence':
      return <span className="schema-node__letter">#</span>;
    case 'column':
      return <span className="schema-node__dot">●</span>;
  }
}

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

function extractSchemaFromId(nodeId: string): string | null {
  // ID format for tables: "table:schema:<serverId>:<schemaName>:<tableName>"
  // The schema node part is embedded: "schema:server:<serverId>:<schemaName>"
  // We need to find a segment that looks like a schema name
  // Approach: walk up the ID structure. Table IDs contain their parent schema name.
  // Given our tree structure, table IDs are: "table:schema:server:<sid>:<schema>:<table>"
  // We parse by splitting on ':' and finding the schema name segment
  const match = nodeId.match(/schema:server:[^:]+:([^:]+)/);
  return match?.[1] ?? null;
}

/** Extract the raw MCP server ID from any node ID that contains "server:<id>". */
function extractServerIdFromNodeId(nodeId: string): string | undefined {
  const match = nodeId.match(/server:([^:]+)/);
  return match?.[1];
}

/**
 * Deep-update a node in the tree via a visitor function.
 * If visitor returns a new node, it replaces the original. Otherwise recurse.
 */
function deepUpdateNode(nodes: TreeNode[], visitor: (n: TreeNode) => TreeNode | null): TreeNode[] {
  return nodes.map(node => {
    const updated = visitor(node);
    if (updated) return updated;
    if (node.children && node.children.length > 0) {
      return { ...node, children: deepUpdateNode(node.children, visitor) };
    }
    return node;
  });
}
