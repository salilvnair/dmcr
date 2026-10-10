import { useCallback, useEffect, useState } from 'react';
import { ButtonView, MergeIcon, CheckCircleIcon, WarningTriangleIcon, RefreshIcon, BranchIcon, UndoIcon, ArrowRightIcon } from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import { ChangeIdLabel } from '../runner/views/ChangeIdLabel';
import { MergeEditor } from './MergeEditor';
import type { Conflict, ConflictReport } from './conflictTypes';
import './Conflicts.css';

/** Conflicts between projects, like git status after a merge: what both sides changed, and how it was resolved. */
export function ConflictsCard({ visible, dbaName, onChanged }: { visible: boolean; dbaName: string; onChanged: () => void }) {
  const [report, setReport] = useState<ConflictReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAuto, setShowAuto] = useState(false);

  const load = useCallback(() => { setLoading(true); postMsg({ type: 'getConflicts' }); }, []);
  useEffect(() => {
    const h = (e: MessageEvent) => {
      if (e.data?.type === 'conflictsData') { setReport(e.data.payload as ConflictReport); setLoading(false); }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, []);
  useEffect(() => { if (visible) load(); }, [visible, load]);

  if (!report) return null;
  const open = report.conflicts.filter(c => !c.resolved);
  const conflicts = open.filter(c => c.status === 'conflict');
  const autos = open.filter(c => c.status === 'auto');
  const resolved = report.conflicts.filter(c => c.resolved);
  const current = report.conflicts.find(c => c.id === openId) ?? null;

  return (
    <section className="rl-card cf-card">
      <div className="rl-card-head">
        <div className="rl-card-title"><MergeIcon size={15} /><span className="rl-card-id">Conflicts</span>
          <span className="rl-muted">between projects, checked like a git merge: same function lines, same column on the same rows, same column or type definition</span>
        </div>
        <div className="cf-counts">
          <span className={`cf-count cf-count--bad${conflicts.length ? '' : ' is-zero'}`}><WarningTriangleIcon size={12} />{conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}</span>
          <span className={`cf-count cf-count--auto${autos.length ? '' : ' is-zero'}`}><MergeIcon size={12} />{autos.length} clean merge{autos.length === 1 ? '' : 's'} to write</span>
          <span className={`cf-count cf-count--ok${resolved.length ? '' : ' is-zero'}`}><CheckCircleIcon size={12} />{resolved.length} resolved</span>
          <button type="button" className={`cf-count cf-count--muted${showAuto ? ' is-on' : ''}`} onClick={() => setShowAuto(!showAuto)} title="Same table, different columns or rows: merges by itself">
            <BranchIcon size={12} />{report.autoMerged.length} auto-merged
          </button>
          <ButtonView variant="ghost" iconLeft={<RefreshIcon size={13} />} label="Check again" loading={loading} onClick={load} />
        </div>
      </div>
      {report.error && <div className="rl-card-empty cf-err"><WarningTriangleIcon size={13} /> {report.error}</div>}
      {report.saveError && <div className="rl-card-empty cf-err"><WarningTriangleIcon size={13} /> {report.saveError}</div>}

      {!report.conflicts.length && !report.error && (
        <div className="cf-clean"><CheckCircleIcon size={15} /><span><b>No conflicts.</b> {report.analyzed} changes checked: no two projects change the same lines of the database{report.autoMerged.length ? `; ${report.autoMerged.length} pair${report.autoMerged.length === 1 ? '' : 's'} share a table and merge by themselves` : ''}.</span></div>
      )}

      {report.conflicts.length > 0 && (
        <div className="cf-list">
          {report.conflicts.map(c => <ConflictRow key={c.id} c={c} onOpen={() => setOpenId(c.id)} />)}
        </div>
      )}

      {showAuto && report.autoMerged.length > 0 && (
        <div className="cf-auto">
          {report.autoMerged.map((a, i) => (
            <div key={i} className="cf-auto-row">
              <span className="cf-auto-tag">auto-merging</span><code>{a.object}</code>
              <ChangeIdLabel id={a.changes[0]} /><span className="cf-plus">+</span><ChangeIdLabel id={a.changes[1]} />
              <span className="rl-muted">{a.why}</span>
            </div>
          ))}
        </div>
      )}

      {current && (
        <MergeEditor conflict={current} dbaName={dbaName} onClose={() => setOpenId(null)}
          onDone={() => { onChanged(); }} />
      )}
    </section>
  );
}

function ConflictRow({ c, onOpen }: { c: Conflict; onOpen: () => void }) {
  const tone = c.resolved ? 'ok' : c.status === 'auto' ? 'auto' : 'bad';
  return (
    <div className={`cf-row cf-row--${tone}`}>
      <span className={`cf-state cf-state--${tone}`}>{c.resolved ? 'resolved' : c.label}</span>
      <div className="cf-main">
        <div className="cf-obj"><code>{c.object}</code><span className="cf-kind">{c.kind}</span></div>
        <div className="cf-pair">
          <ChangeIdLabel id={c.ours.changeId} /><span className="cf-rel">{c.ours.release}</span>
          <span className="cf-vs" title="deploys first, then"><ArrowRightIcon size={12} /></span>
          <ChangeIdLabel id={c.theirs.changeId} /><span className="cf-rel">{c.theirs.release}</span>
        </div>
        <div className="cf-summary">
          {c.resolved
            ? c.resolved.resolution === 'merge'
              ? <>merged by <ChangeIdLabel id={c.resolved.changeId ?? ''} /></>
              : <>deploy order kept ({c.theirs.project} wins){c.resolved.note ? `: ${c.resolved.note}` : ''}{c.resolved.by ? ` · ${c.resolved.by}` : ''}{c.resolved.at ? ` · ${c.resolved.at}` : ''}</>
            : c.summary}
        </div>
      </div>
      <div className="cf-actions">
        {c.resolved?.resolution === 'keep-order'
          ? <ButtonView variant="ghost" iconLeft={<UndoIcon size={12} />} label="Reopen" onClick={() => postMsg({ type: 'reopenConflict', payload: { conflictId: c.id } })} />
          : !c.resolved && <ButtonView variant="secondary" color={c.status === 'conflict' ? '#fbbf24' : '#4ade80'} iconLeft={<MergeIcon size={13} />} label={c.status === 'conflict' ? 'Resolve' : 'Merge'} onClick={onOpen} />}
      </div>
    </div>
  );
}
