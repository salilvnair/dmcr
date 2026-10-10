/**
 * AI tools on the Runner's change list (/status):
 *   pending change → Gate (D19.1), Perf (D18.12), Blast Radius (D19.4), Blue/Green (D19.5),
 *                    Compliance (D19.7), Canary (D19.9)
 *   applied change → Health Check (D19.6)
 *   list header    → Optimize Order (D19.3) for the pending changes, plus the database server
 *                    the DB-querying tools run against.
 * One provider per list holds the state, the message listener and the result modal.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ButtonView, CheckboxView, CheckIcon, WarningTriangleIcon, ChipView, CopyIcon, SelectInputView, CheckCircleIcon, XCircleIcon, OrderedListIcon, SandClockIcon, ModalView, TrafficLightIcon, ZapIcon, TargetGoalIcon, SplitVerticalIcon, ScaleBalanceIcon, FeatureFlagIcon, HealthCheckIcon, RefreshIcon } from '@salilvnair/dui';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import sqlLang from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { postMsg } from '../../../vscode';
import { ChangeIdLabel } from './ChangeIdLabel';
import './ChangeAiTools.css';

SyntaxHighlighter.registerLanguage('sql', sqlLang);
import { useAiFeatures } from '../../../utils/aiFeatures';

type Kind = 'gate' | 'perf' | 'blast' | 'bluegreen' | 'compliance' | 'canary' | 'health';
type AnyRec = Record<string, unknown>;

const KINDS: Record<Kind, { scenario: string; icon: ComponentType<{ size?: number }>; label: string; title: string; hint: string; color: string; request: string; result: string; usesDb?: boolean }> = {
  gate:       { scenario: 'AI_PROMOTION_GATEKEEPER', icon: TrafficLightIcon, label: 'Gate',     title: 'AI Promotion Gatekeeper', hint: 'Pre-flight checklist before promoting to prod (meta.json, revert.sql, dependencies, SQL policies)', color: 'var(--dm-c-a5b4fc)', request: 'promotionGatekeep', result: 'promotionGatekeeperResult' },
  perf:       { scenario: 'AI_PERF_PREDICTOR',       icon: ZapIcon, label: 'Perf',     title: 'AI Performance Impact',   hint: 'Lock type, duration and whether it blocks traffic (reads table size)', color: 'var(--dm-c-fbbf24)', request: 'predictPerformanceImpact', result: 'performanceImpactResult', usesDb: true },
  blast:      { scenario: 'AI_BLAST_RADIUS',       icon: TargetGoalIcon, label: 'Blast',      title: 'AI Blast Radius',        hint: 'What else this change locks or breaks (queries pg_depend)', color: 'var(--dm-c-f87171)', request: 'estimateBlastRadius',  result: 'blastRadiusResult',     usesDb: true },
  bluegreen:  { scenario: 'AI_BLUE_GREEN_PLAN',    icon: SplitVerticalIcon, label: 'Blue/Green', title: 'AI Blue/Green Plan',     hint: 'Split a breaking change into two zero-downtime phases',        color: 'var(--dm-c-22d3ee)', request: 'blueGreenPlan',        result: 'blueGreenPlanResult' },
  compliance: { scenario: 'AI_COMPLIANCE_CHECKER', icon: ScaleBalanceIcon, label: 'Compliance', title: 'AI Compliance Check',     hint: 'Check deploy.sql against GDPR / SOC 2 / HIPAA rules',          color: 'var(--dm-c-fbbf24)', request: 'checkCompliance',      result: 'complianceCheckResult' },
  canary:     { scenario: 'AI_CANARY_ADVISOR',     icon: FeatureFlagIcon, label: 'Canary',     title: 'AI Canary Rollout',      hint: 'Whether and how to roll out a large-table change gradually',   color: 'var(--dm-c-fb923c)', request: 'canaryRolloutAdvisor', result: 'canaryRolloutResult',   usesDb: true },
  health:     { scenario: 'AI_POST_DEPLOY_HEALTH', icon: HealthCheckIcon, label: 'Health',     title: 'AI Post-Deploy Health',  hint: 'Run AI-written read-only checks against the database',         color: 'var(--dm-c-4ade80)', request: 'postDeployHealthCheck', result: 'postDeployHealthResult', usesDb: true },
};
const PENDING_KINDS: Kind[] = ['gate', 'perf', 'blast', 'bluegreen', 'compliance', 'canary'];
const APPLIED_KINDS: Kind[] = ['health'];
const COMPLIANCE_PROFILES = ['GDPR', 'SOC 2', 'HIPAA']; // the profiles checkCompliance has rules for

/** A tool's dui icon next to its plain-text label. */
function IconLabel({ kind, size, text }: { kind: Kind; size: number; text: string }) {
  const Icon = KINDS[kind].icon;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon size={size} />{text}</span>;
}

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
/** env: the --env the /status ran against; preselects the MCP server whose name contains it. */
export function ChangeAiProvider({ pendingIds, env, children }: { pendingIds: string[]; env?: string; children: ReactNode }) {
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
  // "Gate all pending": one change at a time, results land on the chips without opening a popup
  const [batch, setBatch] = useState<{ total: number; done: number; ids: string[] } | null>(null);
  const batchQueue = useRef<string[]>([]);
  const quiet = useRef<Set<string>>(new Set());

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as { type?: string; payload?: AnyRec };
      if (!msg?.type) return;
      if (msg.type === 'dbMcpServers') {
        const list = ((msg.payload?.servers ?? []) as { id: string; name: string }[]);
        setServers(list);
        const forEnv = env ? list.find(s => new RegExp(`(^|[^a-z0-9])${env.replace(/[^a-z0-9]/gi, '')}([^a-z0-9]|$)`, 'i').test(s.name)) : undefined;
        setServerId(prev => prev || forEnv?.id || list[0]?.id || '');
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
      if (quiet.current.has(key)) {
        quiet.current.delete(key);
        setBatch(b => (b ? { ...b, done: b.done + 1 } : b));
        nextInBatch.current();
        return;
      }
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
    const base = kind === 'gate' ? { targetEnv: 'prod' } : { serverId };
    postMsg({ type: KINDS[kind].request, payload: { changeName: changeId, ...base, ...extra } });
  }, [serverId]);

  const nextInBatch = useRef<() => void>(() => {});
  nextInBatch.current = () => {
    const id = batchQueue.current.shift();
    if (!id) return;
    quiet.current.add(keyOf('gate', id));
    send('gate', id);
  };
  const runGateAll = () => {
    if (batch && batch.done < batch.total) return;
    batchQueue.current = [...pendingIds];
    setBatch({ total: pendingIds.length, done: 0, ids: [...pendingIds] });
    nextInBatch.current();
  };
  const batchRunning = !!batch && batch.done < batch.total;
  const gateVerdicts = batch && !batchRunning
    ? batch.ids.map(id => results[keyOf('gate', id)]).filter(Boolean).map(r => (r!.allPassed ? 'go' : 'blocked'))
    : [];
  const goCount = gateVerdicts.filter(v => v === 'go').length;
  const blockedCount = gateVerdicts.length - goCount;

  const run = useCallback((kind: Kind, changeId: string) => {
    const key = keyOf(kind, changeId);
    if (results[key] || loading.has(key)) { setOpen({ kind, changeId }); return; }
    if (kind === 'compliance') { setOpen({ kind, changeId }); return; } // pick profiles first
    send(kind, changeId);
  }, [results, loading, send]);

  const ctx = useMemo<Ctx>(() => ({ isOn, results, loading, run }), [isOn, results, loading, run]);

  const anyDbTool = (Object.keys(KINDS) as Kind[]).some(k => KINDS[k].usesDb && isOn(KINDS[k].scenario));
  const showOrder = isOn('AI_PROMOTION_ORDER') && pendingIds.length >= 2;
  const showGateAll = isOn(KINDS.gate.scenario) && pendingIds.length >= 2;

  return (
    <ChangeAiCtx.Provider value={ctx}>
      {(anyDbTool || showOrder || showGateAll) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '6px 0', fontSize: 10.5, color: 'var(--dm-c-94a3b8)' }}>
          {anyDbTool && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 5 }} title="Database the Perf, Blast Radius, Canary and Health checks query (read-only, through MCP)">
              AI checks query
              <span style={{ minWidth: 220, fontSize: 10.5 }}>
                <SelectInputView size="md"
                  width="100%"
                  options={[{ value: '', label: 'Auto (first MCP server with run_readonly_query)' }, ...servers.map(s => ({ value: s.id, label: s.name }))]}
                  value={serverId}
                  onChange={setServerId}
                />
              </span>
            </label>
          )}
          {showGateAll && (
            <ButtonView variant="secondary" color={KINDS.gate.color} loading={batchRunning}
              title={batchRunning ? 'Gate is checking the pending changes one at a time; click a chip to open its result' : 'Run the AI Promotion Gatekeeper on every pending change, one at a time (no popups; click a chip to open its result)'}
              onClick={runGateAll}
              iconLeft={<TrafficLightIcon size={12} />}
              label={batchRunning ? `Gate ${batch!.done + 1}/${batch!.total}…`
                : batch ? `Gate: ${goCount} GO${blockedCount ? ` · ${blockedCount} BLOCKED` : ''}`
                : `Gate all pending (${pendingIds.length})`}
            />
          )}
          {showOrder && (
            <ButtonView variant="secondary" color="var(--dm-c-a78bfa)" disabled={orderLoading} loading={orderLoading}
              title="AI Promotion Order Optimizer — safest apply order for the pending changes"
              onClick={() => {
                if (order && !orderLoading) { setOpen({ kind: 'order' }); return; }
                askedOrder.current = true; setOrderLoading(true);
                postMsg({ type: 'optimizePromotionOrder', payload: { changeNames: pendingIds } });
              }}
              iconLeft={<OrderedListIcon size={12} />}
              label={orderLoading ? 'Ordering…' : `Optimize order (${pendingIds.length} pending)`}
            />
          )}
        </div>
      )}
      {children}
      {open && (
        <ModalView
          open
          onClose={() => setOpen(null)}
          title={open.kind === 'order' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><OrderedListIcon size={15} />AI Promotion Order</span> : <IconLabel kind={open.kind} size={15} text={KINDS[open.kind].title} />}
          headerColor={open.kind === 'order' ? 'var(--dm-c-a78bfa)' : KINDS[open.kind].color}
          size="xl"
          maxHeight="75vh"
          // minHeight 0: a flex child does not shrink below its content otherwise, so the body never scrolled
          bodyStyle={{ minHeight: 0 }}
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

/** One width for the actions column in every row, so the Status column lines up. */
export function useChangeAiColumn(): string {
  const ctx = useContext(ChangeAiCtx);
  if (!ctx) return '0px';
  if (PENDING_KINDS.some(k => ctx.isOn(KINDS[k].scenario))) return '560px'; // fixed, so the Change column never changes width with the buttons
  if (APPLIED_KINDS.some(k => ctx.isOn(KINDS[k].scenario))) return '120px';
  return '0px';
}

// ── Row buttons ───────────────────────────────────────────────────────────────
export function ChangeAiRowActions({ changeId, status }: { changeId: string; status: string }) {
  const ctx = useContext(ChangeAiCtx);
  if (!ctx) return null;
  const kinds = (status === 'applied' ? APPLIED_KINDS : status === 'pending' ? PENDING_KINDS : [])
    .filter(k => ctx.isOn(KINDS[k].scenario));
  if (kinds.length === 0) return null;
  return (
    <span className="cv-ai-chips">
      {kinds.map(k => {
        const key = keyOf(k, changeId);
        const busy = ctx.loading.has(key);
        const done = !!ctx.results[key];
        const Icon = KINDS[k].icon;
        return (
          <span key={k} title={`${KINDS[k].title}: ${KINDS[k].hint}${done ? ' (result ready: click to open)' : ''}`} className={`cv-ai-chip${done ? ' is-done' : ''}`}>
            <ChipView
              size="sm"
              rounded={false}
              label={busy ? `${KINDS[k].label}…` : KINDS[k].label}
              color={KINDS[k].color}
              bg={done ? `color-mix(in srgb, ${KINDS[k].color} 22%, transparent)` : undefined}
              icon={busy ? <SandClockIcon size={13} /> : done ? <CheckCircleIcon size={13} /> : <Icon size={13} />}
              onClick={() => ctx.run(k, changeId)}
            />
          </span>
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
  // Gate reports failures in its verdict ("Error: …") rather than an error field
  const err = (result?.error as string | undefined)
    ?? (kind === 'gate' && typeof result?.verdict === 'string' && result.verdict.startsWith('Error:') ? result.verdict : undefined);
  return (
    <div className="cai-body" style={{ ['--cai-c' as string]: color }}>
      <div className="cai-change"><ChangeIdLabel id={changeId} /></div>

      {kind === 'compliance' && !isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          {COMPLIANCE_PROFILES.map(p => (
            <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <CheckboxView checked={profiles.includes(p)} size="sm"
                onChange={checked => setProfiles(checked ? [...profiles, p] : profiles.filter(x => x !== p))} />
              {p}
            </label>
          ))}
          <ButtonView variant="secondary" color={color} disabled={profiles.length === 0} onClick={onRun}
            label={result ? 'Check again' : 'Check'} />
        </div>
      )}

      {isLoading && <Thinking color={color} />}
      {!isLoading && err && <div style={{ color: 'var(--dm-c-f87171)' }}>{err}</div>}
      {!isLoading && result && !err && kind === 'gate' && <GateBody r={result} />}
      {!isLoading && result && !err && kind === 'perf' && <PerfBody p={(result.prediction ?? {}) as AnyRec} />}
      {!isLoading && result && !err && kind === 'blast' && <BlastBody r={result} />}
      {!isLoading && result && !err && kind === 'bluegreen' && <BlueGreenBody plan={(result.plan ?? {}) as AnyRec} />}
      {!isLoading && result && !err && kind === 'compliance' && <ComplianceBody r={result} />}
      {!isLoading && result && !err && kind === 'canary' && <CanaryBody a={(result.advice ?? {}) as AnyRec} />}
      {!isLoading && result && !err && kind === 'health' && <HealthBody a={(result.assessment ?? {}) as AnyRec} />}

      {!isLoading && result && kind !== 'compliance' && (
        <div style={{ marginTop: 12 }}>
          <ButtonView variant="secondary" color={color} onClick={onRun} iconLeft={<RefreshIcon size={12} />} label="Run again" />
        </div>
      )}
    </div>
  );
}

function GateBody({ r }: { r: AnyRec }) {
  const checks = (Array.isArray(r.checks) ? r.checks : []) as AnyRec[];
  const ok = !!r.allPassed;
  return (
    <div>
      <Verdict tone={ok ? 'ok' : 'bad'} word={ok ? 'GO' : 'BLOCKED'} text={r.verdict} />
      <div className="cai-rows">
        {checks.map((c, i) => (
          <Row key={i} tone={c.passed ? 'ok' : 'bad'}>
            <span className="cai-row-name">{String(c.name ?? '')}</span>
            <span className="cai-row-text"><Rich text={String(c.detail ?? '')} /></span>
          </Row>
        ))}
      </div>
    </div>
  );
}

function PerfBody({ p }: { p: AnyRec }) {
  const rec = String(p.recommendation ?? '—');
  return (
    <div>
      <Stats items={[
        ['Lock type', String(p.lockType ?? '—'), 'var(--dm-c-fbbf24)'],
        ['Concurrent safe', p.isConcurrentlySafe ? 'Yes' : 'No', p.isConcurrentlySafe ? 'var(--dm-c-4ade80)' : 'var(--dm-c-f87171)'],
        ['Blocks traffic', p.blocksApplicationTraffic ? 'Yes' : 'No', p.blocksApplicationTraffic ? 'var(--dm-c-f87171)' : 'var(--dm-c-4ade80)'],
        ['Est. duration', p.estimatedDurationMs != null ? `${p.estimatedDurationMs} ms` : '—'],
        ['Recommendation', rec, rec === 'SAFE' ? 'var(--dm-c-4ade80)' : 'var(--dm-c-f87171)'],
      ]} />
      <Text label="Lock" value={p.lockDescription} />
      <Text label="Details" value={p.details} />
    </div>
  );
}

function BlastBody({ r }: { r: AnyRec }) {
  const risk = String(r.riskLevel ?? '—');
  return (
    <div>
      <Stats items={[
        ['Risk', risk, risk === 'high' ? 'var(--dm-c-f87171)' : risk === 'medium' ? 'var(--dm-c-fbbf24)' : 'var(--dm-c-4ade80)'],
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
        ['Breaking change', plan.isBreakingChange === false ? 'No' : 'Yes', plan.isBreakingChange === false ? 'var(--dm-c-4ade80)' : 'var(--dm-c-fbbf24)'],
        ['Est. downtime', String(plan.estimatedDowntime ?? '—')],
      ]} />
      <Phase n={1} title="Before the app deploy" text={p1.description} sql={p1.sql} />
      <Phase n={2} title="After the app deploy" text={p2.description} sql={p2.sql} />
      <Text label="Application team" value={plan.applicationInstructions} />
    </div>
  );
}

function ComplianceBody({ r }: { r: AnyRec }) {
  const violations = (Array.isArray(r.violations) ? r.violations : []) as AnyRec[];
  return (
    <div>
      <Verdict tone={r.passed ? 'ok' : 'bad'} word={r.passed ? (violations.length ? 'No errors' : 'Compliant') : 'Violations found'}
        text={r.passed && violations.length ? 'warnings below' : undefined} />
      <div className="cai-rows">
        {violations.map((v, i) => {
          const sev = String(v.severity ?? 'warning');
          return (
            <Row key={i} tone={sev === 'error' ? 'bad' : 'warn'}>
              <div className="cai-row-main">
                <div className="cai-row-tags">
                  <span className="cai-tag" data-tone={sev === 'error' ? 'bad' : 'warn'}>{sev}</span>
                  {!!v.profile && <span className="cai-tag" data-tone="info">{String(v.profile)}</span>}
                  <span className="cai-row-name">{String(v.rule ?? '')}</span>
                </div>
                <div className="cai-row-text"><Rich text={String(v.violation ?? '')} /></div>
                {!!v.remediation && <div className="cai-fix"><b>Fix</b><span><Rich text={String(v.remediation)} /></span></div>}
              </div>
            </Row>
          );
        })}
      </div>
    </div>
  );
}

function CanaryBody({ a }: { a: AnyRec }) {
  return (
    <div>
      <Stats items={[
        ['Canary', a.recommendCanary ? 'Recommended' : 'Not needed', a.recommendCanary ? 'var(--dm-c-fbbf24)' : 'var(--dm-c-4ade80)'],
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
  const tone = (st: string): Tone => (/fail|critical/i.test(st) ? 'bad' : /warn/i.test(st) ? 'warn' : 'ok');
  return (
    <div>
      <Verdict tone={tone(status)} word={status} text={a.summary} />
      <div className="cai-rows">
        {checks.map((c, i) => (
          <Row key={i} tone={tone(String(c.status ?? ''))}>
            <div className="cai-row-main">
              <div className="cai-row-text"><Rich text={String(c.finding ?? '')} /></div>
              <Sql sql={c.query} compact />
            </div>
          </Row>
        ))}
      </div>
      <List label="Recommendations" items={a.recommendations} />
    </div>
  );
}

function OrderBody({ order }: { order: AnyRec | null }) {
  if (!order) return <Thinking color="var(--dm-c-a78bfa)" />;
  const ordered = (Array.isArray(order.orderedChanges) ? order.orderedChanges : []) as string[];
  const conflicts = (Array.isArray(order.conflicts) ? order.conflicts : []) as AnyRec[];
  return (
    <div className="cai-body" style={{ ['--cai-c' as string]: 'var(--dm-c-a78bfa)' }}>
      <div className="cai-label">Suggested order</div>
      <ol className="cai-order">
        {ordered.map((c, i) => <li key={c}><span className="cai-order-num">{i + 1}</span><ChangeIdLabel id={c} /></li>)}
      </ol>
      {conflicts.length > 0 && (
        <div className="cai-section">
          <div className="cai-label cai-label--warn">Conflicts</div>
          <div className="cai-rows">
            {conflicts.map((c, i) => (
              <Row key={i} tone="warn">
                <div className="cai-row-main">
                  <div className="cai-pair">
                    {(Array.isArray(c.between) ? c.between : []).map((id: unknown, j: number) => (
                      <span key={String(id)} className="cai-pair-item">{j > 0 && <span className="cai-pair-sep">and</span>}<ChangeIdLabel id={String(id)} /></span>
                    ))}
                  </div>
                  <div className="cai-row-text"><Rich text={String(c.reason ?? '')} /></div>
                </div>
              </Row>
            ))}
          </div>
        </div>
      )}
      <Text label="Why" value={order.explanation} />
      <div className="cai-note">DMCR deploys in folder-number order. To apply this order, renumber the folders; this tool changes nothing.</div>
    </div>
  );
}

// ── Small pieces ──────────────────────────────────────────────────────────────
type Tone = 'ok' | 'warn' | 'bad';
const TONE_ICON: Record<Tone, (size: number) => ReactNode> = {
  ok: n => <CheckCircleIcon size={n} />, warn: n => <WarningTriangleIcon size={n} />, bad: n => <XCircleIcon size={n} />,
};

/** The headline result: a big colored word and the AI's one-line verdict. */
function Verdict({ tone, word, text }: { tone: Tone; word: string; text?: unknown }) {
  return (
    <div className={`cai-verdict is-${tone}`}>
      <span className="cai-verdict-word">{TONE_ICON[tone](15)}{word}</span>
      {!!text && <span className="cai-verdict-text"><Rich text={String(text)} /></span>}
    </div>
  );
}

function Row({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <div className={`cai-row is-${tone}`}><span className="cai-row-icon">{TONE_ICON[tone](13)}</span>{children}</div>;
}

const RICH = /(\*\*[^*\n]+\*\*|`[^`\n]+`|(?<![\w-])\d{3}_[a-z0-9_]+\b|(?<![\w-])\d{3}(?:\/\d{3})+\b|(?<![\w-])\d{3}\b(?![\d.-])|\b[A-Z][A-Z0-9]+-\d+\b|\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b|\bL\d{3}(?:\.\.L\d{3})?\b|\b(?:SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|INDEX|TABLE|TRIGGER|ENUM|COMMIT|BEGIN|ROLLBACK|IF NOT EXISTS|NOT NULL|PRIMARY KEY|UNIQUE|ACCESS EXCLUSIVE|ACCESS SHARE|ROW EXCLUSIVE)\b|\b\d+(?:\.\d+)?\s?(?:ms|seconds|second|min|minutes|rows|row|%)(?!\w))/g;
/** AI prose with change ids, tickets, schema.table names, row keys, SQL words and amounts in color. */
function Rich({ text }: { text: string }) {
  const parts = text.split(RICH);
  return <>{parts.map((p, i) => {
    if (i % 2 === 0 || !p) return p;
    if (p.startsWith('**')) return <b key={i} className="cai-r-bold"><Rich text={p.slice(2, -2)} /></b>;
    if (p.startsWith('`')) {
      const inner = p.slice(1, -1);
      return <code key={i} className={/^\d{3}_/.test(inner) ? 'cai-r-code cai-r-id' : 'cai-r-code'}>{inner}</code>;
    }
    const cls = /^\d{3}/.test(p) ? 'cai-r-id'
      : /^[A-Z][A-Z0-9]+-\d+$/.test(p) ? 'cai-r-ticket'
      : /^L\d{3}/.test(p) ? 'cai-r-key'
      : /^[a-z_]/.test(p) ? 'cai-r-obj'
      : /^[A-Z]/.test(p) ? 'cai-r-kw'
      : 'cai-r-num';
    return <span key={i} className={cls}>{p}</span>;
  })}</>;
}
function Thinking({ color }: { color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 0', color: 'var(--dm-c-64748b)', fontSize: 12 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, animation: 'pulse 1.2s ease-in-out infinite' }} />
      Analyzing…
    </div>
  );
}

function Stats({ items }: { items: [string, string, string?][] }) {
  return (
    <div className="cai-stats">
      {items.map(([label, value, color]) => (
        <div key={label} className="cai-stat">
          <div className="cai-stat-label">{label}</div>
          <div className="cai-stat-value" style={{ color: color ?? 'var(--dm-c-e2e8f0)' }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function List({ label, items }: { label: string; items: unknown }) {
  const list = Array.isArray(items) ? items.map(String) : [];
  if (list.length === 0) return null;
  return (
    <div className="cai-section">
      <div className="cai-label">{label}</div>
      <div className="cai-list">{list.map(x => <code key={x}>{x}</code>)}</div>
    </div>
  );
}

function Text({ label, value }: { label: string; value: unknown }) {
  if (value == null || value === '') return null;
  return (
    <div className="cai-section">
      <div className="cai-label">{label}</div>
      <div className="cai-text"><Rich text={String(value)} /></div>
    </div>
  );
}

/** One phase of a plan: number, title, what it does, its SQL. */
function Phase({ n, title, text, sql }: { n: number; title: string; text: unknown; sql: unknown }) {
  if (!text && !sql) return null;
  return (
    <div className="cai-phase">
      <div className="cai-phase-head"><span className="cai-phase-num">{n}</span><span className="cai-phase-title">Phase {n}: {title}</span></div>
      {!!text && <div className="cai-text"><Rich text={String(text)} /></div>}
      <Sql sql={sql} />
    </div>
  );
}

/** SQL in color with a header bar and a copy icon; the modal is the only scroller. */
function Sql({ sql, compact }: { sql: unknown; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (typeof sql !== 'string' || !sql.trim()) return null;
  return (
    <div className={`cai-sql${compact ? ' cai-sql--compact' : ''}`}>
      <div className="cai-sql-head">
        <span>SQL</span>
        <button type="button" className="cai-sql-copy" title={copied ? 'Copied' : 'Copy SQL'} aria-label="Copy SQL"
          onClick={() => { navigator.clipboard?.writeText(sql).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); }}>
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        </button>
      </div>
      <SyntaxHighlighter language="sql" style={vscDarkPlus} wrapLongLines
        customStyle={{ margin: 0, padding: compact ? '8px 12px' : '10px 14px', background: 'transparent', fontSize: compact ? 11.5 : 12.5, lineHeight: 1.6 }}>
        {sql.trim()}
      </SyntaxHighlighter>
    </div>
  );
}
