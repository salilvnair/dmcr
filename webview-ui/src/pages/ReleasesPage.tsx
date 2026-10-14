import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ButtonView, IconButtonView, ChipView, ModalView, SelectInputView, TextInputView, DateInputView, LoaderView, ProgressBarView, RadioCardView, TogglePillView, SkeletonView,
  ReleaseIcon, CalendarIcon, RocketLaunchIcon, UndoIcon, RefreshIcon, PlusIcon, EyeIcon, LayersIcon,
  BlockedIcon, UserSingleIcon, UserCheckIcon, WarningTriangleIcon, ShieldAlertIcon, CheckCircleIcon,
  PackageDependencyIcon, ArchiveIcon, CopyIcon, DownloadIcon, EditorView, PullRequestIcon, GithubMarkIcon, SplitVerticalIcon, TestTubeIcon,
} from '@salilvnair/dui';
import { downloadText } from '../services/theme/palette-file';
import { LockLintList, LockLintChip, type LintFinding } from '../components/LockLint';
import { postMsg } from '../vscode';
import { PROJECT_TYPE_COLORS } from '../components/ChangeCard';
import { ChangeSqlViewer } from './runner/views/ChangeSqlViewer';
import { ChangeIdLabel, ProjectChip, KindChip, PersonChip, ReleaseChip, WarnText } from './runner/views/ChangeIdLabel';
import './runner/views/CommandViews.css';
import { ConflictsCard } from './releases/ConflictsCard';
import { ZeroDowntimeModal } from './releases/ZeroDowntimeModal';
import { TestPicker } from './runner/views/TestPicker';
import './ReleasesPage.css';

/* ── Data from the extension (release-handlers.ts) ───────────────────────── */
type Release = { id: string; name?: string; date?: string; status?: string; notes?: string };
type Project = { id: string; name?: string; type?: string; release?: string; status?: string; dropped_reason?: string };
type Catalog = { releases: Release[]; projects: Project[] };
type ChangeRow = {
  id: string; project: string; kind: string; inferredKind: string; requested_by: string; created_by: string; created_at: string;
  ticket: string; status: 'active' | 'dropped'; dropped_reason: string; danger: boolean; metaError?: string;
  /** lock / safety lint of deploy.sql */
  lint?: LintFinding[];
};
type ReleaseData = {
  changesDir?: string; catalog: Catalog | null; catalogError?: string; changes: ChangeRow[]; envs: string[]; active: string;
  dbaName: string; projectTypes: string[]; changeKinds: string[]; error?: string; saveError?: string; saved?: string; requestId?: string;
  /** releases.json has changes git has not committed; releasesCommitted answers commitReleases */
  releasesUncommitted?: boolean; releasesCommitted?: string;
};
/* From the runner: release list --json, status --json, deploy/revert --dry-run --json */
type ReleaseSummary = { release: string; total: number; applied: number; pending: number; dropped: number; last_applied?: string };
type CaptureResult = { captureId: string; exitCode: number | null; data: Record<string, unknown> | unknown[] };
type PlanChange = { change_id: string; project?: string; release?: string; kind?: string };

const RELEASE_STATUSES = ['planned', 'deployed', 'cancelled'];
const TYPE_LABEL: Record<string, string> = { new: 'New', bugfix: 'Bug fix', cr: 'CR', hotfix: 'Hotfix', other: 'Other' };

const kindOf = (c: ChangeRow) => c.kind || c.inferredKind;
const typeColor = (t?: string) => PROJECT_TYPE_COLORS[t ?? ''] ?? 'var(--dm-c-64748b)';
const envColor = (env: string) => (/prod/i.test(env) ? 'var(--dm-c-ef4444)' : /test|st|stag|uat/i.test(env) ? 'var(--dm-c-f59e0b)' : 'var(--dm-c-3b82f6)');

function PencilIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

/** Runs a runner command for this page only (dmcrCaptureResult), never in the Runner terminal. */
function useCapture() {
  const waiting = useRef(new Map<string, (r: CaptureResult) => void>());
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'dmcrCaptureResult') return;
      const r = e.data.payload as CaptureResult;
      const done = waiting.current.get(r.captureId);
      if (done) { waiting.current.delete(r.captureId); done(r); }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);
  return useCallback((args: string[]) => new Promise<CaptureResult>(resolve => {
    const captureId = `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    waiting.current.set(captureId, resolve);
    postMsg({ type: 'runDmcr', payload: { args: [...args, '--json'], captureId } });
  }), []);
}

const errorText = (r: CaptureResult) => {
  const d = r.data as Record<string, unknown>;
  return String(d?.message ?? (Array.isArray(d?.problems) ? (d.problems as string[]).join('\n') : '') ?? `exit ${r.exitCode}`);
};

interface Props { visible: boolean; onRunInRunner: (args: string[]) => void; onOpenSettings: () => void }

export default function ReleasesPage({ visible, onRunInRunner, onOpenSettings }: Props) {
  const [data, setData] = useState<ReleaseData | null>(null);
  const [env, setEnv] = useState('');
  const [summaries, setSummaries] = useState<Record<string, ReleaseSummary>>({});
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const [statusError, setStatusError] = useState('');
  const [loadingStatus, setLoadingStatus] = useState(false);
  // dmcr approvals: whether this environment needs a sign-off, and each pending change's approval
  const [approvals, setApprovals] = useState<Approvals | null>(null);
  const [approving, setApproving] = useState<{ release?: string; ids: string[] } | null>(null);
  const [ciOpen, setCiOpen] = useState(false);
  const [zdOpen, setZdOpen] = useState(false);
  const [committingReleases, setCommittingReleases] = useState(false);
  // progress of the status read: finished runner calls out of the total, and how long the last read took
  const [loadSteps, setLoadSteps] = useState<{ done: number; total: number; started: number; expected: number } | null>(null);
  const lastLoadMs = useRef(2500);
  // the one-transaction script a DBA runs by hand for a danger_ change (dmcr manual-script)
  const [manual, setManual] = useState<{ id: string; env: string; script?: string; error?: string } | null>(null);
  const openManualScript = async (id: string) => {
    setManual({ id, env });
    const r = await capture(['manual-script', id, '--env', env]);
    const d = r.data as { script?: string } | null;
    setManual(r.exitCode === 0 && d?.script ? { id, env, script: d.script } : { id, env, error: errorText(r) });
  };
  // the change files viewer: one change (row click) or a project's changes (project row click)
  const [viewing, setViewing] = useState<{ ids: string[]; title?: ReactNode } | null>(null);
  // Round-trip test picker (dmcr test): from the Changes header (never-passed ticked) or a row (that one ticked)
  const [testPick, setTestPick] = useState<{ preselect?: string[] } | null>(null);
  const [initing, setIniting] = useState(false);
  const changesRef = useRef<HTMLElement | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [editRelease, setEditRelease] = useState<{ value: Release; isNew: boolean } | null>(null);
  const [editProject, setEditProject] = useState<{ value: Project; isNew: boolean } | null>(null);
  const [dropChange, setDropChange] = useState<{ id: string; reason: string } | null>(null);
  const [editChange, setEditChange] = useState<ChangeRow | null>(null);
  const [preview, setPreview] = useState<{ release: string; loading: boolean; changes?: PlanChange[]; dropped?: { change_id: string; reason: string }[]; error?: string } | null>(null);
  const [rollback, setRollback] = useState<RollbackState | null>(null);
  const capture = useCapture();

  /* ── extension data ── */
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'releaseData') return;
      const p = e.data.payload as ReleaseData;
      if (p.error) { setNotice({ kind: 'error', text: p.error }); return; }
      setData(p);
      setCommittingReleases(false);
      if (p.saveError) setNotice({ kind: 'error', text: p.saveError });
      else if (p.releasesCommitted) setNotice({ kind: 'ok', text: p.releasesCommitted === 'nothing to commit' ? 'releases.json: nothing to commit' : `releases.json committed (${p.releasesCommitted})` });
      else if (p.saved) setNotice({ kind: 'ok', text: p.saved === 'catalog' ? 'releases.json saved' : `${p.saved}/meta.json saved` });
      setEnv(prev => (prev && p.envs.includes(prev) ? prev : (p.envs.includes(p.active) ? p.active : p.envs[0] ?? '')));
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);
  useEffect(() => { if (visible) postMsg({ type: 'getReleaseData' }); }, [visible]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 4000); return () => clearTimeout(t); }, [notice]);

  /* ── runner status of the selected environment ── */
  const refreshStatus = useCallback(async () => {
    if (!env) return;
    setLoadingStatus(true); setStatusError('');
    const started = Date.now();
    setLoadSteps({ done: 0, total: data?.catalog ? 3 : 2, started, expected: lastLoadMs.current });
    const step = <T,>(p: Promise<T>) => p.then(v => { setLoadSteps(x => (x ? { ...x, done: x.done + 1 } : x)); return v; });
    const [rl, st, ap] = await Promise.all([
      data?.catalog ? step(capture(['release', 'list', '--env', env])) : Promise.resolve(null),
      step(capture(['status', '--env', env])),
      step(capture(['approvals', '--env', env])),
    ]);
    const apd = ap.data as { required?: boolean; approvers?: string[]; changes?: ApprovalRow[] } | null;
    setApprovals(ap.exitCode === 0 && apd && Array.isArray(apd.changes)
      ? { required: !!apd.required, approvers: apd.approvers ?? [], byId: Object.fromEntries(apd.changes.map(c => [c.change_id, c])) }
      : null);
    lastLoadMs.current = Date.now() - started;
    if (rl) {
      const d = rl.data as { releases?: ReleaseSummary[] };
      if (rl.exitCode === 0 && Array.isArray(d.releases)) setSummaries(Object.fromEntries(d.releases.map(s => [s.release, s])));
      else { setSummaries({}); setStatusError(errorText(rl)); }
    } else setSummaries({});
    if (st.exitCode === 0 && Array.isArray(st.data)) {
      setApplied(Object.fromEntries((st.data as { change_id: string; status: string }[]).map(r => [r.change_id, r.status === 'applied'])));
    } else { setApplied({}); setStatusError(prev => prev || errorText(st)); }
    setLoadingStatus(false);
  }, [env, data?.catalog, capture]);
  // The pending, not-dropped changes of a release on this environment (what an approval covers)
  const pendingOf = (releaseId: string): string[] => {
    const projs = new Set((data?.catalog?.projects ?? []).filter(p => p.release === releaseId && p.status !== 'dropped').map(p => p.id));
    return (data?.changes ?? []).filter(c => projs.has(c.project) && c.status !== 'dropped' && applied[c.id] === false).map(c => c.id);
  };
  // Another environment: forget the last one's status so its rows never show under this heading
  useEffect(() => { setApplied({}); setSummaries({}); setApprovals(null); }, [env]);
  useEffect(() => { if (visible && env && data) void refreshStatus(); }, [visible, env, data?.catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── edits ── */
  const catalog: Catalog = data?.catalog ?? { releases: [], projects: [] };
  const saveCatalog = (next: Catalog) => postMsg({ type: 'saveReleaseCatalog', payload: { catalog: next } });
  const patchChange = (changeId: string, patch: Record<string, string>) => postMsg({ type: 'updateChangeMeta', payload: { changeId, patch } });
  const upsertRelease = (r: Release, isNew: boolean, oldId?: string) => {
    const releases = isNew ? [...catalog.releases, r] : catalog.releases.map(x => (x.id === oldId ? r : x));
    saveCatalog({ ...catalog, releases });
  };
  const upsertProject = (p: Project, isNew: boolean, oldId?: string) => {
    const projects = isNew ? [...catalog.projects, p] : catalog.projects.map(x => (x.id === oldId ? p : x));
    saveCatalog({ ...catalog, projects });
  };

  const changesByProject = useMemo(() => {
    const m: Record<string, ChangeRow[]> = {};
    for (const c of data?.changes ?? []) (m[c.project] ??= []).push(c);
    return m;
  }, [data?.changes]);
  const projectIds = new Set(catalog.projects.map(p => p.id));
  const unassigned = (data?.changes ?? []).filter(c => !c.project || !projectIds.has(c.project));

  const openPreview = async (release: string) => {
    setPreview({ release, loading: true });
    const r = await capture(['deploy', '--release', release, '--env', env, '--dry-run']);
    const d = r.data as { status?: string; changes?: PlanChange[]; dropped?: { change_id: string; reason: string }[]; message?: string };
    if (r.exitCode === 0 && (d.status === 'dry_run' || d.status === 'ok')) setPreview({ release, loading: false, changes: d.changes ?? [], dropped: d.dropped ?? [] });
    else setPreview({ release, loading: false, error: errorText(r) });
  };

  if (!data) {
    return <div className="rl-page"><LoaderView variant="spinner" label="Loading releases" center /></div>;
  }
  // The DBA name is required before anything is created, deployed or rolled back here
  const locked = !data.dbaName;
  const lockedWhy = locked ? 'Set your DBA name first (Settings > DMCR Config)' : undefined;

  // While an environment is read, the loader is the whole page under the header
  const fullLoad = loadingStatus && catalog.releases.length > 0;
  return (
    <div className={`rl-page${fullLoad ? ' rl-page--loading' : ''}`}>
      {/* Header: same layout as Schema Diff */}
      <div className="rl-head">
        <div className="rl-head-title">
          <span className="rl-title">Releases</span>
          <span className="rl-badge">Projects</span>
          <span className="rl-badge rl-badge--green">Rollback by scope</span>
        </div>
        <div className="rl-head-actions">
          <div className="rl-env">
            <span className="rl-env-label">Environment</span>
            <SelectInputView size="md"
              value={env}
              onChange={setEnv}
              options={data.envs.length ? data.envs.map(e => ({ value: e, label: e, badge: { label: e.toUpperCase(), color: envColor(e) } })) : [{ value: '', label: 'no environments in dmcr.cfg' }]}
              width={170}
            />
          </div>
          <ButtonView variant="ghost" iconLeft={<RefreshIcon size={13} />} label="Refresh" loading={loadingStatus} onClick={() => { postMsg({ type: 'getReleaseData' }); void refreshStatus(); }} />
        </div>
      </div>

      {fullLoad && <div className="rl-loading-page"><StatusLoader env={env} steps={loadSteps} releases={catalog.releases.length} changes={data.changes.length} /></div>}

      <div className="rl-intro">
        <div className="rl-intro-icon"><ReleaseIcon size={18} /></div>
        <div className="rl-intro-main">
          <div className="rl-intro-title">Plan, ship and roll back by project</div>
          <div className="rl-intro-text">Schedule <b>projects</b> into <b>releases</b>, deploy one release at a time, mark work as <b>not going</b>, and roll back a project or only its inserts, updates or DDL.</div>
        </div>
        {data.dbaName && <ChipView size="md" icon={<UserCheckIcon size={13} />} label={`DBA: ${data.dbaName}`} color="var(--dm-c-22c55e)" onClick={onOpenSettings} />}
      </div>

      <div className="rl-stats">
        {([
          { label: 'Releases', value: catalog.releases.length, color: 'var(--dm-c-818cf8)', icon: <CalendarIcon size={15} />, sub: catalog.releases.filter(r => r.status !== 'deployed' && r.status !== 'cancelled').length + ' planned' },
          { label: 'Projects', value: catalog.projects.length, color: 'var(--dm-c-34d399)', icon: <PackageDependencyIcon size={15} />, sub: catalog.projects.filter(p => p.status === 'dropped').length + ' not going' },
          { label: 'Changes', value: data.changes.length, color: 'var(--dm-c-60a5fa)', icon: <LayersIcon size={15} />, sub: loadingStatus ? <SkeletonView variant="text" width={120} height={11} /> : `${data.changes.filter(c => applied[c.id]).length} applied on ${env || '-'}` },
          { label: 'No project', value: unassigned.length, color: unassigned.length ? 'var(--dm-c-fbbf24)' : 'var(--dm-c-64748b)', icon: <WarningTriangleIcon size={15} />, sub: 'skipped by release deploys' },
        ]).map(t => (
          <div key={t.label} className="rl-stat-card" style={{ ['--rl-c' as string]: t.color }}>
            <div className="rl-stat-icon">{t.icon}</div>
            <div>
              <div className="rl-stat-value">{t.value}</div>
              <div className="rl-stat-label">{t.label}</div>
            </div>
            <div className="rl-stat-sub">{t.sub}</div>
          </div>
        ))}
      </div>

      {/* manual-only (danger_) changes still waiting on this environment: deploy never runs them */}
      {!loadingStatus && env && Object.keys(applied).length > 0 && (() => {
        const droppedProjects = new Set(catalog.projects.filter(p => p.status === 'dropped').map(p => p.id));
        const waiting = data.changes.filter(c => c.danger && !applied[c.id] && c.status !== 'dropped' && !droppedProjects.has(c.project));
        if (!waiting.length) return null;
        return (
          <div className="rl-manual">
            <ShieldAlertIcon size={18} />
            <div className="rl-manual-body">
              <b>{waiting.length} manual change{waiting.length === 1 ? '' : 's'} waiting on {env}</b>
              <span>Deploy never runs a danger_ change: the DBA runs it by hand, so they see every statement. DMCR gives one script for it (deploy, the registry record and verify, in one transaction) to run in DBeaver or psql.</span>
              {waiting.map(c => (
                <span key={c.id} className="rl-manual-row">
                  <span className="rl-manual-id" onClick={() => setViewing({ ids: [c.id] })} title="Open its files"><ChangeIdLabel id={c.id} /></span>
                  <ButtonView variant="primary" accentColor="var(--bs-status-error)" iconLeft={<ShieldAlertIcon size={13} />} label="Script for DBeaver" onClick={() => void openManualScript(c.id)} />
                </span>
              ))}
            </div>
          </div>
        );
      })()}
      <div className="rl-toolbar">
        <ButtonView variant="primary" accentColor="var(--dm-c-6366f1)" iconLeft={<PlusIcon size={13} />} label="New release" disabled={locked} title={lockedWhy} onClick={() => setEditRelease({ value: { id: '', date: '', status: 'planned' }, isNew: true })} />
        <ButtonView variant="secondary" iconLeft={<PlusIcon size={13} />} label="New project" disabled={locked || !catalog.releases.length} title={lockedWhy ?? (catalog.releases.length ? undefined : 'Add a release first')} onClick={() => setEditProject({ value: { id: '', type: 'new', release: catalog.releases[0]?.id ?? '', status: 'active' }, isNew: true })} />
        <ButtonView variant="secondary" iconLeft={<SplitVerticalIcon size={13} />} label="Zero-downtime change" disabled={locked || !catalog.projects.length} title={lockedWhy ?? 'Rename or retype a column, NOT NULL, a foreign key or an index without locking the table: expand / contract changes'} onClick={() => setZdOpen(true)} />
        <span className="rl-toolbar-gap" />
        {data.releasesUncommitted && (
          <ButtonView variant="primary" accentColor="var(--dm-c-22c55e)" iconLeft={<GithubMarkIcon size={13} />} loading={committingReleases}
            label={committingReleases ? 'Committing\u2026' : 'Commit releases.json'} disabled={committingReleases}
            title="Releases, projects, not-going and moves are saved to releases.json; commit it (and push when the repository has a remote)"
            onClick={() => { setCommittingReleases(true); postMsg({ type: 'commitReleases', payload: { requestId: `commit-releases-${Date.now()}` } }); }} />
        )}
        <ButtonView variant="secondary" iconLeft={<PullRequestIcon size={13} />} label="Set up CI" title="A GitHub Actions check on every pull request: lock lint, the history on an empty database, round trip of the changed changes" onClick={() => setCiOpen(true)} />
        <ButtonView variant="secondary" color="var(--dm-c-f87171)" iconLeft={<UndoIcon size={13} />} label="Roll back" disabled={locked || !env || !catalog.projects.length} onClick={() => setRollback(newRollback(catalog))} />
      </div>

      {!data.dbaName && (
        <div className="rl-notice rl-notice--required">
          <UserCheckIcon size={14} />
          <span><b>Your DBA name is required.</b> Every release, project and change records who created it. Set it once in Settings &gt; DMCR Config.</span>
          <ButtonView variant="secondary" color="var(--dm-c-fbbf24)" iconLeft={<UserCheckIcon size={12} />} label="Set DBA name" onClick={onOpenSettings} />
        </div>
      )}
      {notice && <div className={`rl-notice rl-notice--${notice.kind}`}>{notice.kind === 'ok' ? <CheckCircleIcon size={13} /> : <WarningTriangleIcon size={13} />}<span>{notice.text}</span></div>}
      {data.catalogError && <div className="rl-notice rl-notice--error"><WarningTriangleIcon size={13} /><span>releases.json could not be read: {data.catalogError}</span></div>}
      {statusError && (/registry not found/i.test(statusError) ? (
        <div className="rl-notice rl-notice--info">
          <ShieldAlertIcon size={14} />
          <span><b>DMCR is not set up on {env} yet.</b> Its registry (the dmcr schema that records what is applied) is created once per database.</span>
          <ButtonView variant="primary" accentColor="var(--dm-c-6366f1)" label={initing ? 'Setting up' : `Set up DMCR on ${env}`} loading={initing}
            onClick={async () => { setIniting(true); const r = await capture(['init', '--env', env]); setIniting(false); if (r.exitCode !== 0) setStatusError(errorText(r)); else void refreshStatus(); }} />
        </div>
      ) : (
        <div className="rl-notice rl-notice--warn"><WarningTriangleIcon size={13} /><span>Status on {env}: {statusError.replace(/^[\s\u2717\u2715]+/, '').replace(/^ERROR\s+/, '').split('\n')[0]}</span></div>
      ))}

      <div className="rl-body">
        {/* Releases */}
        {catalog.releases.length === 0 ? (
          <div className="rl-steps">
            {([
              { n: 1, badge: 'Release', color: 'var(--dm-c-818cf8)', icon: <CalendarIcon size={18} />, title: 'Add a release', desc: 'A date you ship on. Prod deploys one release at a time.', blocked: lockedWhy ?? '', action: () => setEditRelease({ value: { id: '', date: '', status: 'planned' }, isNew: true }) },
              { n: 2, badge: 'Project', color: 'var(--dm-c-34d399)', icon: <PackageDependencyIcon size={18} />, title: 'Add its projects', desc: 'New work, a bug fix or a CR. Move a project to another release, or mark it not going.', blocked: lockedWhy ?? 'Add a release first', action: () => setEditProject({ value: { id: '', type: 'new', release: '', status: 'active' }, isNew: true }) },
              { n: 3, badge: 'Changes', color: 'var(--dm-c-60a5fa)', icon: <LayersIcon size={18} />, title: 'Assign changes', desc: 'Pick the project on the change card when you save, or in the table below.', blocked: '', action: () => changesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
            ]).map(st => (
              <div key={st.n} className={`rl-step${st.blocked ? ' rl-step--blocked' : ''}`} style={{ ['--rl-c' as string]: st.color }}
                role="button" tabIndex={st.blocked ? -1 : 0} aria-disabled={!!st.blocked} title={st.blocked || undefined}
                onClick={() => { if (!st.blocked) st.action(); }}
                onKeyDown={e => { if (!st.blocked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); st.action(); } }}>
                <span className="rl-step-num">{st.n}</span>
                <span className="rl-step-icon">{st.icon}</span>
                <span className="rl-step-badge">{st.badge}</span>
                <span className="rl-step-title">{st.title}</span>
                <span className="rl-step-desc">{st.desc}</span>
                {st.blocked && <span className="rl-step-blocked">{st.blocked}</span>}
              </div>
            ))}
          </div>
        ) : fullLoad ? null : catalog.releases.map(r => {
          const s = summaries[r.id];
          const projects = catalog.projects.filter(p => p.release === r.id);
          return (
            <section key={r.id} className="rl-card">
              <div className="rl-card-head">
                <DateTile date={r.date || r.id} />
                <div className="rl-card-title">
                  <div className="rl-card-title-row">
                    <span className="rl-card-id">{r.name || r.id}</span>
                    <span className={`rl-pill rl-pill--${r.status ?? 'planned'}`}>{r.status ?? 'planned'}</span>
                  </div>
                  <div className="rl-card-sub">
                    <span className="rl-mono">{r.id}</span>
                    <span>{projects.length} project{projects.length === 1 ? '' : 's'}</span>
                    {s?.last_applied && <span>last deployed on {env} {s.last_applied}</span>}
                  </div>
                </div>
                <div className="rl-card-progress">
                  {loadingStatus ? (
                    <div className="rl-skel-progress">
                      <SkeletonView variant="text" width={90} height={11} />
                      <SkeletonView variant="block" width="100%" height={4} />
                    </div>
                  ) : s ? (
                    <>
                      <div className="rl-progress-label">
                        <span><b className="rl-ok">{s.applied}</b>/{s.total - s.dropped} on {env}</span>
                        {s.pending > 0 && <span className="rl-warn">{s.pending} pending</span>}
                        {s.dropped > 0 && <span className="rl-dim">{s.dropped} not going</span>}
                      </div>
                      <ProgressBarView value={s.total - s.dropped > 0 ? Math.round((100 * s.applied) / (s.total - s.dropped)) : 0} size="xs" color={s.pending ? 'var(--dm-c-6366f1)' : 'var(--dm-c-22c55e)'} />
                    </>
                  ) : null}
                </div>
                <div className="rl-card-actions">
                  {!loadingStatus && approvals?.required && (() => {
                    const ids = pendingOf(r.id);
                    const need = ids.filter(id => approvals.byId[id]?.state !== 'approved');
                    if (!ids.length) return null;
                    return need.length ? (
                      <ButtonView variant="secondary" color="var(--dm-c-f59e0b)" iconLeft={<UserCheckIcon size={12} />} label={`Approve ${need.length}`} disabled={locked}
                        title={lockedWhy ?? `${need.length} of ${ids.length} pending change${ids.length === 1 ? '' : 's'} need a sign-off before they deploy to ${env}`}
                        onClick={() => setApproving({ release: r.id, ids })} />
                    ) : (
                      <span className="rl-approved" title={ids.map(id => `${id}: approved by ${approvals.byId[id]?.by} (${approvals.byId[id]?.at})`).join('\n')} onClick={() => setApproving({ release: r.id, ids })}>
                        <UserCheckIcon size={13} />Approved
                      </span>
                    );
                  })()}
                  {loadingStatus ? (
                    <SkeletonView variant="block" width={92} height={28} style={{ borderRadius: 6 }} />
                  ) : s && s.total - s.dropped > 0 && s.pending === 0 ? (
                    // every change of this release is already on this environment: nothing to deploy
                    <span className="rl-all-on" title={`All ${s.applied} change${s.applied === 1 ? '' : 's'} of release ${r.id} are already applied on ${env}: nothing to deploy`}>
                      <CheckCircleIcon size={13} />All on {env}
                    </span>
                  ) : (
                    <ButtonView variant="primary" accentColor="var(--dm-c-6366f1)" iconLeft={<RocketLaunchIcon size={12} />} label="Deploy" disabled={locked || !env || loadingStatus || (s ? s.total - s.dropped === 0 : true)} title={lockedWhy ?? (loadingStatus ? `Reading the status on ${env}` : s && s.total - s.dropped === 0 ? 'No changes in this release yet' : `Preview, then deploy release ${r.id} to ${env}`)} onClick={() => void openPreview(r.id)} />
                  )}
                  <ButtonView variant="ghost" color="var(--dm-c-f87171)" iconLeft={<UndoIcon size={12} />} label="Roll back" disabled={locked || !env || !s?.applied} onClick={() => setRollback({ ...newRollback(catalog), scope: 'release', release: r.id })} />
                  <ButtonView variant="ghost" iconLeft={<PencilIcon size={12} />} label="Edit" onClick={() => setEditRelease({ value: { ...r }, isNew: false })} />
                </div>
              </div>
              {projects.length === 0 ? (
                <div className="rl-card-empty">
                  No projects in this release yet.
                  <ButtonView variant="ghost" iconLeft={<PlusIcon size={12} />} label="Add a project" onClick={() => setEditProject({ value: { id: '', type: 'new', release: r.id, status: 'active' }, isNew: true })} />
                </div>
              ) : projects.map(p => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  changes={changesByProject[p.id] ?? []}
                  applied={applied}
                  loading={loadingStatus}
                  onOpen={() => setViewing({ ids: (changesByProject[p.id] ?? []).map(c => c.id), title: <span className="rl-mono">{p.id}{p.name ? ` · ${p.name}` : ''} · {(changesByProject[p.id] ?? []).length} changes</span> })}
                  onEdit={() => setEditProject({ value: { ...p }, isNew: false })}
                  onDrop={() => setEditProject({ value: { ...p, status: 'dropped' }, isNew: false })}
                  onRestore={() => upsertProject({ ...p, status: 'active', dropped_reason: undefined }, false, p.id)}
                  onRollback={() => setRollback({ ...newRollback(catalog), scope: 'project', projects: [p.id] })}
                />
              ))}
            </section>
          );
        })}

        {catalog.projects.some(p => !p.release) && (
          <section className="rl-card rl-card--muted">
            <div className="rl-card-head"><div className="rl-card-title"><ArchiveIcon size={15} /><span className="rl-card-id">Unscheduled projects</span><span className="rl-muted">not in any release yet</span></div></div>
            {catalog.projects.filter(p => !p.release).map(p => (
              <ProjectRow key={p.id} project={p} changes={changesByProject[p.id] ?? []} applied={applied} loading={loadingStatus}
                onOpen={() => setViewing({ ids: (changesByProject[p.id] ?? []).map(c => c.id), title: <span className="rl-mono">{p.id}{p.name ? ` · ${p.name}` : ''} · {(changesByProject[p.id] ?? []).length} changes</span> })}
                onEdit={() => setEditProject({ value: { ...p }, isNew: false })}
                onDrop={() => setEditProject({ value: { ...p, status: 'dropped' }, isNew: false })}
                onRestore={() => upsertProject({ ...p, status: 'active', dropped_reason: undefined }, false, p.id)}
                onRollback={() => setRollback({ ...newRollback(catalog), scope: 'project', projects: [p.id] })} />
            ))}
          </section>
        )}

        {/* Conflicts between projects (git-style) */}
        <ConflictsCard visible={visible} dbaName={data.dbaName} onChanged={() => postMsg({ type: 'getReleaseData' })} />
        {ciOpen && <CiSetupModal onClose={() => setCiOpen(false)} />}
        {zdOpen && <ZeroDowntimeModal projects={catalog.projects} onClose={() => setZdOpen(false)} onCreated={() => postMsg({ type: 'getReleaseData' })} />}
        {approving && data && (
          <ApproveModal env={env} release={approving.release} ids={approving.ids} by={data.dbaName} approvals={approvals} capture={capture}
            onClose={() => setApproving(null)} onDone={() => { setApproving(null); void refreshStatus(); }} />
        )}
        {manual && <ManualScriptModal state={manual} onClose={() => setManual(null)} onRefresh={() => { setManual(null); void refreshStatus(); }} />}
        {testPick && <TestPicker extra={env ? ['--env', env] : []} preselect={testPick.preselect}
          onRun={args => { setTestPick(null); onRunInRunner(args); }} onClose={() => setTestPick(null)} />}
        {viewing && viewing.ids.length > 0 && <ChangeSqlViewer changeIds={viewing.ids} title={viewing.title} onClose={() => setViewing(null)} />}

        {/* Changes */}
        <section className="rl-card" ref={changesRef}>
          <div className="rl-card-head">
            <div className="rl-card-title"><LayersIcon size={15} /><span className="rl-card-id">Changes</span><span className="rl-muted">{data.changes.length} in {data.changesDir}</span></div>
            {unassigned.length > 0 && <div className="rl-card-stats"><span className="rl-stat"><b className="rl-warn">{unassigned.length}</b> without a project: a release deploy skips them</span></div>}
            <span style={{ marginLeft: 'auto' }}><ButtonView variant="secondary" iconLeft={<TestTubeIcon size={13} />} label="Round-trip test"
              disabled={!env || /prod/i.test(env) || data.changes.length === 0}
              title={/prod/i.test(env) ? 'The round-trip test runs on test, not prod: switch the environment to test' : `Pick pending changes and round-trip them on ${env || 'the environment'}: deploy, verify, revert, verify, all rolled back`}
              onClick={() => setTestPick({})} /></span>
          </div>
          {data.changes.length === 0 ? <div className="rl-card-empty">No change folders yet.</div> : (
            <div className="rl-table">
              <div className="rl-tr rl-th">
                <div>Change</div><div>Project</div><div>Kind</div><div>Requested by</div><div>Created by</div><div>{env || 'Status'}</div><div />
              </div>
              {data.changes.map(c => (
                <ChangeTableRow
                  key={c.id}
                  onOpen={() => setViewing({ ids: [c.id] })}
                  change={c}
                  projects={catalog.projects}
                  env={env}
                  isApplied={applied[c.id]}
                  approval={approvals?.required && applied[c.id] === false && c.status !== 'dropped' ? (approvals.byId[c.id] ?? { change_id: c.id, state: 'missing' }) : undefined}
                  loading={loadingStatus}
                  onPatch={patch => patchChange(c.id, patch)}
                  onEdit={() => setEditChange(c)}
                  onDrop={() => setDropChange({ id: c.id, reason: '' })}
                  onTest={/prod/i.test(env) ? undefined : () => setTestPick({ preselect: [c.id] })}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ── Modals ── */}
      {editRelease && (
        <ReleaseModal
          state={editRelease}
          existing={catalog.releases.map(r => r.id)}
          onClose={() => setEditRelease(null)}
          onSave={(r, oldId) => { upsertRelease(r, editRelease.isNew, oldId); setEditRelease(null); }}
          onDelete={editRelease.isNew || catalog.projects.some(p => p.release === editRelease.value.id) ? undefined : () => {
            saveCatalog({ ...catalog, releases: catalog.releases.filter(r => r.id !== editRelease.value.id) }); setEditRelease(null);
          }}
        />
      )}
      {editProject && (
        <ProjectModal
          state={editProject}
          releases={catalog.releases}
          types={data.projectTypes}
          existing={catalog.projects.map(p => p.id)}
          changeCount={(changesByProject[editProject.value.id] ?? []).length}
          onClose={() => setEditProject(null)}
          onSave={(p, oldId) => { upsertProject(p, editProject.isNew, oldId); setEditProject(null); }}
        />
      )}
      {editChange && (
        <ChangeEditModal
          change={editChange}
          projects={catalog.projects}
          kinds={data.changeKinds}
          env={env}
          locked={!!applied[editChange.id]}
          onClose={() => setEditChange(null)}
          onSave={patch => { if (Object.keys(patch).length) patchChange(editChange.id, patch); setEditChange(null); }}
        />
      )}
      {dropChange && (
        <ModalView open size="sm" onClose={() => setDropChange(null)} title={`Drop ${dropChange.id}`} headerIcon={<BlockedIcon size={16} />}
          subtitle="The folder stays in the repository; deploy skips it in every environment until you restore it."
          footerRight={<>
            <ButtonView variant="ghost" label="Cancel" onClick={() => setDropChange(null)} />
            <ButtonView variant="danger" label="Drop change" iconLeft={<BlockedIcon size={13} />} onClick={() => { patchChange(dropChange.id, { status: 'dropped', dropped_reason: dropChange.reason }); setDropChange(null); }} />
          </>}>
          <label className="rl-label">Reason</label>
          <TextInputView value={dropChange.reason} autoFocus placeholder="Why it is not going" onChange={e => setDropChange({ ...dropChange, reason: e.target.value })} />
        </ModalView>
      )}
      {preview && (
        <ModalView open size="lg" onClose={() => setPreview(null)} title={`Deploy release ${preview.release} to ${env}`} headerIcon={<RocketLaunchIcon size={16} />}
          subtitle="Dry run: nothing has been applied yet."
          footerRight={<>
            <ButtonView variant="ghost" label="Close" onClick={() => setPreview(null)} />
            <ButtonView variant="primary" iconLeft={<RocketLaunchIcon size={13} />} label={`Deploy in Runner`}
              disabled={preview.loading || !!preview.error || !preview.changes?.length}
              onClick={() => { const args = ['deploy', '--release', preview.release, '--env', env]; setPreview(null); onRunInRunner(args); }} />
          </>}>
          {preview.loading ? <LoaderView variant="dots" label="Planning" center /> : preview.error ? (
            <div className="rl-problem"><ShieldAlertIcon size={14} /><pre>{preview.error}</pre></div>
          ) : (
            <>
              {preview.changes?.length ? (
                <div className="rl-plan-banner rl-plan-banner--go">
                  <RocketLaunchIcon size={16} />
                  <div><b>{preview.changes.length} change{preview.changes.length === 1 ? '' : 's'} will be deployed to {env}</b><span>in this order</span></div>
                </div>
              ) : (
                <div className="rl-plan-banner rl-plan-banner--done">
                  <CheckCircleIcon size={18} />
                  <div><b>Nothing to deploy</b><span>Every change of release {preview.release} is already applied on {env}.</span></div>
                </div>
              )}
              <PlanTable changes={preview.changes ?? []} projects={catalog.projects} />
              {(() => {
                // lock risks in what this deploy would run
                const risky = (preview.changes ?? []).map(pc => ({ id: pc.change_id, lint: data.changes.find(c => c.id === pc.change_id)?.lint ?? [] })).filter(x => x.lint.length);
                return risky.map(x => <LockLintList key={x.id} findings={x.lint} title={`${x.id}: ${x.lint.length} lock risk${x.lint.length === 1 ? '' : 's'}`} />);
              })()}
              {!!preview.dropped?.length && (
                <>
                  <div className="rl-plan-title rl-muted">Skipped as dropped</div>
                  {preview.dropped.map(d => <div key={d.change_id} className="rl-plan-dropped"><BlockedIcon size={12} /><ChangeIdLabel id={d.change_id} /><span className="rl-muted">{d.reason}</span></div>)}
                </>
              )}
            </>
          )}
        </ModalView>
      )}
      {rollback && (
        <RollbackModal
          state={rollback}
          setState={setRollback}
          catalog={catalog}
          appliedByProject={Object.fromEntries(catalog.projects.map(p => [p.id, (changesByProject[p.id] ?? []).filter(c => applied[c.id]).length]))}
          env={env}
          capture={capture}
          onRun={args => { setRollback(null); onRunInRunner(args); }}
        />
      )}
    </div>
  );
}

/* Calendar-style tile: month over day */
function DateTile({ date }: { date: string }) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleString(undefined, { month: 'short' }) : '';
  return (
    <div className="rl-date">
      {m ? <><span className="rl-date-month">{month}</span><span className="rl-date-day">{Number(m[3])}</span></> : <CalendarIcon size={16} />}
    </div>
  );
}

/* ── Project row inside a release card ──────────────────────────────────── */
/** Reading an environment (like Daakia's log search): a ring round the icon, what is being read, and real progress:
 *  each finished runner call is its share, and in between the bar eases on by how long the last read took. */
function StatusLoader({ env, steps, releases, changes }: { env: string; steps: { done: number; total: number; started: number; expected: number } | null; releases: number; changes: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 120); return () => clearInterval(t); }, []);
  const total = steps?.total ?? 2, done = steps?.done ?? 0;
  const share = 100 / total;
  const elapsed = steps ? Date.now() - steps.started : 0;
  // inside the current step: up to 90% of its share, by elapsed time against the last read
  const within = steps ? Math.min(0.9, elapsed / Math.max(400, steps.expected)) * share : 0;
  const pct = Math.min(99, done * share + (done < total ? within : 0));
  return (
    <div className="rl-loader" data-testid="releases-loading">
      <span className="rl-loader-ring"><span className="rl-loader-glow" /><span className="rl-loader-spin" /><ReleaseIcon size={42} /></span>
      <span className="rl-loader-title">Reading {env}</span>
      <span className="rl-loader-sub">{releases} release{releases === 1 ? '' : 's'} and {changes} change{changes === 1 ? '' : 's'}: what is applied, pending or not going</span>
      <span className="rl-loader-bar"><ProgressBarView value={pct} size="xs" color="var(--bs-accent)" /></span>
      <span className="rl-loader-pct">{Math.round(pct)}% · {done} of {total} step{total === 1 ? '' : 's'} done{steps ? ` · ${(elapsed / 1000).toFixed(1)}s` : ''}</span>
    </div>
  );
}

/** The script for a danger_ change, to run by hand in DBeaver or psql: steps, the SQL, copy and download. */
function ManualScriptModal({ state, onClose, onRefresh }: { state: { id: string; env: string; script?: string; error?: string }; onClose: () => void; onRefresh: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <ModalView open size="xxl" height="95vh" maxHeight="95vh" className="rl-ms-modal" onClose={onClose} headerColor="var(--bs-status-error)" headerIcon={<ShieldAlertIcon size={16} />}
      title={<span className="rl-ms-title">Run by hand on {state.env}: <ChangeIdLabel id={state.id} /></span>}
      subtitle="Deploy, the DMCR registry record and verify, in one transaction: all of it commits, or nothing does"
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'hidden' }}
      footerRight={<>
        <ButtonView variant="ghost" label="Close" onClick={onClose} />
        <ButtonView variant="secondary" iconLeft={<RefreshIcon size={13} />} label={`I ran it: refresh ${state.env}`} onClick={onRefresh} />
      </>}>
      <ol className="rl-ms-steps">
        <li>Open DBeaver (or psql) connected to <b>{state.env}</b>, as a user that may change the schema.</li>
        <li>Paste the script and run it as a script: <b>Execute SQL Script (Alt+X)</b>; in psql, <code>-f</code>. Read it first: this is the danger_ part.</li>
        <li>It stops at the first error and nothing is applied. When it commits, DMCR sees the change as applied (recorded &ldquo;by hand&rdquo;).</li>
      </ol>
      {!state.script && !state.error ? <LoaderView variant="dots" label="Building the script" center />
        : state.error ? <div className="rl-blocked"><WarningTriangleIcon size={15} /><WarnText text={state.error} /></div>
        : (
          <>
            <div className="rl-ms-actions">
              <ButtonView variant="primary" accentColor="var(--bs-accent)" iconLeft={copied ? <CheckCircleIcon size={13} /> : <CopyIcon size={13} />} label={copied ? 'Copied' : 'Copy script'}
                onClick={() => { void navigator.clipboard?.writeText(state.script!); setCopied(true); setTimeout(() => setCopied(false), 2000); }} />
              <ButtonView variant="secondary" iconLeft={<DownloadIcon size={13} />} label="Download .sql" onClick={() => downloadText(`${state.id}.${state.env}.manual.sql`, state.script!, postMsg)} />
            </div>
            <div className="rl-ms-editor"><EditorView value={state.script ?? ''} language="sql" readOnly height="100%" fontSize={13} editorOptions={{ wordWrap: 'on', minimap: false, scrollBeyondLastLine: false }} /></div>
          </>
        )}
    </ModalView>
  );
}

function ProjectRow({ project: p, changes, applied, loading, onOpen, onEdit, onDrop, onRestore, onRollback }: {
  project: Project; changes: ChangeRow[]; applied: Record<string, boolean>; loading?: boolean; onOpen?: () => void;
  onEdit: () => void; onDrop: () => void; onRestore: () => void; onRollback: () => void;
}) {
  const dropped = p.status === 'dropped';
  const appliedCount = changes.filter(c => applied[c.id]).length;
  const kinds = [...new Set(changes.map(kindOf))];
  return (
    <div className={`rl-project${changes.length ? ' rl-clickable' : ''}${dropped ? ' rl-project--dropped' : ''}`} title={changes.length ? `Open the ${changes.length} change${changes.length === 1 ? '' : 's'} of ${p.id}` : undefined} onClick={changes.length ? onOpen : undefined}>
      <span className="rl-type" style={{ ['--rl-c' as string]: typeColor(p.type) }}>{TYPE_LABEL[p.type ?? ''] ?? p.type ?? 'new'}</span>
      <div className="rl-project-main">
        <div className="rl-project-name"><span className="rl-mono">{p.id}</span>{p.name && <span>{p.name}</span>}</div>
        <div className="rl-project-meta">
          {changes.length} change{changes.length === 1 ? '' : 's'}{kinds.length ? ` · ${kinds.join(', ')}` : ''} · {loading ? <SkeletonView variant="text" width={56} height={10} style={{ display: 'inline-block', verticalAlign: 'middle' }} /> : <>{appliedCount} applied</>}
          {dropped && <span className="rl-dropped-note"><BlockedIcon size={11} /> dropped{p.dropped_reason ? `: ${p.dropped_reason}` : ''}</span>}
        </div>
      </div>
      <div className="rl-project-actions" onClick={e => e.stopPropagation()}>
        <ButtonView variant="ghost" iconLeft={<PencilIcon size={12} />} label="Edit / move" onClick={onEdit} />
        {dropped
          ? <ButtonView variant="ghost" iconLeft={<CheckCircleIcon size={12} />} label="Restore" onClick={onRestore} />
          : <ButtonView variant="ghost" iconLeft={<BlockedIcon size={12} />} label="Not going" onClick={onDrop} />}
        <ButtonView variant="ghost" iconLeft={<UndoIcon size={12} />} label="Roll back" disabled={appliedCount === 0} onClick={onRollback} />
      </div>
    </div>
  );
}

type CiSetup = { root?: string; changesRel?: string; workflow?: string; files?: { path: string; exists: boolean }[]; written?: string[]; error?: string };

/** Releases > Set up CI: what goes into the repository (.github/workflows/dmcr.yml + .github/dmcr/), then writes it. */
function CiSetupModal({ onClose }: { onClose: () => void }) {
  const [ci, setCi] = useState<CiSetup | null>(null);
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    const h = (e: MessageEvent) => { if (e.data?.type === 'ciSetup') { setCi(e.data.payload as CiSetup); setWriting(false); } };
    window.addEventListener('message', h);
    postMsg({ type: 'setupCi', payload: { write: false } });
    return () => window.removeEventListener('message', h);
  }, []);
  const done = !!ci?.written?.length;
  return (
    <ModalView open size="xxl" height="92vh" maxHeight="92vh" className="rl-ci-modal" onClose={onClose} headerIcon={<GithubMarkIcon size={16} />}
      title="Set up CI: a DMCR check on every pull request"
      subtitle={ci?.root ? `Into ${ci.root} (changes in ${ci.changesRel}/). Nothing is committed or pushed.` : 'GitHub Actions'}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'hidden' }}
      footerRight={done ? <ButtonView variant="primary" label="Done" onClick={onClose} /> : <>
        <ButtonView variant="ghost" label="Cancel" onClick={onClose} />
        <ButtonView variant="primary" accentColor="var(--dm-c-6366f1)" iconLeft={<PullRequestIcon size={13} />} label={ci?.files?.some(f => f.exists) ? 'Update the files' : 'Write the files'} loading={writing} disabled={!ci?.workflow || writing}
          onClick={() => { setWriting(true); postMsg({ type: 'setupCi', payload: { write: true } }); }} />
      </>}>
      {!ci ? <LoaderView variant="dots" label="Reading the repository" center />
        : ci.error ? <div className="rl-blocked"><WarningTriangleIcon size={15} /><WarnText text={ci.error} /></div>
        : (
          <>
            <ol className="rl-ms-steps">
              <li>On every pull request that touches <code>{ci.changesRel}/</code>: lock lint, meta.json and <code>requires</code> checks, and edits to changes already on the base branch.</li>
              <li>A PostgreSQL 16 service: the whole history from an empty database (danger_ changes through their manual script, as the DBA runs them), and a round trip of each changed change: deploy, verify, revert, deploy again.</li>
              <li>One comment on the pull request, updated on every push; the job fails when a change does not apply or its revert leaves something behind.</li>
            </ol>
            <div className="rl-ci-files">
              {ci.files?.map(f => (
                <span key={f.path} className="rl-ci-file">
                  <code>{f.path}</code>
                  {done ? <span className="rl-ap rl-ap--ok"><CheckCircleIcon size={10} />written</span>
                    : <span className={`rl-ap ${f.exists ? 'rl-ap--need' : 'rl-ap--ok'}`}>{f.exists ? 'replace' : 'new'}</span>}
                </span>
              ))}
            </div>
            {done && <div className="rl-notice rl-notice--ok"><CheckCircleIcon size={13} /><span>Written. Commit and push <code>.github/</code> to turn it on: <code>git add .github &amp;&amp; git commit -m "ci: DMCR pull-request check"</code></span></div>}
            <div className="rl-ms-editor"><EditorView value={ci.workflow ?? ''} language="yaml" readOnly height="100%" fontSize={13} editorOptions={{ minimap: false, scrollBeyondLastLine: false }} /></div>
          </>
        )}
    </ModalView>
  );
}

type ApprovalRow = { change_id: string; state: 'approved' | 'stale' | 'missing'; by?: string; at?: string; note?: string };
type Approvals = { required: boolean; approvers: string[]; byId: Record<string, ApprovalRow> };

/** A pending change's sign-off on this environment: approved (by whom), stale (edited since) or needed. */
function ApprovalChip({ a }: { a: ApprovalRow }) {
  if (a.state === 'approved') return <span className="rl-ap rl-ap--ok" title={`Approved by ${a.by} on ${a.at}${a.note ? `: ${a.note}` : ''}`}><UserCheckIcon size={10} />{a.by}</span>;
  if (a.state === 'stale') return <span className="rl-ap rl-ap--stale" title={`Approved by ${a.by} on ${a.at}, but its files changed since: approve it again`}><WarningTriangleIcon size={10} />re-approve</span>;
  return <span className="rl-ap rl-ap--need" title="Needs a sign-off before it deploys here"><UserCheckIcon size={10} />needs approval</span>;
}

/** Sign off a release's pending changes for one environment (dmcr approve --release), as the DBA in Settings. */
function ApproveModal({ env, release, ids, by, approvals, capture, onClose, onDone }: {
  env: string; release?: string; ids: string[]; by: string; approvals: Approvals | null;
  capture: (args: string[]) => Promise<CaptureResult>; onClose: () => void; onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'' | 'approve' | 'revoke'>('');
  const [result, setResult] = useState<{ ok: boolean; changes: string[]; skipped: { change_id: string; reason: string }[]; error?: string } | null>(null);
  const allowed = !approvals?.approvers.length || approvals.approvers.some(a => a.toLowerCase() === by.toLowerCase());
  const run = async (revoke: boolean) => {
    setBusy(revoke ? 'revoke' : 'approve');
    const scope = release ? ['--release', release] : [ids[0]];
    const r = await capture(['approve', ...scope, '--env', env, '--by', by, ...(note.trim() && !revoke ? ['--note', note.trim()] : []), ...(revoke ? ['--revoke'] : [])]);
    const d = r.data as { changes?: string[]; skipped?: { change_id: string; reason: string }[] } | null;
    setBusy('');
    setResult({ ok: r.exitCode === 0, changes: d?.changes ?? [], skipped: d?.skipped ?? [], error: r.exitCode === 0 ? undefined : errorText(r) });
  };
  const approvedAny = ids.some(id => approvals?.byId[id]?.state === 'approved');
  return (
    <ModalView open size="lg" onClose={onClose} headerIcon={<UserCheckIcon size={16} />} headerColor="var(--dm-c-f59e0b)"
      title={`Approve ${release ? `release ${release}` : ids[0]} for ${env}`}
      subtitle={`Signed as ${by}. Each change is approved with its current files: an edit afterwards needs a new sign-off.`}
      footerRight={result ? <ButtonView variant="primary" label="Done" onClick={onDone} /> : <>
        <ButtonView variant="ghost" label="Cancel" onClick={onClose} />
        {approvedAny && <ButtonView variant="secondary" color="var(--dm-c-f87171)" label="Revoke" loading={busy === 'revoke'} disabled={!!busy || !allowed} onClick={() => void run(true)} />}
        <ButtonView variant="primary" accentColor="var(--dm-c-22c55e)" iconLeft={<UserCheckIcon size={13} />} label={`Approve ${ids.length} change${ids.length === 1 ? '' : 's'}`} loading={busy === 'approve'} disabled={!!busy || !allowed} onClick={() => void run(false)} />
      </>}>
      {!allowed && <div className="rl-blocked"><WarningTriangleIcon size={15} /><span>{by} is not an approver for {env} (approvers: {approvals?.approvers.join(', ')}). Settings &gt; DMCR Config &gt; Release pipeline.</span></div>}
      {!result ? (
        <>
          <div className="rl-ap-list">
            {ids.map(id => {
              const a = approvals?.byId[id] ?? { change_id: id, state: 'missing' as const };
              return <div key={id} className="rl-ap-row"><ChangeIdLabel id={id} /><ApprovalChip a={a} /></div>;
            })}
          </div>
          <label className="rl-label">Note (optional)</label>
          <TextInputView value={note} placeholder="e.g. CAB 2026-10-12, reviewed the lock risks" onChange={e => setNote(e.target.value)} />
          <p className="rl-hint">Whoever created or requested a change cannot approve it; the runner skips those and says why.</p>
        </>
      ) : (
        <div className="rl-ap-list">
          {result.changes.map(id => <div key={id} className="rl-ap-row"><ChangeIdLabel id={id} /><span className="rl-ap rl-ap--ok"><CheckCircleIcon size={10} />done</span></div>)}
          {result.skipped.map(k => <div key={k.change_id} className="rl-ap-row"><ChangeIdLabel id={k.change_id} /><span className="rl-ap-why">{k.reason}</span></div>)}
          {!result.ok && !result.skipped.length && <div className="rl-blocked"><WarningTriangleIcon size={15} /><WarnText text={result.error ?? ''} /></div>}
        </div>
      )}
    </ModalView>
  );
}

/* ── One change in the table: chips; the pencil edits its meta.json ───── */
function ChangeTableRow({ change: c, projects, env, isApplied, approval, loading, onOpen, onPatch, onEdit, onDrop, onTest }: {
  change: ChangeRow; projects: Project[]; env: string; isApplied?: boolean; approval?: ApprovalRow; loading?: boolean; onOpen: () => void;
  onPatch: (patch: Record<string, string>) => void; onEdit: () => void; onDrop: () => void; onTest?: () => void;
}) {
  const dropped = c.status === 'dropped';
  const status = isApplied ? 'applied' : dropped ? 'dropped' : c.danger ? 'manual' : isApplied === undefined ? '' : 'pending';
  const statusColor: Record<string, string> = { applied: 'var(--dm-c-22c55e)', dropped: 'var(--dm-c-64748b)', manual: 'var(--dm-c-ef4444)', pending: 'var(--dm-c-f59e0b)' };
  const project = projects.find(p => p.id === c.project);
  return (
    <div className={`rl-tr rl-clickable${dropped ? ' rl-tr--dropped' : ''}`} title={`Open ${c.id}`} onClick={onOpen}>
      <div className="rl-ellipsis" title={c.metaError ? `meta.json: ${c.metaError}` : c.id}><ChangeIdLabel id={c.id} projectType={project?.type} />{c.metaError && <WarningTriangleIcon size={11} />}</div>
      <div title={c.project && !project ? `${c.project} is not in releases.json` : project?.name}><ProjectChip id={c.project || undefined} /></div>
      <div title={c.kind ? 'Set in meta.json' : 'Worked out from the SQL'}><span className="cv-chips"><KindChip kind={kindOf(c)} /><LockLintChip findings={c.lint} /></span></div>
      <div className="rl-ellipsis"><PersonChip name={c.requested_by || undefined} /></div>
      <div className="rl-ellipsis" title={c.created_at ? `on ${c.created_at}` : undefined}><PersonChip name={c.created_by || undefined} dba /></div>
      <div><span className="cv-chips">{status && <ChipView size="xs" label={status} color={statusColor[status]} />}{approval && <ApprovalChip a={approval} />}</span></div>
      <div className="rl-row-actions" onClick={e => e.stopPropagation()}>
        {onTest && isApplied === false && !dropped && !c.danger && (
          <IconButtonView size="sm" variant="ghost" icon={<TestTubeIcon size={13} />} title={`Round-trip test ${c.id} on ${env} (rolled back)`} aria-label="Round-trip test" onClick={onTest} />
        )}
        <IconButtonView size="sm" variant="ghost" icon={<PencilIcon size={13} />} disabled={loading}
          title={loading ? `Reading the status on ${env}` : isApplied ? `Edit ticket (applied on ${env}: project, kind and requester are locked)` : 'Edit project, kind, requester and ticket'}
          aria-label="Edit change" onClick={onEdit} />
        {dropped
          ? <IconButtonView size="sm" variant="ghost" icon={<CheckCircleIcon size={13} />} title={`Restore${c.dropped_reason ? ` (dropped: ${c.dropped_reason})` : ''}`} aria-label="Restore change" onClick={() => onPatch({ status: '', dropped_reason: '' })} />
          : <IconButtonView size="sm" variant="ghost" icon={<BlockedIcon size={13} />} disabled={isApplied || loading} title={loading ? `Reading the status on ${env}` : isApplied ? 'Applied here: roll it back first' : 'Drop: not going, deploy skips it everywhere'} aria-label="Drop change" onClick={onDrop} />}
      </div>
    </div>
  );
}

/** Edits one change's project, kind and requester in its meta.json. */
function ChangeEditModal({ change: c, projects, kinds, env, locked, onClose, onSave }: {
  change: ChangeRow; projects: Project[]; kinds: string[]; env: string; locked: boolean;
  onClose: () => void; onSave: (patch: Record<string, string>) => void;
}) {
  const [project, setProject] = useState(c.project);
  const [kind, setKind] = useState(c.kind);
  const [requestedBy, setRequestedBy] = useState(c.requested_by);
  const [ticket, setTicket] = useState(c.ticket ?? '');
  const patch: Record<string, string> = {};
  if (project !== c.project) patch.project = project;
  if (kind !== c.kind) patch.kind = kind;
  if (requestedBy.trim() !== c.requested_by) patch.requested_by = requestedBy.trim();
  if (ticket.trim() !== (c.ticket ?? '')) patch.ticket = ticket.trim();
  const changed = Object.keys(patch).length > 0;
  return (
    <ModalView open size="md" bodyStyle={{ overflow: 'visible' }} onClose={onClose} title={c.id} headerIcon={<PencilIcon size={15} />}
      subtitle={locked ? `Applied on ${env}: only the ticket can change. Roll it back to move it to another project.` : "Saved to this change's meta.json."}
      footerRight={<>
        <ButtonView variant="ghost" label="Cancel" onClick={onClose} />
        <ButtonView variant="primary" label="Save" disabled={!changed} onClick={() => onSave(patch)} />
      </>}>
      <div className="rl-form">
        <label className="rl-label">Project</label>
        <SelectInputView size="md" value={project} onChange={setProject} disabled={locked}
          options={[{ value: '', label: '(none)' }, ...projects.map(p => ({ value: p.id, label: p.name ? `${p.id} · ${p.name}` : p.id, badge: { label: (p.type ?? 'new').toUpperCase(), color: typeColor(p.type) } })),
            ...(c.project && !projects.some(p => p.id === c.project) ? [{ value: c.project, label: `${c.project} (not in releases.json)` }] : [])]} />
        <label className="rl-label">Kind</label>
        <SelectInputView size="md" value={kind} onChange={setKind} disabled={locked}
          options={[{ value: '', label: `auto: ${c.inferredKind}` }, ...kinds.map(k => ({ value: k, label: k }))]} />
        <label className="rl-label">Requested by</label>
        <TextInputView value={requestedBy} disabled={locked} placeholder="Developer" iconLeft={<UserSingleIcon size={11} />} onChange={e => setRequestedBy(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && changed) onSave(patch); }} />
        <label className="rl-label">Ticket</label>
        <TextInputView value={ticket} placeholder="Ticket id" onChange={e => setTicket(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && changed) onSave(patch); }} />
      </div>
    </ModalView>
  );
}

function PlanTable({ changes, projects }: { changes: PlanChange[]; projects: Project[] }) {
  if (!changes.length) return null;
  return (
    <div className="rl-table rl-table--plan">
      <div className="rl-tr rl-th"><div>#</div><div>Change</div><div>Project</div><div>Release</div><div>Kind</div></div>
      {changes.map((c, i) => (
        <div key={c.change_id} className="rl-tr">
          <div className="rl-plan-num">{i + 1}</div>
          <div className="rl-ellipsis"><ChangeIdLabel id={c.change_id} projectType={projects.find(p => p.id === c.project)?.type} /></div>
          <div><ProjectChip id={c.project || undefined} /></div>
          <div><ReleaseChip id={c.release || undefined} /></div>
          <div><KindChip kind={c.kind || undefined} /></div>
        </div>
      ))}
    </div>
  );
}

/* ── Release edit ───────────────────────────────────────────────────────── */
function ReleaseModal({ state, existing, onClose, onSave, onDelete }: {
  state: { value: Release; isNew: boolean }; existing: string[];
  onClose: () => void; onSave: (r: Release, oldId?: string) => void; onDelete?: () => void;
}) {
  const [r, setR] = useState<Release>(state.value);
  const id = r.id.trim();
  const problem = !id ? 'Give the release an id (picking a date fills it)'
    : !/^[A-Za-z0-9._-]+$/.test(id) ? 'Use letters, digits, dots, dashes and underscores'
    : state.isNew && existing.includes(id) ? `Release ${id} already exists`
    : r.date && !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ? 'Date: YYYY-MM-DD' : '';
  return (
    <ModalView open size="md" bodyStyle={{ overflow: 'visible' }} onClose={onClose} title={state.isNew ? 'New release' : `Release ${state.value.id}`} headerIcon={<CalendarIcon size={16} />}
      footerLeft={onDelete ? <ButtonView variant="ghost" label="Delete release" onClick={onDelete} /> : undefined}
      footerRight={<>
        <ButtonView variant="ghost" label="Cancel" onClick={onClose} />
        <ButtonView variant="primary" label="Save" disabled={!!problem} title={problem || undefined} onClick={() => onSave({ ...r, id }, state.value.id)} />
      </>}>
      <div className="rl-form">
        <label className="rl-label">Release id</label>
        <TextInputView value={r.id} disabled={!state.isNew} placeholder="Release id" onChange={e => setR({ ...r, id: e.target.value })} />
        <label className="rl-label">Name</label>
        <TextInputView value={r.name ?? ''} placeholder="Release name" onChange={e => setR({ ...r, name: e.target.value })} />
        <label className="rl-label">Release date</label>
        <DateInputView value={r.date || null} placeholder="Pick the release date" onChange={d => setR({ ...r, date: d, id: state.isNew && (!r.id || r.id === r.date) ? d : r.id })} />
        <label className="rl-label">Status</label>
        <SelectInputView size="md" value={r.status ?? 'planned'} onChange={v => setR({ ...r, status: v })} options={RELEASE_STATUSES.map(s => ({ value: s, label: s }))} />
        {problem && <div className="rl-hint rl-warn">{problem}</div>}
        {!state.isNew && <div className="rl-hint">The id is fixed: projects and the registry (release_id) refer to it.</div>}
      </div>
    </ModalView>
  );
}

/* ── Project edit / move / drop ─────────────────────────────────────────── */
function ProjectModal({ state, releases, types, existing, changeCount, onClose, onSave }: {
  state: { value: Project; isNew: boolean }; releases: Release[]; types: string[]; existing: string[]; changeCount: number;
  onClose: () => void; onSave: (p: Project, oldId?: string) => void;
}) {
  const [p, setP] = useState<Project>(state.value);
  const id = p.id.trim();
  const dropped = p.status === 'dropped';
  const problem = !id ? 'Give the project an id'
    : !/^[A-Za-z0-9._-]+$/.test(id) ? 'Use letters, digits, dots, dashes and underscores'
    : state.isNew && existing.includes(id) ? `Project ${id} already exists` : '';
  return (
    <ModalView open size="md" bodyStyle={{ overflow: 'visible' }} onClose={onClose} title={state.isNew ? 'New project' : `Project ${state.value.id}`} headerIcon={<PackageDependencyIcon size={16} />}
      subtitle={state.isNew ? undefined : `${changeCount} change${changeCount === 1 ? '' : 's'} follow this project to whichever release it is in.`}
      footerRight={<>
        <ButtonView variant="ghost" label="Cancel" onClick={onClose} />
        <ButtonView variant={dropped ? 'danger' : 'primary'} label={dropped && state.value.status !== 'dropped' ? 'Mark not going' : 'Save'} disabled={!!problem} title={problem || undefined}
          onClick={() => onSave({ ...p, id, dropped_reason: dropped ? p.dropped_reason : undefined }, state.value.id)} />
      </>}>
      <div className="rl-form">
        <label className="rl-label">Project id</label>
        <TextInputView value={p.id} disabled={!state.isNew} placeholder="Project id" onChange={e => setP({ ...p, id: e.target.value })} />
        <label className="rl-label">Name</label>
        <TextInputView value={p.name ?? ''} placeholder="Project name" onChange={e => setP({ ...p, name: e.target.value })} />
        <label className="rl-label">Type</label>
        <SelectInputView size="md" value={p.type ?? 'new'} onChange={v => setP({ ...p, type: v })}
          options={types.map(t => ({ value: t, label: TYPE_LABEL[t] ?? t, badge: { label: t.toUpperCase(), color: typeColor(t) } }))} />
        <label className="rl-label">Release</label>
        <SelectInputView size="md" value={p.release ?? ''} onChange={v => setP({ ...p, release: v })}
          options={[{ value: '', label: '(unscheduled)' }, ...releases.map(r => ({ value: r.id, label: `${r.id}${r.name ? ' · ' + r.name : ''}` }))]} />
        <label className="rl-label">Status</label>
        <SelectInputView size="md" value={dropped ? 'dropped' : 'active'} onChange={v => setP({ ...p, status: v })}
          options={[{ value: 'active', label: 'active: goes out with its release' }, { value: 'dropped', label: 'not going: deploy skips its changes' }]} />
        {dropped && (
          <>
            <label className="rl-label">Reason</label>
            <TextInputView value={p.dropped_reason ?? ''} placeholder="Why it is not going" onChange={e => setP({ ...p, dropped_reason: e.target.value })} />
          </>
        )}
        {problem && <div className="rl-hint rl-warn">{problem}</div>}
      </div>
    </ModalView>
  );
}

/* ── Rollback: release or projects, optionally only some kinds ──────────── */
type RollbackState = {
  scope: 'release' | 'project'; release: string; projects: string[]; kinds: string[];
  loading?: boolean; changes?: PlanChange[]; warnings?: string[]; problems?: string[]; error?: string; previewedKey?: string;
};
const newRollback = (c: Catalog): RollbackState => ({ scope: 'project', release: c.releases[0]?.id ?? '', projects: [], kinds: [] });
const rollbackArgs = (s: RollbackState, env: string) => [
  'revert',
  ...(s.scope === 'release' ? ['--release', s.release] : ['--project', s.projects.join(',')]),
  ...(s.kinds.length ? ['--kind', s.kinds.join(',')] : []),
  '--env', env,
];

/** Pills in the rollback dialog: the same height as its md buttons */
const PILL = { fontSize: 13, padding: '7px 14px', height: 34, gap: 8 } as const;

const KIND_GROUPS: { title: string; hint: string; color: string; kinds: { id: string; label: string }[] }[] = [
  { title: 'Data', hint: 'rows added, changed or removed', color: 'var(--dm-c-f59e0b)', kinds: [{ id: 'insert', label: 'Inserts' }, { id: 'update', label: 'Updates' }, { id: 'delete', label: 'Deletes' }] },
  { title: 'Structure', hint: 'tables, functions, types', color: 'var(--dm-c-818cf8)', kinds: [{ id: 'ddl', label: 'DDL' }, { id: 'function', label: 'Functions' }, { id: 'type', label: 'Types' }] },
];

function RollbackModal({ state: s, setState, catalog, appliedByProject, env, capture, onRun }: {
  state: RollbackState; setState: (s: RollbackState | null) => void; catalog: Catalog; appliedByProject: Record<string, number>; env: string;
  capture: (args: string[]) => Promise<CaptureResult>; onRun: (args: string[]) => void;
}) {
  const args = rollbackArgs(s, env);
  const key = args.join(' ');
  const ready = s.scope === 'release' ? !!s.release : s.projects.length > 0;
  const previewed = s.previewedKey === key && !s.loading && !s.error;
  const blocked = previewed && !!s.problems?.length;
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
  const set = (patch: Partial<RollbackState>) => setState({ ...s, ...patch });

  const runPreview = async () => {
    set({ loading: true, error: undefined });
    const r = await capture([...args, '--dry-run']);
    const d = r.data as { status?: string; changes?: PlanChange[]; warnings?: string[]; problems?: string[] };
    if (d.status === 'dry_run' || d.status === 'blocked' || d.status === 'nothing_to_revert') {
      setState({ ...s, loading: false, changes: d.changes ?? [], warnings: d.warnings ?? [], problems: d.problems ?? [], previewedKey: key, error: undefined });
    } else {
      setState({ ...s, loading: false, error: errorText(r), previewedKey: key });
    }
  };

  return (
    <ModalView open size="lg" onClose={() => setState(null)} title={`Roll back on ${env}`} headerIcon={<UndoIcon size={18} />} headerColor="var(--dm-c-ef4444)"
      subtitle="Reverts the applied changes you pick, newest first, wherever they sit in the history. Preview first: DMCR refuses when a later change outside your pick depends on them."
      maxHeight="94vh" bodyStyle={{ overflowX: 'hidden', overflowY: 'auto' }}
      footerRight={<>
        <ButtonView variant="ghost" label="Cancel" onClick={() => setState(null)} />
        <ButtonView variant="secondary" iconLeft={<EyeIcon size={15} />} label="Preview" disabled={!ready || !!s.loading} loading={s.loading} onClick={() => void runPreview()} />
        <ButtonView variant="danger" iconLeft={<UndoIcon size={15} />} label={blocked ? 'Blocked' : 'Roll back in Runner'}
          className={!previewed || blocked || !s.changes?.length ? 'rl-btn-off' : undefined}
          disabled={!previewed || blocked || !s.changes?.length}
          title={!previewed ? 'Preview this pick first' : blocked ? 'Blocked: see the problems below' : undefined}
          onClick={() => onRun(args)} />
      </>}>
      <div className="rb">
        <section className="rb-sec">
          <div className="rb-sec-title"><span className="rb-num">1</span>What to roll back</div>
          <RadioCardView
            size="md"
            columns={2}
            accentColor="var(--dm-c-ef4444)"
            value={s.scope}
            onChange={v => set({ scope: v as RollbackState['scope'] })}
            options={[
              { value: 'project', label: 'Projects', description: 'One or more projects, in whichever release they went out', icon: <PackageDependencyIcon size={18} /> },
              { value: 'release', label: 'A whole release', description: 'Everything that went out in one release', icon: <CalendarIcon size={18} /> },
            ]}
          />
        </section>

        <section className="rb-sec">
          <div className="rb-sec-title"><span className="rb-num">2</span>{s.scope === 'release' ? 'Release' : 'Projects'}</div>
          {s.scope === 'release' ? (
            <SelectInputView size="md" value={s.release} onChange={v => set({ release: v })}
              options={catalog.releases.map(r => ({ value: r.id, label: `${r.id}${r.name ? '  ·  ' + r.name : ''}` }))} />
          ) : catalog.projects.length === 0 ? (
            <div className="rb-empty">No projects yet.</div>
          ) : (
            <div className="rb-pills">
              {catalog.projects.map(p => (
                <TogglePillView key={p.id} active={s.projects.includes(p.id)} accentColor={typeColor(p.type)}
                  count={appliedByProject[p.id] ?? 0}
                  title={`${appliedByProject[p.id] ?? 0} change(s) applied on ${env}`}
                  icon={<span className="rb-dot" style={{ background: typeColor(p.type) }} />}
                  style={PILL} onClick={() => set({ projects: toggle(s.projects, p.id) })}>
                  {p.id}{p.type ? <span className="rb-pill-type">{TYPE_LABEL[p.type] ?? p.type}</span> : null}
                </TogglePillView>
              ))}
            </div>
          )}
        </section>

        <section className="rb-sec">
          <div className="rb-sec-title"><span className="rb-num">3</span>Only some kinds of change <span className="rb-optional">optional: nothing picked means everything</span></div>
          <div className="rb-kinds">
            {KIND_GROUPS.map(g => (
              <div key={g.title} className="rb-kind-group">
                <div className="rb-kind-head"><b style={{ color: g.color }}>{g.title}</b><span>{g.hint}</span></div>
                <div className="rb-pills">
                  {g.kinds.map(k => (
                    <TogglePillView key={k.id} active={s.kinds.includes(k.id)} accentColor={g.color} style={PILL} onClick={() => set({ kinds: toggle(s.kinds, k.id) })}>
                      {k.label}
                    </TogglePillView>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className={`rb-cmd${ready ? '' : ' rb-cmd--empty'}`}>
          <span className="rb-cmd-label">Runs in the Runner tab</span>
          <code>{ready ? `dmcr ${key}` : 'Pick at least one project'}</code>
        </div>

        {s.previewedKey === key && !s.loading && (
          s.error ? <div className="rl-problem"><ShieldAlertIcon size={15} /><pre>{s.error}</pre></div> : (
            <div className="rb-preview">
              <div className="rl-plan-title">{s.changes?.length ? `${s.changes.length} change(s) will be reverted, newest first` : 'Nothing applied in this pick.'}</div>
              <PlanTable changes={s.changes ?? []} projects={catalog.projects} />
              {!!s.problems?.length && (
                <div className="rl-blocked">
                  <div className="rl-blocked-head"><ShieldAlertIcon size={16} /><b>Blocked</b><span>{s.problems.length} later change{s.problems.length === 1 ? '' : 's'} outside this pick depend{s.problems.length === 1 ? 's' : ''} on it: DMCR will not revert it</span></div>
                  {s.problems.map((p, i) => <div key={`p${i}`} className="rl-blocked-row"><span className="rl-blocked-dot" /><span><WarnText text={p} /></span></div>)}
                </div>
              )}
              {s.warnings?.map((w, i) => <div key={`w${i}`} className="rl-warning"><WarningTriangleIcon size={14} /><span><WarnText text={w} /></span></div>)}
            </div>
          )
        )}
      </div>
    </ModalView>
  );
}
