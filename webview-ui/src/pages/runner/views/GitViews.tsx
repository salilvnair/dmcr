import { useState } from 'react';
import { CalendarIcon, CommitIcon, CopyIcon, DiffIcon, EditorView, FolderIcon, InboxIcon, MinusIcon, PlusIcon, SegmentedControlView, UserCheckIcon, CheckIcon } from '@salilvnair/dui';
import { ChangeIdLabel, KindChip, PersonChip, ProjectChip, ReleaseChip } from './ChangeIdLabel';
import { usePagedRows } from '../../../components/BigList';
import { openChanges } from '../../../components/ChangeViewerHost';
import './GitViews.css';

/* git-style views of the runner: dmcr log (git log), dmcr diff (git diff), dmcr show (git show) */

const MONACO_OPTS = { scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 }, wordWrap: 'on' as const, minimap: false, scrollBeyondLastLine: false };

function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="gv-copy" title={`Copy ${id}`}
      onClick={e => { e.stopPropagation(); void navigator.clipboard?.writeText(id).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => undefined); }}>
      {done ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
    </button>
  );
}

/** A command shown in a result: selectable, with a copy button */
export function CopyCmd({ cmd }: { cmd: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="gv-cmd">
      <code>{cmd}</code>
      <button type="button" className="gv-copy" title={`Copy: ${cmd}`}
        onClick={e => { e.stopPropagation(); void navigator.clipboard?.writeText(cmd).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => undefined); }}>
        {done ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
      </button>
    </span>
  );
}

// ── dmcr log: deployments as a git log ───────────────────────────────────────
type Run = { deploy_id: string; short: string; at: string; action: string; environment?: string; actor?: string; ok: number; failed: number; still_applied: number; git_commit?: string; changes: string[] };

export function LogView({ data }: { data: { environment?: string; deployments?: Run[] } }) {
  const runs = data.deployments ?? [];
  const pg = usePagedRows(runs, r => `${r.deploy_id} ${r.changes.join(' ')} ${r.actor ?? ''}`, [
    { value: 'deploy', label: 'Deploys', keep: r => r.action === 'deploy' },
    { value: 'revert', label: 'Reverts', keep: r => r.action === 'revert' },
    { value: 'failed', label: 'With a failure', keep: r => r.failed > 0 },
  ], 0);
  if (!runs.length) return <div className="gv-empty"><InboxIcon size={20} /><span>No deployments recorded on {data.environment} yet. Every deploy and revert from now on gets an id here.</span></div>;
  const deploys = runs.filter(r => r.action === 'deploy').length;
  return (
    <div className="gv-root">
      <div className="gv-head">
        <span className="gv-head-title"><CommitIcon size={14} />git log</span>
        <span className="gv-env">{data.environment}</span>
        <span className="gv-muted">{runs.length} deployment{runs.length !== 1 ? 's' : ''} · {deploys} deploy{deploys !== 1 ? 's' : ''} · {runs.length - deploys} revert{runs.length - deploys !== 1 ? 's' : ''} · newest first</span>
      </div>
      {pg.bar}
      <ol className="gv-log">
        {pg.rows.map((r, i) => (
          <li key={r.deploy_id} className={`gv-commit gv-commit--${r.action}${r.failed ? ' gv-commit--failed' : ''}`}>
            <div className="gv-rail"><span className="gv-dot" />{i < pg.rows.length - 1 && <span className="gv-line" />}</div>
            <div className="gv-card">
              <div className="gv-card-head">
                <span className="gv-sha" title={r.deploy_id}>deployment {r.short}</span><CopyId id={r.deploy_id} />
                <span className={`gv-action gv-action--${r.action}`}>{r.action}</span>
                {r.environment && <span className="gv-env">{r.environment}</span>}
                {r.failed > 0 && <span className="gv-action gv-action--failed">{r.failed} failed</span>}
                <span className="gv-spacer" />
                {r.actor && <span className="gv-meta"><UserCheckIcon size={12} />{r.actor}</span>}
                <span className="gv-meta"><CalendarIcon size={12} />{r.at}</span>
                {r.git_commit && <span className="gv-meta gv-mono" title="git commit of the change files">commit {r.git_commit.slice(0, 7)}</span>}
                <button type="button" className="gv-open" title="Open every change of this deployment" onClick={() => openChanges(r.changes, `deployment ${r.short}`)}><FolderIcon size={12} />View files</button>
              </div>
              <div className="gv-msg">
                {r.ok} change{r.ok !== 1 ? 's' : ''} {r.action === 'deploy' ? 'applied' : 'reverted'}
                {r.action === 'deploy' && <span className={`gv-still${r.still_applied < r.ok ? ' gv-still--part' : ''}`}>{r.still_applied === r.ok ? 'all still applied' : `${r.still_applied} of ${r.ok} still applied`}</span>}
              </div>
              <div className="gv-changes">{r.changes.map((c, k) => <span key={c + k} className="gv-change"><ChangeIdLabel id={c} /></span>)}</div>
              {r.action === 'deploy' && r.still_applied > 0 && <div className="gv-hint">undo it: <CopyCmd cmd={`dmcr revert ${r.short}`} /> · details: <CopyCmd cmd={`dmcr show ${r.short}`} /></div>}
            </div>
          </li>
        ))}
      </ol>
      {pg.more}
    </div>
  );
}

// ── dmcr diff ────────────────────────────────────────────────────────────────
type WorkDiff = { mode: 'work'; environment: string; applied: number; pending: { change_id: string; project?: string; release?: string; kind?: string }[]; edited: { change_id: string; files: string[] }[]; missing: string[]; not_going: string[] };
type EnvDiff = { mode: 'envs'; left: string; right: string; same: number; only_left: { change_id: string; applied_at?: string }[]; only_right: { change_id: string; applied_at?: string }[]; differ: { change_id: string; files: string[] }[] };
type ChangeDiff = { mode: 'change'; change_id: string; environment: string; applied: boolean; applied_at?: string; git_commit?: string; edited: string[]; note: string; patch?: string };

function Gutter({ sign }: { sign: '+' | '-' | '~' | ' ' }) {
  return <span className={`gv-gutter gv-gutter--${sign === '+' ? 'add' : sign === '-' ? 'del' : sign === '~' ? 'mod' : 'ctx'}`}>{sign === '+' ? <PlusIcon size={11} /> : sign === '-' ? <MinusIcon size={11} /> : sign === '~' ? '~' : ''}</span>;
}

function Stat({ n, label, tone }: { n: number; label: string; tone: 'add' | 'del' | 'mod' | 'ctx' }) {
  return <span className={`gv-stat gv-stat--${tone}`}><b>{n}</b>{label}</span>;
}

function Patch({ text }: { text: string }) {
  return (
    <pre className="gv-patch">
      {text.split('\n').map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') ? 'file' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : l.startsWith('diff ') || l.startsWith('index ') ? 'meta' : 'ctx';
        return <div key={i} className={`gv-pl gv-pl--${cls}`}>{l || ' '}</div>;
      })}
    </pre>
  );
}

export function DiffView({ data }: { data: WorkDiff | EnvDiff | ChangeDiff }) {
  if (data.mode === 'change') {
    return (
      <div className="gv-root">
        <div className="gv-head">
          <span className="gv-head-title"><DiffIcon size={14} />git diff</span>
          <ChangeIdLabel id={data.change_id} /><span className="gv-env">{data.environment}</span>
          {data.git_commit && <span className="gv-meta gv-mono">since commit {data.git_commit.slice(0, 7)}</span>}
        </div>
        <div className={`gv-note gv-note--${!data.applied ? 'add' : data.edited.length ? 'mod' : 'ok'}`}>{data.note}</div>
        {data.patch ? <Patch text={data.patch} /> : null}
      </div>
    );
  }
  if (data.mode === 'envs') {
    const total = data.only_left.length + data.only_right.length + data.differ.length;
    return (
      <div className="gv-root">
        <div className="gv-head">
          <span className="gv-head-title"><DiffIcon size={14} />git diff</span>
          <span className="gv-env gv-env--del">{data.left}</span><span className="gv-muted">..</span><span className="gv-env gv-env--add">{data.right}</span>
          <span className="gv-spacer" />
          <Stat n={data.only_left.length} label={`only on ${data.left}`} tone="del" />
          <Stat n={data.only_right.length} label={`only on ${data.right}`} tone="add" />
          <Stat n={data.differ.length} label="different files" tone="mod" />
          <Stat n={data.same} label="identical" tone="ctx" />
        </div>
        {total === 0 ? <div className="gv-note gv-note--ok">{data.left} and {data.right} hold the same {data.same} changes, with identical files</div> : (
          <div className="gv-diff">
            <div className="gv-diff-file gv-diff-file--del">--- {data.left}</div>
            <div className="gv-diff-file gv-diff-file--add">+++ {data.right}</div>
            {data.only_left.map(x => <div key={x.change_id} className="gv-row gv-row--del"><Gutter sign="-" /><ChangeIdLabel id={x.change_id} /><span className="gv-row-note">only on {data.left}{x.applied_at ? ` · applied ${x.applied_at}` : ''}</span></div>)}
            {data.only_right.map(x => <div key={x.change_id} className="gv-row gv-row--add"><Gutter sign="+" /><ChangeIdLabel id={x.change_id} /><span className="gv-row-note">only on {data.right}{x.applied_at ? ` · applied ${x.applied_at}` : ''}</span></div>)}
            {data.differ.map(x => <div key={x.change_id} className="gv-row gv-row--mod"><Gutter sign="~" /><ChangeIdLabel id={x.change_id} /><span className="gv-row-note">applied on both, with different {x.files.join(', ')}</span></div>)}
          </div>
        )}
      </div>
    );
  }
  const clean = !data.pending.length && !data.edited.length && !data.missing.length;
  return (
    <div className="gv-root">
      <div className="gv-head">
        <span className="gv-head-title"><DiffIcon size={14} />git diff</span>
        <span className="gv-env gv-env--del">{data.environment}</span><span className="gv-muted">..</span><span className="gv-env gv-env--add">change files</span>
        <span className="gv-spacer" />
        <Stat n={data.pending.length} label="not applied" tone="add" />
        <Stat n={data.edited.length} label="edited" tone="mod" />
        <Stat n={data.missing.length} label="missing" tone="del" />
        <Stat n={data.applied} label="applied" tone="ctx" />
      </div>
      {clean ? <div className="gv-note gv-note--ok">Nothing to deploy: {data.environment} matches the change files ({data.applied} applied)</div> : (
        <div className="gv-diff">
          <div className="gv-diff-file gv-diff-file--del">--- {data.environment} (applied)</div>
          <div className="gv-diff-file gv-diff-file--add">+++ change files</div>
          {data.pending.map(x => (
            <div key={x.change_id} className="gv-row gv-row--add"><Gutter sign="+" /><ChangeIdLabel id={x.change_id} />
              <span className="gv-row-chips"><ProjectChip id={x.project || undefined} /><ReleaseChip id={x.release || undefined} /><KindChip kind={x.kind || undefined} /></span>
              <span className="gv-row-note">not applied on {data.environment} yet</span></div>
          ))}
          {data.edited.map(x => <div key={x.change_id} className="gv-row gv-row--mod"><Gutter sign="~" /><ChangeIdLabel id={x.change_id} /><span className="gv-row-note">edited since applied: {x.files.join(', ')} · <CopyCmd cmd={`dmcr diff ${x.change_id}`} /> shows the lines</span></div>)}
          {data.missing.map(x => <div key={x} className="gv-row gv-row--del"><Gutter sign="-" /><ChangeIdLabel id={x} /><span className="gv-row-note">applied on {data.environment}, but its folder is not in the change files</span></div>)}
        </div>
      )}
      {data.not_going.length > 0 && <div className="gv-foot">{data.not_going.length} not going (skipped by deploys): {data.not_going.join(', ')}</div>}
    </div>
  );
}

// ── dmcr show <change_id> ────────────────────────────────────────────────────
type ShowChange = { change_id: string; environment: string; state: string; project?: string; project_type?: string; release?: string; kind?: string; requested_by?: string; created_by?: string; ticket?: string; requires?: string;
  applied_at?: string; applied_by?: string; deploy_id?: string; git_commit?: string; deploy_sql?: string; verify_sql?: string; revert_sql?: string };

export function ShowChangeView({ data }: { data: ShowChange }) {
  const [file, setFile] = useState<'deploy' | 'verify' | 'revert'>('deploy');
  const sql = (file === 'deploy' ? data.deploy_sql : file === 'verify' ? data.verify_sql : data.revert_sql) ?? '';
  const tone = data.state === 'applied' ? 'ok' : data.state === 'not going' ? 'ctx' : 'add';
  return (
    <div className="gv-root">
      <div className="gv-show">
        <div className="gv-show-head">
          <span className="gv-sha">change</span><ChangeIdLabel id={data.change_id} />
          <span className={`gv-state gv-state--${tone}`}>{data.state} on {data.environment}</span>
        </div>
        <div className="gv-show-grid">
          <span>Project</span><span><ProjectChip id={data.project || undefined} />{data.project_type ? <span className="gv-muted"> {data.project_type}</span> : null}</span>
          <span>Release</span><span><ReleaseChip id={data.release || undefined} /></span>
          <span>Kind</span><span><KindChip kind={data.kind || undefined} /></span>
          <span>Asked by</span><span><PersonChip name={data.requested_by || undefined} /></span>
          <span>Built by</span><span><PersonChip name={data.created_by || undefined} dba /></span>
          {data.ticket ? <><span>Ticket</span><span className="gv-mono">{data.ticket}</span></> : null}
          {data.requires ? <><span>Requires</span><span className="gv-mono">{data.requires}</span></> : null}
          {data.state === 'applied' && <>
            <span>Applied</span><span>{data.applied_at} by <b>{data.applied_by}</b></span>
            {data.deploy_id ? <><span>Deployment</span><span><span className="gv-sha gv-sha--chip">{data.deploy_id.slice(0, 7)}</span><CopyId id={data.deploy_id} /></span></> : null}
            {data.git_commit ? <><span>Commit</span><span className="gv-mono">{data.git_commit}</span></> : null}
          </>}
        </div>
      </div>
      <div className="gv-files">
        <SegmentedControlView size="md" variant="rounded" accentColor="var(--bs-accent)" value={file} onChange={v => setFile(v as typeof file)}
          options={[{ value: 'deploy', label: 'deploy.sql' }, { value: 'verify', label: 'verify.sql' }, { value: 'revert', label: 'revert.sql' }]} />
      </div>
      {/* Monaco, read-only, as tall as the file (up to a screen) */}
      <div className="gv-editor" style={{ height: Math.min(640, Math.max(120, sql.split('\n').length * 19 + 20)) }}>
        <EditorView key={file} value={sql} language="sql" readOnly height="100%" fontSize={13} editorOptions={MONACO_OPTS} />
      </div>
    </div>
  );
}
