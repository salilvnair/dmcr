import React, { useState, useMemo } from 'react';
import { postMsg } from '../../../vscode';
import type { CeAuditEntry } from '../../../types';
import JsonView from '../../../components/JsonView';
import PillTabs from '../../../components/PillTabs';
import { CheckboxView, SelectInputView } from '@salilvnair/dui';
import { BackBtn } from './BackBtn';

/* ── Stage categorization ── */
const STAGE_CATEGORIES: Record<string, { color: string; icon: string; label: string }> = {
  // AI/LLM calls
  'DMCR_RULES':          { color: '#6366f1', icon: '🤖', label: 'DMCR Agent' },
  'INTENT_DETECTOR':     { color: '#8b5cf6', icon: '🎯', label: 'Intent Detector' },
  'REQUEST_PLANNER':     { color: '#a78bfa', icon: '📋', label: 'Request Planner' },
  'FOLLOWUP_DECIDER':    { color: '#f59e0b', icon: '🔄', label: 'Follow-up Decider' },
  'FREEFORM_SQL':        { color: '#22c55e', icon: '📝', label: 'Freeform SQL' },
  'SCHEMA_DIFF':         { color: '#06b6d4', icon: '🔍', label: 'Schema Diff' },
  'ADD_COLUMNS':         { color: '#14b8a6', icon: '➕', label: 'DDL Builder' },
  'INSERT_ROWS':         { color: '#10b981', icon: '📥', label: 'DML Builder' },
  'MASTER_AGENT':        { color: '#f97316', icon: '🧭', label: 'Master Agent' },
  'GREETING_AGENT':      { color: '#84cc16', icon: '👋', label: 'Greeting Agent' },
  'GENERAL_FAQ_AGENT':   { color: '#38bdf8', icon: '💬', label: 'General FAQ Agent' },
  'SQL_FAQ_AGENT':       { color: '#0284c7', icon: '🗃️', label: 'SQL FAQ Agent' },
  'WIKI_AGENT':          { color: '#6366f1', icon: '📚', label: 'Wiki Agent' },
  'MCP_AGENT':           { color: '#a855f7', icon: '🔌', label: 'MCP Agent' },
  'DIALOGUE_INTENT':     { color: '#0f766e', icon: '🧩', label: 'Dialogue Intent' },
  // MCP tool calls
  'MCP_TOOL_CALL':       { color: '#f59e0b', icon: '⚡', label: 'Tool Call' },
  'MCP_TOOL_RESULT':     { color: '#22c55e', icon: '✅', label: 'Tool Result' },
  'MCP_TOOL_ERROR':      { color: '#ef4444', icon: '❌', label: 'Tool Error' },
};

function resolveStage(stage: string) {
  if (STAGE_CATEGORIES[stage]) return STAGE_CATEGORIES[stage];
  const base = stage.replace(/_OUTPUT$/, '');
  if (base === 'DMCR_AGENT') return STAGE_CATEGORIES['DMCR_RULES'];
  return STAGE_CATEGORIES[base] ?? { color: '#6366f1', icon: '📄', label: stage };
}

type AuditFilter = 'all' | 'ai' | 'mcp' | 'error';

const FILTERS: { id: AuditFilter; label: string }[] = [
  { id: 'all',   label: 'All' },
  { id: 'ai',    label: 'AI Calls' },
  { id: 'mcp',   label: 'MCP Tools' },
  { id: 'error', label: 'Errors' },
];

type FormFilter = 'all' | 'ddl' | 'insert' | 'freeform' | 'conversation' | 'schema_diff';
const FORM_STAGE_MAP: Record<FormFilter, string[]> = {
  all: [],
  ddl: ['ADD_COLUMNS'],
  insert: ['INSERT_ROWS'],
  freeform: ['FREEFORM_SQL'],
  conversation: ['DMCR_RULES', 'MASTER_AGENT', 'INTENT_DETECTOR', 'REQUEST_PLANNER', 'FOLLOWUP_DECIDER', 'GREETING_AGENT', 'GENERAL_FAQ_AGENT', 'SQL_FAQ_AGENT', 'WIKI_AGENT', 'MCP_AGENT', 'DIALOGUE_INTENT'],
  schema_diff: ['SCHEMA_DIFF'],
};
const FORM_FILTER_OPTIONS = [
  { value: 'all',          label: 'All Forms' },
  { value: 'ddl',          label: 'DDL Builder' },
  { value: 'insert',       label: 'Insert Rows' },
  { value: 'freeform',     label: 'Freeform SQL' },
  { value: 'conversation', label: 'Conversation' },
  { value: 'schema_diff',  label: 'Schema Diff' },
];

const DETAIL_TABS = [
  { id: 'overview',  label: 'Overview' },
  { id: 'system',    label: 'System Prompt' },
  { id: 'user',      label: 'User Prompt' },
  { id: 'request',   label: 'Request' },
  { id: 'response',  label: 'Response' },
  { id: 'meta',      label: 'Meta' },
  { id: 'raw',       label: 'Raw JSON' },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['id'];

function parseMeta(entry: CeAuditEntry): Record<string, unknown> | null {
  if (!entry.meta) return null;
  try { return JSON.parse(entry.meta); } catch { return null; }
}

function parseJson(str: string | null | undefined): unknown {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}

/** Extract a short human-readable description for the row */
function getRowDescription(entry: CeAuditEntry, meta: Record<string, unknown> | null): string | null {
  // For all entries: prefer meta.userInput (the raw user message from UI)
  if (meta?.userInput) {
    const raw = String(meta.userInput).trim();
    return raw.length > 90 ? raw.slice(0, 90) + '…' : raw;
  }
  // For MCP tool calls — show what the tool was asked
  if (entry.stage === 'MCP_TOOL_CALL') {
    try {
      const req = JSON.parse(entry.request_payload ?? '{}');
      const args = req.args;
      if (args) {
        // Try to find a meaningful arg value
        const hint = args.query ?? args.sql ?? args.schema ?? args.table ?? args.name ?? args.pattern;
        if (hint) return String(hint).slice(0, 80);
        // Fallback: show first arg key=value
        const keys = Object.keys(args);
        if (keys.length > 0) return `${keys[0]}: ${String(args[keys[0]]).slice(0, 60)}`;
      }
    } catch { /* ignore */ }
    return null;
  }
  // For MCP tool results — show a brief summary of the result
  if (entry.stage === 'MCP_TOOL_RESULT') {
    if (entry.response_payload) {
      const preview = entry.response_payload.slice(0, 80).replace(/[\n\r]+/g, ' ');
      return preview.length < (entry.response_payload?.length ?? 0) ? preview + '…' : preview;
    }
    return null;
  }
  return null;
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
  } catch { return iso; }
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return iso; }
}

export function AuditLogPanel({ entries, onBack }: { entries: CeAuditEntry[]; onBack: () => void }) {
  const [filter, setFilter] = useState<AuditFilter>('all');
  const [formFilter, setFormFilter] = useState<FormFilter>('all');
  const [viewEntry, setViewEntry] = useState<CeAuditEntry | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [viewMode, setViewMode] = useState<'table' | 'timeline'>('timeline');
  const filtered = useMemo(() => {
    let items = entries;
    switch (filter) {
      case 'ai':    items = items.filter(e => !e.stage.startsWith('MCP_TOOL_')); break;
      case 'mcp':   items = items.filter(e => e.stage.startsWith('MCP_TOOL_')); break;
      case 'error': items = items.filter(e => e.stage.includes('ERROR') || !!e.error); break;
    }
    if (formFilter !== 'all') {
      const allowedStages = FORM_STAGE_MAP[formFilter];
      items = items.filter(e => allowedStages.some(s => e.stage.startsWith(s)));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(e =>
        e.stage.toLowerCase().includes(q) ||
        e.conversation_id?.toLowerCase().includes(q) ||
        e.model?.toLowerCase().includes(q) ||
        e.request_payload?.toLowerCase().includes(q) ||
        e.meta?.toLowerCase().includes(q) ||
        e.error?.toLowerCase().includes(q)
      );
    }
    return items;
  }, [entries, filter, formFilter, searchQuery]);

  // Group entries by conversation_id for the timeline view
  const conversationGroups = useMemo(() => {
    const groups = new Map<string, CeAuditEntry[]>();
    for (const e of filtered) {
      const arr = groups.get(e.conversation_id) ?? [];
      arr.push(e);
      groups.set(e.conversation_id, arr);
    }
    return groups;
  }, [filtered]);

  function handleRefresh() {
    setRefreshing(true);
    postMsg({ type: 'getAiFootprint' });
    setTimeout(() => setRefreshing(false), 800);
  }

  // ── Detail View ──
  if (viewEntry) {
    const meta = parseMeta(viewEntry);
    const stageInfo = resolveStage(viewEntry.stage);
    const fullJson = JSON.stringify({
      ...viewEntry,
      meta: meta,
      request_payload: parseJson(viewEntry.request_payload),
      response_payload: parseJson(viewEntry.response_payload),
      headers: parseJson(viewEntry.headers),
    }, null, 2);

    return (
      <div className="bs-settings-pane" style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%' }}>
        {/* Header */}
        <div className="bs-settings-section-head" style={{ flexShrink: 0, gap: 8 }}>
          <BackBtn onClick={() => setViewEntry(null)} />
          <span style={{ fontSize: 16, lineHeight: 1 }}>{stageInfo.icon}</span>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: stageInfo.color, fontWeight: 700 }}>{viewEntry.stage}</span>
            <span style={{
              display: 'inline-block', padding: '1px 7px', borderRadius: 999, fontSize: 9, fontWeight: 600,
              background: stageInfo.color + '18', color: stageInfo.color, border: `1px solid ${stageInfo.color}44`,
            }}>{stageInfo.label}</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)' }}>#{viewEntry.audit_id}</span>
          </span>
          {viewEntry.model && <span style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)' }}>{viewEntry.model}</span>}
          {viewEntry.duration_ms != null && (
            <span style={{ fontSize: 11, fontFamily: 'monospace', color: viewEntry.duration_ms > 5000 ? '#ef4444' : viewEntry.duration_ms > 2000 ? '#f59e0b' : '#22c55e' }}>
              {viewEntry.duration_ms}ms
            </span>
          )}
        </div>

        {/* Error banner */}
        {viewEntry.error && (
          <div style={{ padding: '8px 14px', background: '#ef444418', borderBottom: '1px solid #ef444444', fontSize: 12, color: '#ef4444', fontFamily: 'monospace' }}>
            ❌ {viewEntry.error}
          </div>
        )}

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--ce-border, #333)', flexShrink: 0, overflow: 'auto' }}>
          {DETAIL_TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '8px 14px', fontSize: 11, fontWeight: 500,
                color: activeTab === t.id ? '#6366f1' : 'var(--text-secondary, #94a3b8)',
                borderBottom: activeTab === t.id ? '2px solid #6366f1' : '2px solid transparent',
                whiteSpace: 'nowrap',
              }}
            >{t.label}</button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
          {activeTab === 'overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Summary cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                <InfoCard label="Stage" value={viewEntry.stage} color={stageInfo.color} />
                <InfoCard label="Conversation" value={viewEntry.conversation_id} mono />
                <InfoCard label="Model" value={viewEntry.model ?? '—'} />
                <InfoCard label="Duration" value={viewEntry.duration_ms != null ? `${viewEntry.duration_ms}ms` : '—'} />
                <InfoCard label="Created" value={viewEntry.created_at ? new Date(viewEntry.created_at).toLocaleString() : '—'} />
                {!!meta?.tool && <InfoCard label="Tool" value={String(meta.tool)} color="#f59e0b" />}
                {!!meta?.serverId && <InfoCard label="Server" value={String(meta.serverId)} mono />}
                {!!meta?.serverName && <InfoCard label="Server Name" value={String(meta.serverName)} />}
              </div>
              {/* Meta section */}
              {meta && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#a855f7', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Metadata</div>
                  <JsonView value={JSON.stringify(meta, null, 2)} defaultExpanded={2} style={{ fontSize: 12 }} />
                </div>
              )}
              {/* Request/Response preview */}
              {viewEntry.request_payload && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#38bdf8', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Request</div>
                  <JsonView value={viewEntry.request_payload} defaultExpanded={1} style={{ fontSize: 12 }} />
                </div>
              )}
              {viewEntry.response_payload && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#22c55e', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Response</div>
                  <JsonView value={viewEntry.response_payload} defaultExpanded={1} style={{ fontSize: 12 }} />
                </div>
              )}
            </div>
          )}
          {activeTab === 'system' && (
            viewEntry.system_prompt
              ? <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, color: 'var(--text-primary, #e2e8f0)' }}>{viewEntry.system_prompt}</pre>
              : <EmptyTab />
          )}
          {activeTab === 'user' && (
            viewEntry.user_prompt
              ? <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, color: 'var(--text-primary, #e2e8f0)' }}>{viewEntry.user_prompt}</pre>
              : <EmptyTab />
          )}
          {activeTab === 'request' && (
            viewEntry.request_payload
              ? <JsonView value={viewEntry.request_payload} defaultExpanded={3} style={{ fontSize: 12 }} />
              : <EmptyTab />
          )}
          {activeTab === 'response' && (
            viewEntry.response_payload
              ? <JsonView value={viewEntry.response_payload} defaultExpanded={3} style={{ fontSize: 12 }} />
              : <EmptyTab />
          )}
          {activeTab === 'meta' && (
            meta
              ? <JsonView value={JSON.stringify(meta, null, 2)} defaultExpanded={3} style={{ fontSize: 12 }} />
              : <EmptyTab />
          )}
          {activeTab === 'raw' && (
            <JsonView value={fullJson} defaultExpanded={2} style={{ fontSize: 12 }} />
          )}
        </div>
      </div>
    );
  }

  // ── List View ──
  return (
    <div className="bs-settings-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>
      {/* Header */}
      <div className="bs-settings-section-head" style={{ flexShrink: 0, gap: 8 }}>
        <BackBtn onClick={onBack} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Audit Log</span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)', marginLeft: 4 }}>
          {filtered.length} entries • {conversationGroups.size} conversations
        </span>
        <button className="bs-btn-sm bs-btn-secondary" style={{ marginLeft: 'auto' }} onClick={handleRefresh}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.27" />
          </svg>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Filter bar + search */}
      <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--ce-border, #333)', alignItems: 'center', flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              background: filter === f.id ? '#6366f122' : 'transparent',
              border: filter === f.id ? '1px solid #6366f155' : '1px solid var(--ce-border, #333)',
              borderRadius: 999, padding: '3px 10px', fontSize: 11, cursor: 'pointer',
              color: filter === f.id ? '#6366f1' : 'var(--text-secondary, #94a3b8)',
              fontWeight: filter === f.id ? 600 : 400,
            }}
          >{f.label}</button>
        ))}
        <SelectInputView
          options={FORM_FILTER_OPTIONS}
          value={formFilter}
          onChange={v => setFormFilter(v as FormFilter)}
          size="md"
        />
        {/* View mode toggle */}
        <PillTabs
          tabs={[{ id: 'timeline', label: 'Timeline' }, { id: 'table', label: 'Table' }]}
          active={viewMode}
          onChange={id => setViewMode(id as 'timeline' | 'table')}
          size="sm"
          accentColor="#6366f1"
        />
        <input
          type="text"
          placeholder="Search stage, tool, conversation…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{
            marginLeft: 'auto', background: 'var(--bg-secondary, #1a1a2e)', border: '1px solid var(--ce-border, #333)',
            borderRadius: 6, padding: '4px 10px', fontSize: 11, color: 'var(--text-primary, #e2e8f0)', width: 200, outline: 'none',
          }}
        />
      </div>

      {/* Content */}
      {filtered.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary, #94a3b8)', fontSize: 12 }}>
          No audit records match the current filter.
        </div>
      ) : viewMode === 'table' ? (
        <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-secondary, #1a1a2e)', position: 'sticky', top: 0, zIndex: 1 }}>
                <th style={{ padding: '6px 10px', width: 32 }}>
                  <CheckboxView
                    checked={selected.size === filtered.length && filtered.length > 0}
                    indeterminate={selected.size > 0 && selected.size < filtered.length}
                    onChange={checked => setSelected(checked ? new Set(filtered.map(r => r.audit_id!)) : new Set())}
                    size="xs"
                    accentColor="#6366f1"
                  />
                </th>
                {['#', 'Stage', 'Model', 'Duration', 'Created At', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary, #94a3b8)', borderBottom: '1px solid var(--ce-border, #333)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => {
                const isChecked = selected.has(e.audit_id!);
                const stageInfo = resolveStage(e.stage);
                const auditJson = JSON.stringify({
                  audit_id: e.audit_id, conversation_id: e.conversation_id, stage: e.stage,
                  model: e.model, duration_ms: e.duration_ms, created_at: e.created_at,
                  error: e.error, system_prompt: e.system_prompt, user_prompt: e.user_prompt,
                  request: e.request_payload, response: e.response_payload, headers: e.headers, meta: e.meta,
                }, null, 2);
                return (
                  <tr
                    key={e.audit_id ?? i}
                    style={{ borderBottom: '1px solid var(--ce-border, #2a2a2a)', background: isChecked ? 'rgba(99,102,241,0.08)' : '' }}
                    onMouseEnter={ev => { if (!isChecked) ev.currentTarget.style.background = 'rgba(99,102,241,0.05)'; }}
                    onMouseLeave={ev => { ev.currentTarget.style.background = isChecked ? 'rgba(99,102,241,0.08)' : ''; }}
                  >
                    <td style={{ padding: '5px 10px', width: 32 }} onClick={ev => ev.stopPropagation()}>
                      <CheckboxView
                        checked={isChecked}
                        onChange={() => setSelected(prev => { const s = new Set(prev); s.has(e.audit_id!) ? s.delete(e.audit_id!) : s.add(e.audit_id!); return s; })}
                        size="xs"
                        accentColor="#6366f1"
                      />
                    </td>
                    <td style={{ padding: '5px 10px', color: 'var(--text-secondary, #94a3b8)', cursor: 'pointer' }} onClick={() => { setViewEntry(e); setActiveTab('overview'); }}>{e.audit_id}</td>
                    <td style={{ padding: '4px 8px', cursor: 'pointer' }} onClick={() => { setViewEntry(e); setActiveTab('overview'); }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ fontSize: 12 }}>{stageInfo.icon}</span>
                        <span style={{
                          fontSize: 10, fontFamily: 'monospace', fontWeight: 600, letterSpacing: '0.02em',
                          color: e.stage?.includes('ERROR') ? '#ef4444' : stageInfo.color,
                        }}>{e.stage}</span>
                        <span style={{
                          display: 'inline-block', padding: '1px 6px', borderRadius: 999, fontSize: 8, fontWeight: 600,
                          letterSpacing: '0.02em', background: (e.stage?.includes('ERROR') ? '#ef4444' : stageInfo.color) + '22',
                          color: e.stage?.includes('ERROR') ? '#ef4444' : stageInfo.color,
                          border: `1px solid ${(e.stage?.includes('ERROR') ? '#ef4444' : stageInfo.color) + '55'}`,
                        }}>{stageInfo.label}</span>
                      </span>
                    </td>
                    <td style={{ padding: '5px 10px', color: 'var(--text-primary, #e2e8f0)', cursor: 'pointer' }} onClick={() => { setViewEntry(e); setActiveTab('overview'); }}>{e.model ?? '—'}</td>
                    <td style={{ padding: '5px 10px', color: e.duration_ms != null ? (e.duration_ms > 5000 ? '#ef4444' : e.duration_ms > 2000 ? '#f59e0b' : '#22c55e') : 'var(--text-secondary, #94a3b8)', cursor: 'pointer' }} onClick={() => { setViewEntry(e); setActiveTab('overview'); }}>{e.duration_ms != null ? `${e.duration_ms}ms` : '—'}</td>
                    <td style={{ padding: '5px 10px', color: 'var(--text-secondary, #94a3b8)', fontSize: 11, whiteSpace: 'nowrap', cursor: 'pointer' }} onClick={() => { setViewEntry(e); setActiveTab('overview'); }}>{e.created_at?.slice(0, 19) ?? ''}</td>
                    <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }} onClick={ev => ev.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <button
                          title="Copy audit JSON"
                          onClick={() => { navigator.clipboard.writeText(auditJson); }}
                          style={{ background: 'none', border: '1px solid var(--ce-border, #444)', borderRadius: 4, cursor: 'pointer', padding: '2px 8px', fontSize: 11, color: 'var(--text-secondary, #94a3b8)', display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 68 }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg> Copy
                        </button>
                        <button
                          title="Delete this entry"
                          onClick={() => { if (e.audit_id != null) { postMsg({ type: 'deleteAuditEntry', payload: { auditId: e.audit_id } }); } }}
                          style={{ background: 'none', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 4, cursor: 'pointer', padding: '2px 6px', color: '#f87171', display: 'flex', alignItems: 'center' }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Multiselect HUD */}
          {selected.size > 0 && (
            <div className="bs-multiselect-hud">
              <span className="bs-multiselect-hud-count">{selected.size} selected</span>
              <div className="bs-multiselect-hud-divider" />
              <button
                className="bs-multiselect-hud-btn bs-multiselect-hud-btn-danger"
                onClick={() => setDeleteConfirm(true)}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
                </svg>
                Delete
              </button>
              <div className="bs-multiselect-hud-divider" />
              <button className="bs-multiselect-hud-btn bs-multiselect-hud-btn-muted" onClick={() => setSelected(new Set())}>
                × Deselect
              </button>
            </div>
          )}
          {/* Delete confirm dialog */}
          {deleteConfirm && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
              <div style={{ background: 'var(--bg-secondary, #1a1a2e)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 10, padding: '20px 24px', minWidth: 300, boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#dc2626', marginBottom: 8 }}>Delete {selected.size} {selected.size === 1 ? 'entry' : 'entries'}?</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)', marginBottom: 20 }}>This action cannot be undone. The selected audit records will be permanently removed.</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="bs-btn-sm bs-btn-secondary" onClick={() => setDeleteConfirm(false)}>Cancel</button>
                  <button
                    className="bs-btn-sm bs-btn-danger"
                    onClick={() => {
                      postMsg({ type: 'deleteAuditEntries', payload: { auditIds: Array.from(selected) } });
                      setSelected(new Set());
                      setDeleteConfirm(false);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
          {[...conversationGroups.entries()].map(([convId, convEntries]) => (
            <div key={convId} style={{ marginBottom: 16 }}>
              {/* Conversation header */}
              <div style={{ padding: '4px 14px', fontSize: 10, fontFamily: 'monospace', color: 'var(--text-secondary, #94a3b8)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ opacity: 0.6 }}>●</span>
                <span title={convId}>{convId.length > 32 ? convId.slice(0, 12) + '…' + convId.slice(-8) : convId}</span>
                <span style={{ opacity: 0.5 }}>•</span>
                <span>{convEntries.length} event{convEntries.length > 1 ? 's' : ''}</span>
                {convEntries[0]?.created_at && <span style={{ opacity: 0.5 }}>{formatDate(convEntries[0].created_at)}</span>}
              </div>
              {/* Entries */}
              {convEntries.map((entry, idx) => {
                const stageInfo = resolveStage(entry.stage);
                const meta = parseMeta(entry);
                const toolName = meta?.tool as string | undefined;
                const desc = getRowDescription(entry, meta);
                return (
                  <div
                    key={entry.audit_id ?? idx}
                    onClick={() => { setViewEntry(entry); setActiveTab('overview'); }}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 14px', cursor: 'pointer',
                      borderLeft: `3px solid ${stageInfo.color}33`, marginLeft: 14,
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={ev => { ev.currentTarget.style.background = 'rgba(99,102,241,0.05)'; }}
                    onMouseLeave={ev => { ev.currentTarget.style.background = ''; }}
                  >
                    {/* Main row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {/* Icon */}
                    <span style={{ fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 }}>{stageInfo.icon}</span>
                    {/* Stage pill */}
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                      fontFamily: 'monospace', letterSpacing: '0.02em',
                      background: stageInfo.color + '18', color: stageInfo.color, border: `1px solid ${stageInfo.color}33`,
                      flexShrink: 0,
                    }}>{stageInfo.label}</span>
                    {/* Tool name if MCP */}
                    {toolName && (
                      <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#f59e0b', fontWeight: 500 }}>{toolName}</span>
                    )}
                    {/* Model if AI */}
                    {entry.model && !entry.stage.startsWith('MCP_TOOL_') && (
                      <span style={{ fontSize: 10, color: 'var(--text-secondary, #94a3b8)' }}>{entry.model}</span>
                    )}
                    {/* Error badge */}
                    {entry.error && (
                      <span style={{ fontSize: 10, color: '#ef4444', fontFamily: 'monospace', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {entry.error}
                      </span>
                    )}
                    {/* Spacer + duration + time */}
                    <span style={{ flex: 1 }} />
                    {entry.duration_ms != null && (
                      <span style={{
                        fontSize: 10, fontFamily: 'monospace', flexShrink: 0,
                        color: entry.duration_ms > 5000 ? '#ef4444' : entry.duration_ms > 2000 ? '#f59e0b' : '#22c55e',
                      }}>{entry.duration_ms}ms</span>
                    )}
                    <span style={{ fontSize: 10, color: 'var(--text-secondary, #94a3b8)', flexShrink: 0, fontFamily: 'monospace' }}>
                      {formatTime(entry.created_at)}
                    </span>
                    </div>
                    {/* Description line */}
                    {desc && (
                      <div style={{ paddingLeft: 30, fontSize: 10, color: stageInfo.color + 'bb', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                        {desc}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Helper components ── */

function InfoCard({ label, value, color, mono }: { label: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div style={{
      background: 'var(--bg-secondary, #1a1a2e)', borderRadius: 8, padding: '8px 12px',
      border: '1px solid var(--ce-border, #2a2a2a)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-secondary, #94a3b8)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{label}</div>
      <div style={{
        fontSize: 12, fontWeight: 500, color: color ?? 'var(--text-primary, #e2e8f0)',
        fontFamily: mono ? 'monospace' : 'inherit',
        wordBreak: 'break-all',
      }}>{value}</div>
    </div>
  );
}

function EmptyTab() {
  return <span style={{ color: 'var(--text-secondary, #94a3b8)', fontSize: 12 }}>— empty —</span>;
}
