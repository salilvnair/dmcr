import React, { useState } from 'react';
import { postMsg } from '../../../vscode';
import type { CeAuditEntry } from '../../../types';
import JsonView from '../../../components/JsonView';
import { BackBtn } from './BackBtn';

/* ── Stage → color mapping (matches Prompt Library) ── */
const STAGE_COLORS: Record<string, string> = {
  'DMCR_RULES': '#6366f1',
  'INTENT_DETECTOR': '#8b5cf6',
  'REQUEST_PLANNER': '#a78bfa',
  'FOLLOWUP_DECIDER': '#f59e0b',
  'FREEFORM_SQL': '#22c55e',
  'SCHEMA_DIFF': '#06b6d4',
  'ADD_COLUMNS': '#14b8a6',
  'INSERT_ROWS': '#10b981',
  'MASTER_AGENT': '#f97316',
  'GREETING_AGENT': '#84cc16',
  'GENERAL_FAQ_AGENT': '#38bdf8',
  'SQL_FAQ_AGENT': '#0284c7',
  'WIKI_AGENT': '#6366f1',
  'MCP_AGENT': '#a855f7',
  'DIALOGUE_INTENT': '#0f766e',
  'MCP_TOOL_CALL': '#f59e0b',
  'MCP_TOOL_RESULT': '#22c55e',
  'MCP_TOOL_ERROR': '#ef4444',
};
const STAGE_LABELS: Record<string, string> = {
  'DMCR_RULES': 'DMCR Agent',
  'INTENT_DETECTOR': 'Intent Detector',
  'REQUEST_PLANNER': 'Request Planner',
  'FOLLOWUP_DECIDER': 'Follow-up Decider',
  'FREEFORM_SQL': 'Freeform SQL',
  'SCHEMA_DIFF': 'Schema Diff',
  'ADD_COLUMNS': 'DDL Builder',
  'INSERT_ROWS': 'DML Builder',
  'MASTER_AGENT': 'Master Agent',
  'GREETING_AGENT': 'Greeting Agent',
  'GENERAL_FAQ_AGENT': 'General FAQ Agent',
  'SQL_FAQ_AGENT': 'SQL FAQ Agent',
  'WIKI_AGENT': 'Wiki Agent',
  'MCP_AGENT': 'MCP Agent',
  'DIALOGUE_INTENT': 'Dialogue Intent Resolver',
  'MCP_TOOL_CALL': 'Tool Call',
  'MCP_TOOL_RESULT': 'Tool Result',
  'MCP_TOOL_ERROR': 'Tool Error',
};
function resolveStageKey(stage: string): string {
  if (STAGE_COLORS[stage]) return stage;
  const base = stage.replace(/_OUTPUT$/, '');
  return base === 'DMCR_AGENT' ? 'DMCR_RULES' : base;
}
function stageColor(stage: string): string {
  return STAGE_COLORS[resolveStageKey(stage)] || '#6366f1';
}
function stageLabel(stage: string): string | null {
  return STAGE_LABELS[resolveStageKey(stage)] || null;
}

const AI_TABS = [
  { id: 'systemPrompt',    label: 'System Prompt' },
  { id: 'userPrompt',      label: 'User Prompt' },
  { id: 'request',         label: 'Request' },
  { id: 'response',        label: 'Response' },
  { id: 'headers',         label: 'Headers' },
  { id: 'meta',            label: 'Meta' },
  { id: 'audit',           label: 'Audit' },
] as const;
type AiTab = (typeof AI_TABS)[number]['id'];

function AuditCopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title="Copy full audit to clipboard"
      onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      style={{
        background: 'none', border: '1px solid var(--ce-border, #444)', borderRadius: 4, cursor: 'pointer',
        padding: '2px 8px', fontSize: 11, color: copied ? '#22c55e' : 'var(--text-secondary, #94a3b8)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        minWidth: 68, width: 68, flexShrink: 0,
      }}
    >
      {copied
        ? <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> Copied</>
        : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg> Copy</>}
    </button>
  );
}

export function AiFootprintPanel({ entries, onBack }: { entries: CeAuditEntry[]; onBack: () => void }) {
  // Only show actual AI/LLM calls — filter out MCP tool call/result/error entries
  const aiEntries = entries.filter(e => !e.stage.startsWith('MCP_TOOL_'));

  const [viewEntry, setViewEntry] = useState<CeAuditEntry | null>(null);
  const [activeTab, setActiveTab] = useState<AiTab>('systemPrompt');
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  function handleRefresh() {
    setRefreshing(true);
    postMsg({ type: 'getAiFootprint' });
    setTimeout(() => setRefreshing(false), 800);
  }

  if (viewEntry) {
    const auditFull = JSON.stringify({
      audit_id:       viewEntry.audit_id,
      conversation_id: viewEntry.conversation_id,
      stage:          viewEntry.stage,
      model:          viewEntry.model,
      duration_ms:    viewEntry.duration_ms,
      created_at:     viewEntry.created_at,
      error:          viewEntry.error,
      system_prompt:  viewEntry.system_prompt,
      user_prompt:    viewEntry.user_prompt,
      request:        viewEntry.request_payload,
      response:       viewEntry.response_payload,
      headers:        viewEntry.headers,
      meta:           viewEntry.meta,
    }, null, 2);

    const tabValue: Record<AiTab, string | null | undefined> = {
      systemPrompt: viewEntry.system_prompt,
      userPrompt:   viewEntry.user_prompt,
      request:      viewEntry.request_payload,
      response:     viewEntry.response_payload,
      headers:      viewEntry.headers,
      meta:         viewEntry.meta,
      audit:        auditFull,
    };

    return (
      <div className="bs-settings-pane" style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%' }}>
        <div className="bs-settings-section-head" style={{ flexShrink: 0 }}>
          <BackBtn onClick={() => setViewEntry(null)} />
          <span style={{ fontSize: 13, fontWeight: 500, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            #{viewEntry.audit_id}
            <span style={{
              fontSize: 11,
              fontFamily: 'monospace',
              fontWeight: 600,
              letterSpacing: '0.02em',
              color: stageColor(viewEntry.stage),
            }}>{viewEntry.stage}</span>
            {stageLabel(viewEntry.stage) && (
              <span style={{
                display: 'inline-block',
                padding: '1px 6px',
                borderRadius: 999,
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: '0.02em',
                background: stageColor(viewEntry.stage) + '22',
                color: stageColor(viewEntry.stage),
                border: `1px solid ${stageColor(viewEntry.stage) + '55'}`,
              }}>{stageLabel(viewEntry.stage)}</span>
            )}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)' }}>{viewEntry.model}</span>
          {viewEntry.duration_ms != null && <span style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)', marginLeft: 8 }}>{viewEntry.duration_ms}ms</span>}
          <AuditCopyBtn text={auditFull} />
        </div>
        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--ce-border, #333)', flexShrink: 0, paddingLeft: 4, flexWrap: 'wrap' }}>
          {AI_TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 12,
                color: activeTab === t.id ? '#6366f1' : 'var(--text-secondary, #94a3b8)',
                borderBottom: activeTab === t.id ? '2px solid #6366f1' : '2px solid transparent',
                fontWeight: activeTab === t.id ? 600 : 400,
              }}
            >{t.label}</button>
          ))}
        </div>
        {/* Tab content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {activeTab === 'audit'
            ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {AI_TABS.filter(t => t.id !== 'audit').map(t => (
                  <div key={t.id}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#6366f1', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t.label}</div>
                    {tabValue[t.id] == null
                      ? <span style={{ color: 'var(--text-secondary, #94a3b8)', fontSize: 12 }}>—</span>
                      : <JsonView value={tabValue[t.id]!} defaultExpanded={1} style={{ fontSize: 12 }} />}
                  </div>
                ))}
              </div>
            )
            : tabValue[activeTab] == null
              ? <span style={{ color: 'var(--text-secondary, #94a3b8)', fontSize: 12 }}>—</span>
              : <JsonView value={tabValue[activeTab]!} defaultExpanded={2} style={{ fontSize: 12 }} />}
        </div>
      </div>
    );
  }

  return (
    <div className="bs-settings-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>
      <div className="bs-settings-section-head" style={{ flexShrink: 0 }}>
        <BackBtn onClick={onBack} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>AI Footprint</span>
        <button className="bs-btn-sm bs-btn-secondary" style={{ marginLeft: 'auto' }} onClick={handleRefresh}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.27" />
          </svg>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {aiEntries.length === 0
        ? <div style={{ padding: 24, color: 'var(--text-secondary, #94a3b8)', fontSize: 12, textAlign: 'center' }}>No AI audit records yet. Make a request to generate data.</div>
        : (
          <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--bg-secondary, #1a1a2e)', position: 'sticky', top: 0, zIndex: 1 }}>
                  <th style={{ padding: '6px 10px', width: 32 }}>
                    <input
                      type="checkbox"
                      checked={selected.size === aiEntries.length && aiEntries.length > 0}
                      ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < aiEntries.length; }}
                      onChange={e => setSelected(e.target.checked ? new Set(aiEntries.map(r => r.audit_id!)) : new Set())}
                      style={{ cursor: 'pointer', accentColor: '#6366f1' }}
                    />
                  </th>
                  {['#', 'Stage', 'Model', 'Duration', 'Created At', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary, #94a3b8)', borderBottom: '1px solid var(--ce-border, #333)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {aiEntries.map((e, i) => {
                  const isChecked = selected.has(e.audit_id!);
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
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => setSelected(prev => { const s = new Set(prev); s.has(e.audit_id!) ? s.delete(e.audit_id!) : s.add(e.audit_id!); return s; })}
                          style={{ cursor: 'pointer', accentColor: '#6366f1' }}
                        />
                      </td>
                      <td style={{ padding: '5px 10px', color: 'var(--text-secondary, #94a3b8)', cursor: 'pointer' }} onClick={() => { setViewEntry(e); setActiveTab('systemPrompt'); }}>{e.audit_id}</td>
                      <td style={{ padding: '4px 8px', cursor: 'pointer' }} onClick={() => { setViewEntry(e); setActiveTab('systemPrompt'); }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <span style={{
                            fontSize: 10,
                            fontFamily: 'monospace',
                            fontWeight: 600,
                            letterSpacing: '0.02em',
                            color: e.stage?.includes('ERROR') ? '#ef4444' : stageColor(e.stage),
                          }}>{e.stage}</span>
                          {stageLabel(e.stage) && (
                            <span style={{
                              display: 'inline-block',
                              padding: '1px 6px',
                              borderRadius: 999,
                              fontSize: 8,
                              fontWeight: 600,
                              letterSpacing: '0.02em',
                              background: (e.stage?.includes('ERROR') ? '#ef4444' : stageColor(e.stage)) + '22',
                              color: e.stage?.includes('ERROR') ? '#ef4444' : stageColor(e.stage),
                              border: `1px solid ${(e.stage?.includes('ERROR') ? '#ef4444' : stageColor(e.stage)) + '55'}`,
                            }}>{stageLabel(e.stage)}</span>
                          )}
                        </span>
                      </td>
                      <td style={{ padding: '5px 10px', color: 'var(--text-primary, #e2e8f0)', cursor: 'pointer' }} onClick={() => { setViewEntry(e); setActiveTab('systemPrompt'); }}>{e.model ?? '—'}</td>
                      <td style={{ padding: '5px 10px', color: '#f59e0b', cursor: 'pointer' }} onClick={() => { setViewEntry(e); setActiveTab('systemPrompt'); }}>{e.duration_ms != null ? `${e.duration_ms}ms` : '—'}</td>
                      <td style={{ padding: '5px 10px', color: 'var(--text-secondary, #94a3b8)', fontSize: 11, whiteSpace: 'nowrap', cursor: 'pointer' }} onClick={() => { setViewEntry(e); setActiveTab('systemPrompt'); }}>{e.created_at?.slice(0, 19) ?? ''}</td>
                      <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }} onClick={ev => ev.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <AuditCopyBtn text={auditJson} />
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
        )}
    </div>
  );
}
