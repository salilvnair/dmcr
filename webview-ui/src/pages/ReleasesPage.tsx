import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ButtonView, ChipView, ModalView, SelectInputView, TextInputView, DateInputView, LoaderView, ProgressBarView,
  ReleaseIcon, CalendarIcon, RocketLaunchIcon, UndoIcon, RefreshIcon, PlusIcon, EyeIcon, LayersIcon,
  BlockedIcon, UserSingleIcon, UserCheckIcon, WarningTriangleIcon, ShieldAlertIcon, CheckCircleIcon,
  PackageDependencyIcon, ArchiveIcon,
} from '@salilvnair/dui';
import { postMsg } from '../vscode';
import { PROJECT_TYPE_COLORS } from '../components/ChangeCard';
import './ReleasesPage.css';

/* ── Data from the extension (release-handlers.ts) ───────────────────────── */
type Release = { id: string; name?: string; date?: string; status?: string; notes?: string };
type Project = { id: string; name?: string; type?: string; release?: string; status?: string; dropped_reason?: string };
type Catalog = { releases: Release[]; projects: Project[] };
type ChangeRow = {
  id: string; project: string; kind: string; inferredKind: string; requested_by: string; created_by: string; created_at: string;
  ticket: string; status: 'active' | 'dropped'; dropped_reason: string; danger: boolean; metaError?: string;
};
type ReleaseData = {
  changesDir?: string; catalog: Catalog | null; catalogError?: string; changes: ChangeRow[]; envs: string[]; active: string;
  dbaName: string; projectTypes: string[]; changeKinds: string[]; error?: string; saveError?: string; saved?: string; requestId?: string;
};
/* From the runner: release list --json, status --json, deploy/revert --dry-run --json */
type ReleaseSummary = { release: string; total: number; applied: number; pending: number; dropped: number; last_applied?: string };
type CaptureResult = { captureId: string; exitCode: number | null; data: Record<string, unknown> | unknown[] };
type PlanChange = { change_id: string; project?: string; release?: string; kind?: string };

const RELEASE_STATUSES = ['planned', 'deployed', 'cancelled'];
const TYPE_LABEL: Record<string, string> = { new: 'New', bugfix: 'Bug fix', cr: 'CR', hotfix: 'Hotfix', other: 'Other' };

const kindOf = (c: ChangeRow) => c.kind || c.inferredKind;
const typeColor = (t?: string) => PROJECT_TYPE_COLORS[t ?? ''] ?? '#64748b';
const envColor = (env: string) => (/prod/i.test(env) ? '#ef4444' : /test|st|stag|uat/i.test(env) ? '#f59e0b' : '#3b82f6');

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
  const [initing, setIniting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [editRelease, setEditRelease] = useState<{ value: Release; isNew: boolean } | null>(null);
  const [editProject, setEditProject] = useState<{ value: Project; isNew: boolean } | null>(null);
  const [dropChange, setDropChange] = useState<{ id: string; reason: string } | null>(null);
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
      if (p.saveError) setNotice({ kind: 'error', text: p.saveError });
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
    const [rl, st] = await Promise.all([
      data?.catalog ? capture(['release', 'list', '--env', env]) : Promise.resolve(null),
      capture(['status', '--env', env]),
    ]);
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

  return (
    <div className="rl-page">
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
            <SelectInputView
              size="sm"
              value={env}
              onChange={setEnv}
              options={data.envs.length ? data.envs.map(e => ({ value: e, label: e, badge: { label: e.toUpperCase(), color: envColor(e) } })) : [{ value: '', label: 'no environments in dmcr.cfg' }]}
              width={170}
            />
          </div>
          <ButtonView size="sm" variant="ghost" iconLeft={<RefreshIcon size={13} />} label="Refresh" loading={loadingStatus} onClick={() => { postMsg({ type: 'getReleaseData' }); void refreshStatus(); }} />
        </div>
      </div>

      <div className="rl-intro">
        <div className="rl-intro-icon"><ReleaseIcon size={18} /></div>
        <div className="rl-intro-main">
          <div className="rl-intro-title">Plan, ship and roll back by project</div>
          <div className="rl-intro-text">Schedule <b>projects</b> into <b>releases</b>, deploy one release at a time, mark work as <b>not going</b>, and roll back a project or only its inserts, updates or DDL.</div>
        </div>
        <ChipView size="md" icon={<UserCheckIcon size={13} />} label={data.dbaName ? `DBA: ${data.dbaName}` : 'Set your DBA name'} color={data.dbaName ? '#22c55e' : '#f59e0b'} onClick={onOpenSettings} />
      </div>

      <div className="rl-stats">
        {([
          { label: 'Releases', value: catalog.releases.length, color: '#818cf8', icon: <CalendarIcon size={15} />, sub: catalog.releases.filter(r => r.status !== 'deployed' && r.status !== 'cancelled').length + ' planned' },
          { label: 'Projects', value: catalog.projects.length, color: '#34d399', icon: <PackageDependencyIcon size={15} />, sub: catalog.projects.filter(p => p.status === 'dropped').length + ' not going' },
          { label: 'Changes', value: data.changes.length, color: '#60a5fa', icon: <LayersIcon size={15} />, sub: `${data.changes.filter(c => applied[c.id]).length} applied on ${env || '-'}` },
          { label: 'No project', value: unassigned.length, color: unassigned.length ? '#fbbf24' : '#64748b', icon: <WarningTriangleIcon size={15} />, sub: 'skipped by release deploys' },
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

      <div className="rl-toolbar">
        <ButtonView size="sm" variant="primary" accentColor="#6366f1" iconLeft={<PlusIcon size={13} />} label="New release" onClick={() => setEditRelease({ value: { id: '', date: '', status: 'planned' }, isNew: true })} />
        <ButtonView size="sm" variant="secondary" iconLeft={<PlusIcon size={13} />} label="New project" disabled={!catalog.releases.length} title={catalog.releases.length ? undefined : 'Add a release first'} onClick={() => setEditProject({ value: { id: '', type: 'new', release: catalog.releases[0]?.id ?? '', status: 'active' }, isNew: true })} />
        <span className="rl-toolbar-gap" />
        <ButtonView size="sm" variant="secondary" color="#f87171" iconLeft={<UndoIcon size={13} />} label="Roll back" disabled={!env || !catalog.projects.length} onClick={() => setRollback(newRollback(catalog))} />
      </div>

      {notice && <div className={`rl-notice rl-notice--${notice.kind}`}>{notice.kind === 'ok' ? <CheckCircleIcon size={13} /> : <WarningTriangleIcon size={13} />}<span>{notice.text}</span></div>}
      {data.catalogError && <div className="rl-notice rl-notice--error"><WarningTriangleIcon size={13} /><span>releases.json could not be read: {data.catalogError}</span></div>}
      {statusError && (/registry not found/i.test(statusError) ? (
        <div className="rl-notice rl-notice--info">
          <ShieldAlertIcon size={14} />
          <span><b>DMCR is not set up on {env} yet.</b> Its registry (the dmcr schema that records what is applied) is created once per database.</span>
          <ButtonView size="xs" variant="primary" accentColor="#6366f1" label={initing ? 'Setting up' : `Set up DMCR on ${env}`} loading={initing}
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
              { n: 1, badge: 'Release', color: '#818cf8', icon: <CalendarIcon size={18} />, title: 'Add a release', desc: 'A date you ship on. Prod deploys one release at a time.', action: () => setEditRelease({ value: { id: '', date: '', status: 'planned' }, isNew: true }) },
              { n: 2, badge: 'Project', color: '#34d399', icon: <PackageDependencyIcon size={18} />, title: 'Add its projects', desc: 'New work, a bug fix or a CR. Move a project to another release, or mark it not going.', action: null },
              { n: 3, badge: 'Changes', color: '#60a5fa', icon: <LayersIcon size={18} />, title: 'Assign changes', desc: 'Pick the project on the change card when you save, or in the table below.', action: null },
            ]).map(st => (
              <div key={st.n} className="rl-step" style={{ ['--rl-c' as string]: st.color }}>
                <span className="rl-step-num">{st.n}</span>
                <span className="rl-step-icon">{st.icon}</span>
                <span className="rl-step-badge">{st.badge}</span>
                <span className="rl-step-title">{st.title}</span>
                <span className="rl-step-desc">{st.desc}</span>
                {st.action && <ButtonView size="sm" variant="primary" accentColor="#6366f1" iconLeft={<PlusIcon size={13} />} label="Add a release" onClick={st.action} />}
              </div>
            ))}
          </div>
        ) : catalog.releases.map(r => {
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
                  {s ? (
                    <>
                      <div className="rl-progress-label">
                        <span><b className="rl-ok">{s.applied}</b>/{s.total - s.dropped} on {env}</span>
                        {s.pending > 0 && <span className="rl-warn">{s.pending} pending</span>}
                        {s.dropped > 0 && <span className="rl-dim">{s.dropped} not going</span>}
                      </div>
                      <ProgressBarView value={s.total - s.dropped > 0 ? Math.round((100 * s.applied) / (s.total - s.dropped)) : 0} size="xs" color={s.pending ? '#6366f1' : '#22c55e'} />
                    </>
                  ) : <span className="rl-muted">{loadingStatus ? 'reading status' : ''}</span>}
                </div>
                <div className="rl-card-actions">
                  <ButtonView size="xs" variant="primary" accentColor="#6366f1" iconLeft={<RocketLaunchIcon size={12} />} label="Deploy" disabled={!env} title={`Preview, then deploy release ${r.id} to ${env}`} onClick={() => void openPreview(r.id)} />
                  <ButtonView size="xs" variant="ghost" color="#f87171" iconLeft={<UndoIcon size={12} />} label="Roll back" disabled={!env || !s?.applied} onClick={() => setRollback({ ...newRollback(catalog), scope: 'release', release: r.id })} />
                  <ButtonView size="xs" variant="ghost" iconLeft={<PencilIcon size={12} />} label="Edit" onClick={() => setEditRelease({ value: { ...r }, isNew: false })} />
                </div>
              </div>
              {projects.length === 0 ? (
                <div className="rl-card-empty">
                  No projects in this release yet.
                  <ButtonView size="xs" variant="ghost" iconLeft={<PlusIcon size={12} />} label="Add a project" onClick={() => setEditProject({ value: { id: '', type: 'new', release: r.id, status: 'active' }, isNew: true })} />
                </div>
              ) : projects.map(p => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  changes={changesByProject[p.id] ?? []}
                  applied={applied}
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
              <ProjectRow key={p.id} project={p} changes={changesByProject[p.id] ?? []} applied={applied}
                onEdit={() => setEditProject({ value: { ...p }, isNew: false })}
                onDrop={() => setEditProject({ value: { ...p, status: 'dropped' }, isNew: false })}
                onRestore={() => upsertProject({ ...p, status: 'active', dropped_reason: undefined }, false, p.id)}
                onRollback={() => setRollback({ ...newRollback(catalog), scope: 'project', projects: [p.id] })} />
            ))}
          </section>
        )}

        {/* Changes */}
        <section className="rl-card">
          <div className="rl-card-head">
            <div className="rl-card-title"><LayersIcon size={15} /><span className="rl-card-id">Changes</span><span className="rl-muted">{data.changes.length} in {data.changesDir}</span></div>
            {unassigned.length > 0 && <div className="rl-card-stats"><span className="rl-stat"><b className="rl-warn">{unassigned.length}</b> without a project: a release deploy skips them</span></div>}
          </div>
          {data.changes.length === 0 ? <div className="rl-card-empty">No change folders yet.</div> : (
            <div className="rl-table">
              <div className="rl-tr rl-th">
                <div>Change</div><div>Project</div><div>Kind</div><div>Requested by</div><div>Created by</div><div>{env || 'Status'}</div><div />
              </div>
              {data.changes.map(c => (
                <ChangeTableRow
                  key={c.id}
                  change={c}
                  projects={catalog.projects}
                  kinds={data.changeKinds}
                  isApplied={applied[c.id]}
                  onPatch={patch => patchChange(c.id, patch)}
                  onDrop={() => setDropChange({ id: c.id, reason: '' })}
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
      {dropChange && (
        <ModalView open size="sm" onClose={() => setDropChange(null)} title={`Drop ${dropChange.id}`} headerIcon={<BlockedIcon size={16} />}
          subtitle="The folder stays in the repository; deploy skips it in every environment until you restore it."
          footerRight={<>
            <ButtonView size="sm" variant="ghost" label="Cancel" onClick={() => setDropChange(null)} />
            <ButtonView size="sm" variant="danger" label="Drop change" iconLeft={<BlockedIcon size={13} />} onClick={() => { patchChange(dropChange.id, { status: 'dropped', dropped_reason: dropChange.reason }); setDropChange(null); }} />
          </>}>
          <label className="rl-label">Reason</label>
          <TextInputView size="sm" value={dropChange.reason} autoFocus placeholder="Why it is not going" onChange={e => setDropChange({ ...dropChange, reason: e.target.value })} />
        </ModalView>
      )}
      {preview && (
        <ModalView open size="lg" onClose={() => setPreview(null)} title={`Deploy release ${preview.release} to ${env}`} headerIcon={<RocketLaunchIcon size={16} />}
          subtitle="Dry run: nothing has been applied yet."
          footerRight={<>
            <ButtonView size="sm" variant="ghost" label="Close" onClick={() => setPreview(null)} />
            <ButtonView size="sm" variant="primary" iconLeft={<RocketLaunchIcon size={13} />} label={`Deploy in Runner`}
              disabled={preview.loading || !!preview.error || !preview.changes?.length}
              onClick={() => { onRunInRunner(['deploy', '--release', preview.release, '--env', env]); setPreview(null); }} />
          </>}>
          {preview.loading ? <LoaderView variant="dots" label="Planning" center /> : preview.error ? (
            <div className="rl-problem"><ShieldAlertIcon size={14} /><pre>{preview.error}</pre></div>
          ) : (
            <>
              <div className="rl-plan-title">{preview.changes?.length ? `${preview.changes.length} change(s) will be deployed, in this order` : 'Nothing to deploy: every change of this release is already applied here.'}</div>
              <PlanTable changes={preview.changes ?? []} />
              {!!preview.dropped?.length && (
                <>
                  <div className="rl-plan-title rl-muted">Skipped as dropped</div>
                  {preview.dropped.map(d => <div key={d.change_id} className="rl-plan-dropped"><BlockedIcon size={12} /><span className="rl-mono">{d.change_id}</span><span className="rl-muted">{d.reason}</span></div>)}
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
          kinds={data.changeKinds}
          env={env}
          capture={capture}
          onRun={args => { onRunInRunner(args); setRollback(null); }}
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
function ProjectRow({ project: p, changes, applied, onEdit, onDrop, onRestore, onRollback }: {
  project: Project; changes: ChangeRow[]; applied: Record<string, boolean>;
  onEdit: () => void; onDrop: () => void; onRestore: () => void; onRollback: () => void;
}) {
  const dropped = p.status === 'dropped';
  const appliedCount = changes.filter(c => applied[c.id]).length;
  const kinds = [...new Set(changes.map(kindOf))];
  return (
    <div className={`rl-project${dropped ? ' rl-project--dropped' : ''}`}>
      <span className="rl-type" style={{ ['--rl-c' as string]: typeColor(p.type) }}>{TYPE_LABEL[p.type ?? ''] ?? p.type ?? 'new'}</span>
      <div className="rl-project-main">
        <div className="rl-project-name"><span className="rl-mono">{p.id}</span>{p.name && <span>{p.name}</span>}</div>
        <div className="rl-project-meta">
          {changes.length} change{changes.length === 1 ? '' : 's'}{kinds.length ? ` · ${kinds.join(', ')}` : ''} · {appliedCount} applied
          {dropped && <span className="rl-dropped-note"><BlockedIcon size={11} /> dropped{p.dropped_reason ? `: ${p.dropped_reason}` : ''}</span>}
        </div>
      </div>
      <div className="rl-project-actions">
        <ButtonView size="xs" variant="ghost" iconLeft={<PencilIcon size={12} />} label="Edit / move" onClick={onEdit} />
        {dropped
          ? <ButtonView size="xs" variant="ghost" iconLeft={<CheckCircleIcon size={12} />} label="Restore" onClick={onRestore} />
          : <ButtonView size="xs" variant="ghost" iconLeft={<BlockedIcon size={12} />} label="Not going" onClick={onDrop} />}
        <ButtonView size="xs" variant="ghost" iconLeft={<UndoIcon size={12} />} label="Roll back" disabled={appliedCount === 0} onClick={onRollback} />
      </div>
    </div>
  );
}

/* ── One change in the table ────────────────────────────────────────────── */
function ChangeTableRow({ change: c, projects, kinds, isApplied, onPatch, onDrop }: {
  change: ChangeRow; projects: Project[]; kinds: string[]; isApplied?: boolean;
  onPatch: (patch: Record<string, string>) => void; onDrop: () => void;
}) {
  const [requestedBy, setRequestedBy] = useState(c.requested_by);
  useEffect(() => setRequestedBy(c.requested_by), [c.requested_by]);
  const dropped = c.status === 'dropped';
  const status = isApplied ? 'applied' : dropped ? 'dropped' : c.danger ? 'manual' : isApplied === undefined ? '' : 'pending';
  const statusColor: Record<string, string> = { applied: '#22c55e', dropped: '#64748b', manual: '#ef4444', pending: '#f59e0b' };
  return (
    <div className={`rl-tr${dropped ? ' rl-tr--dropped' : ''}`}>
      <div className="rl-mono rl-ellipsis" title={c.metaError ? `meta.json: ${c.metaError}` : c.id}>{c.id}{c.metaError && <WarningTriangleIcon size={11} />}</div>
      <div>
        <SelectInputView size="xs" value={c.project} onChange={v => onPatch({ project: v })}
          options={[{ value: '', label: '(none)' }, ...projects.map(p => ({ value: p.id, label: p.id, badge: { label: (p.type ?? 'new').toUpperCase(), color: typeColor(p.type) } })),
            ...(c.project && !projects.some(p => p.id === c.project) ? [{ value: c.project, label: `${c.project} (not in releases.json)` }] : [])]} />
      </div>
      <div>
        <SelectInputView size="xs" value={c.kind} onChange={v => onPatch({ kind: v })}
          options={[{ value: '', label: `auto: ${c.inferredKind}` }, ...kinds.map(k => ({ value: k, label: k }))]} />
      </div>
      <div>
        <TextInputView size="xs" value={requestedBy} placeholder="Developer" iconLeft={<UserSingleIcon size={11} />}
          onChange={e => setRequestedBy(e.target.value)}
          onBlur={() => { if (requestedBy.trim() !== c.requested_by) onPatch({ requested_by: requestedBy.trim() }); }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </div>
      <div className="rl-ellipsis rl-muted" title={c.created_at ? `on ${c.created_at}` : undefined}>{c.created_by || '-'}</div>
      <div>{status && <ChipView size="xs" label={status} color={statusColor[status]} />}</div>
      <div className="rl-row-actions">
        {dropped
          ? <ButtonView size="xs" variant="ghost" iconLeft={<CheckCircleIcon size={12} />} label="Restore" title={c.dropped_reason || undefined} onClick={() => onPatch({ status: '', dropped_reason: '' })} />
          : <ButtonView size="xs" variant="ghost" iconLeft={<BlockedIcon size={12} />} label="Drop" disabled={isApplied} title={isApplied ? 'Applied here: roll it back first' : 'Not going: deploy skips it everywhere'} onClick={onDrop} />}
      </div>
    </div>
  );
}

function PlanTable({ changes }: { changes: PlanChange[] }) {
  if (!changes.length) return null;
  return (
    <div className="rl-table rl-table--plan">
      <div className="rl-tr rl-th"><div>#</div><div>Change</div><div>Project</div><div>Release</div><div>Kind</div></div>
      {changes.map((c, i) => (
        <div key={c.change_id} className="rl-tr">
          <div className="rl-muted">{i + 1}</div><div className="rl-mono rl-ellipsis">{c.change_id}</div>
          <div>{c.project || '-'}</div><div>{c.release || '-'}</div><div>{c.kind || '-'}</div>
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
    <ModalView open size="md" onClose={onClose} title={state.isNew ? 'New release' : `Release ${state.value.id}`} headerIcon={<CalendarIcon size={16} />}
      footerLeft={onDelete ? <ButtonView size="sm" variant="ghost" label="Delete release" onClick={onDelete} /> : undefined}
      footerRight={<>
        <ButtonView size="sm" variant="ghost" label="Cancel" onClick={onClose} />
        <ButtonView size="sm" variant="primary" label="Save" disabled={!!problem} title={problem || undefined} onClick={() => onSave({ ...r, id }, state.value.id)} />
      </>}>
      <div className="rl-form">
        <label className="rl-label">Release id</label>
        <TextInputView size="sm" value={r.id} disabled={!state.isNew} placeholder="Release id" onChange={e => setR({ ...r, id: e.target.value })} />
        <label className="rl-label">Name</label>
        <TextInputView size="sm" value={r.name ?? ''} placeholder="Release name" onChange={e => setR({ ...r, name: e.target.value })} />
        <label className="rl-label">Release date</label>
        <DateInputView size="sm" value={r.date || null} placeholder="Pick the release date" onChange={d => setR({ ...r, date: d, id: state.isNew && (!r.id || r.id === r.date) ? d : r.id })} />
        <label className="rl-label">Status</label>
        <SelectInputView size="sm" value={r.status ?? 'planned'} onChange={v => setR({ ...r, status: v })} options={RELEASE_STATUSES.map(s => ({ value: s, label: s }))} />
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
    <ModalView open size="md" onClose={onClose} title={state.isNew ? 'New project' : `Project ${state.value.id}`} headerIcon={<PackageDependencyIcon size={16} />}
      subtitle={state.isNew ? undefined : `${changeCount} change${changeCount === 1 ? '' : 's'} follow this project to whichever release it is in.`}
      footerRight={<>
        <ButtonView size="sm" variant="ghost" label="Cancel" onClick={onClose} />
        <ButtonView size="sm" variant={dropped ? 'danger' : 'primary'} label={dropped && state.value.status !== 'dropped' ? 'Mark not going' : 'Save'} disabled={!!problem} title={problem || undefined}
          onClick={() => onSave({ ...p, id, dropped_reason: dropped ? p.dropped_reason : undefined }, state.value.id)} />
      </>}>
      <div className="rl-form">
        <label className="rl-label">Project id</label>
        <TextInputView size="sm" value={p.id} disabled={!state.isNew} placeholder="Project id" onChange={e => setP({ ...p, id: e.target.value })} />
        <label className="rl-label">Name</label>
        <TextInputView size="sm" value={p.name ?? ''} placeholder="Project name" onChange={e => setP({ ...p, name: e.target.value })} />
        <label className="rl-label">Type</label>
        <SelectInputView size="sm" value={p.type ?? 'new'} onChange={v => setP({ ...p, type: v })}
          options={types.map(t => ({ value: t, label: TYPE_LABEL[t] ?? t, badge: { label: t.toUpperCase(), color: typeColor(t) } }))} />
        <label className="rl-label">Release</label>
        <SelectInputView size="sm" value={p.release ?? ''} onChange={v => setP({ ...p, release: v })}
          options={[{ value: '', label: '(unscheduled)' }, ...releases.map(r => ({ value: r.id, label: `${r.id}${r.name ? ' · ' + r.name : ''}` }))]} />
        <label className="rl-label">Status</label>
        <SelectInputView size="sm" value={dropped ? 'dropped' : 'active'} onChange={v => setP({ ...p, status: v })}
          options={[{ value: 'active', label: 'active: goes out with its release' }, { value: 'dropped', label: 'not going: deploy skips its changes' }]} />
        {dropped && (
          <>
            <label className="rl-label">Reason</label>
            <TextInputView size="sm" value={p.dropped_reason ?? ''} placeholder="Why it is not going" onChange={e => setP({ ...p, dropped_reason: e.target.value })} />
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

function RollbackModal({ state: s, setState, catalog, kinds, env, capture, onRun }: {
  state: RollbackState; setState: (s: RollbackState | null) => void; catalog: Catalog; kinds: string[]; env: string;
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
    <ModalView open size="lg" onClose={() => setState(null)} title={`Roll back on ${env}`} headerIcon={<UndoIcon size={16} />} headerColor="#ef4444"
      subtitle="Reverts the applied changes in the scope, newest first, wherever they sit in the history. Preview first: DMCR refuses when a later change outside the scope depends on them."
      maxHeight="80vh"
      footerRight={<>
        <ButtonView size="sm" variant="ghost" label="Cancel" onClick={() => setState(null)} />
        <ButtonView size="sm" variant="secondary" iconLeft={<EyeIcon size={13} />} label="Preview" disabled={!ready || !!s.loading} loading={s.loading} onClick={() => void runPreview()} />
        <ButtonView size="sm" variant="danger" iconLeft={<UndoIcon size={13} />} label="Roll back in Runner"
          disabled={!previewed || blocked || !s.changes?.length}
          title={!previewed ? 'Preview this scope first' : blocked ? 'Blocked: see the problems listed' : undefined}
          onClick={() => onRun(args)} />
      </>}>
      <div className="rl-form">
        <label className="rl-label">What to roll back</label>
        <SelectInputView size="sm" value={s.scope} onChange={v => set({ scope: v as RollbackState['scope'] })}
          options={[{ value: 'project', label: 'One or more projects' }, { value: 'release', label: 'A whole release' }]} />
        {s.scope === 'release' ? (
          <>
            <label className="rl-label">Release</label>
            <SelectInputView size="sm" value={s.release} onChange={v => set({ release: v })} options={catalog.releases.map(r => ({ value: r.id, label: `${r.id}${r.name ? ' · ' + r.name : ''}` }))} />
          </>
        ) : (
          <>
            <label className="rl-label">Projects</label>
            <div className="rl-chips">
              {catalog.projects.map(p => (
                <ChipView key={p.id} size="sm" label={p.id} color={s.projects.includes(p.id) ? typeColor(p.type) : '#64748b'}
                  bg={s.projects.includes(p.id) ? undefined : 'transparent'}
                  icon={s.projects.includes(p.id) ? <CheckCircleIcon size={11} /> : undefined}
                  onClick={() => set({ projects: toggle(s.projects, p.id) })} />
              ))}
            </div>
          </>
        )}
        <label className="rl-label">Only these kinds of change <span className="rl-muted">(none selected: all kinds)</span></label>
        <div className="rl-chips">
          {kinds.filter(k => k !== 'other').map(k => (
            <ChipView key={k} size="sm" label={k} color={s.kinds.includes(k) ? '#ef4444' : '#64748b'} bg={s.kinds.includes(k) ? undefined : 'transparent'}
              icon={s.kinds.includes(k) ? <CheckCircleIcon size={11} /> : undefined}
              onClick={() => set({ kinds: toggle(s.kinds, k) })} />
          ))}
        </div>
        <div className="rl-cmd"><span className="rl-muted">Runs</span> <code>dmcr {key}</code></div>
      </div>

      {s.previewedKey === key && !s.loading && (
        s.error ? <div className="rl-problem"><ShieldAlertIcon size={14} /><pre>{s.error}</pre></div> : (
          <div className="rl-preview">
            <div className="rl-plan-title">{s.changes?.length ? `${s.changes.length} change(s) will be reverted, newest first` : 'Nothing applied in this scope.'}</div>
            <PlanTable changes={s.changes ?? []} />
            {s.problems?.map((p, i) => <div key={`p${i}`} className="rl-problem"><ShieldAlertIcon size={14} /><span>{p}</span></div>)}
            {s.warnings?.map((w, i) => <div key={`w${i}`} className="rl-warning"><WarningTriangleIcon size={13} /><span>{w}</span></div>)}
          </div>
        )
      )}
    </ModalView>
  );
}
