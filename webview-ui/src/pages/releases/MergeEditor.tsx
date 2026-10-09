import { useEffect, useMemo, useRef, useState } from 'react';
import { ButtonView, ModalView, SelectInputView, TextInputView, LoaderView, DiffEditorView, EditorView, MergeIcon, CheckCircleIcon, WarningTriangleIcon, ArrowRightIcon, EyeIcon, BranchIcon } from '@salilvnair/dui';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import sqlLang from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { postMsg } from '../../vscode';
import { ChangeIdLabel, WarnText } from '../runner/views/ChangeIdLabel';
import { shown, type Conflict, type MergeChunk, type MergeSql } from './conflictTypes';
import './Conflicts.css';

SyntaxHighlighter.registerLanguage('sql', sqlLang);

type Pick = 'ours' | 'theirs' | 'both';
type SelfCheck = { status: 'passed' | 'failed' | 'skipped'; message: string; error?: string; env?: string; ms: number };

function Code({ lines, tone, empty }: { lines: string[]; tone?: 'ours' | 'theirs' | 'result' | 'muted'; empty?: string }) {
  if (!lines.length) return <div className={`mg-code mg-code--empty mg-code--${tone ?? 'muted'}`}>{empty ?? 'no lines'}</div>;
  return (
    <div className={`mg-code mg-code--${tone ?? 'muted'}`}>
      <SyntaxHighlighter language="sql" style={vscDarkPlus} customStyle={{ margin: 0, padding: '6px 10px', background: 'transparent', fontSize: 12, lineHeight: 1.55 }} wrapLongLines>
        {lines.join('\n')}
      </SyntaxHighlighter>
    </div>
  );
}

/** Unchanged lines; a long stretch shows its first and last lines and folds the middle. */
function Stable({ lines }: { lines: string[] }) {
  const [openAll, setOpenAll] = useState(false);
  if (lines.length <= 8 || openAll) return <div className="mg-stable"><Code lines={lines} /></div>;
  return (
    <div className="mg-stable">
      <Code lines={lines.slice(0, 3)} />
      <button type="button" className="mg-fold" onClick={() => setOpenAll(true)}>{lines.length - 5} unchanged lines</button>
      <Code lines={lines.slice(-2)} />
    </div>
  );
}

/** Builds the result from the chunks and the picks; an unpicked conflict keeps git's markers. */
function buildResult(chunks: MergeChunk[], picks: Record<number, Pick>, oursLabel: string, theirsLabel: string): string {
  return chunks.flatMap((c, i) => {
    if (c.kind !== 'conflict') return c.lines;
    const p = picks[i];
    if (p === 'ours') return c.ours;
    if (p === 'theirs') return c.theirs;
    if (p === 'both') return [...c.ours, ...c.theirs];
    return [`<<<<<<< ${oursLabel}`, ...c.ours, '=======', ...c.theirs, `>>>>>>> ${theirsLabel}`];
  }).join('\n');
}

const hasMarkers = (t: string) => /^(<{7}|={7}|>{7})( |$)/m.test(t);
const lineCount = (...texts: string[]) => Math.max(...texts.map(t => t.split('\n').length));

type MonacoEditor = { getModel: () => { getValue: () => string } | null; deltaDecorations: (old: string[], next: unknown[]) => string[]; onDidChangeModelContent: (cb: () => void) => void };
/** Colors git's conflict markers in the result: A's block amber, B's block blue, the marker lines bold. */
function markerDecorations(editor: MonacoEditor, monaco: { Range: new (a: number, b: number, c: number, d: number) => unknown }, ids: { current: string[] }) {
  const paint = () => {
    const lines = (editor.getModel()?.getValue() ?? '').split('\n');
    const decos: unknown[] = [];
    let zone: 'ours' | 'theirs' | null = null;
    lines.forEach((l, i) => {
      const n = i + 1;
      const line = (cls: string) => decos.push({ range: new monaco.Range(n, 1, n, 1), options: { isWholeLine: true, className: cls } });
      if (/^<{7}( |$)/.test(l)) { zone = 'ours'; line('mg-dec-marker mg-dec-marker--ours'); }
      else if (/^={7}$/.test(l) && zone) { zone = 'theirs'; line('mg-dec-marker'); }
      else if (/^>{7}( |$)/.test(l)) { zone = null; line('mg-dec-marker mg-dec-marker--theirs'); }
      else if (zone) line(zone === 'ours' ? 'mg-dec-ours' : 'mg-dec-theirs');
    });
    ids.current = editor.deltaDecorations(ids.current, decos);
  };
  paint();
  editor.onDidChangeModelContent(paint);
}

export function MergeEditor({ conflict: c, dbaName, onClose, onDone }: { conflict: Conflict; dbaName: string; onClose: () => void; onDone: (changeId: string) => void }) {
  const oursLabel = `${c.ours.changeId} (${c.ours.project})`;
  const theirsLabel = `${c.theirs.changeId} (${c.theirs.project})`;
  const chunks = c.merge?.chunks ?? [];
  const [picks, setPicks] = useState<Record<number, Pick>>({});
  const [rowPicks, setRowPicks] = useState<Record<string, 'ours' | 'theirs'>>({});
  const auto = useMemo(() => buildResult(chunks, picks, oursLabel, theirsLabel), [chunks, picks, oursLabel, theirsLabel]);
  const [result, setResult] = useState(auto);
  const [edited, setEdited] = useState(false);
  useEffect(() => { if (!edited) setResult(auto); }, [auto, edited]);
  const [project, setProject] = useState(c.theirs.project);
  const [preview, setPreview] = useState<{ sql?: MergeSql; error?: string; loading?: boolean } | null>(null);
  const [tab, setTab] = useState<'deploy' | 'verify' | 'revert'>('deploy');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ changeId?: string; error?: string; selfCheck?: SelfCheck } | null>(null);
  const [keepOrder, setKeepOrder] = useState<{ note: string } | null>(null);
  const decoIds = useRef<string[]>([]);

  const mergeable = c.kind === 'definition' && /^(function|view):/.test(c.key) || c.kind === 'data';
  const conflictIdx = chunks.map((ch, i) => (ch.kind === 'conflict' ? i : -1)).filter(i => i >= 0);
  const open = c.kind === 'definition' ? (hasMarkers(result) ? conflictIdx.filter(i => !picks[i]).length || 1 : 0)
    : c.kind === 'data' ? (c.rows?.length ? c.rows.filter(r => !rowPicks[r.key] && !rowPicks['*']).length : rowPicks['*'] ? 0 : 1) : 0;
  const input = c.kind === 'definition' ? { result } : { picks: rowPicks };

  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: { conflictId?: string; sql?: MergeSql; error?: string; changeId?: string; selfCheck?: SelfCheck } };
      if (m?.payload?.conflictId !== c.id) return;
      if (m.type === 'mergeChangePreview') setPreview({ sql: m.payload.sql, error: m.payload.error });
      if (m.type === 'mergeChangeCreated') {
        setCreating(false);
        setCreated({ changeId: m.payload.changeId, error: m.payload.error, selfCheck: m.payload.selfCheck });
        if (m.payload.changeId) onDone(m.payload.changeId);
      }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, [c.id, onDone]);

  const runPreview = () => { setPreview({ loading: true }); postMsg({ type: 'previewMergeChange', payload: { conflictId: c.id, input } }); };
  const create = () => { setCreating(true); setCreated(null); postMsg({ type: 'createMergeChange', payload: { conflictId: c.id, input, project, requestedBy: dbaName } }); };

  const statusTone = c.status === 'auto' ? 'auto' : 'conflict';
  return (
    <ModalView open size="xxl" height="88vh" maxHeight="88vh" onClose={onClose} headerColor={c.status === 'auto' ? '#22c55e' : '#f59e0b'}
      headerIcon={<MergeIcon size={18} />}
      title={<span className="mg-title">Merge <code>{c.object}</code><span className={`mg-label mg-label--${statusTone}`}>{c.label}</span></span>}
      subtitle={c.summary}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}
      footerLeft={!created?.changeId && (keepOrder ? (
        <span className="mg-keep">
          <TextInputView value={keepOrder.note} placeholder="Why the deploy order is right (recorded)" onChange={e => setKeepOrder({ note: e.target.value })} />
          <ButtonView variant="secondary" label={`Keep: ${c.theirs.project} wins`} disabled={!keepOrder.note.trim()}
            onClick={() => { postMsg({ type: 'resolveConflict', payload: { conflictId: c.id, note: keepOrder.note } }); onClose(); }} />
          <ButtonView variant="ghost" label="Cancel" onClick={() => setKeepOrder(null)} />
        </span>
      ) : (
        <ButtonView variant="ghost" iconLeft={<BranchIcon size={13} />} label="Keep the deploy order instead"
          title={`No merge change: ${c.theirs.project} deploys later and its version stays. The decision is recorded in conflicts.json.`} onClick={() => setKeepOrder({ note: '' })} />
      ))}
      footerRight={<>
        <ButtonView variant="ghost" label={created?.changeId ? 'Close' : 'Cancel'} onClick={onClose} />
        {mergeable && !created?.changeId && <>
          <ButtonView variant="secondary" iconLeft={<EyeIcon size={13} />} label="Preview merge change" disabled={open > 0} title={open ? 'Resolve every conflict first' : undefined} onClick={runPreview} />
          <ButtonView variant="primary" iconLeft={<MergeIcon size={13} />} label={creating ? 'Round-trip test…' : 'Create merge change'} loading={creating} disabled={open > 0 || creating}
            title={open ? 'Resolve every conflict first' : 'Writes a new change after both sides; it is test-run (deploy, verify, revert, rolled back) before it is saved'} onClick={create} />
        </>}
      </>}>

      {/* who is who */}
      <div className="mg-sides">
        <div className="mg-side mg-side--ours"><span className="mg-side-tag">1</span><ChangeIdLabel id={c.ours.changeId} /><span className="mg-side-rel">{c.ours.release} · deploys first</span></div>
        <ArrowRightIcon size={14} />
        <div className="mg-side mg-side--theirs"><span className="mg-side-tag">2</span><ChangeIdLabel id={c.theirs.changeId} /><span className="mg-side-rel">{c.theirs.release} · deploys later, wins today</span></div>
        {c.kind === 'definition' && <span className="mg-base">{c.base ? <>merge base <ChangeIdLabel id={c.base.changeId} /></> : 'no common base: both added it'}</span>}
      </div>

      {created?.changeId && (
        <div className="mg-banner mg-banner--ok"><CheckCircleIcon size={16} /><span>Merge change <ChangeIdLabel id={created.changeId} /> saved{created.selfCheck ? ` · round trip ${created.selfCheck.status}${created.selfCheck.env ? ` on ${created.selfCheck.env}` : ''}` : ''}. It requires both sides, so it always deploys after them.</span></div>
      )}
      {created?.error && <div className="mg-banner mg-banner--bad"><WarningTriangleIcon size={16} /><span><WarnText text={created.error} />{created.selfCheck?.error && <pre className="mg-err">{created.selfCheck.error}</pre>}</span></div>}

      {c.kind === 'definition' && (
        <>
          <div className="mg-grid-head"><span className="mg-col-ours">{oursLabel}</span><span className="mg-col-theirs">{theirsLabel}</span></div>
          <div className="mg-diff"><DiffEditorView original={c.ours.text} modified={c.theirs.text} language="sql" readOnly renderSideBySide height={Math.min(420, 40 + 19 * lineCount(c.ours.text, c.theirs.text))} fontSize={12} /></div>
          <div className="mg-section-title"><MergeIcon size={13} />Hunks <span>{conflictIdx.length ? `${conflictIdx.length} to decide, the rest merged by itself` : 'all merged by themselves'}</span></div>
          <div className="mg-chunks">
            {chunks.map((ch, i) => ch.kind === 'stable' ? (
              <Stable key={i} lines={ch.lines} />
            ) : ch.kind === 'conflict' ? (
              <div key={i} className={`mg-hunk${picks[i] ? ' is-picked' : ''}`}>
                <div className="mg-hunk-head"><WarningTriangleIcon size={13} /><b>Conflict {conflictIdx.indexOf(i) + 1} of {conflictIdx.length}</b><span>both changed {ch.base.length ? `${ch.base.length} line${ch.base.length === 1 ? '' : 's'}` : 'the same place'}</span>
                  <span className="mg-hunk-actions">
                    {(['ours', 'theirs', 'both'] as Pick[]).map(p => (
                      <button key={p} type="button" className={`mg-pick mg-pick--${p}${picks[i] === p ? ' is-on' : ''}`} onClick={() => { setEdited(false); setPicks({ ...picks, [i]: p }); }}>
                        {p === 'ours' ? `Accept ${c.ours.project}` : p === 'theirs' ? `Accept ${c.theirs.project}` : 'Accept both'}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="mg-two">
                  <Code lines={ch.ours} tone="ours" empty="(removed)" />
                  <Code lines={ch.theirs} tone="theirs" empty="(removed)" />
                </div>
                {ch.base.length > 0 && <details className="mg-basebox"><summary>merge base</summary><Code lines={ch.base} /></details>}
              </div>
            ) : (
              <div key={i} className={`mg-auto mg-auto--${ch.kind}`}>
                <span className="mg-auto-tag">{ch.kind === 'both' ? 'same change on both sides' : `only ${ch.kind === 'ours' ? c.ours.project : c.theirs.project} changed this: taken`}</span>
                <Code lines={ch.lines} tone={ch.kind === 'theirs' ? 'theirs' : 'ours'} empty="(lines removed)" />
              </div>
            ))}
          </div>
          <div className="mg-result">
            <div className="mg-result-head"><b>Result</b><span>{hasMarkers(result) ? 'pick a side for every conflict, or edit the markers out' : edited ? 'edited by hand' : 'merged'}</span>
              {edited && <button type="button" className="mg-link" onClick={() => setEdited(false)}>rebuild from the picks</button>}</div>
            <div className="mg-monaco">
              <EditorView value={result} language="sql" height={Math.min(520, 60 + 19 * lineCount(result))} fontSize={12}
                onChange={v => { if (v !== result) { setEdited(true); setResult(v); } }}
                onEditorMount={(ed, mon) => markerDecorations(ed as MonacoEditor, mon as never, decoIds)} />
            </div>
          </div>
        </>
      )}

      {c.kind === 'data' && (
        <div className="mg-data">
          <div className="mg-grid-head"><span className="mg-col-ours">{oursLabel}</span><span className="mg-col-theirs">{theirsLabel}</span></div>
          <div className="mg-diff"><DiffEditorView original={c.ours.text} modified={c.theirs.text} language="sql" readOnly renderSideBySide wordWrap height={Math.min(320, 60 + 19 * lineCount(c.ours.text, c.theirs.text))} fontSize={12} /></div>
          {c.rows?.length ? (
            <>
              <div className="mg-data-bulk">
                <span><b>{c.table}.{c.column}</b> · key <code>{c.keyColumn}</code> · {c.rows.length} conflicting row{c.rows.length === 1 ? '' : 's'}</span>
                <button type="button" className="mg-pick mg-pick--ours" onClick={() => setRowPicks(Object.fromEntries(c.rows!.map(r => [r.key, 'ours'])))}>All {c.ours.project}</button>
                <button type="button" className="mg-pick mg-pick--theirs" onClick={() => setRowPicks(Object.fromEntries(c.rows!.map(r => [r.key, 'theirs'])))}>All {c.theirs.project}</button>
              </div>
              <div className="mg-rows">
                <div className="mg-row mg-row--head"><span>{c.keyColumn}</span><span>{c.ours.project} · {c.ours.changeId.slice(0, 3)}</span><span>{c.theirs.project} · {c.theirs.changeId.slice(0, 3)}</span><span>Result</span></div>
                {c.rows.map(r => (
                  <div key={r.key} className="mg-row">
                    <span className="mg-row-key">{r.key}</span>
                    <button type="button" className={`mg-val mg-val--ours${rowPicks[r.key] === 'ours' ? ' is-on' : ''}`} onClick={() => setRowPicks({ ...rowPicks, [r.key]: 'ours' })}>{shown(r.ours)}</button>
                    <button type="button" className={`mg-val mg-val--theirs${rowPicks[r.key] === 'theirs' ? ' is-on' : ''}`} onClick={() => setRowPicks({ ...rowPicks, [r.key]: 'theirs' })}>{shown(r.theirs)}</button>
                    <span className={`mg-row-res${rowPicks[r.key] ? ` is-${rowPicks[r.key]}` : ''}`}>{rowPicks[r.key] ? shown(rowPicks[r.key] === 'ours' ? r.ours : r.theirs) : 'pick one'}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="mg-data-bulk"><span><b>{c.table}.{c.column}</b> on {c.rowsText}: the rows cannot be listed from the SQL; pick whose values win where both write</span></div>
              <div className="mg-two">
                <button type="button" className={`mg-exprpick mg-val--ours${rowPicks['*'] === 'ours' ? ' is-on' : ''}`} onClick={() => setRowPicks({ '*': 'ours' })}><b>{c.ours.project}</b><Code lines={[`${c.column} = ${c.oursExpr}`]} tone="ours" /></button>
                <button type="button" className={`mg-exprpick mg-val--theirs${rowPicks['*'] === 'theirs' ? ' is-on' : ''}`} onClick={() => setRowPicks({ '*': 'theirs' })}><b>{c.theirs.project}</b><Code lines={[`${c.column} = ${c.theirsExpr}`]} tone="theirs" /></button>
              </div>
            </>
          )}
        </div>
      )}

      {c.kind !== 'definition' && c.kind !== 'data' && (
        <>
          <div className="mg-banner mg-banner--warn"><WarningTriangleIcon size={16} /><span>A merge change cannot fix this one: the second change fails or undoes the first when it deploys. Edit one side (it must not be applied anywhere yet), or keep the deploy order and record why.</span></div>
          <div className="mg-grid-head"><span className="mg-col-ours">{oursLabel}</span><span className="mg-col-theirs">{theirsLabel}</span></div>
          <div className="mg-diff"><DiffEditorView original={c.ours.text} modified={c.theirs.text} language="sql" readOnly renderSideBySide height={Math.min(420, 60 + 19 * lineCount(c.ours.text, c.theirs.text))} fontSize={12} /></div>
        </>
      )}

      {mergeable && !created?.changeId && (
        <div className="mg-project">
          <span>Merge change goes to project</span>
          <span style={{ width: 200 }}>
            <SelectInputView size="md" width="100%" value={project} onChange={setProject}
              options={[...new Set([c.theirs.project, c.ours.project])].map(p => ({ value: p, label: p === c.theirs.project ? `${p} (later release: recommended)` : p }))} />
          </span>
          <span className="mg-hint">It requires {c.ours.changeId.slice(0, 3)} and {c.theirs.changeId.slice(0, 3)}; in the later release it deploys after both everywhere.</span>
        </div>
      )}

      {preview && (
        <div className="mg-preview">
          {preview.loading ? <LoaderView variant="dots" label="Building" /> : preview.error ? (
            <div className="mg-banner mg-banner--bad"><WarningTriangleIcon size={16} /><span>{preview.error}</span></div>
          ) : preview.sql && (
            <>
              <div className="mg-tabs">
                <span className="mg-tabs-name"><MergeIcon size={13} />{preview.sql.changeName}</span>
                {(['deploy', 'verify', 'revert'] as const).map(t => (
                  <button key={t} type="button" className={`mg-tab${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>{t}.sql</button>
                ))}
              </div>
              <Code lines={(tab === 'deploy' ? preview.sql.deploySql : tab === 'verify' ? preview.sql.verifySql : preview.sql.revertSql).split('\n')} tone="result" />
            </>
          )}
        </div>
      )}
    </ModalView>
  );
}
