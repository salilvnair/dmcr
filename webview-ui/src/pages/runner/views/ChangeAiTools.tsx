/**
 * AI tools on the Runner's change list (/status):
 *   pending change → 💥 Blast Radius (D19.4), 🔵 Blue/Green (D19.5), ⚖ Compliance (D19.7), 🐤 Canary (D19.9)
 *   applied change → 🩺 Health Check (D19.6)
 *   list header    → ⇅ Optimize Order (D19.3) for the pending changes, plus the database server
 *                    the DB-querying tools run against.
 * One provider per list holds the state, the message listener and the result modal.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ModalView } from '@salilvnair/dui';
import { postMsg } from '../../../vscode';
import { useAiFeatures } from '../../../utils/aiFeatures';

type Kind = 'blast' | 'bluegreen' | 'compliance' | 'canary' | 'health';
type AnyRec = Record<string, unknown>;

const KINDS: Record<Kind, { scenario: string; label: string; title: string; hint: string; color: string; request: string; result: string; usesDb?: boolean }> = {
  blast:      { scenario: 'AI_BLAST_RADIUS',       label: '💥 Blast',      title: '💥 AI Blast Radius',        hint: 'What else this change locks or breaks (queries pg_depend)', color: '#f87171', request: 'estimateBlastRadius',  result: 'blastRadiusResult',     usesDb: true },
  bluegreen:  { scenario: 'AI_BLUE_GREEN_PLAN',    label: '🔵 Blue/Green', title: '🔵 AI Blue/Green Plan',     hint: 'Split a breaking change into two zero-downtime phases',        color: '#22d3ee', request: 'blueGreenPlan',        result: 'blueGreenPlanResult' },
  compliance: { scenario: 'AI_COMPLIANCE_CHECKER', label: '⚖ Compliance', title: '⚖ AI Compliance Check',     hint: 'Check deploy.sql against GDPR / SOC 2 / HIPAA rules',          color: '#fbbf24', request: 'checkCompliance',      result: 'complianceCheckResult' },
  canary:     { scenario: 'AI_CANARY_ADVISOR',     label: '🐤 Canary',     title: '🐤 AI Canary Rollout',      hint: 'Whether and how to roll out a large-table change gradually',   color: '#fb923c', request: 'canaryRolloutAdvisor', result: 'canaryRolloutResult',   usesDb: true },
  health:     { scenario: 'AI_POST_DEPLOY_HEALTH', label: '🩺 Health',     title: '🩺 AI Post-Deploy Health',  hint: 'Run AI-written read-only checks against the database',         color: '#4ade80', request: 'postDeployHealthCheck', result: 'postDeployHealthResult', usesDb: true },
};
const PENDING_KINDS: Kind[] = ['blast', 'bluegreen', 'compliance', 'canary'];
const APPLIED_KINDS: Kind[] = ['health'];
const COMPLIANCE_PROFILES = ['GDPR', 'SOC 2', 'HIPAA']; // the profiles checkCompliance has rules for

type Open = { kind: Kind; changeId: string } | { kind: 'order' } | null;

interface Ctx {
  isOn: (scenario: string) => boolean;
  results: Record<string, AnyRec>;
  loading: Set<string>;
  run: (kind: Kind, changeId: string) => void;
}
const ChangeAiCtx = createContext<Ctx | null>(null);
const keyOf = (kind: Kind, changeId: string) => `${kind}:${changeId}`;

// ── Provider ──────────────────────────────────────────────────────────────────
export function ChangeAiProvider({ pendingIds, children }: { pendingIds: string[]; children: ReactNode }) {
  const isOn = useAiFeatures();
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [serverId, setServerId] = useState('');
  const [results, setResults] = useState<Record<string, AnyRec>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<AnyRec | null>(null);
  const [orderLoading, setOrderLoading] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [profiles, setProfiles] = useState<string[]>(COMPLIANCE_PROFILES);
  // Only accept results this list asked for (several /status cards can be on screen).
  const asked = useRef<Set<string>>(new Set());
  const askedOrder = useRef(false);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as { type?: string; payload?: AnyRec };
      if (!msg?.type) return;
      if (msg.type === 'dbMcpServers') {
        const list = ((msg.payload?.servers ?? []) as { id: string; name: string }[]);
        setServers(list);
        setServerId(prev => prev || list[0]?.id || '');
        return;
      }
      if (msg.type === 'promotionOrderResult' && askedOrder.current) {
        askedOrder.current = false;
        setOrder(msg.payload ?? {});
        setOrderLoading(false);
        setOpen({ kind: 'order' });
        return;
      }
      const kind = (Object.keys(KINDS) as Kind[]).find(k => KINDS[k].result === msg.type);
      const changeId = msg.payload?.changeName as string | undefined;
      if (!kind || !changeId) return;
      const key = keyOf(kind, changeId);
      if (!asked.current.has(key)) return;
      asked.current.delete(key);
      setResults(prev => ({ ...prev, [key]: msg.payload ?? {} }));
      setLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
      setOpen({ kind, changeId });
    };
    window.addEventListener('message', handler);
    postMsg({ type: 'getDbMcpServers' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const send = useCallback((kind: Kind, changeId: string, extra: AnyRec = {}) => {
    const key = keyOf(kind, changeId);
    asked.current.add(key);
    setLoading(prev => new Set(prev).add(key));
    setResults(prev => { const n = { ...prev }; delete n[key]; return n; });
    // '' lets the extension use the first MCP server that has run_readonly_query
    postMsg({ type: KINDS[kind].request, payload: { changeName: changeId, serverId, ...extra } });
  }, [serverId]);

  const run = useCallback((kind: Kind, changeId: string) => {
    const key = keyOf(kind, changeId);
    if (results[key] || loading.has(key)) { setOpen({ kind, changeId }); return; }
    if (kind === 'compliance') { setOpen({ kind, changeId }); return; } // pick profiles first
    send(kind, changeId);
  }, [results, loading, send]);

  const ctx = useMemo<Ctx>(() => ({ isOn, results, loading, run }), [isOn, results, loading, run]);

  const anyDbTool = (Object.keys(KINDS) as Kind[]).some(k => KINDS[k].usesDb && isOn(KINDS[k].scenario));
  const showOrder = isOn('AI_PROMOTION_ORDER') && pendingIds.length >= 2;

  return (
    <ChangeAiCtx.Provider value={ctx}>
      {(anyDbTool || showOrder) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '6px 0', fontSize: 10.5, color: '#94a3b8' }}>
          {anyDbTool && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 5 }} title="Database the Blast Radius, Canary and Health checks query (read-only, through MCP)">
              AI checks query
              <select value={serverId} onChange={e => setServerId(e.target.value)}
                style={{ fontSize: 10.5, background: 'rgba(255,255,255,0.05)', color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '1px 4px', fontFamily: 'inherit' }}>
                <option value="">Auto (first MCP server with run_readonly_query)</option>
                {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          {showOrder && (
            <button type="button" disabled={orderLoading}
              title="AI Promotion Order Optimizer — safest apply order for the pending changes"
              onClick={() => {
                if (order && !orderLoading) { setOpen({ kind: 'order' }); return; }
                askedOrder.current = true; setOrderLoading(true);
                postMsg({ type: 'optimizePromotionOrder', payload: { changeNames: pendingIds } });
              }}
              style={btnStyle('#a78bfa', !!order, orderLoading)}
            >{orderLoading ? '⇅ Ordering…' : `⇅ Optimize order (${pendingIds.length} pending)`}</button>
          )}
        </div>
      )}
      {children}
      {open && (
        <ModalView
          open
          onClose={() => setOpen(null)}
          title={open.kind === 'order' ? '⇅ AI Promotion Order' : KINDS[open.kind].title}
          headerColor={open.kind === 'order' ? '#a78bfa' : KINDS[open.kind].color}
          size="md"
        >
          {open.kind === 'order'
            ? <OrderBody order={order} />
            : <ChangeBody
                kind={open.kind}
                changeId={open.changeId}
                result={results[keyOf(open.kind, open.changeId)]}
                isLoading={loading.has(keyOf(open.kind, open.changeId))}
                profiles={profiles}
                setProfiles={setProfiles}
                onRun={() => send(open.kind, open.changeId, open.kind === 'compliance' ? { profiles } : {})}
              />}
        </ModalView>
      )}
    </ChangeAiCtx.Provider>
  );
}

// ── Row buttons ───────────────────────────────────────────────────────────────
export function ChangeAiRowActions({ changeId, status }: { changeId: string; status: string }) {
  const ctx = useContext(ChangeAiCtx);
  if (!ctx) return null;
  const kinds = (status === 'applied' ? APPLIED_KINDS : status === 'pending' ? PENDING_KINDS : [])
    .filter(k => ctx.isOn(KINDS[k].scenario));
  if (kinds.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {kinds.map(k => {
        const key = keyOf(k, changeId);
        const busy = ctx.loading.has(key);
        return (
          <button key={k} type="button" title={KINDS[k].hint} onClick={() => ctx.run(k, changeId)}
            style={btnStyle(KINDS[k].color, !!ctx.results[key], busy)}>
            {busy ? '…' : KINDS[k].label}
          </button>
        );
      })}
    </span>
  );
}

// ── Modal bodies ──────────────────────────────────────────────────────────────
function ChangeBody({ kind, changeId, result, isLoading, profiles, setProfiles, onRun }: {
  kind: Kind; changeId: string; result?: AnyRec; isLoading: boolean;
  profiles: string[]; setProfiles: (p: string[]) => void; onRun: () => void;
}) {
  const color = KINDS[kind].color;
  const err = result?.error as string | undefined;
  return (
    <div style={{ minHeight: 80, fontSize: 11.5, color: '#cbd5e1' }}>
      <div style={{ marginBottom: 10, padding: '3px 8px', borderRadius: 5, background: 'rgba(255,255,255,0.04)', display: 'inline-block', fontFamily: 'monospace', fontSize: 11, color: '#64748b' }}>{changeId}</div>

      {kind === 'compliance' && !isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          {COMPLIANCE_PROFILES.map(p => (
            <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={profiles.includes(p)}
                onChange={e => setProfiles(e.target.checked ? [...profiles, p] : profiles.filter(x => x !== p))} />
              {p}
            </label>
          ))}
          <button type="button" disabled={profiles.length === 0} onClick={onRun} style={btnStyle(color, false, false)}>
            {result ? 'Check again' : 'Check'}
          </button>
        </div>
      )}

      {isLoading && <Thinking color={color} />}
      {!isLoading && err && <div style={{ color: '#f87171' }}>{err}</div>}
      {!isLoading && result && !err && kind === 'blast' && <BlastBody r={result} />}
      {!isLoading && result && !err && kind === 'bluegreen' && <BlueGreenBody plan={(result.plan ?? {}) as AnyRec} />}
      {!isLoading && result && !err && kind === 'compliance' && <ComplianceBody r={result} />}
      {!isLoading && result && !err && kind === 'canary' && <CanaryBody a={(result.advice ?? {}) as AnyRec} />}
      {!isLoading && result && !err && kind === 'health' && <HealthBody a={(result.assessment ?? {}) as AnyRec} />}

      {!isLoading && result && kind !== 'compliance' && (
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={onRun} style={btnStyle(color, false, false)}>↻ Run again</button>
        </div>
      )}
    </div>
  );
}

function BlastBody({ r }: { r: AnyRec }) {
  const risk = String(r.riskLevel ?? '—');
  return (
    <div>
      <Stats items={[
        ['Risk', risk, risk === 'high' ? '#f87171' : risk === 'medium' ? '#fbbf24' : '#4ade80'],
        ['Lock', String(r.lockType ?? '—')],
        ['Est. block', r.estimatedBlockTimeMs != null ? `${r.estimatedBlockTimeMs} ms` : '—'],
      ]} />
      <List label="Affected tables" items={r.affectedTables} />
      <List label="Affected views" items={r.affectedViews} />
      <List label="Affected functions" items={r.affectedFunctions} />
      <Text label="Recommendation" value={r.recommendation} />
    </div>
  );
}

function BlueGreenBody({ plan }: { plan: AnyRec }) {
  const p1 = (plan.phase1 ?? {}) as AnyRec;
  const p2 = (plan.phase2 ?? {}) as AnyRec;
  return (
    <div>
      <Stats items={[
        ['Breaking change', plan.isBreakingChange === false ? 'No' : 'Yes', plan.isBreakingChange === false ? '#4ade80' : '#fbbf24'],
        ['Est. downtime', String(plan.estimatedDowntime ?? '—')],
      ]} />
      <Text label="Phase 1 — before the app deploy" value={p1.description} />
      <Sql sql={p1.sql} />
      <Text label="Phase 2 — after the app deploy" value={p2.description} />
      <Sql sql={p2.sql} />
      <Text label="Application team" value={plan.applicationInstructions} />
    </div>
  );
}

function ComplianceBody({ r }: { r: AnyRec }) {
  const violations = (Array.isArray(r.violations) ? r.violations : []) as AnyRec[];
  return (
    <div>
      <div style={{ fontWeight: 700, color: r.passed ? '#4ade80' : '#f87171', marginBottom: 8 }}>
        {r.passed ? (violations.length ? '✓ No errors (warnings below)' : '✓ No violations found') : '✗ Violations found'}
      </div>
      {violations.map((v, i) => (
        <div key={i} style={{ padding: '6px 8px', borderRadius: 5, background: 'rgba(255,255,255,0.03)', marginBottom: 4 }}>
          <div><b style={{ color: v.severity === 'error' ? '#f87171' : '#fbbf24' }}>{String(v.severity ?? '')}</b> · {String(v.profile ?? '')} · {String(v.rule ?? '')}</div>
          <div style={{ color: '#94a3b8', marginTop: 2 }}>{String(v.violation ?? '')}</div>
          {!!v.remediation && <div style={{ color: '#64748b', marginTop: 2 }}>Fix: {String(v.remediation)}</div>}
        </div>
      ))}
    </div>
  );
}

function CanaryBody({ a }: { a: AnyRec }) {
  return (
    <div>
      <Stats items={[
        ['Canary', a.recommendCanary ? 'Recommended' : 'Not needed', a.recommendCanary ? '#fbbf24' : '#4ade80'],
        ['Table', String(a.tableName ?? '—')],
        ['Est. rows', a.estimatedRows != null ? Number(a.estimatedRows).toLocaleString() : '—'],
        ['First phase', a.phase1Percent != null ? `${a.phase1Percent}%` : '—'],
        ['Phase 1 time', a.estimatedPhase1DurationMin != null ? `${a.estimatedPhase1DurationMin} min` : '—'],
      ]} />
      <List label="Watch" items={a.monitoringMetrics} />
      <Text label="Go on when" value={a.greenLightThreshold} />
      <Sql sql={a.rolloutScript} />
    </div>
  );
}

function HealthBody({ a }: { a: AnyRec }) {
  const status = String(a.status ?? '—');
  const checks = (Array.isArray(a.checks) ? a.checks : []) as AnyRec[];
  return (
    <div>
      <Stats items={[['Status', status, status === 'critical' ? '#f87171' : status === 'warning' ? '#fbbf24' : '#4ade80']]} />
      <Text label="Summary" value={a.summary} />
      {checks.map((c, i) => (
        <div key={i} style={{ padding: '6px 8px', borderRadius: 5, background: 'rgba(255,255,255,0.03)', marginBottom: 4 }}>
          <div style={{ color: c.status === 'fail' ? '#f87171' : c.status === 'warn' ? '#fbbf24' : '#4ade80', fontWeight: 700 }}>{String(c.status ?? '')}</div>
          <code style={{ display: 'block', fontSize: 10.5, color: '#94a3b8', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{String(c.query ?? '')}</code>
          <div style={{ color: '#cbd5e1', marginTop: 2 }}>{String(c.finding ?? '')}</div>
        </div>
      ))}
      <List label="Recommendations" items={a.recommendations} />
    </div>
  );
}

function OrderBody({ order }: { order: AnyRec | null }) {
  if (!order) return <Thinking color="#a78bfa" />;
  const ordered = (Array.isArray(order.orderedChanges) ? order.orderedChanges : []) as string[];
  const conflicts = (Array.isArray(order.conflicts) ? order.conflicts : []) as AnyRec[];
  return (
    <div style={{ fontSize: 11.5, color: '#cbd5e1' }}>
      <ol style={{ margin: '0 0 10px', paddingLeft: 20, fontFamily: 'monospace' }}>
        {ordered.map(c => <li key={c}>{c}</li>)}
      </ol>
      {conflicts.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: '#fbbf24', fontWeight: 700, marginBottom: 4 }}>Conflicts</div>
          {conflicts.map((c, i) => (
            <div key={i} style={{ marginBottom: 3 }}>
              <code>{(Array.isArray(c.between) ? c.between : []).join(' ↔ ')}</code> — {String(c.reason ?? '')}
            </div>
          ))}
        </div>
      )}
      <Text label="Why" value={order.explanation} />
      <div style={{ marginTop: 10, color: '#64748b' }}>
        DMCR deploys in folder-number order. To apply this order, renumber the folders; this tool changes nothing.
      </div>
    </div>
  );
}

// ── Small pieces ──────────────────────────────────────────────────────────────
function btnStyle(color: string, hasResult: boolean, busy: boolean): CSSProperties {
  return {
    fontSize: 9.5, padding: '1px 6px', borderRadius: 4, fontFamily: 'sans-serif', flexShrink: 0,
    border: `1px solid ${color}${hasResult ? '88' : '4d'}`, background: `${color}${hasResult ? '26' : '14'}`,
    color, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1,
  };
}

function Thinking({ color }: { color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 0', color: '#64748b', fontSize: 12 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, animation: 'pulse 1.2s ease-in-out infinite' }} />
      Analyzing…
    </div>
  );
}

function Stats({ items }: { items: [string, string, string?][] }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
      {items.map(([label, value, color]) => (
        <div key={label} style={{ padding: '5px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ color: '#64748b', fontSize: 10, marginBottom: 2 }}>{label}</div>
          <div style={{ color: color ?? '#e2e8f0', fontWeight: 700 }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function List({ label, items }: { label: string; items: unknown }) {
  const list = Array.isArray(items) ? items.map(String) : [];
  if (list.length === 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color: '#64748b', fontSize: 10, marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {list.map(x => <code key={x} style={{ padding: '1px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)' }}>{x}</code>)}
      </div>
    </div>
  );
}

function Text({ label, value }: { label: string; value: unknown }) {
  if (value == null || value === '') return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color: '#64748b', fontSize: 10, marginBottom: 2 }}>{label}</div>
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{String(value)}</div>
    </div>
  );
}

function Sql({ sql }: { sql: unknown }) {
  const [copied, setCopied] = useState(false);
  if (typeof sql !== 'string' || !sql.trim()) return null;
  return (
    <div style={{ position: 'relative', marginBottom: 10 }}>
      <pre style={{ margin: 0, padding: '8px 10px', borderRadius: 6, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)', fontSize: 10.5, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{sql}</pre>
      <button type="button" onClick={() => { navigator.clipboard?.writeText(sql).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); }}
        style={{ position: 'absolute', top: 4, right: 4, fontSize: 9.5, padding: '1px 6px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: '#cbd5e1', cursor: 'pointer' }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
