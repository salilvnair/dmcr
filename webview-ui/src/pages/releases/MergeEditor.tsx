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
      <SyntaxHighlighter language="sql" style={vscDarkPlus} wrapLongLines
        customStyle={{ margin: 0, padding: '6px 10px', background: 'transparent', fontSize: 12, lineHeight: 1.55, overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        codeTagProps={{ style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }}>
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
  const [leftTab, setLeftTab] = useState<'work' | 'diff'>(c.kind === 'definition' || c.kind === 'data' ? 'work' : 'diff');
  const [rightTab, setRightTab] = useState<'result' | 'change'>('result');
  useEffect(() => { if (preview?.sql || preview?.error) setRightTab('change'); }, [preview]);
  const changeSql = preview?.sql ? (tab === 'deploy' ? preview.sql.deploySql : tab === 'verify' ? preview.sql.verifySql : preview.sql.revertSql) : '';

  const hunks = (
    <div className="mg-chunks">
      {chunks.map((ch, i) => ch.kind === 'stable' ? (
        <Stable key={i} lines={ch.lines} />
      ) : ch.kind === 'conflict' ? (
        <div key={i} className={`mg-hunk${picks[i] ? ' is-picked' : ''}`}>
          <div className="mg-hunk-head"><WarningTriangleIcon size={13} /><b>Conflict {conflictIdx.indexOf(i) + 1} of {conflictIdx.length}</b>
            <span className="mg-hunk-actions">
              {(['ours', 'theirs', 'both'] as Pick[]).map(p => (
                <button key={p} type="button" className={`mg-pick mg-pick--${p}${picks[i] === p ? ' is-on' : ''}`} onClick={() => { setEdited(false); setPicks({ ...picks, [i]: p }); }}>
                  {p === 'ours' ? `Accept ${c.ours.project}` : p === 'theirs' ? `Accept ${c.theirs.project}` : 'Both'}
                </button>
              ))}
            </span>
          </div>
          <div className="mg-sidebyside">
            <div className="mg-sidebox"><span className="mg-sidebox-label mg-sidebox-label--ours">{c.ours.project} · {c.ours.changeId.slice(0, 3)}</span><Code lines={ch.ours} tone="ours" empty="(removed)" /></div>
            <div className="mg-sidebox"><span className="mg-sidebox-label mg-sidebox-label--theirs">{c.theirs.project} · {c.theirs.changeId.slice(0, 3)}</span><Code lines={ch.theirs} tone="theirs" empty="(removed)" /></div>
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
  );

  const rows = c.kind === 'data' && (c.rows?.length ? (
    <div className="mg-data">
      <div className="mg-data-bulk">
        <span><b>{c.table}.{c.column}</b> · key <code>{c.keyColumn}</code> · {c.rows.length} conflicting row{c.rows.length === 1 ? '' : 's'}</span>
        <button type="button" className="mg-pick mg-pick--ours" onClick={() => setRowPicks(Object.fromEntries(c.rows!.map(r => [r.key, 'ours'])))}>All {c.ours.project}</button>
        <button type="button" className="mg-pick mg-pick--theirs" onClick={() => setRowPicks(Object.fromEntries(c.rows!.map(r => [r.key, 'theirs'])))}>All {c.theirs.project}</button>
      </div>
      <div className="mg-rows">
        <div className="mg-row mg-row--head"><span>{c.keyColumn}</span><span>{c.ours.project} · {c.ours.changeId.slice(0, 3)}</span><span>{c.theirs.project} · {c.theirs.changeId.slice(0, 3)}</span></div>
        {c.rows.map(r => (
          <div key={r.key} className="mg-row">
            <span className="mg-row-key">{r.key}</span>
            <button type="button" className={`mg-val mg-val--ours${rowPicks[r.key] === 'ours' ? ' is-on' : ''}`} onClick={() => setRowPicks({ ...rowPicks, [r.key]: 'ours' })}>{shown(r.ours)}</button>
            <button type="button" className={`mg-val mg-val--theirs${rowPicks[r.key] === 'theirs' ? ' is-on' : ''}`} onClick={() => setRowPicks({ ...rowPicks, [r.key]: 'theirs' })}>{shown(r.theirs)}</button>
          </div>
        ))}
      </div>
      <div className="mg-section-title">The two changes</div>
      <div className="mg-diff"><DiffEditorView original={c.ours.text} modified={c.theirs.text} language="sql" readOnly renderSideBySide={false} wordWrap height={Math.min(360, 60 + 22 * lineCount(c.ours.text, c.theirs.text) * 2)} fontSize={12} /></div>
    </div>
  ) : (
    <div className="mg-data">
      <div className="mg-data-bulk"><span><b>{c.table}.{c.column}</b> on {c.rowsText}: the rows cannot be listed from the SQL; pick whose values win where both write</span></div>
      <button type="button" className={`mg-exprpick mg-val--ours${rowPicks['*'] === 'ours' ? ' is-on' : ''}`} onClick={() => setRowPicks({ '*': 'ours' })}><b>{c.ours.project}</b><Code lines={[`${c.column} = ${c.oursExpr}`]} tone="ours" /></button>
      <button type="button" className={`mg-exprpick mg-val--theirs${rowPicks['*'] === 'theirs' ? ' is-on' : ''}`} onClick={() => setRowPicks({ '*': 'theirs' })}><b>{c.theirs.project}</b><Code lines={[`${c.column} = ${c.theirsExpr}`]} tone="theirs" /></button>
    </div>
  ));

  /** data: the merged rows as a table (the result pane) */
  const dataResult = c.kind === 'data' && c.rows?.length ? (
    <div className="mg-rows mg-rows--result">
      <div className="mg-row mg-row--head mg-row--2"><span>{c.keyColumn}</span><span>{c.column} after the merge</span></div>
      {c.rows.map(r => (
        <div key={r.key} className="mg-row mg-row--2">
          <span className="mg-row-key">{r.key}</span>
          <span className={`mg-row-res${rowPicks[r.key] ? ` is-${rowPicks[r.key]}` : ''}`}>{rowPicks[r.key] ? <>{shown(rowPicks[r.key] === 'ours' ? r.ours : r.theirs)}<em>from {rowPicks[r.key] === 'ours' ? c.ours.project : c.theirs.project}</em></> : 'pick a side'}</span>
        </div>
      ))}
    </div>
  ) : null;

  return (
    <ModalView open size="xxl" className="mg-modal" height="92vh" maxHeight="92vh" onClose={onClose} headerColor={c.status === 'auto' ? '#22c55e' : '#f59e0b'}
      headerIcon={<MergeIcon size={18} />}
      title={<span className="mg-title">Merge <code>{c.object}</code><span className={`mg-label mg-label--${statusTone}`}>{c.label}</span></span>}
      subtitle={c.summary}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'hidden' }}
      footerLeft={!created?.changeId && (keepOrder ? (
        <span className="mg-keep">
          <TextInputView value={keepOrder.note} placeholder="Why the deploy order is right (recorded)" onChange={e => setKeepOrder({ note: e.target.value })} />
          <ButtonView variant="secondary" label={`Keep: ${c.theirs.project} wins`} disabled={!keepOrder.note.trim()}
            onClick={() => { postMsg({ type: 'resolveConflict', payload: { conflictId: c.id, note: keepOrder.note } }); onClose(); }} />
          <ButtonView variant="ghost" label="Cancel" onClick={() => setKeepOrder(null)} />
        </span>
      ) : (
        <span className="mg-foot-left">
          <ButtonView variant="ghost" iconLeft={<BranchIcon size={13} />} label="Keep the deploy order instead"
            title={`No merge change: ${c.theirs.project} deploys later and its version stays. The decision is recorded in conflicts.json.`} onClick={() => setKeepOrder({ note: '' })} />
          {mergeable && (
            <span className="mg-project">
              <span>Merge change goes to</span>
              <span style={{ width: 210 }}>
                <SelectInputView size="md" width="100%" value={project} onChange={setProject}
                  options={[...new Set([c.theirs.project, c.ours.project])].map(p => ({ value: p, label: p === c.theirs.project ? `${p} · later release` : p }))} />
              </span>
            </span>
          )}
        </span>
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
      {!mergeable && (
        <div className="mg-banner mg-banner--warn"><WarningTriangleIcon size={16} /><span>A merge change cannot fix this one: the second change fails or undoes the first when it deploys. Edit one side (it must not be applied anywhere yet), or keep the deploy order and record why.</span></div>
      )}

      <div className={`mg-main${mergeable ? '' : ' mg-main--one'}`}>
        {/* left: what each side did */}
        <div className="mg-pane">
          <div className="mg-pane-tabs">
            {mergeable && (
              <button type="button" className={`mg-pane-tab${leftTab === 'work' ? ' is-on' : ''}`} onClick={() => setLeftTab('work')}>
                {c.kind === 'definition' ? <>Hunks <span className={`mg-count${open ? ' is-open' : ''}`}>{open ? `${open} to decide` : 'all decided'}</span></> : <>Rows <span className={`mg-count${open ? ' is-open' : ''}`}>{open ? `${open} to pick` : 'all picked'}</span></>}
              </button>
            )}
            <button type="button" className={`mg-pane-tab${leftTab === 'diff' ? ' is-on' : ''}`} onClick={() => setLeftTab('diff')}>
              <span className="mg-dot mg-dot--ours" />{c.ours.project} vs <span className="mg-dot mg-dot--theirs" />{c.theirs.project}
            </button>
          </div>
          <div className={`mg-pane-body${leftTab === 'diff' ? ' mg-pane-body--fill' : ''}`}>
            {leftTab === 'diff'
              ? <DiffEditorView original={c.ours.text} modified={c.theirs.text} language="sql" readOnly renderSideBySide={!mergeable} wordWrap height="100%" fontSize={12} />
              : c.kind === 'definition' ? hunks : rows}
          </div>
        </div>

        {/* right: the result */}
        {mergeable && (
          <div className="mg-pane mg-pane--result">
            <div className="mg-pane-tabs">
              <button type="button" className={`mg-pane-tab${rightTab === 'result' ? ' is-on' : ''}`} onClick={() => setRightTab('result')}>
                Result <span className={`mg-count${open ? ' is-open' : ' is-ok'}`}>{c.kind === 'definition' ? (hasMarkers(result) ? 'has conflict markers' : edited ? 'edited by hand' : 'merged') : open ? `${open} unpicked` : 'merged'}</span>
              </button>
              {preview && (
                <button type="button" className={`mg-pane-tab${rightTab === 'change' ? ' is-on' : ''}`} onClick={() => setRightTab('change')}>
                  <MergeIcon size={12} />{preview.sql?.changeName ?? 'Merge change'}
                </button>
              )}
              {rightTab === 'result' && edited && <button type="button" className="mg-link" onClick={() => setEdited(false)}>rebuild from the picks</button>}
              {rightTab === 'change' && preview?.sql && (
                <span className="mg-subtabs">
                  {(['deploy', 'verify', 'revert'] as const).map(t => (
                    <button key={t} type="button" className={`mg-tab${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>{t}.sql</button>
                  ))}
                </span>
              )}
            </div>
            <div className="mg-pane-body mg-pane-body--fill">
              {rightTab === 'change' ? (
                preview?.loading ? <LoaderView variant="dots" label="Building" center />
                  : preview?.error ? <div className="mg-banner mg-banner--bad"><WarningTriangleIcon size={16} /><span>{preview.error}</span></div>
                  : <EditorView key={tab} value={changeSql} language="sql" readOnly height="100%" fontSize={12} />
              ) : c.kind === 'definition' ? (
                <EditorView value={result} language="sql" height="100%" fontSize={12}
                  onChange={v => { if (v !== result) { setEdited(true); setResult(v); } }}
                  onEditorMount={(ed, mon) => markerDecorations(ed as MonacoEditor, mon as never, decoIds)} />
              ) : (
                <div className="mg-pane-scroll">{dataResult ?? <div className="mg-hint">{rowPicks['*'] ? `${rowPicks['*'] === 'ours' ? c.ours.project : c.theirs.project}'s values win where both write.` : 'Pick whose values win.'}</div>}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </ModalView>
  );
}
