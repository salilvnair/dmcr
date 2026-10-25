import { useEffect, useRef, useState } from 'react';
import {
  ModalView, ButtonView, IconButtonView, TextInputView, SelectInputView, SegmentedControlView, EditorView, ChipView, LoaderView, TogglePillView,
  FolderImportIcon, ArrowUpIcon, ArrowDownIcon, EyeIcon, CheckCircleIcon, WarningTriangleIcon, ShieldAlertIcon, RefreshIcon, InfoCircleIcon,
} from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import { ChangeIdLabel } from '../runner/views/ChangeIdLabel';
import './ImportModal.css';

/* From import-handlers.ts */
type ScanFile = { name: string; path: string; sql: string; kind: string; reasons: string[]; after: string[] };
type Gen = { changeName: string; deploySql: string; verifySql: string; revertSql: string; metaJson?: string; previousFrom?: string; file: string; after?: string[] };
// keepOut: this file stays on the environment it ran on (test data, a debug function): never deployed to the target
type Row = ScanFile & { gen?: Gen; status?: 'running' | 'done' | 'error'; error?: string; chunk?: string; trial?: { status: string; details: string }; keepOut?: boolean };
type TrialResult = { aligned?: { index: number; revertSql: string }[]; ok?: boolean; error?: string; env: string; results?: { index: number; status: string; details: string }[]; stopped?: { index: number; reason: string }; blockedBy?: string };
type SaveResult = { error?: string; saved: { file: string; id: string }[]; commit?: { ok: boolean; commitHash?: string; error?: string } | null; marked?: { id: string; ok: boolean; error?: string }[]; verified?: { id: string; status: string; error?: string }[] };
type Project = { id: string; name?: string; status?: string };
type Stage = 'source' | 'order' | 'generate' | 'confirm' | 'trial' | 'saving' | 'done';

const KIND_COLOR: Record<string, string> = { DDL: 'var(--dm-c-a78bfa)', DML: 'var(--dm-c-60a5fa)', function: 'var(--dm-c-34d399)', mixed: 'var(--dm-c-fbbf24)', other: 'var(--dm-c-94a3b8)' };
const STEPS: { key: Stage[]; label: string }[] = [
  { key: ['source'], label: 'Files' }, { key: ['order'], label: 'Order' }, { key: ['generate'], label: 'Changes' },
  { key: ['confirm', 'trial'], label: 'Trial on prod' }, { key: ['saving', 'done'], label: 'Save' },
];

/**
 * Releases > Import from test: SQL files that already ran on test by hand become DMCR changes that go to prod
 * through Releases. Test is not touched (the changes are only recorded there as applied).
 */
export function ImportModal({ envs, projects, onClose, onDone }: { envs: string[]; projects: Project[]; onClose: () => void; onDone: () => void }) {
  const prodEnv = envs.find(e => /prod/i.test(e)) ?? envs[envs.length - 1] ?? 'prod';
  const [source, setSource] = useState('');
  const [ranOn, setRanOn] = useState(envs.find(e => e !== prodEnv && /test|stag|uat|st$/i.test(e)) ?? envs.find(e => e !== prodEnv) ?? '');
  const [target, setTarget] = useState(prodEnv);
  const [stage, setStage] = useState<Stage>('source');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [unsure, setUnsure] = useState(false);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [tab, setTab] = useState<Record<number, 'file' | 'deploy' | 'verify' | 'revert'>>({});
  const [trial, setTrial] = useState<TrialResult | null>(null);
  const [project, setProject] = useState(projects.find(p => p.status !== 'dropped')?.id ?? '');
  const [requestedBy, setRequestedBy] = useState('');
  const [ticket, setTicket] = useState('');
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const req = useRef('');
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: Record<string, unknown> };
      if (!m?.type?.startsWith('import') || m.payload?.requestId !== req.current) return;
      const p = m.payload as never as Record<string, never>;
      switch (m.type) {
        case 'importStep': setStep(p.text); break;
        case 'importScanResult': {
          setBusy(false); setStep('');
          if (p.error) { setError(p.error); break; }
          setLabel(p.label); setRows((p.files as ScanFile[]).map(f => ({ ...f }))); setNotes(p.notes); setUnsure(p.unsure); setStage('order');
          break;
        }
        case 'importProgress': {
          const i = p.index as number;
          setRows(rs => rs.map((r, k) => k !== i ? r : {
            ...r, status: p.status, chunk: p.chunk ?? r.chunk, error: p.error,
            gen: p.status === 'done' ? p.change : p.status === 'running' ? undefined : r.gen, trial: undefined,
          }));
          break;
        }
        case 'importGenerateDone': setBusy(false); break;
        case 'importTrialResult': {
          setBusy(false);
          const t = p as never as TrialResult;
          setTrial(t);
          // reverts aligned with the changes before them (a function replaced twice): shown as they were run
          // indexes count the rows that were sent (kept-out rows are not)
          setRows(rs => { let n = -1; return rs.map(r => {
            if (r.keepOut) return { ...r, trial: undefined };
            n++;
            const al = t.aligned?.find(x => x.index === n);
            return { ...r, trial: t.results?.find(x => x.index === n), gen: al && r.gen ? { ...r.gen, revertSql: al.revertSql } : r.gen };
          }); });
          setStage('trial');
          break;
        }
        case 'importSaveResult': {
          setBusy(false); setStep('');
          setSaved(p as never as SaveResult); setStage('done'); onDoneRef.current();
          break;
        }
      }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, []);

  const send = (type: string, payload: Record<string, unknown>) => {
    req.current = `imp-${Date.now()}`;
    setBusy(true); setError('');
    postMsg({ type, payload: { requestId: req.current, ...payload } });
  };
  const scan = () => send('importScan', { source, ranOn });
  const generate = (only?: number) => {
    setStage('generate'); setTrial(null);
    if (only === undefined) setRows(rs => rs.map(r => ({ ...r, gen: undefined, status: undefined, error: undefined, trial: undefined })));
    send('importGenerate', { items: rows.map(r => ({ name: r.name, sql: r.sql, after: r.after })), target, only });
  };
  // the rows that go to the target (the trial runs only these; kept-out rows are saved for the other environments)
  const going = rows.map((r, i) => (r.keepOut ? -1 : i)).filter(i => i >= 0);
  // a new trial: the last one's marks go, so nothing shows a result before this run has one
  const runTrial = () => { setStage('trial'); setTrial(null); setRows(rs => rs.map(r => ({ ...r, trial: undefined }))); send('importTrial', { target, changes: going.map(i => rows[i].gen) }); };
  const save = () => {
    setStage('saving');
    const elsewhere = envs.filter(e => e !== target);
    send('importSave', { changes: rows.map(r => ({ ...r.gen, environments: r.keepOut ? elsewhere : undefined })), project, requestedBy, ticket, ranOn, label });
  };
  const toggleKeep = (i: number) => { setTrial(null); setRows(rs => rs.map((r, k) => (k === i ? { ...r, keepOut: !r.keepOut, trial: undefined } : { ...r, trial: undefined }))); if (stage === 'trial') setStage('confirm'); };
  const move = (i: number, d: -1 | 1) => setRows(rs => {
    const j = i + d; if (j < 0 || j >= rs.length) return rs;
    const n = [...rs]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });

  const allGenerated = rows.length > 0 && rows.every(r => r.status === 'done' && r.gen);
  const anyRunning = rows.some(r => r.status === 'running');
  // a file now sits before one it needs: the order the user made breaks what the SQL says
  const broken = rows.flatMap((r, i) => r.after.filter(a => rows.findIndex(x => x.name === a) > i).map(a => `${r.name} needs ${a} first`));
  // a file going to the target that needs one kept out of it would fail there
  const keptNeeded = rows.flatMap(r => (r.keepOut ? [] : r.after.filter(a => rows.find(x => x.name === a)?.keepOut).map(a => `${r.name} needs ${a}, which stays off ${target}`)));
  const stepIdx = STEPS.findIndex(s => s.key.includes(stage));

  const footer = (() => {
    if (stage === 'source') return <>
      <ButtonView variant="ghost" label="Cancel" onClick={onClose} />
      <ButtonView variant="primary" accentColor="var(--dm-c-22d3ee)" iconLeft={<FolderImportIcon size={13} />} label="Load files" loading={busy}
        disabled={busy || !source.trim() || !ranOn || !target || ranOn === target} onClick={scan} />
    </>;
    if (stage === 'order') return <>
      <ButtonView variant="ghost" label="Back" onClick={() => setStage('source')} />
      <ButtonView variant="primary" accentColor="var(--dm-c-22d3ee)" label={`Make ${rows.length} change${rows.length === 1 ? '' : 's'}`} disabled={!rows.length || broken.length > 0}
        title={broken.length ? broken.join('; ') : undefined} onClick={() => generate()} />
    </>;
    if (stage === 'generate') return <>
      <ButtonView variant="ghost" label="Back to order" disabled={busy} onClick={() => setStage('order')} />
      <ButtonView variant="primary" accentColor="var(--dm-c-ef4444)" iconLeft={<ShieldAlertIcon size={13} />} label={`Trial run on ${target}`} disabled={busy || anyRunning || !allGenerated || !going.length || keptNeeded.length > 0}
        title={keptNeeded.length ? keptNeeded.join('; ') : !going.length ? `Every file stays off ${target}: nothing to try` : undefined} onClick={() => setStage('confirm')} />
    </>;
    if (stage === 'confirm') return <>
      <ButtonView variant="ghost" label="Not now" onClick={() => setStage('generate')} />
      <ButtonView variant="primary" accentColor="var(--dm-c-ef4444)" iconLeft={<ShieldAlertIcon size={13} />} label={`Run on ${target}, rolled back`} disabled={!going.length || keptNeeded.length > 0} onClick={runTrial} />
    </>;
    if (stage === 'trial') return <>
      <ButtonView variant="ghost" label="Back to changes" disabled={busy} onClick={() => setStage('generate')} />
      <ButtonView variant="primary" accentColor="var(--dm-c-22c55e)" iconLeft={<CheckCircleIcon size={13} />} label={`Save, commit and mark applied on ${ranOn}`}
        disabled={busy || !trial?.ok || !project} title={!project ? 'Pick a project' : undefined} onClick={save} />
    </>;
    if (stage === 'saving') return <ButtonView variant="primary" label="Saving" loading disabled />;
    return <ButtonView variant="primary" label="Done" onClick={onClose} />;
  })();

  const sqlTabs = (i: number, r: Row) => {
    const t = tab[i] ?? (r.gen ? 'deploy' : 'file');
    const opts = [{ value: 'file', label: r.name }, ...(r.gen ? [{ value: 'deploy', label: 'deploy.sql' }, { value: 'verify', label: 'verify.sql' }, { value: 'revert', label: 'revert.sql' }] : [])];
    const text = t === 'file' ? r.sql : t === 'deploy' ? r.gen!.deploySql : t === 'verify' ? r.gen!.verifySql : r.gen!.revertSql;
    return <div className="im-sql">
      {opts.length > 1 && <SegmentedControlView variant="rounded" size="md" value={t} onChange={v => setTab(x => ({ ...x, [i]: v as 'file' }))} options={opts} />}
      <div className="im-editor"><EditorView value={text} language="sql" readOnly height="100%" fontSize={12.5} editorOptions={{ minimap: false, scrollBeyondLastLine: false, wordWrap: 'on' }} /></div>
    </div>;
  };

  return (
    <ModalView open size="xxl" height="95vh" maxHeight="95vh" className="im-modal" onClose={onClose} headerIcon={<FolderImportIcon size={16} />} headerColor="var(--dm-c-22d3ee)"
      title={`Import changes already run on ${ranOn || 'test'}`}
      subtitle={`SQL files someone ran on ${ranOn || 'test'} by hand become DMCR changes for ${target}. ${ranOn || 'Test'} is not touched again: they are only recorded there as applied.`}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'auto' }}
      footerRight={footer}>
      <ol className="im-steps">
        {STEPS.map((s, i) => <li key={s.label} className={i < stepIdx ? 'is-done' : i === stepIdx ? 'is-on' : ''}><span className="im-step-n">{i < stepIdx ? <CheckCircleIcon size={12} /> : i + 1}</span>{s.label}</li>)}
      </ol>

      {error && <div className="im-box im-box--err"><WarningTriangleIcon size={14} /><span>{error}</span></div>}

      {stage === 'source' && <>
        <div className="im-form">
          <label className="im-field im-field--wide"><span className="im-label">Where the SQL files are</span>
            <TextInputView value={source} placeholder="https://github.com/owner/repo/commit/… · …/pull/42 · …/tree/main/sql · or C:\path\to\folder" onChange={e => setSource(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' && source.trim() && !busy) scan(); }} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }} /></label>
          <label className="im-field"><span className="im-label">Already ran on</span>
            <SelectInputView size="md" value={ranOn} onChange={setRanOn} options={envs.map(e => ({ value: e, label: e }))} /></label>
          <label className="im-field"><span className="im-label">Goes to</span>
            <SelectInputView size="md" value={target} onChange={setTarget} options={envs.map(e => ({ value: e, label: e }))} /></label>
        </div>
        {ranOn && ranOn === target && <div className="im-box im-box--warn"><WarningTriangleIcon size={14} /><span>Pick two different environments.</span></div>}
        {busy ? <div className="im-busy"><LoaderView variant="spinner" size="sm" /> {step || 'Loading'}</div> : (
          <div className="im-box"><InfoCircleIcon size={14} /><span>
            A GitHub link is read with your own git sign-in (private repositories too). The order is worked out from the SQL: a file that uses a column,
            table or row another file creates goes after it, and where several files replace the same function, the one {ranOn || 'test'} has now ran last.
            You can change the order before anything is made.
          </span></div>
        )}
      </>}

      {stage === 'order' && <>
        <div className="im-head"><b>{rows.length} file{rows.length === 1 ? '' : 's'}</b> from {label}</div>
        {unsure && <div className="im-box im-box--warn"><WarningTriangleIcon size={14} /><span>Some files need nothing from the others and git cannot tell when they ran: check their place, they keep the order shown.</span></div>}
        {notes.map(n => <div key={n} className="im-box im-box--warn"><WarningTriangleIcon size={14} /><span>{n}</span></div>)}
        {broken.length > 0 && <div className="im-box im-box--err"><WarningTriangleIcon size={14} /><span>{broken.join('; ')}.</span></div>}
        <div className="im-list">
          {rows.map((r, i) => (
            <div key={r.name} className="im-row">
              <div className="im-row-head">
                <span className="im-n">{i + 1}</span>
                <span className="im-name">{r.name}</span>
                <ChipView size="xs" label={r.kind} color={KIND_COLOR[r.kind] ?? KIND_COLOR.other} />
                <span className="im-gap" />
                <IconButtonView size="sm" variant="ghost" icon={<EyeIcon size={13} />} title="Show the SQL" aria-label="Show the SQL" onClick={() => setOpen(o => ({ ...o, [i]: !o[i] }))} />
                <IconButtonView size="sm" variant="ghost" icon={<ArrowUpIcon size={13} />} title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButtonView size="sm" variant="ghost" icon={<ArrowDownIcon size={13} />} title="Move down" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)} />
              </div>
              <ul className="im-reasons">{r.reasons.map(x => <li key={x}>{x}</li>)}</ul>
              {open[i] && sqlTabs(i, r)}
            </div>
          ))}
        </div>
      </>}

      {(stage === 'generate' || stage === 'confirm' || stage === 'trial' || stage === 'saving') && <>
        {stage === 'confirm' && <div className="im-box im-box--danger"><ShieldAlertIcon size={16} /><span>
          <b>Trial run on {target}.</b> {going.length === rows.length ? `All ${rows.length}` : `The ${going.length} going to ${target}`} changes run on {target} in this order, each one deployed, verified, reverted and verified, inside one
          transaction that is then rolled back: nothing stays on {target}. The tables they touch are locked while it runs (a few seconds; a busy table
          makes it fail after 3 seconds instead of waiting).{going.length < rows.length ? ` The ${rows.length - going.length} kept off ${target} are not run.` : ''}
        </span></div>}
        {keptNeeded.length > 0 && stage !== 'saving' && <div className="im-box im-box--err"><WarningTriangleIcon size={14} /><span>{keptNeeded.join('; ')}: keep that one off {target} too, or send the other there.</span></div>}
        {stage === 'trial' && busy && <div className="im-busy"><LoaderView variant="spinner" size="sm" /> Running {going.length === rows.length ? `all ${rows.length}` : `the ${going.length} going there`} on {target}, rolled back</div>}
        {stage === 'trial' && trial && !busy && (
          trial.error ? <div className="im-box im-box--err"><WarningTriangleIcon size={14} /><span>{trial.error}</span></div>
          : trial.ok ? <div className="im-box im-box--ok"><CheckCircleIcon size={14} /><span>{going.length === rows.length ? `All ${rows.length}` : `All ${going.length} going there`} passed on {trial.env}: deployed, verified, reverted and verified in this order, then rolled back. Nothing stayed on {trial.env}.{going.length < rows.length ? ` ${rows.length - going.length} stay on ${ranOn} only.` : ''}</span></div>
          : <div className="im-box im-box--err"><WarningTriangleIcon size={14} /><span>
              {trial.blockedBy ?? (() => {
                const failed = (trial.results ?? []).filter(x => x.status === 'fail').map(x => rows[going[x.index]]?.name).filter(Boolean);
                return failed.length
                  ? `${failed.join(', ')} failed on ${trial.env}; the files after it were not reached. Make it again (↻) or change the order, then run the trial again.`
                  : `The trial did not pass on ${trial.env}.`;
              })()}
            </span></div>
        )}
        {stage === 'saving' && <div className="im-busy"><LoaderView variant="spinner" size="sm" /> {step || 'Saving'}</div>}
        {stage === 'trial' && trial?.ok && <div className="im-form">
          <label className="im-field"><span className="im-label">Project</span>
            <SelectInputView size="md" value={project} onChange={setProject} options={projects.filter(p => p.status !== 'dropped').map(p => ({ value: p.id, label: p.name ? `${p.id} · ${p.name}` : p.id }))} /></label>
          <label className="im-field"><span className="im-label">Requested by</span><TextInputView value={requestedBy} placeholder="Developer" onChange={e => setRequestedBy(e.target.value)} /></label>
          <label className="im-field"><span className="im-label">Ticket</span><TextInputView value={ticket} placeholder="optional" onChange={e => setTicket(e.target.value)} /></label>
        </div>}
        <div className="im-list">
          {rows.map((r, i) => (
            <div key={r.name} className={`im-row${r.trial ? (r.trial.status === 'pass' ? ' is-pass' : r.trial.status === 'fail' ? ' is-fail' : ' is-skip') : ''}`}>
              <div className="im-row-head">
                <span className="im-n">{i + 1}</span>
                <span className="im-name">{r.name}</span>
                <ChipView size="xs" label={r.kind} color={KIND_COLOR[r.kind] ?? KIND_COLOR.other} />
                {r.gen && <span className="im-arrow">→ {r.gen.changeName}</span>}
                <span className="im-gap" />
                {stage !== 'saving' && <TogglePillView testId={`keep-${r.name}`} active={!!r.keepOut} disabled={busy}
                  title={r.keepOut ? `Stays on ${ranOn}: not tried on ${target} and never deployed there. Click to send it to ${target}` : `Never send it to ${target} (test data, a debug function): it stays on ${ranOn} only`}
                  onClick={() => toggleKeep(i)}>{r.keepOut ? `never to ${target}` : `never send to ${target}`}</TogglePillView>}
                {r.status === 'running' && <span className="im-state"><LoaderView variant="spinner" size="sm" /> making</span>}
                {r.status === 'error' && <ChipView size="xs" label="failed" color="var(--dm-c-ef4444)" />}
                {r.trial && <ChipView size="xs" label={r.trial.status === 'pass' ? `passed on ${target}` : r.trial.status === 'fail' ? `failed on ${target}` : 'not reached'}
                  color={r.trial.status === 'pass' ? 'var(--dm-c-22c55e)' : r.trial.status === 'fail' ? 'var(--dm-c-ef4444)' : 'var(--dm-c-94a3b8)'} />}
                {(r.status === 'done' || r.status === 'error') && stage !== 'saving' && <IconButtonView size="sm" variant="ghost" icon={<RefreshIcon size={13} />} title="Make this one again" aria-label="Make again" disabled={busy} onClick={() => generate(i)} />}
                <IconButtonView size="sm" variant="ghost" icon={<EyeIcon size={13} />} title="Show the SQL" aria-label="Show the SQL" onClick={() => setOpen(o => ({ ...o, [i]: !o[i] }))} />
              </div>
              {r.gen?.previousFrom && <div className="im-meta">Revert puts back the previous version, from {r.gen.previousFrom}</div>}
              {r.status === 'running' && r.chunk && <div className="im-chunk">{r.chunk}</div>}
              {r.error && <div className="im-err">{r.error}</div>}
              {r.trial?.status === 'fail' && r.trial.details && <div className="im-err">{r.trial.details}</div>}
              {open[i] && sqlTabs(i, r)}
            </div>
          ))}
        </div>
      </>}

      {stage === 'done' && saved && <>
        {saved.error
          ? <div className="im-box im-box--err"><WarningTriangleIcon size={14} /><span>{saved.error}{saved.saved.length ? ` (${saved.saved.length} saved before it stopped)` : ''}</span></div>
          : <div className="im-box im-box--ok"><CheckCircleIcon size={14} /><span>
              <b>{saved.saved.length} changes saved</b>{saved.commit?.ok ? <> and committed ({saved.commit.commitHash})</> : saved.commit ? <>; the commit failed: {saved.commit.error}</> : null}.
              {' '}Deploy them to {target} from Releases: project <b>{project}</b>, in its release, Deploy.
            </span></div>}
        <div className="im-list">
          {saved.saved.map(s => {
            const mk = saved.marked?.find(m => m.id === s.id);
            const vf = saved.verified?.find(v => v.id === s.id);
            return (
              <div key={s.id} className="im-row">
                <div className="im-row-head">
                  <ChangeIdLabel id={s.id} />
                  <span className="im-arrow">← {s.file}</span>
                  <span className="im-gap" />
                  {mk && <ChipView size="xs" label={mk.ok ? `applied on ${ranOn}` : `not marked on ${ranOn}`} color={mk.ok ? 'var(--dm-c-22c55e)' : 'var(--dm-c-ef4444)'} />}
                  {vf && <ChipView size="xs" label={vf.status === 'ok' ? `verified on ${ranOn}` : vf.status === 'no-backup' ? `no backup on ${ranOn}` : vf.status === 'superseded' ? 'changed again later' : `verify: ${vf.status}`}
                    color={vf.status === 'ok' ? 'var(--dm-c-22c55e)' : vf.status === 'superseded' ? 'var(--dm-c-94a3b8)' : vf.status === 'no-backup' ? 'var(--dm-c-f59e0b)' : 'var(--dm-c-ef4444)'} />}
                </div>
                {mk && !mk.ok && mk.error && <div className="im-err">{mk.error}</div>}
                {vf?.error && vf.status !== 'ok' && <div className={vf.status === 'superseded' || vf.status === 'no-backup' ? 'im-meta' : 'im-err'}>{
                  vf.status === 'superseded' ? 'A later import changed the same rows or object, so this verify describes an earlier state.'
                  : vf.status === 'no-backup' ? `Its deploy saves the old values in a backup table; on ${ranOn} the SQL ran by hand, so there is none and it cannot be reverted on ${ranOn}. ${target} gets the backup when it is deployed.`
                  : vf.error}</div>}
              </div>
            );
          })}
        </div>
      </>}
    </ModalView>
  );
}
