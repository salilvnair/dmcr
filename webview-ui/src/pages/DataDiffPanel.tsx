import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRightIcon, ButtonView, CheckboxView, ComboBoxView, DatabaseTableIcon, EditorView, KeyIcon, KeyboardIcon, MinusIcon, PlusIcon, SelectInputView, SyncIcon, WarningTriangleIcon } from '@salilvnair/dui';
import { postMsg } from '../vscode';
import { usePagedRows } from '../components/BigList';
import './DataDiffPanel.css';

type Row = Record<string, string | null>;
type Changed = { key: Row; source: Row; target: Row; columns: string[] };
type Result = {
  table: string; sourceSchema: string; targetSchema: string;
  keyColumns: string[]; keyKind: 'primary' | 'unique' | 'chosen' | 'none'; tableKey: string[];
  columns: string[]; onlyInSourceColumns: string[]; onlyInTargetColumns: string[]; ignored: string[];
  sourceRows: number; targetRows: number; same: number;
  counts: { added: number; removed: number; changed: number };
  added: Row[]; removed: Row[]; changed: Changed[];
  complete: boolean; truncated: boolean; ms: number;
};
type Sql = { deploy: string; verify: string; revert: string };
type Side = { serverId: string; schema: string };
type View = 'changed' | 'added' | 'removed';

const ENV_PREFIX = 'dmcr-env-';
const n = (x: number) => x.toLocaleString();

type Props = { servers: { id: string; name: string; connAvailable: boolean }[]; onStep?: (step: number) => void };

/**
 * Data Diff: one table's rows on two databases (test vs prod), matched by primary key. What is only on one side
 * and what differs, column by column; then the change that makes the target match, to check and save in Manual.
 */
export default function DataDiffPanel({ servers, onStep }: Props) {
  const [src, setSrc] = useState<Side>({ serverId: '', schema: '' });
  const [tgt, setTgt] = useState<Side>({ serverId: '', schema: '' });
  const [schemas, setSchemas] = useState<Record<string, string[]>>({});
  const [tables, setTables] = useState<Record<string, { name: string; rows: number }[]>>({});
  const [metaError, setMetaError] = useState<Record<string, string>>({});
  const [table, setTable] = useState('');
  const [ignore, setIgnore] = useState<string[]>([]);
  /** match rows by this column instead of the table's key ('' = the key) */
  const [matchBy, setMatchBy] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [sync, setSync] = useState<{ withDeletes: Sql; keepExtra: Sql } | null>(null);
  const [view, setView] = useState<View>('changed');
  const [deletes, setDeletes] = useState(false);
  const [preview, setPreview] = useState(false);
  const [envSchema, setEnvSchema] = useState<Record<string, string>>({});
  const [prod, setProd] = useState('');

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: Record<string, unknown> };
      const p = m?.payload ?? {};
      switch (m?.type) {
        case 'dmcrConfig': {
          const envs = (p.envs as { name: string; schema?: string }[] | undefined) ?? [];
          setEnvSchema(Object.fromEntries(envs.map(x => [x.name, x.schema ?? ''])));
          setProd(String(p.production ?? ''));
          break;
        }
        case 'dataDiffMetaResult': {
          const sid = String(p.serverId);
          if (p.error) { setMetaError(x => ({ ...x, [sid]: String(p.error) })); break; }
          setMetaError(x => { const { [sid]: _, ...rest } = x; return rest; });
          setSchemas(x => ({ ...x, [sid]: (p.schemas as string[]) ?? [] }));
          if (p.schema && p.tables) setTables(x => ({ ...x, [`${sid}|${p.schema}`]: p.tables as { name: string; rows: number }[] }));
          break;
        }
        case 'dataDiffProgress': setProgress(String(p.text ?? '')); break;
        case 'dataDiffResult':
          setRunning(false); setProgress('');
          if (p.ok) {
            const r = p.result as Result;
            setResult(r); setSync((p.sync as typeof sync) ?? null); setError('');
            setView(r.counts.changed ? 'changed' : r.counts.added ? 'added' : r.counts.removed ? 'removed' : 'changed');
          } else { setError(String(p.error ?? 'The compare failed')); setResult(null); setSync(null); }
          break;
      }
    };
    window.addEventListener('message', on);
    postMsg({ type: 'getDmcrConfig' });
    return () => window.removeEventListener('message', on);
  }, []);

  // first visit: test → prod, each in its own schema (DMCR Config)
  useEffect(() => {
    if (src.serverId || tgt.serverId || !servers.length || !Object.keys(envSchema).length) return;
    const envServers = servers.filter(s => s.id.startsWith(ENV_PREFIX)).map(s => s.id.slice(ENV_PREFIX.length));
    const prodEnv = envServers.find(e => e === prod);
    const testEnv = envServers.find(e => e !== prod && /test|st|qa|dev/i.test(e)) ?? envServers.find(e => e !== prod);
    if (testEnv) pick('src', ENV_PREFIX + testEnv, envSchema[testEnv] ?? '');
    if (prodEnv) pick('tgt', ENV_PREFIX + prodEnv, envSchema[prodEnv] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers, envSchema, prod]);

  const pick = (side: 'src' | 'tgt', serverId: string, schema: string) => {
    (side === 'src' ? setSrc : setTgt)({ serverId, schema });
    setResult(null); setSync(null); setError('');
    if (serverId) postMsg({ type: 'dataDiffMeta', payload: { serverId, schema: schema || undefined } });
  };

  const label = (id: string) => (id.startsWith(ENV_PREFIX) ? id.slice(ENV_PREFIX.length) : servers.find(s => s.id === id)?.name ?? id);
  const srcName = label(src.serverId) || 'source', tgtName = label(tgt.serverId) || 'target';
  const srcTables = tables[`${src.serverId}|${src.schema}`];
  const tgtTables = tables[`${tgt.serverId}|${tgt.schema}`];
  const common = useMemo(() => {
    if (!srcTables || !tgtTables) return [];
    const t = new Map(tgtTables.map(x => [x.name, x.rows]));
    return srcTables.filter(x => t.has(x.name)).map(x => ({ value: x.name, label: x.name, hint: `~${n(x.rows)} · ~${n(t.get(x.name) ?? 0)} rows` }));
  }, [srcTables, tgtTables]);
  const oneSided = srcTables && tgtTables ? srcTables.length + tgtTables.length - 2 * common.length : 0;
  useEffect(() => { if (table && srcTables && tgtTables && !common.some(c => c.value === table)) setTable(''); }, [common, table, srcTables, tgtTables]);

  useEffect(() => { onStep?.(result ? 3 : table ? 2 : 1); }, [result, table, onStep]);
  const canRun = !!src.serverId && !!tgt.serverId && !!src.schema && !!tgt.schema && !!table && !running && !(src.serverId === tgt.serverId && src.schema === tgt.schema);
  const compare = (ign = ignore, by = matchBy) => {
    setRunning(true); setError(''); setProgress('Starting');
    postMsg({ type: 'compareTableData', payload: { sourceServerId: src.serverId, targetServerId: tgt.serverId, sourceSchema: src.schema, targetSchema: tgt.schema, table, ignore: ign, key: by ? [by] : undefined } });
  };
  const ignoreChanged = !!result && [...ignore].sort().join() !== [...result.ignored].sort().join();

  const sideCard = (side: 'src' | 'tgt') => {
    const s = side === 'src' ? src : tgt;
    const isProd = label(s.serverId) === prod && !!prod;
    return (
      <div className={`dd-side dd-side--${side}`}>
        <div className="dd-side-hd"><span className="dd-dot" />{side === 'src' ? 'Source' : 'Target'}{isProd && <span className="dd-prod">PROD</span>}</div>
        <SelectInputView size="md" width="100%" placeholder="Database"
          options={servers.map(x => ({ value: x.id, label: label(x.id) }))}
          value={s.serverId} onChange={id => pick(side, id, id.startsWith(ENV_PREFIX) ? envSchema[id.slice(ENV_PREFIX.length)] ?? '' : '')} />
        <SelectInputView size="md" width="100%" placeholder="Schema" disabled={!s.serverId}
          options={(schemas[s.serverId] ?? (s.schema ? [s.schema] : [])).map(x => ({ value: x, label: x }))}
          value={s.schema} onChange={schema => pick(side, s.serverId, schema)} />
        {metaError[s.serverId] && <div className="dd-err-sm"><WarningTriangleIcon size={11} />{metaError[s.serverId]}</div>}
      </div>
    );
  };

  return (
    <div className="dd">
      <section className="dd-card dd-pick">
        {sideCard('src')}
        <span className="dd-arrow"><ArrowRightIcon size={16} /></span>
        {sideCard('tgt')}
        <div className="dd-table">
          <div className="dd-side-hd"><DatabaseTableIcon size={13} />Table</div>
          <ComboBoxView size="md" width="fullWidth" options={common} value={table} onChange={v => { setTable(v); setIgnore([]); setMatchBy(''); setResult(null); setSync(null); }}
            placeholder={srcTables && tgtTables ? `${common.length} tables on both` : 'Pick both schemas first'} disabled={!common.length} />
          {oneSided > 0 && <div className="dd-note">{oneSided} table{oneSided === 1 ? '' : 's'} only on one side: Schema Diff shows those</div>}
        </div>
        <button type="button" className="dd-go" disabled={!canRun} onClick={() => compare()}>
          <SyncIcon size={15} />{running ? 'Comparing…' : 'Compare rows'}
          <small>{running ? progress : 'by primary key, read-only'}</small>
        </button>
      </section>

      {error && <div className="dd-error"><WarningTriangleIcon size={13} />{error}</div>}

      {result && <ResultView r={result} srcName={srcName} tgtName={tgtName} view={view} onView={setView}
        ignore={ignore} onIgnore={setIgnore} ignoreChanged={ignoreChanged} onRecompare={() => compare(ignore)} running={running}
        matchBy={matchBy} onMatchBy={by => { setMatchBy(by); compare(ignore.filter(c => c !== by), by); setIgnore(i => i.filter(c => c !== by)); }} />}

      {result && (result.counts.added + result.counts.changed + result.counts.removed > 0) && (
        <section className="dd-card dd-sync">
          <div className="dd-sync-hd">
            <span className="dd-sync-icon"><SyncIcon size={18} /></span>
            <div>
              <h3>Make {tgtName} match {srcName}</h3>
              <p>A change that inserts {n(result.counts.added)}, updates {n(result.counts.changed)}{deletes ? <>, deletes {n(result.counts.removed)}</> : null} row{result.counts.added + result.counts.changed === 1 ? '' : 's'} in <code>{result.table}</code>, with its exact revert and a verify. It opens in Manual: self-check it, then save it like any other change.</p>
            </div>
          </div>
          {sync ? (
            <>
              <div className="dd-sync-row">
                <CheckboxView size="md" checked={deletes} onChange={setDeletes} disabled={!result.counts.removed}
                  label={result.counts.removed ? `Also delete the ${n(result.counts.removed)} row${result.counts.removed === 1 ? '' : 's'} only on ${tgtName}` : `Nothing only on ${tgtName}`} />
                <ButtonView variant="ghost" size="md" label={preview ? 'Hide SQL' : 'Preview SQL'} onClick={() => setPreview(v => !v)} style={{ marginLeft: 'auto' }} />
                <button type="button" className="dd-go dd-go--inline" onClick={() => {
                  const s = deletes ? sync.withDeletes : sync.keepExtra;
                  postMsg({ type: 'openFormWithPrefill', payload: { form: 'manual', manual: { name: `sync_${result.table}_data`, ...s, tags: 'data-sync' } } });
                }}><KeyboardIcon size={14} />Open in Manual</button>
              </div>
              {preview && (
                <div className="dd-preview">
                  <EditorView value={(deletes ? sync.withDeletes : sync.keepExtra).deploy} language="sql" height="260px" fontSize={12} readOnly editorOptions={{ minimap: false, scrollBeyondLastLine: false }} />
                </div>
              )}
            </>
          ) : (
            <div className="dd-note dd-note--warn"><WarningTriangleIcon size={12} />
              {result.truncated ? `The table has more rows than DMCR reads (${n(200000)} a side): compare a smaller table, or ignore it here.` : 'More than 1,000 rows of one kind differ: the change would be too big to read. Write it in Freeform or Manual instead.'}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ResultView({ r, srcName, tgtName, view, onView, ignore, onIgnore, ignoreChanged, onRecompare, running, matchBy, onMatchBy }: {
  r: Result; srcName: string; tgtName: string; view: View; onView: (v: View) => void;
  ignore: string[]; onIgnore: (v: string[]) => void; ignoreChanged: boolean; onRecompare: () => void; running: boolean;
  matchBy: string; onMatchBy: (col: string) => void;
}) {
  const allCols = [...new Set([...r.keyColumns, ...r.columns, ...r.ignored])];
  const tiles: { v: View | 'same'; label: string; count: number; icon: ReactNode }[] = [
    { v: 'same', label: 'Same on both', count: r.same, icon: <span className="dd-eq">=</span> },
    { v: 'changed', label: 'Different values', count: r.counts.changed, icon: <SyncIcon size={14} /> },
    { v: 'added', label: `Only on ${srcName}`, count: r.counts.added, icon: <PlusIcon size={14} /> },
    { v: 'removed', label: `Only on ${tgtName}`, count: r.counts.removed, icon: <MinusIcon size={14} /> },
  ];
  const keyless = r.keyKind === 'none';
  const allSame = !r.counts.added && !r.counts.removed && !r.counts.changed;
  const toggleIgnore = (c: string) => onIgnore(ignore.includes(c) ? ignore.filter(x => x !== c) : [...ignore, c]);

  return (
    <section className="dd-card dd-result">
      <div className="dd-res-hd">
        <span className="dd-chip dd-chip--src">{srcName} · {r.sourceSchema}.{r.table}</span>
        <ArrowRightIcon size={12} />
        <span className="dd-chip dd-chip--tgt">{tgtName} · {r.targetSchema}.{r.table}</span>
        <span className="dd-key">{keyless ? <><WarningTriangleIcon size={11} />no key: whole rows compared</> : <><KeyIcon size={11} />{r.keyKind === 'primary' ? 'primary key' : r.keyKind === 'unique' ? 'unique key' : 'matched by'} {r.keyColumns.join(', ')}</>}</span>
        <span className="dd-match">
          <span>Match rows by</span>
          <SelectInputView size="md" value={matchBy} onChange={onMatchBy} disabled={running} menuMinWidth={200}
            options={[{ value: '', label: r.tableKey.length ? `Table key (${r.tableKey.join(', ')})` : 'Whole row (no key)' }, ...allCols.filter(c => r.tableKey.join() !== c).map(c => ({ value: c, label: c }))]} />
        </span>
        <span className="dd-meta">{n(r.sourceRows)} · {n(r.targetRows)} rows · {(r.ms / 1000).toFixed(1)}s</span>
      </div>

      <div className="dd-tiles">
        {tiles.map(t => (
          <button key={t.v} type="button" disabled={t.v === 'same' || !t.count || (keyless && t.v === 'changed')}
            className={`dd-tile dd-tile--${t.v}${view === t.v ? ' is-on' : ''}`} onClick={() => t.v !== 'same' && onView(t.v)}>
            <span className="dd-tile-icon">{t.icon}</span>
            <b>{n(t.count)}</b><span>{t.label}</span>
          </button>
        ))}
      </div>

      {(r.onlyInSourceColumns.length > 0 || r.onlyInTargetColumns.length > 0 || r.truncated) && (
        <div className="dd-notes">
          {r.onlyInSourceColumns.length > 0 && <div className="dd-note"><WarningTriangleIcon size={12} />Columns only on {srcName}, not compared: <code>{r.onlyInSourceColumns.join(', ')}</code></div>}
          {r.onlyInTargetColumns.length > 0 && <div className="dd-note"><WarningTriangleIcon size={12} />Columns only on {tgtName}, not compared: <code>{r.onlyInTargetColumns.join(', ')}</code></div>}
          {r.truncated && <div className="dd-note dd-note--warn"><WarningTriangleIcon size={12} />Read the first {n(200000)} rows of a side only</div>}
        </div>
      )}

      <div className="dd-ignore">
        <span className="dd-ignore-lbl">Compare columns</span>
        {allCols.filter(c => !r.keyColumns.includes(c)).map(c => (
          <button key={c} type="button" className={`dd-col${ignore.includes(c) ? ' is-off' : ''}`} onClick={() => toggleIgnore(c)} title={ignore.includes(c) ? 'Ignored: click to compare it again' : 'Click to ignore it (e.g. updated_at)'}>{c}</button>
        ))}
        {ignoreChanged && <ButtonView variant="secondary" size="md" iconLeft={<SyncIcon size={12} />} label="Compare again" loading={running} onClick={onRecompare} />}
      </div>

      {allSame ? (
        <div className="dd-same"><span className="dd-eq dd-eq--big">=</span>Every row matches{r.ignored.length ? <> (ignoring {r.ignored.join(', ')})</> : null}.</div>
      ) : (
        <Rows r={r} view={view} srcName={srcName} tgtName={tgtName} />
      )}
    </section>
  );
}

function Rows({ r, view, srcName, tgtName }: { r: Result; view: View; srcName: string; tgtName: string }) {
  const keyCols = r.keyColumns.length ? r.keyColumns : [];
  const list: (Row | Changed)[] = view === 'changed' ? r.changed : view === 'added' ? r.added : r.removed;
  const idOf = (x: Row | Changed) => Object.values('key' in x && 'source' in x ? { ...(x as Changed).key, ...(x as Changed).source } : x as Row).map(v => v ?? '').join(' ');
  const { rows, bar, more } = usePagedRows(list, idOf, [], 50, 'rows', 'Search the rows');
  const shownOf = view === 'changed' ? r.counts.changed : view === 'added' ? r.counts.added : r.counts.removed;
  const cell = (v: string | null) => (v == null ? <span className="dd-null">NULL</span> : v === '' ? <span className="dd-null">''</span> : v);

  if (view === 'changed') {
    // only the columns that differ somewhere, after the key
    const diffCols = r.columns.filter(c => !keyCols.includes(c) && r.changed.some(x => x.columns.includes(c)));
    return (
      <div className="dd-rows">
        {bar}
        {shownOf > list.length && <div className="dd-note">Showing the first {n(list.length)} of {n(shownOf)}</div>}
        <div className="dd-scroll">
          <table className="dd-grid">
            <thead><tr>{keyCols.map(k => <th key={k} className="is-key"><KeyIcon size={10} />{k}</th>)}{diffCols.map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {(rows as Changed[]).map((x, i) => (
                <tr key={i}>
                  {keyCols.map(k => <td key={k} className="is-key">{cell(x.key[k])}</td>)}
                  {diffCols.map(c => x.columns.includes(c) ? (
                    <td key={c} className="is-diff">
                      <div className="dd-new" title={`on ${srcName}`}>{cell(x.source[c])}</div>
                      <div className="dd-old" title={`on ${tgtName}`}>{cell(x.target[c])}</div>
                    </td>
                  ) : <td key={c} className="is-dim">{cell(x.source[c])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dd-legend"><span className="dd-new">{srcName}</span><span className="dd-old">{tgtName}</span></div>
        {more}
      </div>
    );
  }
  const cols = [...keyCols, ...r.columns.filter(c => !keyCols.includes(c))];
  return (
    <div className={`dd-rows dd-rows--${view}`}>
      {bar}
      {shownOf > list.length && <div className="dd-note">Showing the first {n(list.length)} of {n(shownOf)}</div>}
      <div className="dd-scroll">
        <table className="dd-grid">
          <thead><tr><th className="dd-sign" />{cols.map(c => <th key={c} className={keyCols.includes(c) ? 'is-key' : ''}>{keyCols.includes(c) && <KeyIcon size={10} />}{c}</th>)}</tr></thead>
          <tbody>
            {(rows as Row[]).map((x, i) => (
              <tr key={i}>
                <td className="dd-sign">{view === 'added' ? <PlusIcon size={11} /> : <MinusIcon size={11} />}</td>
                {cols.map(c => <td key={c} className={keyCols.includes(c) ? 'is-key' : ''}>{cell(x[c])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more}
    </div>
  );
}
