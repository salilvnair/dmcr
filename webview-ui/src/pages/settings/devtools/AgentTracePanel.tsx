import React, { useState, useEffect } from 'react';
import { postMsg } from '../../../vscode';
import type { CeAuditEntry } from '../../../types';
import { AgentIcon, CheckCircleIcon, ClipboardCheckIcon, CompassIcon, DocumentIcon, FileTextIcon, InboxIcon, PinIcon, PlusIcon, PuzzlePieceIcon, RefreshIcon, ScopeIcon, SearchIcon, TargetGoalIcon, XCircleIcon, ZapIcon } from '@salilvnair/dui';
import { BackBtn } from './BackBtn';

const STAGE_META: Record<string, { color: string; icon: React.ComponentType<{ size?: number }> }> = {
  'MASTER_AGENT':      { color: '#f97316', icon: CompassIcon },
  'INTENT_DETECTOR':   { color: '#8b5cf6', icon: TargetGoalIcon },
  'REQUEST_PLANNER':   { color: '#a78bfa', icon: ClipboardCheckIcon },
  'FOLLOWUP_DECIDER':  { color: '#f59e0b', icon: RefreshIcon },
  'DIALOGUE_INTENT':   { color: '#0f766e', icon: PuzzlePieceIcon },
  'DMCR_RULES':        { color: '#6366f1', icon: AgentIcon },
  'ADD_COLUMNS':       { color: '#14b8a6', icon: PlusIcon },
  'INSERT_ROWS':       { color: '#10b981', icon: InboxIcon },
  'FREEFORM_SQL':      { color: '#22c55e', icon: FileTextIcon },
  'SCHEMA_DIFF':       { color: '#06b6d4', icon: SearchIcon },
  'MCP_TOOL_CALL':     { color: '#f59e0b', icon: ZapIcon },
  'MCP_TOOL_RESULT':   { color: '#22c55e', icon: CheckCircleIcon },
  'MCP_TOOL_ERROR':    { color: '#ef4444', icon: XCircleIcon },
  'GIT_COMMIT_MESSAGE':{ color: '#84cc16', icon: PinIcon },
};

function stageMeta(stage: string) {
  return STAGE_META[stage] ?? STAGE_META[stage.replace(/_OUTPUT$/, '')] ?? { color: '#6366f1', icon: DocumentIcon };
}

function fmtMs(ms: number | null | undefined) {
  if (!ms) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function shortModel(model: string | null | undefined) {
  if (!model) return '—';
  return model.split('/').pop()?.split(':')[0]?.slice(0, 20) ?? model.slice(0, 20);
}

type TraceGroup = { conversationId: string; entries: CeAuditEntry[]; firstAt: string };

function groupByConversation(entries: CeAuditEntry[]): TraceGroup[] {
  const map = new Map<string, TraceGroup>();
  for (const e of entries) {
    const cid = e.conversation_id ?? '(unknown)';
    if (!map.has(cid)) map.set(cid, { conversationId: cid, entries: [], firstAt: e.created_at ?? '' });
    map.get(cid)!.entries.push(e);
  }
  return Array.from(map.values()).sort((a, b) => (b.firstAt > a.firstAt ? 1 : -1));
}

export function AgentTracePanel({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<CeAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedConvs, setExpandedConvs] = useState<Set<string>>(new Set());
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'auditTimeline' && msg?.payload?.requestId === 'agentTrace') {
        setLoading(false);
        setEntries(msg.payload?.entries ?? []);
      }
    };
    window.addEventListener('message', handler);
    postMsg({ type: 'getAuditTimeline', payload: { requestId: 'agentTrace' } });
    return () => window.removeEventListener('message', handler);
  }, []);

  const groups = groupByConversation(
    entries.filter(e =>
      !e.conversation_id?.startsWith('form-') &&
      !e.conversation_id?.startsWith('mcp-') &&
      !e.conversation_id?.startsWith('dmcr-gen-') &&
      !e.conversation_id?.startsWith('git-autocommit')
    )
  );

  const toggleConv = (cid: string) =>
    setExpandedConvs(prev => { const n = new Set(prev); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });

  const toggleEntry = (id: number | undefined) => {
    if (id === undefined) return;
    setExpandedEntries(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head">
        <BackBtn onClick={onBack} />
        <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 4 }}><ScopeIcon size={18} /></span>
        <h3 className="bs-settings-h3">Agent Trace</h3>
        <button
          className="bs-btn-sm bs-btn-secondary"
          style={{ marginLeft: 'auto' }}
          onClick={() => { setLoading(true); postMsg({ type: 'getAuditTimeline', payload: { requestId: 'agentTrace' } }); }}
        >Refresh</button>
      </div>

      {loading && <div style={{ padding: 20, textAlign: 'center', color: '#64748b', fontSize: 12 }}>Loading trace…</div>}

      {!loading && groups.length === 0 && (
        <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: 12 }}>
          No conversation traces yet. Send a message in the Chat tab to see agent steps here.
        </div>
      )}

      {!loading && groups.map(group => {
        const expanded = expandedConvs.has(group.conversationId);
        const totalMs = group.entries.reduce((s, e) => s + (e.duration_ms ?? 0), 0);
        const hasError = group.entries.some(e => !!e.error);

        return (
          <div key={group.conversationId} style={{ marginBottom: 8, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
            {/* Conversation header */}
            <button
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'rgba(255,255,255,0.03)', border: 'none', cursor: 'pointer', textAlign: 'left' }}
              onClick={() => toggleConv(group.conversationId)}
            >
              <span style={{ fontSize: 13, color: '#94a3b8', transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'none' }}>▶</span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--vscode-foreground, #e2e8f0)', flex: 1 }}>
                Conv {group.conversationId.slice(0, 12)}…
              </span>
              <span style={{ fontSize: 10.5, color: '#64748b' }}>{group.entries.length} steps</span>
              <span style={{ fontSize: 10.5, color: '#818cf8', marginLeft: 6 }}>{fmtMs(totalMs)}</span>
              {hasError && <span style={{ fontSize: 10, background: 'rgba(239,68,68,0.12)', color: '#f87171', padding: '1px 6px', borderRadius: 4 }}>error</span>}
              <span style={{ fontSize: 10, color: '#475569', marginLeft: 6 }}>{group.firstAt ? new Date(group.firstAt).toLocaleTimeString() : ''}</span>
            </button>

            {/* Steps */}
            {expanded && (
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                {group.entries.map((e, idx) => {
                  const meta = stageMeta(e.stage ?? '');
                  const entryExpanded = expandedEntries.has(e.audit_id ?? idx);
                  return (
                    <div key={e.audit_id ?? idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <button
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 18px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                        onClick={() => toggleEntry(e.audit_id ?? idx)}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: meta.color }}><meta.icon size={13} /></span>
                        <span style={{ fontSize: 10.5, fontWeight: 600, color: meta.color, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.stage}</span>
                        <span style={{ fontSize: 10, color: '#64748b', marginLeft: 4 }}>{shortModel(e.model)}</span>
                        <span style={{ fontSize: 10, color: '#818cf8', marginLeft: 8, flexShrink: 0 }}>{fmtMs(e.duration_ms)}</span>
                        {e.error && <span style={{ fontSize: 10, color: '#f87171', marginLeft: 4 }}>err</span>}
                        <span style={{ fontSize: 10, color: '#475569', transition: 'transform 0.1s', transform: entryExpanded ? 'rotate(90deg)' : 'none', flexShrink: 0 }}>▶</span>
                      </button>
                      {entryExpanded && (
                        <div style={{ padding: '8px 18px 12px 40px' }}>
                          {e.user_prompt && (
                            <div style={{ marginBottom: 8 }}>
                              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 600, marginBottom: 3 }}>USER PROMPT</div>
                              <pre style={{ margin: 0, fontSize: 10.5, fontFamily: 'ui-monospace,monospace', color: '#94a3b8', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 100, overflowY: 'auto', background: 'rgba(255,255,255,0.03)', borderRadius: 5, padding: '6px 8px' }}>{e.user_prompt.slice(0, 500)}{e.user_prompt.length > 500 ? '…' : ''}</pre>
                            </div>
                          )}
                          {e.response_payload && (
                            <div style={{ marginBottom: 8 }}>
                              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 600, marginBottom: 3 }}>RESPONSE</div>
                              <pre style={{ margin: 0, fontSize: 10.5, fontFamily: 'ui-monospace,monospace', color: '#4ade80', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 100, overflowY: 'auto', background: 'rgba(255,255,255,0.03)', borderRadius: 5, padding: '6px 8px' }}>{e.response_payload.slice(0, 500)}{e.response_payload.length > 500 ? '…' : ''}</pre>
                            </div>
                          )}
                          {e.error && (
                            <div>
                              <div style={{ fontSize: 10, color: '#f87171', fontWeight: 600, marginBottom: 3 }}>ERROR</div>
                              <pre style={{ margin: 0, fontSize: 10.5, fontFamily: 'ui-monospace,monospace', color: '#f87171', whiteSpace: 'pre-wrap', background: 'rgba(239,68,68,0.05)', borderRadius: 5, padding: '6px 8px' }}>{e.error}</pre>
                            </div>
                          )}
                          {e.meta && (
                            <div style={{ marginTop: 6, fontSize: 10, color: '#475569' }}>
                              meta: <code>{e.meta.slice(0, 200)}</code>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
