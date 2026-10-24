import { useEffect, useRef, useState, type ReactNode } from 'react';
import { postMsg } from '../../../vscode';
import { BlockedIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, CloseIcon, CommitIcon, EyeIcon, InboxIcon, MinusIcon, PlusIcon, RedoIcon, ShieldAlertIcon, UserSingleIcon, WarningTriangleIcon, XCircleIcon, CheckCircleIcon } from '@salilvnair/dui';
import { ChangeIdLabel, DetailText, KindChip, PersonChip, ProjectChip, ReleaseChip, WarnText } from './ChangeIdLabel';
import './CommandViews.css';
import { ChangeAiProvider, ChangeAiRowActions, useChangeAiColumn } from './ChangeAiTools';
import { RiskCell, RiskDetail, RiskSummary, riskColor, type RiskState } from './RiskViews';
import { ChangeSqlViewer } from './ChangeSqlViewer';
import { CopyCmd, DiffView, LogView, ShowChangeView } from './GitViews';
import { openChanges } from '../../../components/ChangeViewerHost';
import { ListToolbar, matchesChange, usePager, usePagedRows } from '../../../components/BigList';
import { usePageSize } from '../../../services/listPrefs';

// ── Shared types ──────────────────────────────────────────────────────────────
export interface JsonCommandResult {
  command:  string;
  args:     string[];
  exitCode: number | null;
  data:     unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const ic = (I: (p: { size?: number; style?: React.CSSProperties }) => ReactNode) => <I size={11} style={{ verticalAlign: '-1px' }} />;
function Badge({ status, label }: { status: string; label?: string }) {
  const cls = `cv-badge cv-badge--${status.toLowerCase().replace(/[^a-z]/g, '-')}`;
  const icons: Record<string, ReactNode> = {
    applied: ic(CheckIcon), success: ic(CheckIcon), ok: ic(CheckIcon),
    pending: ic(ClockIcon), manual: ic(UserSingleIcon), superseded: ic(RedoIcon), no_backup: ic(CheckIcon), dropped: ic(BlockedIcon),
    failure: ic(CloseIcon), error: ic(CloseIcon), failed: ic(CloseIcon),
    created: ic(PlusIcon), deleted: ic(CloseIcon),
    'applied-action': ic(CheckIcon),
    'dry-run': ic(EyeIcon), nothing: ic(MinusIcon), setup: ic(MinusIcon),
  };
  const icon = icons[status.toLowerCase()] ?? '';
  // "dropped" reads like deleted: it means not going (skipped by deploys)
  const said: Record<string, string> = { dropped: 'not going', no_backup: 'ok · no backup' };
  return <span className={cls}>{icon && <>{icon}&nbsp;</>}{label ?? said[status.toLowerCase()] ?? status}</span>;
}

function SectionHd({ title }: { title: string }) {
  return (
    <div className="cv-section-hd">
      <span className="cv-section-title">{title}</span>
      <span className="cv-section-line" />
    </div>
  );
}

// A result title written as '✓  text' / '✗  text' rendered with dui icons
function titled(t: ReactNode): ReactNode {
  if (typeof t !== 'string') return t;
  const m = /^([✓✗◌])\s+/.exec(t);
  if (!m) return t;
  const I = m[1] === '✓' ? CheckCircleIcon : m[1] === '✗' ? XCircleIcon : InboxIcon;
  return <><I size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />{t.slice(m[0].length)}</>;
}

function EmptyState({ icon = <InboxIcon size={22} />, text = 'No data' }: { icon?: ReactNode; text?: string }) {
  return (
    <div className="cv-empty">
      <span className="cv-empty-icon">{icon}</span>
      <span className="cv-empty-text">{text}</span>
    </div>
  );
}

// ── StatusView ────────────────────────────────────────────────────────────────
type StatusRow = { change_id: string; status: string; dropped?: boolean; dropped_reason?: string };
/** A pending danger_ change: deploy never runs it, the DBA does (by hand). */
const isManual = (r: { change_id: string; status: string }) => r.status === 'pending' && /(^|_)danger_/i.test(r.change_id);
/** Not applied and not going (the change or its project is dropped): deploy skips it here. */
const isDropped = (r: StatusRow) => r.status === 'pending' && !!r.dropped;
const shownStatus = (r: StatusRow) => (isDropped(r) ? 'dropped' : isManual(r) ? 'manual' : r.status);

function StatusView({ data, env }: { data: StatusRow[]; env?: string }) {
  const applied = data.filter(r => r.status === 'applied').length;
  const dropped = data.filter(isDropped).length;
  const pending = data.filter(r => r.status === 'pending').length - dropped;

  return (
    <ChangeAiProvider env={env} pendingIds={data.filter(r => r.status === 'pending' && !isDropped(r)).map(r => r.change_id)}>
    <div className="cv-root">
      <div className="cv-stats-row">
        <div className="cv-stat">
          <span className="cv-stat-label">Total</span>
          <span className="cv-stat-value">{data.length}</span>
        </div>
        <div className="cv-stat cv-stat--green">
          <span className="cv-stat-label">Applied</span>
          <span className="cv-stat-value">{applied}</span>
        </div>
        <div className="cv-stat cv-stat--amber">
          <span className="cv-stat-label">Pending</span>
          <span className="cv-stat-value">{pending}</span>
        </div>
        {dropped > 0 && (
          <div className="cv-stat cv-stat--slate">
            <span className="cv-stat-label">Not going</span>
            <span className="cv-stat-value">{dropped}</span>
          </div>
        )}
      </div>

      {data.length === 0 ? (
        <EmptyState text="No change folders found" />
      ) : (
        <StatusTable data={data} />
      )}
    </div>
    </ChangeAiProvider>
  );
}

// Rendered inside ChangeAiProvider so every row shares one actions-column width.
function StatusTable({ data }: { data: StatusRow[] }) {
  const cols = `minmax(0, 1fr) 120px ${useChangeAiColumn()}`;
  // a row opens the change's files (deploy / verify / revert / meta.json), as on the Releases tab
  const [viewing, setViewing] = useState<string | null>(null);
  // hundreds of changes: find one, and show what you act on (pending) unless you ask for the rest
  const counts = { pending: data.filter(r => shownStatus(r) === 'pending' || shownStatus(r) === 'manual').length, applied: data.filter(r => r.status === 'applied').length, dropped: data.filter(isDropped).length };
  const pageSize = usePageSize();
  const [filter, setFilter] = useState(counts.pending > 0 && data.length > pageSize ? 'pending' : 'all');
  const [query, setQuery] = useState('');
  const rows = data.filter(r => (filter === 'all' || (filter === 'pending' ? counts.pending && (shownStatus(r) === 'pending' || shownStatus(r) === 'manual') : filter === 'applied' ? r.status === 'applied' : isDropped(r))) && matchesChange(r.change_id, query));
  const big = data.length > pageSize;
  const { rows: pageRows, pager } = usePager(rows, `${filter}|${query}`);
  return (
    <div className="cv-table-wrap">
      {big && (
        <ListToolbar query={query} onQuery={setQuery} shown={rows.length} total={data.length} filter={filter} onFilter={setFilter}
          filters={[
            ...(counts.pending ? [{ value: 'pending', label: 'Pending', count: counts.pending }] : []),
            ...(counts.applied ? [{ value: 'applied', label: 'Applied', count: counts.applied }] : []),
            ...(counts.dropped ? [{ value: 'dropped', label: 'Not going', count: counts.dropped }] : []),
            { value: 'all', label: 'All', count: data.length },
          ]} />
      )}
      <div className="cv-table-head" style={{ gridTemplateColumns: cols }}>
        <div className="cv-th">Change</div>
        <div className="cv-th">Status</div>
        <div className="cv-th" style={{ textAlign: 'right' }}>{data.some(r => r.status === 'pending' && !isDropped(r)) ? 'AI checks before deploy' : data.some(r => r.status === 'applied') ? 'AI checks' : ''}</div>
      </div>
      <div className="cv-table-body">
        {pageRows.map(r => (
          <div key={r.change_id} className="cv-table-row cv-table-row--open" style={{ gridTemplateColumns: cols }} title="Open its files"
            onClick={() => setViewing(r.change_id)}>
            <div className="cv-td cv-td-main"><ChangeIdLabel id={r.change_id} /></div>
            <div className="cv-td" title={isDropped(r) ? `Not going (${r.dropped_reason || 'dropped'}): deploy skips it` : isManual(r) ? 'danger_ change: deploy skips it — the DBA runs deploy.sql by hand' : undefined}>
              <Badge status={shownStatus(r)} />
            </div>
            <div className="cv-td" onClick={e => e.stopPropagation()}><ChangeAiRowActions changeId={r.change_id} status={isDropped(r) ? 'dropped' : r.status} /></div>
          </div>
        ))}
        {big && !rows.length && <div className="bl-empty">Nothing matches.</div>}
      </div>
      {pager}
      {viewing && <ChangeSqlViewer changeIds={[viewing]} onClose={() => setViewing(null)} />}
    </div>
  );
}

// ── TestView (dmcr test — round trip, rolled back) ───────────────────────────
type TestData = {
  status: 'passed' | 'failed';
  // setup: deployed for the changes after it without the round-trip checks (test --only)
  changes: { change_id: string; status: 'pass' | 'fail' | 'not_run' | 'setup'; details: string }[];
  stopped_at?: { change_id: string; reason: string };
};

/** How often each change passed a round trip before (same files), for the setup rows of a test --only result. */
function useEarlierPasses(ids: string[]): Record<string, number> {
  const [passes, setPasses] = useState<Record<string, number>>({});
  const reqId = useRef(`test-view-${Math.random().toString(36).slice(2)}`);
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    const h = (e: MessageEvent) => { if (e.data?.type === 'testPasses' && e.data.payload?.requestId === reqId.current) setPasses(e.data.payload.passes ?? {}); };
    window.addEventListener('message', h);
    postMsg({ type: 'getTestPasses', payload: { requestId: reqId.current, ids: key.split(',') } });
    return () => window.removeEventListener('message', h);
  }, [key]);
  return passes;
}

function TestView({ data }: { data: TestData }) {
  const changes = Array.isArray(data.changes) ? data.changes : [];
  const setupIds = changes.filter(c => c.status === 'setup').map(c => c.change_id);
  const earlier = useEarlierPasses(setupIds);
  const setup = setupIds.length;
  const passedBefore = setupIds.filter(id => (earlier[id] ?? 0) > 0).length;
  const tested = changes.length - setup;
  const failed = changes.filter(c => c.status === 'fail').length;
  const notRun = changes.filter(c => c.status === 'not_run').length;
  // hundreds of rows: search, filters and pages
  const pg = usePagedRows(changes, c => c.change_id, [
    { value: 'fail', label: 'Failed', keep: c => c.status === 'fail' },
    { value: 'pass', label: 'Passed', keep: c => c.status === 'pass' },
    { value: 'setup', label: 'Not tested', keep: c => c.status === 'setup' },
    { value: 'not_run', label: 'Not run', keep: c => c.status === 'not_run' },
  ]);
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${changes.length === 0 ? 'info' : data.status === 'passed' ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
        {changes.length === 0
          ? 'No pending changes to test'
          : data.status === 'passed'
            ? <><CheckCircleIcon size={14} style={{ flexShrink: 0 }} /><span><b>{tested}</b> change{tested === 1 ? '' : 's'} round-tripped: <DetailText text="deploy, verify, revert and verify passed; schema and data restored exactly" />{passedBefore ? ` · ${passedBefore} passed in an earlier run, not re-tested` : ''}{setup - passedBefore ? ` · ${setup - passedBefore} not ticked, not tested` : ''}</span></>
            : <><XCircleIcon size={14} style={{ flexShrink: 0 }} /><span>{failed} of {changes.length} change{changes.length === 1 ? '' : 's'} failed the round trip{notRun ? ` (${notRun} after it not run)` : ''}</span></>}
        </div>
      </div>
      {pg.bar}
      {changes.length > 0 && (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: 'minmax(0, 1fr) 220px', paddingRight: 18 }}>
            <div className="cv-th">Change</div>
            <div className="cv-th">Result</div>
          </div>
          <div className="cv-table-body">
            {pg.rows.map(c => (
              <div key={c.change_id} className="cv-table-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) 220px', alignItems: 'center', paddingRight: 18 }}>
                <div className="cv-td cv-td-main" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                  <ChangeIdLabel id={c.change_id} />
                  {c.details && (
                    <div style={{ marginTop: 3, fontSize: 11, color: c.status === 'fail' ? 'var(--dm-c-fca5a5)' : 'var(--dm-c-94a3b8)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>{c.status === 'fail' ? c.details : <DetailText text={c.status !== 'setup' ? c.details : (earlier[c.change_id] ?? 0) > 0 ? `deploy, verify, revert and verify passed in an earlier run (×${earlier[c.change_id]}, same files) · not re-tested now: only applied inside this test, under the ticked change, and rolled back with it` : 'not ticked, so not tested: only applied inside this test, under the ticked change, and rolled back with it'} />}</div>
                  )}
                </div>
                <div className="cv-td">{c.status === 'setup' && (earlier[c.change_id] ?? 0) > 0
                  ? <span title={`Passed a round trip ${earlier[c.change_id]}× in earlier runs (same files); not re-tested in this run`}><Badge status="ok" label={`ok · earlier ×${earlier[c.change_id]}`} /></span>
                  : <Badge status={c.status === 'pass' ? 'ok' : c.status === 'not_run' ? 'not run' : c.status === 'setup' ? 'not tested' : 'failed'} />}</div>
              </div>
            ))}
          </div>
          {pg.more}
        </div>
      )}
      {data.stopped_at && (
        <div className="cv-alert cv-alert--warn"><div className="cv-alert-body">Stopped at {data.stopped_at.change_id}: {data.stopped_at.reason}</div></div>
      )}
      <div style={{ fontSize: 11, color: 'var(--dm-c-64748b)', padding: '6px 2px' }}>Everything ran in one transaction that was rolled back — the database is unchanged.</div>
    </div>
  );
}

// ── Deployment ids: every deploy / revert run has one, like a git commit (shown as 7 characters) ──
function DeployIdChip({ id, title }: { id?: string | null; title?: string }) {
  if (!id) return <span className="cv-muted">—</span>;
  return <span className="cv-did" title={title ?? `deployment ${id}`}><CommitIcon size={11} />{id.slice(0, 7)}</span>;
}

/** The deployment a deploy / revert run was: its id, and how to see or undo it */
function DeploymentNote({ id, revert }: { id?: string | null; revert?: boolean }) {
  if (!id) return null;
  const s = id.slice(0, 7);
  return (
    <div className="cv-did-note">
      <span>Deployment</span><DeployIdChip id={id} />
      <span className="cv-muted">{revert ? 'This revert is recorded as its own deployment.' : <>See it with <CopyCmd cmd={`dmcr deployments ${s}`} />; undo it with <CopyCmd cmd={`dmcr revert ${s}`} /></>}</span>
    </div>
  );
}

// ── DeploymentsView: dmcr deployments [<id>] ─────────────────────────────────
type DeploymentRun = { deploy_id: string; short: string; at: string; action: string; environment?: string; actor?: string; ok: number; failed: number; still_applied: number; git_commit?: string; changes: string[] };
type DeploymentOne = { deploy_id: string; short: string; action: string; environment?: string; actor?: string; started_at?: string; git_commit?: string;
  changes: { change_id: string; status: string; at?: string; still_applied?: boolean; release?: string; project?: string; message?: string }[] };

function DeploymentsView({ data }: { data: { environment?: string; deployments?: DeploymentRun[] } | DeploymentOne }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const runs = 'deployments' in data ? data.deployments ?? [] : [];
  const pg = usePagedRows(runs, r => `${r.deploy_id} ${r.changes.join(' ')}`, [
    { value: 'deploy', label: 'Deploys', keep: r => r.action === 'deploy' },
    { value: 'revert', label: 'Reverts', keep: r => r.action === 'revert' },
    { value: 'failed', label: 'With a failure', keep: r => r.failed > 0 },
  ], undefined, 'deployment', 'Find a deployment: id, change or who');
  if (!('deployments' in data)) {
    const d = data as DeploymentOne;
    const cols = '36px minmax(0, 1fr) 110px 120px 90px 170px';
    return (
      <div className="cv-root">
        <div className="cv-alert cv-alert--info">
          <div className="cv-alert-title cv-did-head"><DeployIdChip id={d.deploy_id} /><b>{d.action}</b> on {d.environment} · {d.actor} · {d.started_at}{d.git_commit ? <> · commit <span className="cv-td-mono">{d.git_commit.slice(0, 7)}</span></> : null}
            <button type="button" className="gv-open" style={{ marginLeft: 'auto' }} title="Open every change of this deployment" onClick={() => openChanges(d.changes.map(x => x.change_id), `deployment ${d.short}`)}>View files</button></div>
          <div className="cv-alert-body cv-td-mono" style={{ fontSize: 11 }}>{d.deploy_id}</div>
        </div>
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: cols }}>
            <div className="cv-th">#</div><div className="cv-th">Change</div><div className="cv-th">Project</div><div className="cv-th">Release</div><div className="cv-th">Result</div><div className="cv-th">Now</div>
          </div>
          <div className="cv-table-body">
            {d.changes.map((c, i) => (
              <div key={c.change_id + i} className="cv-table-row" style={{ gridTemplateColumns: cols }} title={c.message || undefined}>
                <div className="cv-td" style={{ color: 'var(--dm-c-334155)', fontSize: 11 }}>{i + 1}</div>
                <div className="cv-td cv-td-main"><ChangeIdLabel id={c.change_id} /></div>
                <div className="cv-td"><ProjectChip id={c.project || undefined} /></div>
                <div className="cv-td"><ReleaseChip id={c.release || undefined} /></div>
                <div className="cv-td"><Badge status={c.status} /></div>
                <div className="cv-td cv-muted">{d.action === 'deploy' && c.status === 'success' ? (c.still_applied ? 'still applied' : 'reverted or redeployed since') : '—'}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  const cols = '18px 104px 130px 70px minmax(0, 1fr) 150px 90px';
  const toggle = (id: string) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="cv-root">
      <div className="cv-summary">
        <span className="cv-summary-num cv-summary-num--green">{runs.length}</span>
        <span>deployment{runs.length !== 1 ? 's' : ''} on <b className="cv-hist-env">{data.environment}</b>, newest first. Undo a deploy with <code>dmcr revert &lt;id&gt;</code></span>
      </div>
      {runs.length === 0 ? <EmptyState text="No deployments recorded yet" /> : (<>
        {pg.bar}
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: cols }}>
            <div className="cv-th" /><div className="cv-th">Deployment</div><div className="cv-th">When</div><div className="cv-th">Action</div><div className="cv-th">Changes</div><div className="cv-th">By</div><div className="cv-th">Still applied</div>
          </div>
          <div className="cv-table-body">
            {pg.rows.map(r => (
              <div key={r.deploy_id}>
                <div className="cv-table-row cv-did-row" style={{ gridTemplateColumns: cols }} onClick={() => toggle(r.deploy_id)}>
                  <div className="cv-td cv-muted">{open.has(r.deploy_id) ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</div>
                  <div className="cv-td"><DeployIdChip id={r.deploy_id} /></div>
                  <div className="cv-td cv-td-mono">{r.at}</div>
                  <div className="cv-td"><span className={`cv-did-action cv-did-action--${r.action}`}>{r.action}</span></div>
                  <div className="cv-td">{r.ok} change{r.ok !== 1 ? 's' : ''}{r.failed ? <span className="cv-did-failed"> · {r.failed} failed</span> : null}</div>
                  <div className="cv-td"><PersonChip name={r.actor || undefined} /></div>
                  <div className="cv-td cv-td-mono">{r.action === 'deploy' ? `${r.still_applied} of ${r.ok}` : '—'}</div>
                </div>
                {open.has(r.deploy_id) && (
                  <div className="cv-did-changes">
                    <div className="cv-td-mono cv-muted" style={{ fontSize: 11 }}>{r.deploy_id}{r.git_commit ? ` · commit ${r.git_commit.slice(0, 7)}` : ''}</div>
                    {r.changes.map((c, i) => <div key={c + i}><ChangeIdLabel id={c} /></div>)}
                  </div>
                )}
              </div>
            ))}
          </div>
          {pg.more}
        </div>
      </>)}
    </div>
  );
}

// ── HistoryView ───────────────────────────────────────────────────────────────
type HistoryRow = {
  change_id: string; applied_at: string; applied_by: string;
  deploy_checksum: string; ticket_id: string; git_commit: string;
  environment: string; actor: string;
  project_id?: string; release_id?: string; change_kind?: string; requested_by?: string; created_by?: string; deploy_id?: string;
};

/** dmcr history: per applied change, which release, who asked, who built it, who deployed it, when, ticket, commit. */
function HistoryView({ data }: { data: HistoryRow[] }) {
  // database time, the same as release list and the Releases page ("2026-10-09 05:08")
  const formatDate = (s: string) => (s ? s.replace('T', ' ').slice(0, 16) : '—');
  const envs = [...new Set(data.map(r => r.environment).filter(Boolean))];
  const releases = [...new Set(data.map(r => r.release_id).filter(Boolean))] as string[];
  const cols = 'minmax(0, 1.3fr) 120px 92px 140px 150px 200px 96px 130px 80px 96px';
  // hundreds of rows: search, a filter per release, and pages
  const pg = usePagedRows(data, r => r.change_id, releases.map(rel => ({ value: rel, label: rel, keep: (r: HistoryRow) => r.release_id === rel })));
  return (
    <div className="cv-root">
      <div className="cv-summary">
        <span className="cv-summary-num cv-summary-num--green">{data.length}</span>
        <span>applied change{data.length !== 1 ? 's' : ''}{envs.length ? <> on <b className="cv-hist-env">{envs.join(', ')}</b></> : null}</span>
        {releases.length > 0 && <span className="cv-chips cv-hist-rels">{releases.map(r => <ReleaseChip key={r} id={r} />)}</span>}
      </div>
      {data.length === 0 ? (
        <EmptyState text="No history yet" />
      ) : (<>
        {pg.bar}
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: cols }}>
            <div className="cv-th">Change</div>
            <div className="cv-th">Release</div>
            <div className="cv-th">Kind</div>
            <div className="cv-th">Asked by</div>
            <div className="cv-th">Built by</div>
            <div className="cv-th">Deployed by</div>
            <div className="cv-th">Ticket</div>
            <div className="cv-th">Applied</div>
            <div className="cv-th">Commit</div>
            <div className="cv-th">Deployment</div>
          </div>
          <div className="cv-table-body">
            {pg.rows.map(r => (
              <div key={r.change_id + r.applied_at} className="cv-table-row" style={{ gridTemplateColumns: cols }}>
                <div className="cv-td cv-td-main" title={`${r.change_id}\ndeploy checksum ${r.deploy_checksum || '—'}`}><ChangeIdLabel id={r.change_id} /></div>
                <div className="cv-td"><ReleaseChip id={r.release_id || undefined} /></div>
                <div className="cv-td"><KindChip kind={r.change_kind || undefined} /></div>
                <div className="cv-td"><PersonChip name={r.requested_by || undefined} /></div>
                <div className="cv-td"><PersonChip name={r.created_by || undefined} dba /></div>
                <div className="cv-td cv-td-mono cv-hist-by" title={`${r.actor || ''}${r.applied_by ? ` (database role ${r.applied_by})` : ''}`}>{r.actor || r.applied_by || '—'}</div>
                <div className="cv-td cv-td-mono cv-hist-ticket">{r.ticket_id || '—'}</div>
                <div className="cv-td cv-td-mono" title={r.applied_at}>{formatDate(r.applied_at)}</div>
                <div className="cv-td cv-td-mono cv-hist-commit" title={r.git_commit}>{r.git_commit ? r.git_commit.slice(0, 7) : '—'}</div>
                <div className="cv-td"><DeployIdChip id={r.deploy_id} /></div>
              </div>
            ))}
          </div>
          {pg.more}
        </div>
      </>)}
    </div>
  );
}

// ── InfoView ──────────────────────────────────────────────────────────────────
type InfoData = {
  environment: string; total_changes: number; applied: number;
  pending: number; danger: number; registry_ok: boolean | string; checksum_policy: string;
};

function InfoView({ data }: { data: InfoData }) {
  const isOk = data.registry_ok === true || data.registry_ok === 'true';
  const envColor = data.environment?.toLowerCase().includes('prod') ? 'env-prod' : 'env-dev';

  return (
    <div className="cv-root">
      <div className="cv-stats-row">
        <div className="cv-stat">
          <span className="cv-stat-label">Total</span>
          <span className="cv-stat-value">{data.total_changes ?? 0}</span>
        </div>
        <div className="cv-stat cv-stat--green">
          <span className="cv-stat-label">Applied</span>
          <span className="cv-stat-value">{data.applied ?? 0}</span>
        </div>
        <div className="cv-stat cv-stat--amber">
          <span className="cv-stat-label">Pending</span>
          <span className="cv-stat-value">{data.pending ?? 0}</span>
        </div>
        {(data.danger ?? 0) > 0 && (
          <div className="cv-stat cv-stat--red">
            <span className="cv-stat-label">Danger</span>
            <span className="cv-stat-value">{data.danger}</span>
          </div>
        )}
        <div className={`cv-stat ${isOk ? 'cv-stat--green' : 'cv-stat--red'}`}>
          <span className="cv-stat-label">Registry</span>
          <span className="cv-stat-value" style={{ fontSize: 13, fontWeight: 700, marginTop: 3 }}>{isOk ? <><CheckIcon size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />OK</> : <><CloseIcon size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />Not found</>}</span>
        </div>
        <div className="cv-stat cv-stat--muted">
          <span className="cv-stat-label">Checksum</span>
          <span className="cv-stat-value">{data.checksum_policy ?? '—'}</span>
        </div>
      </div>

      <div className="cv-kv-grid">
        <div className="cv-kv-row">
          <div className="cv-kv-key">Environment</div>
          <div className={`cv-kv-val cv-kv-val--${envColor}`}>{data.environment ?? '—'}</div>
        </div>
        <div className="cv-kv-row">
          <div className="cv-kv-key">Checksum Policy</div>
          <div className="cv-kv-val">{data.checksum_policy ?? '—'}</div>
        </div>
      </div>
    </div>
  );
}

// ── CheckView ─────────────────────────────────────────────────────────────────
type CheckData = { ok: boolean | string; issues: string[] };

function CheckView({ data }: { data: CheckData }) {
  const isOk = data.ok === true || data.ok === 'true';
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isOk ? 'success' : 'warn'}`}>
        <div className="cv-alert-title">
          {isOk ? titled('✓  All preflight checks passed') : <><WarningTriangleIcon size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />Preflight issues found</>}
        </div>
        {!isOk && data.issues?.length > 0 && (
          <div className="cv-alert-body">
            {data.issues.map((issue, i) => (
              <div key={i} className="cv-alert-issue">{issue}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── PlanView ──────────────────────────────────────────────────────────────────
type PlanRow = { change_id: string; status: string; requires: string[] };

function PlanView({ data }: { data: PlanRow[] }) {
  const applied = data.filter(r => r.status === 'applied').length;
  const pending = data.filter(r => r.status === 'pending').length;
  // hundreds of changes: search, filters and pages
  const pg = usePagedRows(data, r => r.change_id, [
    { value: 'pending', label: 'Pending', keep: r => r.status === 'pending' },
    { value: 'applied', label: 'Applied', keep: r => r.status === 'applied' },
  ]);

  return (
    <div className="cv-root">
      <div className="cv-summary">
        <span className="cv-summary-num cv-summary-num--green">{applied}</span><span>applied</span>
        <span style={{ color: 'var(--dm-c-334155)' }}>·</span>
        <span className="cv-summary-num cv-summary-num--amber">{pending}</span><span>pending</span>
      </div>
      {data.length === 0 ? (
        <EmptyState text="No changes found" />
      ) : (<>
        {pg.bar}
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '36px 1fr 110px 1fr' }}>
            <div className="cv-th">#</div>
            <div className="cv-th">Change</div>
            <div className="cv-th">Status</div>
            <div className="cv-th">Requires</div>
          </div>
          <div className="cv-table-body">
            {pg.rows.map(r => ({ r, i: data.indexOf(r) })).map(({ r, i }) => (
              <div key={r.change_id} className="cv-table-row" style={{ gridTemplateColumns: '36px 1fr 110px 1fr' }}>
                <div className="cv-td" style={{ color: 'var(--dm-c-334155)', fontSize: 11 }}>{i + 1}</div>
                <div className="cv-td cv-td-main" title={r.change_id}><ChangeIdLabel id={r.change_id} /></div>
                <div className="cv-td"><Badge status={r.status} /></div>
                <div className="cv-td">
                  {r.requires?.length > 0 ? (
                    <div className="cv-deps">
                      {r.requires.map(dep => <span key={dep} className="cv-dep">{dep}</span>)}
                    </div>
                  ) : <span style={{ color: 'var(--dm-c-334155)' }}>—</span>}
                </div>
              </div>
            ))}
          </div>
          {pg.more}
        </div>
      </>)}
    </div>
  );
}

// ── DeployView ────────────────────────────────────────────────────────────────
type DeployData =
  | { status: 'ok';       changes: Array<{ change_id: string; status: string; duration_ms?: number; duration_s?: number; error?: string }> }
  | { status: 'dry_run';  count:   number; changes: Array<{ change_id: string }> }
  | { status: 'ok';       message: string; changes: [] };

// dmcr.ps1 emits duration_ms; dmcr.sh emits duration_s
type DeployChange = { change_id: string; status?: string; duration_ms?: number; duration_s?: number; error?: string; project?: string; release?: string; kind?: string };

function formatDuration(c: DeployChange): string {
  if (c.duration_ms != null) return c.duration_ms < 1000 ? `${c.duration_ms}ms` : `${(c.duration_ms / 1000).toFixed(1)}s`;
  if (c.duration_s != null) return `${c.duration_s}s`;
  return '—';
}

function DeployView({ data, risk }: { data: DeployData | Record<string, unknown>; risk?: RiskState }) {
  const d = data as Record<string, unknown>;
  // dry-run: which rows show their AI risk reason; all of them open once the scores arrive
  const [open, setOpen] = useState<Set<string>>(new Set());
  const riskScores = risk?.scores;
  useEffect(() => { if (riskScores?.length) setOpen(new Set(riskScores.map(s => s.change_id))); }, [riskScores]);
  const status  = (d['status'] as string) ?? 'ok';
  const changes = (d['changes'] as DeployChange[]) ?? [];
  const message = d['message'] as string | undefined;
  // hundreds of changes: search, filters and pages (dry run: by AI risk once scored; a deploy: by result)
  const riskOf = new Map((risk?.scores ?? []).map(s => [s.change_id, String(s.risk ?? '').toLowerCase()]));
  const pgDry = usePagedRows(status === 'dry_run' ? changes : [], c => c.change_id, ['high', 'medium', 'low'].map(r => ({ value: r, label: `${r[0].toUpperCase()}${r.slice(1)} risk`, keep: (c: DeployChange) => riskOf.get(c.change_id) === r })));
  const pgRun = usePagedRows(status === 'dry_run' ? [] : changes, c => c.change_id, [
    { value: 'failed', label: 'Failed', keep: c => !!c.status && !['success', 'applied', 'dropped', 'manual'].includes(c.status) },
    { value: 'success', label: 'Deployed', keep: c => c.status === 'success' || c.status === 'applied' || !c.status },
    { value: 'dropped', label: 'Not going', keep: c => c.status === 'dropped' },
    { value: 'manual', label: 'Manual (danger_)', keep: c => c.status === 'manual' },
  ]);

  if (status === 'dry_run') {
    const scope = d['scope'] as string | undefined;
    const dropped = (d['dropped'] as { change_id: string; reason?: string }[] | undefined) ?? [];
    const withProject = changes.some(c => c.project || c.kind);
    const scores = new Map((risk?.scores ?? []).map(s => [s.change_id, s]));
    const withRisk = !!risk?.scores || !!risk?.analyzing;
    const cols = (withProject ? '36px 1fr 110px 100px 80px' : '36px 1fr') + (withRisk ? ' 130px' : '');
    const allOpen = changes.length > 0 && changes.every(c => !scores.has(c.change_id) || open.has(c.change_id));
    const toggle = (id: string) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    // the guards a real deploy runs first (promotion gate, out of order, requires, edited applied files)
    const blocked = (d['blocked'] as string[] | undefined) ?? [];
    const repeatable = (d['repeatable'] as string[] | undefined) ?? [];
    return (
      <div className="cv-root">
        {blocked.length > 0 && (
          <div className="cv-alert cv-alert--error">
            <div className="cv-alert-title"><BlockedIcon size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />The deploy would be BLOCKED</div>
            {blocked.map((b, i) => <div key={i} className="cv-warn-row"><WarnText text={b} /></div>)}
          </div>
        )}
        <div className="cv-alert cv-alert--info">
          <div className="cv-alert-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span><EyeIcon size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />Dry-run: {changes.length} change{changes.length !== 1 ? 's' : ''} would be deployed{scope ? ` (${scope})` : ''}{repeatable.length ? ` · ${repeatable.length} repeatable${repeatable.length === 1 ? '' : 's'} re-applied (${repeatable.join(', ')})` : ''}{blocked.length ? ', if the block above is fixed' : ''}</span>
            {risk && changes.length > 0 && <span style={{ marginLeft: 'auto' }}><RiskSummary risk={risk} expandedAll={allOpen}
              onToggleAll={() => setOpen(allOpen ? new Set() : new Set(changes.map(c => c.change_id).filter(id => scores.has(id))))} /></span>}
          </div>
        </div>
        {pgDry.bar}
        {changes.length > 0 && (
          <div className="cv-table-wrap">
            <div className="cv-table-head" style={{ gridTemplateColumns: cols }}>
              <div className="cv-th">#</div>
              <div className="cv-th">Change</div>
              {withProject && <><div className="cv-th">Project</div><div className="cv-th">Release</div><div className="cv-th">Kind</div></>}
              {withRisk && <div className="cv-th">Risk</div>}
            </div>
            <div className="cv-table-body">
              {pgDry.rows.map(c => {
                const i = changes.indexOf(c);
                const sc = scores.get(c.change_id);
                const isOpen = !!sc && open.has(c.change_id);
                return (
                  <div key={c.change_id}>
                    <div className={`cv-table-row${sc ? ' rk-row' : ''}${isOpen ? ' is-open' : ''}`} style={{ gridTemplateColumns: cols, ...(isOpen && sc ? { background: `color-mix(in srgb, ${riskColor(sc.risk)} 14%, transparent)` } : {}) }}
                      onClick={sc ? () => toggle(c.change_id) : undefined} title={sc ? (isOpen ? 'Hide the reason' : 'Why this risk') : undefined}>
                      <div className="cv-td" style={{ color: 'var(--dm-c-334155)', fontSize: 11 }}>{i + 1}</div>
                      <div className="cv-td cv-td-main"><ChangeIdLabel id={c.change_id} /></div>
                      {withProject && <><div className="cv-td"><ProjectChip id={c.project} /></div><div className="cv-td"><ReleaseChip id={c.release} /></div><div className="cv-td"><KindChip kind={c.kind} /></div></>}
                      {withRisk && <div className="cv-td"><RiskCell score={sc} analyzing={risk?.analyzing} open={isOpen} /></div>}
                    </div>
                    {isOpen && sc && <RiskDetail score={sc} />}
                  </div>
                );
              })}
            </div>
            {pgDry.more}
          </div>
        )}
        {dropped.length > 0 && <DroppedList rows={dropped} />}
      </div>
    );
  }

  if (message && changes.length === 0) {
    return (
      <div className="cv-root">
        <div className="cv-alert cv-alert--info">
          <div className="cv-alert-title"><InboxIcon size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />{message}</div>
        </div>
      </div>
    );
  }

  // Repeatable (R__) migrations the deploy re-applied after the versioned changes
  const repeatable = (d['repeatable'] as DeployChange[] | undefined) ?? [];
  const manual = changes.filter(c => c.status === 'manual');
  // not going (the change or its project is dropped): skipped on purpose, never a failure
  const dropped = changes.filter(c => c.status === 'dropped');
  const deployed = changes.filter(c => c.status !== 'manual' && c.status !== 'dropped');
  const allOk = deployed.every(c => c.status === 'success' || c.status === 'applied')
    && repeatable.every(c => c.status === 'applied' || c.status === 'success');
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${allOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {titled(allOk
            ? `✓  ${deployed.length} change${deployed.length !== 1 ? 's' : ''} deployed successfully${dropped.length ? ` · ${dropped.length} not going, skipped` : ''}${repeatable.length ? ` · ${repeatable.length} repeatable re-applied` : ''}${manual.length ? ` · ${manual.length} manual (danger_) skipped — the DBA runs ${manual.length === 1 ? 'it' : 'them'} by hand` : ''}`
            : '✗  Deploy failed')}
        </div>
      </div>
      <DeploymentNote id={d['deploy_id'] as string | undefined} />
      {repeatable.length > 0 && (
        <div className="cv-table-wrap" style={{ marginBottom: 8 }}>
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr 100px 70px' }}>
            <div className="cv-th">Repeatable migration</div>
            <div className="cv-th">Status</div>
            <div className="cv-th">Time</div>
          </div>
          <div className="cv-table-body">
            {repeatable.map(c => (
              <div key={c.change_id} className="cv-table-row" style={{ gridTemplateColumns: '1fr 100px 70px' }}>
                <div className="cv-td cv-td-main" title={c.change_id}><ChangeIdLabel id={c.change_id} /></div>
                <div className="cv-td"><Badge status={c.status === 'applied' ? 'success' : (c.status ?? 'success')} /></div>
                <div className="cv-td cv-td-mono">{formatDuration(c)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {pgRun.bar}
      {changes.length > 0 && (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr 100px 70px' }}>
            <div className="cv-th">Change</div>
            <div className="cv-th">Status</div>
            <div className="cv-th">Time</div>
          </div>
          <div className="cv-table-body">
            {pgRun.rows.map(c => (
              <div key={c.change_id} className="cv-table-row" style={{ gridTemplateColumns: '1fr 100px 70px' }}>
                <div className="cv-td cv-td-main" title={c.change_id}><ChangeIdLabel id={c.change_id} /></div>
                <div className="cv-td"><Badge status={c.status ?? 'success'} /></div>
                <div className="cv-td cv-td-mono">{formatDuration(c)}</div>
              </div>
            ))}
          </div>
          {pgRun.more}
        </div>
      )}
    </div>
  );
}

function DroppedList({ rows }: { rows: { change_id: string; reason?: string }[] }) {
  return (
    <div className="cv-table-wrap" style={{ marginTop: 8 }}>
      <div className="cv-table-head" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
        <div className="cv-th">Skipped: not going</div>
        <div className="cv-th">Reason</div>
      </div>
      <div className="cv-table-body">
        {rows.map(r => (
          <div key={r.change_id} className="cv-table-row" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
            <div className="cv-td cv-td-main" style={{ opacity: 0.7 }}><BlockedIcon size={11} style={{ verticalAlign: '-1px', marginRight: 5 }} /><ChangeIdLabel id={r.change_id} /></div>
            <div className="cv-td">{r.reason || '—'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ReleaseView: release list / release show ─────────────────────────────────
type ReleaseSummary = { release: string; name?: string; date?: string; status?: string; projects?: { id: string; type?: string; status?: string }[]; total: number; applied: number; pending: number; dropped: number; last_applied?: string };
type ReleaseChange = { change_id: string; project?: string; project_type?: string; kind?: string; status: string; requested_by?: string; created_by?: string; applied_at?: string; dropped_reason?: string };

function ReleaseView({ data }: { data: { environment?: string; releases?: ReleaseSummary[]; release?: string; name?: string; changes?: ReleaseChange[] } }) {
  // hundreds of changes in a release: search, filters and pages (first, on every render: the view returns early by shape)
  const pg = usePagedRows(Array.isArray(data.releases) ? [] : data.changes ?? [], c => c.change_id, [
    { value: 'pending', label: 'Pending', keep: c => c.status === 'pending' },
    { value: 'applied', label: 'Applied', keep: c => c.status === 'applied' },
    { value: 'dropped', label: 'Not going', keep: c => c.status === 'dropped' },
  ]);
  if (Array.isArray(data.releases)) {
    // sized to their content: the counts sit next to the projects, the spare width stays at the end
    const cols = 'minmax(200px, 280px) 100px minmax(170px, 300px) 80px 80px 90px 150px';
    return (
      <div className="cv-root">
        <div className="cv-summary">
          <span className="cv-summary-num cv-summary-num--green">{data.releases.length}</span>
          <span>release group{data.releases.length !== 1 ? 's' : ''} on {data.environment}</span>
        </div>
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: cols }}>
            <div className="cv-th">Release</div><div className="cv-th">Date</div><div className="cv-th">Projects</div>
            <div className="cv-th">Applied</div><div className="cv-th">Pending</div><div className="cv-th">Not going</div><div className="cv-th">Last deployed</div>
          </div>
          <div className="cv-table-body">
            {data.releases.map(r => (
              <div key={r.release} className="cv-table-row" style={{ gridTemplateColumns: cols }}>
                <div className="cv-td cv-td-main"><span className="cv-chips"><ReleaseChip id={r.release} />{r.name ? <span style={{ color: 'var(--dm-c-e2e8f0)', fontWeight: 600 }}>{r.name}</span> : null}</span></div>
                <div className="cv-td cv-td-mono">{r.date || '—'}</div>
                <div className="cv-td"><span className="cv-chips">{r.projects?.length ? r.projects.map(p => <ProjectChip key={p.id} id={p.id} type={p.type ?? 'new'} dropped={p.status === 'dropped'} />) : <span className="cv-dim">—</span>}</span></div>
                <div className="cv-td cv-td-mono">{r.applied}/{r.total}</div>
                <div className="cv-td cv-td-mono">{r.pending}</div>
                <div className="cv-td cv-td-mono">{r.dropped}</div>
                <div className="cv-td cv-td-mono">{r.last_applied || '—'}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  const changes = data.changes ?? [];
  const cols = '1.5fr 1fr 90px 1fr 1.1fr 150px';
  return (
    <div className="cv-root">
      <div className="cv-summary">
        <span className="cv-summary-num cv-summary-num--green">{changes.length}</span>
        <span className="cv-chips">change{changes.length !== 1 ? 's' : ''} in release <ReleaseChip id={data.release} />{data.name ? <b style={{ color: 'var(--dm-c-e2e8f0)' }}>{data.name}</b> : null} on <b style={{ color: 'var(--dm-c-7dd3fc)' }}>{data.environment}</b></span>
      </div>
      {changes.length === 0 ? <EmptyState text="No changes in this release" /> : (<>
        {pg.bar}
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: cols }}>
            <div className="cv-th">Change</div><div className="cv-th">Project</div><div className="cv-th">Kind</div>
            <div className="cv-th">Requested by</div><div className="cv-th">Created by</div><div className="cv-th">Status</div>
          </div>
          <div className="cv-table-body">
            {pg.rows.map(c => (
              <div key={c.change_id} className="cv-table-row" style={{ gridTemplateColumns: cols }} title={c.dropped_reason}>
                <div className="cv-td cv-td-main"><ChangeIdLabel id={c.change_id} /></div>
                <div className="cv-td"><ProjectChip id={c.project} type={c.project_type} /></div>
                <div className="cv-td"><KindChip kind={c.kind} /></div>
                <div className="cv-td"><PersonChip name={c.requested_by} /></div>
                <div className="cv-td"><PersonChip name={c.created_by} dba /></div>
                <div className="cv-td"><Badge status={c.status} />{c.applied_at ? <span className="cv-td-mono" style={{ marginLeft: 6, opacity: 0.7 }}>{c.applied_at}</span> : null}</div>
              </div>
            ))}
          </div>
          {pg.more}
        </div>
      </>)}
    </div>
  );
}

// ── RevertScopeView: revert --project / --release / --kind ───────────────────
type ScopeRevert = { status: string; deploy_id?: string; scope?: string; changes?: { change_id: string; project?: string; release?: string; kind?: string }[]; warnings?: string[]; problems?: string[] };

function RevertScopeView({ data }: { data: ScopeRevert }) {
  const changes = data.changes ?? [];
  const blocked = data.status === 'blocked';
  const dry = data.status === 'dry_run';
  const title = data.status === 'nothing_to_revert' ? `Nothing applied in scope (${data.scope})`
    : blocked ? `Rollback refused (${data.scope})`
    : dry ? `Dry-run: ${changes.length} change${changes.length !== 1 ? 's' : ''} would be reverted, newest first (${data.scope})`
    : `✓  ${changes.length} change${changes.length !== 1 ? 's' : ''} reverted (${data.scope})`;
  const cols = '36px 1fr 110px 120px 90px';
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${blocked ? 'error' : dry || data.status === 'nothing_to_revert' ? 'info' : 'success'}`}>
        <div className="cv-alert-title">{blocked ? <ShieldAlertIcon size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} /> : dry ? <EyeIcon size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} /> : null}{titled(title)}</div>
        {!!data.problems?.length && <div className="cv-alert-body">{data.problems.map((p, i) => <div key={i}>{p}</div>)}</div>}
      </div>
      <DeploymentNote id={data.deploy_id} revert />
      {changes.length > 0 && (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: cols }}>
            <div className="cv-th">#</div><div className="cv-th">Change</div><div className="cv-th">Project</div><div className="cv-th">Release</div><div className="cv-th">Kind</div>
          </div>
          <div className="cv-table-body">
            {changes.map((c, i) => (
              <div key={c.change_id} className="cv-table-row" style={{ gridTemplateColumns: cols }}>
                <div className="cv-td" style={{ color: 'var(--dm-c-334155)', fontSize: 11 }}>{i + 1}</div>
                <div className="cv-td cv-td-main"><ChangeIdLabel id={c.change_id} /></div>
                <div className="cv-td"><ProjectChip id={c.project} /></div>
                <div className="cv-td"><ReleaseChip id={c.release} /></div>
                <div className="cv-td"><KindChip kind={c.kind} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
      {!!data.warnings?.length && (
        <div className="cv-alert cv-alert--warn" style={{ marginTop: 8 }}>
          {data.warnings.map((w, i) => (
            <div key={i} className="cv-warn-row">
              <WarningTriangleIcon size={14} />
              <span><WarnText text={w} /></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── VerifyView ────────────────────────────────────────────────────────────────
// "superseded": verify.sql failed, but a later applied change rewrote the same objects, so the
// verify describes an older state (e.g. a seed later updated, a function later replaced).
// "no_backup": recorded as applied here without DMCR running it (the SQL ran by hand), so the backup of the rows
// it changed does not exist; everything else in verify.sql holds. Only a revert here cannot restore those rows.
type VerifyRow = { change_id: string; status: string; superseded_by?: string[]; error?: string };
type VerifyData = VerifyRow | VerifyRow[];

function VerifyView({ data }: { data: VerifyData }) {
  const rows = Array.isArray(data) ? data : [data as VerifyRow];
  const passed = (s: string) => s === 'ok' || s === 'superseded' || s === 'no_backup';
  const failed = rows.filter(r => !passed(r.status));
  const superseded = rows.filter(r => r.status === 'superseded');
  const noBackup = rows.filter(r => r.status === 'no_backup');
  const okCount = rows.length - failed.length - superseded.length - noBackup.length;
  const extra = [superseded.length ? `${superseded.length} superseded by later changes` : '', noBackup.length ? `${noBackup.length} without a backup here` : ''].filter(Boolean).join(' · ');
  const title = failed.length
    ? `✗  Verify failed — ${failed.length} change${failed.length === 1 ? '' : 's'}`
    : extra
      ? `✓  ${okCount} verified OK · ${extra}`
      : `✓  ${rows.length === 1 ? rows[0]?.change_id : `${rows.length} changes`} verified OK`;
  // hundreds of rows: search, filters and pages
  const pg = usePagedRows(rows, r => r.change_id, [
    { value: 'failed', label: 'Failed', keep: r => !passed(r.status) },
    { value: 'superseded', label: 'Superseded', keep: r => r.status === 'superseded' },
    { value: 'no_backup', label: 'No backup', keep: r => r.status === 'no_backup' },
    { value: 'ok', label: 'OK', keep: r => r.status === 'ok' },
  ]);

  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${failed.length ? 'error' : superseded.length || noBackup.length ? 'warn' : 'success'}`}>
        <div className="cv-alert-title">{titled(title)}</div>
        {superseded.length > 0 && (
          <div className="cv-alert-body">
            Superseded: the change's verify.sql no longer matches because a later change rewrote the same objects. Not a failure.
          </div>
        )}
        {noBackup.length > 0 && (
          <div className="cv-alert-body">
            No backup here: recorded as applied without DMCR running it (the SQL ran by hand, for example an import), so there is no copy of the rows it changed. Everything else checked out. Not a failure; only a revert here cannot restore those rows.
          </div>
        )}
      </div>
      {rows.length > 1 && pg.bar}
      {rows.length > 1 && (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: 'minmax(0, 1fr) 150px' }}>
            <div className="cv-th">Change</div>
            <div className="cv-th" style={{ textAlign: 'right' }}>Status</div>
          </div>
          <div className="cv-table-body">
            {pg.rows.map(r => (
              <div key={r.change_id} className="cv-table-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) 150px' }}>
                <div className="cv-td cv-td-main cv-verify-main" title={r.error ?? r.change_id}>
                  <ChangeIdLabel id={r.change_id} />
                  {r.superseded_by?.length ? (
                    <div className="cv-verify-by">
                      <span className="cv-verify-by-label">superseded by</span>
                      {r.superseded_by.map(b => {
                        const m = /^(\S+)(?:\s+\((.*)\))?$/.exec(b.trim());
                        return <span key={b} className="cv-verify-by-item"><ChangeIdLabel id={m?.[1] ?? b} />{m?.[2] && <code className="cv-warn-obj">{m[2]}</code>}</span>;
                      })}
                    </div>
                  ) : null}
                  {r.status === 'failed' && r.error ? <div className="cv-verify-err">{r.error}</div> : null}
                </div>
                <div className="cv-td cv-td-end"><Badge status={r.status} /></div>
              </div>
            ))}
          </div>
          {pg.more}
        </div>
      )}
    </div>
  );
}

// ── ConfigView ────────────────────────────────────────────────────────────────
type ConfigData = {
  command?: string; path: string; env: string; changes_dir: string;
  psql_path: string; lock_timeout: string; stmt_timeout: string;
  checksum_policy: string; placeholders: string; conn: string;
};

function ConfigView({ data }: { data: ConfigData }) {
  const envColor = data.env?.toLowerCase().includes('prod') ? 'env-prod' : 'env-dev';
  const rows: Array<[string, string, string?]> = [
    ['Config Path', data.path],
    ['Environment', data.env, envColor],
    ['Changes Dir', data.changes_dir],
    ['psql Path', data.psql_path ?? 'auto'],
    ['Lock Timeout', data.lock_timeout],
    ['Stmt Timeout', data.stmt_timeout],
    ['Checksum Policy', data.checksum_policy],
    ['Placeholders', data.placeholders],
    ['Connection', data.conn, 'muted'],
  ];

  return (
    <div className="cv-root">
      <div className="cv-kv-grid">
        {rows.map(([key, val, mod]) => (
          <div key={key} className="cv-kv-row">
            <div className="cv-kv-key">{key}</div>
            <div className={`cv-kv-val${mod ? ` cv-kv-val--${mod}` : ''}`}>{val || '—'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── InitView ──────────────────────────────────────────────────────────────────
type InitData = { command?: string; status: string; message: string };

function InitView({ data }: { data: InitData }) {
  const isOk = data.status === 'ok';
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {titled(`${isOk ? '✓' : '✗'}  ${data.message ?? (isOk ? 'Registry initialized' : 'Init failed')}`)}
        </div>
      </div>
    </div>
  );
}

// ── TagView ───────────────────────────────────────────────────────────────────
type TagData =
  | Array<{ tag_name: string; change_id: string; created_at: string; description: string; applied?: boolean }>
  | { tag: string; change_id?: string; status: string };

function TagView({ data }: { data: TagData }) {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <div className="cv-root"><EmptyState text="No tags yet" /></div>;
    }
    const formatDate = (s: string) => {
      if (!s) return '—';
      try { return new Date(s).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); }
      catch { return s; }
    };
    return (
      <div className="cv-root">
        <div className="cv-table-wrap">
          {data.map(t => (
            <div key={t.tag_name} className="cv-tag-item">
              <span className="cv-tag-name">@{t.tag_name}</span>
              <span className="cv-tag-change">→ {t.change_id}</span>
              {t.applied === false && (
                <span className="cv-badge cv-badge--failed" title="The tagged change is no longer applied (it was reverted). The tag row is kept.">
                  <WarningTriangleIcon size={11} style={{ verticalAlign: '-1px' }} />&nbsp;change reverted
                </span>
              )}
              {t.description && <span style={{ fontSize: 11, color: 'var(--dm-c-64748b)' }}>{t.description}</span>}
              <span className="cv-tag-date">{formatDate(t.created_at)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const d = data as { tag: string; change_id?: string; status: string };
  const isOk = d.status === 'created' || d.status === 'deleted' || d.status === 'ok';
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {isOk ? <CheckCircleIcon size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} /> : <XCircleIcon size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />}Tag <span style={{ color: 'var(--dm-c-f9a8d4)', marginLeft: 4, marginRight: 4 }}>@{d.tag}</span>
          {d.status === 'created' ? ' created' : d.status === 'deleted' ? ' deleted' : ` — ${d.status}`}
          {d.change_id && ` → ${d.change_id}`}
        </div>
      </div>
    </div>
  );
}

// ── RevertView ────────────────────────────────────────────────────────────────
type RevertData =
  | { status: string; change_id: string | null; action: string }
  | { status: string; target: string; action: string }
  | Array<{ change_id: string; applied_at: string }>;

function RevertView({ data, args }: { data: RevertData; args: string[] }) {
  // hundreds of applied changes: search and pages (first, on every render: the view returns early by shape)
  const pg = usePagedRows(Array.isArray(data) ? data : [], r => r.change_id);
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <div className="cv-root"><EmptyState text="No applied changes" /></div>;
    }
    const formatDate = (s: string) => {
      if (!s) return '—';
      try { return new Date(s).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); }
      catch { return s; }
    };
    return (
      <div className="cv-root">
        <div className="cv-summary">
          <span className="cv-summary-num cv-summary-num--green">{data.length}</span>
          <span>applied change{data.length !== 1 ? 's' : ''} (most recent first)</span>
        </div>
        {pg.bar}
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr 150px' }}>
            <div className="cv-th">Change</div>
            <div className="cv-th">Applied At</div>
          </div>
          <div className="cv-table-body">
            {pg.rows.map(r => (
              <div key={r.change_id} className="cv-table-row" style={{ gridTemplateColumns: '1fr 150px' }}>
                <div className="cv-td cv-td-main"><ChangeIdLabel id={r.change_id} /></div>
                <div className="cv-td cv-td-mono">{formatDate(r.applied_at)}</div>
              </div>
            ))}
          </div>
          {pg.more}
        </div>
      </div>
    );
  }

  const d = data as Record<string, unknown>;
  const status = d['status'] as string;
  const isNothing = status === 'nothing_to_revert';
  const isOk = status === 'ok';

  if (isNothing) {
    return (
      <div className="cv-root">
        <div className="cv-alert cv-alert--info">
          <div className="cv-alert-title"><InboxIcon size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />Nothing to revert</div>
        </div>
      </div>
    );
  }

  // --dry-run: what would be reverted, newest first; nothing was changed
  if (status === 'dry_run') {
    const plan = (d['changes'] as string[] | undefined) ?? [];
    const target = d['target'] as string | undefined;
    return (
      <div className="cv-root">
        <div className="cv-alert cv-alert--info">
          <div className="cv-alert-title">
            <EyeIcon size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Dry run: {target ? <>revert to <ChangeIdLabel id={target} /> would revert</> : 'would revert'} {plan.length} change{plan.length === 1 ? '' : 's'}, newest first. Nothing was reverted.
          </div>
        </div>
        {plan.length > 0 && (
          <div className="cv-table-wrap">
            <div className="cv-table-head" style={{ gridTemplateColumns: '48px 1fr' }}>
              <div className="cv-th">#</div>
              <div className="cv-th">Would revert</div>
            </div>
            <div className="cv-table-body">
              {plan.map((id, i) => (
                <div key={id} className="cv-table-row" style={{ gridTemplateColumns: '48px 1fr' }}>
                  <div className="cv-td">{i + 1}</div>
                  <div className="cv-td cv-td-main"><ChangeIdLabel id={id} /></div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const changeId = (d['change_id'] ?? d['target']) as string;
  const action = (d['action'] as string) ?? args.join(' ');
  const isRevertTo = action === 'revert_to';

  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {isOk ? <CheckCircleIcon size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} /> : <XCircleIcon size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />}
          {isRevertTo ? `Reverted to: ${changeId}` : `Reverted: ${changeId ?? '—'}`}
        </div>
      </div>
    </div>
  );
}

// ── RepeatableView ────────────────────────────────────────────────────────────
type RepeatableData = { status: string; applied: string[] | Array<Record<string, unknown>> };

function RepeatableView({ data }: { data: RepeatableData }) {
  const applied = (data.applied ?? []) as unknown[];
  const count = applied.length;
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${count > 0 ? 'success' : 'info'}`}>
        <div className="cv-alert-title">
          {titled(count > 0
            ? `✓  ${count} repeatable migration${count !== 1 ? 's' : ''} applied`
            : '◌  No repeatable migrations needed updating')}
        </div>
      </div>
      {count > 0 && (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr' }}>
            <div className="cv-th">Change</div>
          </div>
          <div className="cv-table-body">
            {applied.map((a, i) => (
              <div key={i} className="cv-table-row" style={{ gridTemplateColumns: '1fr' }}>
                <div className="cv-td cv-td-main">{typeof a === 'string' ? a : JSON.stringify(a)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── BaselineView ──────────────────────────────────────────────────────────────
type BaselineData = { status: string; baselined: string[] };

function BaselineView({ data }: { data: BaselineData }) {
  const count = data.baselined?.length ?? 0;
  return (
    <div className="cv-root">
      <div className="cv-alert cv-alert--success">
        <div className="cv-alert-title">{titled(`✓  Baseline complete — ${count} change${count !== 1 ? 's' : ''} marked as applied`)}</div>
      </div>
      {count > 0 && (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr' }}>
            <div className="cv-th">Change</div>
          </div>
          <div className="cv-table-body">
            {data.baselined.map(id => (
              <div key={id} className="cv-table-row" style={{ gridTemplateColumns: '1fr' }}>
                <div className="cv-td cv-td-main">{id}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── RepairView ────────────────────────────────────────────────────────────────
type RepairData =
  | { action: 'checksums'; repaired: string[] }
  | { action: 'unlock'; status: string; cleared: boolean; previous_holder?: string }
  | { change_id: string; action: string; status: string };

function RepairView({ data }: { data: RepairData }) {
  const d = data as Record<string, unknown>;
  if (d['action'] === 'checksums') {
    const repaired = (d['repaired'] as string[]) ?? [];
    return (
      <div className="cv-root">
        <div className="cv-alert cv-alert--success">
          <div className="cv-alert-title">{titled(`✓  ${repaired.length} checksum${repaired.length !== 1 ? 's' : ''} reconciled`)}</div>
        </div>
        {repaired.length > 0 && (
          <div className="cv-table-wrap">
            <div className="cv-table-head" style={{ gridTemplateColumns: '1fr' }}>
              <div className="cv-th">Change</div>
            </div>
            <div className="cv-table-body">
              {repaired.map(id => (
                <div key={id} className="cv-table-row" style={{ gridTemplateColumns: '1fr' }}>
                  <div className="cv-td cv-td-main">{id}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (d['action'] === 'unlock') {
    const cleared = d['cleared'] === true;
    const holder = d['previous_holder'] as string | undefined;
    return (
      <div className="cv-root">
        <div className="cv-alert cv-alert--success">
          <div className="cv-alert-title">{titled(cleared ? '✓  Deploy lock cleared' : '◌  No deploy lock was held')}</div>
          {cleared && holder && <div className="cv-alert-body">Was held by {holder}</div>}
        </div>
      </div>
    );
  }

  const action = d['action'] as string;
  const changeId = d['change_id'] as string;
  const status = (d['status'] as string) ?? 'ok';
  const isOk = status === 'ok';
  const actionLabel = action === 'mark-applied' ? 'marked as applied' : action === 'mark-reverted' ? 'marked as reverted' : action;

  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {isOk ? '✓  ' : '✗  '}{changeId} {actionLabel}
        </div>
      </div>
    </div>
  );
}

// ── HelpView ──────────────────────────────────────────────────────────────────
const HELP_CMDS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/status',              desc: 'Show applied / pending changes' },
  { cmd: '/deploy',              desc: 'Apply all pending changes' },
  { cmd: '/deploy --dry-run',    desc: 'Preview pending changes (no DB writes)' },
  { cmd: '/deploy --to <id>',    desc: 'Deploy up to a specific change or @tag' },
  { cmd: '/verify',              desc: 'Run verify.sql for last change' },
  { cmd: '/history',             desc: 'Show change_log history' },
  { cmd: '/info',                desc: 'Summary stats and registry health' },
  { cmd: '/plan',                desc: 'Show dependency-aware execution plan' },
  { cmd: '/check',               desc: 'Preflight validation (no DB writes)' },
  { cmd: '/parse <sql>',         desc: 'Validate SQL in a rolled-back transaction' },
  { cmd: '/repeatable',          desc: 'Apply R__ migrations with changed checksums' },
  { cmd: '/tag list',            desc: 'List release tags' },
  { cmd: '/tag create <name>',   desc: 'Create a release tag at current state' },
  { cmd: '/tag delete <name>',   desc: 'Delete a release tag' },
  { cmd: '/revertLast',          desc: 'Revert the last applied change' },
  { cmd: '/revert list',         desc: 'List all applied changes' },
  { cmd: '/revert <id>',         desc: 'Revert a specific change (must be latest)' },
  { cmd: '/revert to <id|@t>',   desc: 'Revert all changes down to target' },
  { cmd: '/baseline <id>',       desc: 'Mark change as applied without running SQL' },
  { cmd: '/repair --checksums',  desc: 'Recalculate all stored checksums' },
  { cmd: '/repair --unlock',     desc: 'Clear the deploy lock left by a crashed run' },
  { cmd: '/init',                desc: 'Initialize DMCR registry tables (once)' },
  { cmd: '/config',              desc: 'Show active configuration' },
  { cmd: '/ls [pattern]',        desc: 'Tree view of changes directory' },
  { cmd: '/it',                  desc: 'Interactive revert mode (arrow keys)' },
];

const HELP_SHORTCUTS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/clear',   desc: 'Clear the terminal' },
  { cmd: '/help',    desc: 'Show this help' },
  { cmd: '↑ / ↓',    desc: 'Navigate command history' },
];

function HelpView() {
  return (
    <div className="cv-root">
      <SectionHd title="DMCR Commands" />
      <div className="cv-table-wrap">
        <div className="cv-table-head" style={{ gridTemplateColumns: '190px 1fr' }}>
          <div className="cv-th">Command</div>
          <div className="cv-th">Description</div>
        </div>
        <div className="cv-table-body">
          {HELP_CMDS.map(r => (
            <div key={r.cmd} className="cv-table-row" style={{ gridTemplateColumns: '190px 1fr' }}>
              <div className="cv-td cv-td-mono" style={{ color: 'var(--dm-c-67e8f9)' }}>{r.cmd}</div>
              <div className="cv-td" style={{ color: 'var(--dm-c-94a3b8)' }}>{r.desc}</div>
            </div>
          ))}
        </div>
      </div>
      <SectionHd title="Shell Shortcuts" />
      <div className="cv-table-wrap">
        <div className="cv-table-body">
          {HELP_SHORTCUTS.map(r => (
            <div key={r.cmd} className="cv-table-row" style={{ gridTemplateColumns: '190px 1fr' }}>
              <div className="cv-td cv-td-mono" style={{ color: 'var(--dm-c-67e8f9)' }}>{r.cmd}</div>
              <div className="cv-td" style={{ color: 'var(--dm-c-94a3b8)' }}>{r.desc}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="cv-help-tip">Tip: /<code>command</code> --help for detailed docs on any command</div>
    </div>
  );
}

// ── GenericResultView ─────────────────────────────────────────────────────────
function GenericResultView({ result }: { result: JsonCommandResult }) {
  const { exitCode, data } = result;
  const d = data as Record<string, unknown>;
  const status = d?.status as string | undefined;
  const rawMsg = d?.message as string | undefined;
  const stackTrace = d?.stackTrace as string | undefined;

  const isError = status === 'error' || (exitCode != null && exitCode !== 0);

  // Strip leading DMCR log symbols, then split into title + body lines
  const lines = (rawMsg ?? '')
    .split('\n')
    .map(l => l.replace(/^[\s›✓✗\u25C7◌×✕\u23F3]+\s*/, '').trim())
    .filter(Boolean);

  const titleLine = lines[0] ?? (isError ? 'Command failed' : 'Done');
  const bodyLines = lines.slice(1);

  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isError ? 'error' : 'info'}`}>
        <div className="cv-alert-title">
          {isError ? '✗  ' : '◌  '}{titleLine}
        </div>
        {bodyLines.length > 0 && (
          <div className="cv-alert-body">
            {bodyLines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
      {stackTrace && (
        <div className="cv-stack-trace">
          <div className="cv-stack-trace-label">Stack trace</div>
          <pre className="cv-stack-trace-pre">{stackTrace}</pre>
        </div>
      )}
    </div>
  );
}

/** Value of a flag given as `--flag value` or `--flag=value`. */
const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i >= 0) return args[i + 1];
  return args.find(a => a.startsWith(flag + '='))?.slice(flag.length + 1);
};

// ── CommandResultView — routes to the right sub-view ─────────────────────────
export function CommandResultView({ result, risk }: { result: JsonCommandResult; risk?: RiskState }) {
  const { command, args, data } = result;
  const cmd = command.toLowerCase();
  const subArg = args[1]?.toLowerCase();

  // Synthetic results (no JSON stdout) — always go to generic view
  if ((data as Record<string, unknown>)?.__synthetic) {
    return <GenericResultView result={result} />;
  }

  try {
    if (cmd === 'help')                            return <HelpView />;
    if (cmd === 'status')                          return <StatusView data={data as StatusRow[]} env={argValue(args, '--env')} />;
    if (cmd === 'history')                         return <HistoryView data={data as HistoryRow[]} />;
    // git-style: log (a single deployment shows like deployments <id>), diff, show <change_id>
    if (cmd === 'log' && (data as { deployments?: unknown })?.deployments) return <LogView data={data as Parameters<typeof LogView>[0]['data']} />;
    if (cmd === 'log' || cmd === 'deployments')    return <DeploymentsView data={data as Parameters<typeof DeploymentsView>[0]['data']} />;
    if (cmd === 'diff' && (data as { mode?: string })?.mode) return <DiffView data={data as Parameters<typeof DiffView>[0]['data']} />;
    if (cmd === 'show' && (data as { deploy_id?: string; changes?: unknown })?.deploy_id && Array.isArray((data as { changes?: unknown }).changes)) return <DeploymentsView data={data as Parameters<typeof DeploymentsView>[0]['data']} />;
    if (cmd === 'show' && (data as { state?: string; change_id?: string })?.state && (data as { change_id?: string }).change_id) return <ShowChangeView data={data as Parameters<typeof ShowChangeView>[0]['data']} />;
    if (cmd === 'info')                            return <InfoView data={data as InfoData} />;
    if (cmd === 'check')                           return <CheckView data={data as CheckData} />;
    if (cmd === 'plan')                            return <PlanView data={data as PlanRow[]} />;
    if (cmd === 'deploy')                          return <DeployView data={data as DeployData} risk={risk} />;
    if (cmd === 'verify')                          return <VerifyView data={data as VerifyData} />;
    if (cmd === 'test')                            return <TestView data={data as TestData} />;
    if (cmd === 'show')                            return <ConfigView data={data as ConfigData} />;
    if (cmd === 'init')                            return <InitView data={data as InitData} />;
    if (cmd === 'tag')                             return <TagView data={data as TagData} />;
    if (cmd === 'release')                         return <ReleaseView data={data as Parameters<typeof ReleaseView>[0]['data']} />;
    if (cmd === 'revert' && (data as { action?: string })?.action === 'revert_scope') return <RevertScopeView data={data as ScopeRevert} />;
    if (cmd === 'revert' && (data as { status?: string })?.status === 'nothing_to_revert' && (data as { scope?: string })?.scope) return <RevertScopeView data={data as ScopeRevert} />;
    if (cmd === 'revert' && subArg !== 'list')     return <RevertView data={data as RevertData} args={args} />;
    if (cmd === 'revert' && subArg === 'list')     return <RevertView data={data as RevertData} args={args} />;
    if (cmd === 'revertlast' || cmd === 'revert-last') return <RevertView data={data as RevertData} args={args} />;
    if (cmd === 'repeatable')                      return <RepeatableView data={data as RepeatableData} />;
    if (cmd === 'baseline')                        return <BaselineView data={data as BaselineData} />;
    if (cmd === 'repair')                          return <RepairView data={data as RepairData} />;
  } catch {
    // Fall through to generic view
  }

  return <GenericResultView result={result} />;
}
