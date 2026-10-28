import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRightIcon, ButtonView, CheckboxView, DatabaseTableIcon, EditorView, EyeIcon, KeyIcon, KeyboardIcon, MinusIcon, PlusIcon, RefreshIcon, SearchInputView, SelectInputView, SpinnerIcon, SyncIcon, WarningTriangleIcon } from '@salilvnair/dui';
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
/** pg_class.reltuples: an estimate, 0 or -1 until the table is analyzed (then not shown) */
const est = (x: number) => (x > 0 ? `~${n(x)}` : '');

type Props = { servers: { id: string; name: string; connAvailable: boolean }[]; onStep?: (step: number) => void };

/**
 * Data Diff: one table's rows on two databases (test vs prod), matched by primary key. The databases on top, the
 * tables on both down the left; pick one and its rows are compared: what is only on one side and what differs,
 * column by column. Then the change that makes the target match, to check and save in Manual.
 */
export default function DataDiffPanel({ servers, onStep }: Props) {
  const [src, setSrc] = useState<Side>({ serverId: '', schema: '' });
  const [tgt, setTgt] = useState<Side>({ serverId: '', schema: '' });
  const [schemas, setSchemas] = useState<Record<string, string[]>>({});
  const [tables, setTables] = useState<Record<string, { name: string; rows: number }[]>>({});
  const [metaError, setMetaError] = useState<Record<string, string>>({});
  const [table, setTable] = useState('');
  const [query, setQuery] = useState('');
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
    return srcTables.filter(x => t.has(x.name)).map(x => ({ name: x.name, src: x.rows, tgt: t.get(x.name) ?? 0 }));
  }, [srcTables, tgtTables]);
  const shown = common.filter(t => t.name.toLowerCase().includes(query.trim().toLowerCase()));
  const oneSided = srcTables && tgtTables ? srcTables.length + tgtTables.length - 2 * common.length : 0;
  useEffect(() => { if (table && srcTables && tgtTables && !common.some(c => c.name === table)) { setTable(''); setResult(null); } }, [common, table, srcTables, tgtTables]);

  useEffect(() => { onStep?.(result ? 3 : table ? 2 : 1); }, [result, table, onStep]);
  const sameSide = !!src.serverId && src.serverId === tgt.serverId && src.schema === tgt.schema;
  const ready = !!src.serverId && !!tgt.serverId && !!src.schema && !!tgt.schema && !sameSide;
  const compare = (t = table, ign = ignore, by = matchBy) => {
    if (!ready || !t) return;
    setRunning(true); setError(''); setProgress('Starting');
    postMsg({ type: 'compareTableData', payload: { sourceServerId: src.serverId, targetServerId: tgt.serverId, sourceSchema: src.schema, targetSchema: tgt.schema, table: t, ignore: ign, key: by ? [by] : undefined } });
  };
  // a table is compared as soon as you pick it: it only reads
  const open = (t: string) => {
    if (running) return;
    setTable(t); setIgnore([]); setMatchBy(''); setResult(null); setSync(null); setDeletes(false); setPreview(false);
    compare(t, [], '');
  };
  const ignoreChanged = !!result && [...ignore].sort().join() !== [...result.ignored].sort().join();

  const lane = (side: 'src' | 'tgt') => {
    const s = side === 'src' ? src : tgt;
    const isProd = label(s.serverId) === prod && !!prod;
    return (
      <div className={`dd-lane dd-lane--${side}`}>
        <span className="dd-lane-lbl"><span className="dd-dot" />{side === 'src' ? 'Source' : 'Target'}</span>
        <SelectInputView size="md" width="100%" placeholder="Database"
          options={servers.map(x => ({ value: x.id, label: label(x.id) }))}
          value={s.serverId} onChange={id => pick(side, id, id.startsWith(ENV_PREFIX) ? envSchema[id.slice(ENV_PREFIX.length)] ?? '' : '')} />
        <SelectInputView size="md" width="100%" placeholder="Schema" disabled={!s.serverId}
          options={(schemas[s.serverId] ?? (s.schema ? [s.schema] : [])).map(x => ({ value: x, label: x }))}
          value={s.schema} onChange={schema => pick(side, s.serverId, schema)} />
        {isProd && <span className="dd-prod">PROD</span>}
        {metaError[s.serverId] && <span className="dd-lane-err" title={metaError[s.serverId]}><WarningTriangleIcon size={12} /></span>}
      </div>
    );
  };

  let main: ReactNode;
  if (running) {
    main = (
      <div className="dd-state">
        <span className="dd-state-icon dd-spin"><SpinnerIcon size={22} /></span>
        <h3>Comparing <code>{table}</code></h3>
        <p>{progress || 'Starting'}</p>
      </div>
    );
  } else if (error) {
    main = (
      <div className="dd-state dd-state--err">
        <span className="dd-state-icon"><WarningTriangleIcon size={22} /></span>
        <h3>The compare failed</h3>
        <p>{error}</p>
        {table && <ButtonView variant="secondary" size="md" iconLeft={<RefreshIcon size={12} />} label="Try again" onClick={() => compare()} />}
      </div>
    );
  } else if (result) {
    main = (
      <ResultView r={result} srcName={srcName} tgtName={tgtName} view={view} onView={setView}
        ignore={ignore} onIgnore={setIgnore} ignoreChanged={ignoreChanged} onRecompare={() => compare()} running={running}
        matchBy={matchBy} onMatchBy={by => { const ign = ignore.filter(c => c !== by); setMatchBy(by); setIgnore(ign); compare(table, ign, by); }}
        sync={result.counts.added + result.counts.changed + result.counts.removed > 0 ? (
          <SyncCard r={result} sync={sync} srcName={srcName} tgtName={tgtName} deletes={deletes} onDeletes={setDeletes} preview={preview} onPreview={setPreview} />
        ) : null} />
    );
  } else {
    main = (
      <div className="dd-state">
        <CompareArt />
        <h3>{!ready ? (sameSide ? 'Source and target are the same' : 'Pick the two databases') : common.length ? 'Pick a table' : 'No table is on both sides'}</h3>
        <p>{!ready ? 'Choose a database and schema on each side, above.' : common.length
          ? <>Its rows on <b className="dd-c-src">{srcName}</b> and <b className="dd-c-tgt">{tgtName}</b> are matched by primary key: you see what is only on one side and which values differ.</>
          : 'Schema Diff shows the tables that are only on one side.'}</p>
        <ul className="dd-facts">
          <li><EyeIcon size={13} />Read-only: nothing is changed</li>
          <li><KeyIcon size={13} />Matched by primary key, or any column you pick</li>
          <li><KeyboardIcon size={13} />One click writes the change that makes {tgtName} match</li>
        </ul>
      </div>
    );
  }

  return (
    <div className="dd">
      <section className="dd-conn">
        {lane('src')}
        <span className="dd-arrow"><ArrowRightIcon size={14} /></span>
        {lane('tgt')}
      </section>

      <div className="dd-body">
        <aside className="dd-tables">
          <div className="dd-tables-hd">
            <DatabaseTableIcon size={13} />Tables on both
            {srcTables && tgtTables && <span className="dd-count">{common.length}</span>}
          </div>
          <SearchInputView size="md" value={query} onChange={setQuery} placeholder="Find a table" disabled={!common.length} />
          <div className="dd-tables-list">
            {!ready ? <div className="dd-tables-empty">Pick both databases</div>
              : !srcTables || !tgtTables ? <div className="dd-tables-empty"><span className="dd-spin"><SpinnerIcon size={14} /></span>Reading the tables</div>
              : !shown.length ? <div className="dd-tables-empty">{common.length ? 'No table matches' : 'None'}</div>
              : shown.map(t => (
                <button key={t.name} type="button" className={`dd-titem${t.name === table ? ' is-on' : ''}`} disabled={running && t.name !== table} onClick={() => open(t.name)}>
                  <DatabaseTableIcon size={13} />
                  <span className="dd-tname">{t.name}</span>
                  {(t.src > 0 || t.tgt > 0) ? (
                    <span className="dd-trows" title={`about ${n(Math.max(t.src, 0))} rows on ${srcName}, ${n(Math.max(t.tgt, 0))} on ${tgtName}`}>
                      <span className="dd-c-src">{est(t.src) || '~0'}</span><span className="dd-c-tgt">{est(t.tgt) || '~0'}</span>
                    </span>
                  ) : <span />}
                </button>
              ))}
          </div>
          {oneSided > 0 && <div className="dd-tables-ft">{oneSided} table{oneSided === 1 ? ' is' : 's are'} only on one side: Schema Diff shows {oneSided === 1 ? 'it' : 'them'}</div>}
        </aside>

        <main className="dd-main">{main}</main>
      </div>
    </div>
  );
}

/** two small tables, rows paired across: what the page does, drawn */
function CompareArt() {
  const rows = [0, 1, 2, 3];
  return (
    <svg className="dd-art" width="200" height="96" viewBox="0 0 200 96" aria-hidden>
      {[{ x: 4, c: 'var(--dd-src)' }, { x: 128, c: 'var(--dd-tgt)' }].map(({ x, c }, s) => (
        <g key={s}>
          <rect x={x} y="4" width="68" height="88" rx="8" fill="none" stroke={c} strokeOpacity="0.55" />
          <rect x={x} y="4" width="68" height="16" rx="8" fill={c} fillOpacity="0.22" />
          {rows.map(i => <rect key={i} x={x + 8} y={28 + i * 16} width={i === 2 ? 34 : 52} height="7" rx="3.5" fill={c} fillOpacity={s === 1 && i === 2 ? 0.95 : 0.35} />)}
        </g>
      ))}
      {rows.map(i => <line key={i} x1="76" x2="124" y1={31.5 + i * 16} y2={31.5 + i * 16} stroke={i === 2 ? 'var(--dd-chg)' : 'var(--dd-line)'} strokeDasharray={i === 2 ? '0' : '3 4'} strokeWidth={i === 2 ? 1.6 : 1} />)}
      <circle cx="100" cy="63.5" r="7" fill="var(--dd-chg)" />
      <path d="M97 63.5h6M100 60.5v6" stroke="var(--dd-bg)" strokeWidth="1.6" strokeLinecap="round" transform="rotate(45 100 63.5)" />
    </svg>
  );
}

function SyncCard({ r, sync, srcName, tgtName, deletes, onDeletes, preview, onPreview }: {
  r: Result; sync: { withDeletes: Sql; keepExtra: Sql } | null; srcName: string; tgtName: string;
  deletes: boolean; onDeletes: (v: boolean) => void; preview: boolean; onPreview: (v: boolean) => void;
}) {
  const sql = sync ? (deletes ? sync.withDeletes : sync.keepExtra) : null;
  return (
    <section className="dd-sync">
      <div className="dd-sync-hd">
        <span className="dd-sync-icon"><SyncIcon size={16} /></span>
        <div className="dd-sync-txt">
          <h3>Make {tgtName} match {srcName}</h3>
          <p>Inserts {n(r.counts.added)}, updates {n(r.counts.changed)}{deletes ? <>, deletes {n(r.counts.removed)}</> : null} in <code>{r.table}</code>, with its exact revert and a verify. Opens in Manual to self-check and save.</p>
        </div>
        {sql && (
          <div className="dd-sync-actions">
            <ButtonView variant="ghost" size="md" iconLeft={<EyeIcon size={12} />} label={preview ? 'Hide SQL' : 'Preview SQL'} onClick={() => onPreview(!preview)} />
            <button type="button" className="dd-btn dd-btn--green" onClick={() =>
              postMsg({ type: 'openFormWithPrefill', payload: { form: 'manual', manual: { name: `sync_${r.table}_data`, ...sql, tags: 'data-sync' } } })}>
              <KeyboardIcon size={13} />Open in Manual
            </button>
          </div>
        )}
      </div>
      {sql ? (
        <>
          <CheckboxView size="md" checked={deletes} onChange={onDeletes} disabled={!r.counts.removed}
            label={r.counts.removed ? `Also delete the ${n(r.counts.removed)} row${r.counts.removed === 1 ? '' : 's'} only on ${tgtName}` : `Nothing is only on ${tgtName}`} />
          {preview && (
            <div className="dd-preview">
              <EditorView value={sql.deploy} language="sql" height="260px" fontSize={12} readOnly editorOptions={{ minimap: false, scrollBeyondLastLine: false }} />
            </div>
          )}
        </>
      ) : (
        <div className="dd-note dd-note--warn"><WarningTriangleIcon size={12} />
          {r.truncated ? `The table has more rows than DMCR reads (${n(200000)} a side): the change is not written.` : 'More than 1,000 rows of one kind differ: the change would be too big to read. Write it in Freeform or Manual instead.'}
        </div>
      )}
    </section>
  );
}

function ResultView({ r, srcName, tgtName, view, onView, ignore, onIgnore, ignoreChanged, onRecompare, running, matchBy, onMatchBy, sync }: {
  r: Result; srcName: string; tgtName: string; view: View; onView: (v: View) => void;
  ignore: string[]; onIgnore: (v: string[]) => void; ignoreChanged: boolean; onRecompare: () => void; running: boolean;
  matchBy: string; onMatchBy: (col: string) => void; sync: ReactNode;
}) {
  const allCols = [...new Set([...r.keyColumns, ...r.columns, ...r.ignored])];
  const keyless = r.keyKind === 'none';
  const tiles: { v: View | 'same'; label: string; count: number; icon: ReactNode }[] = [
    { v: 'same', label: 'Same on both', count: r.same, icon: <span className="dd-eq">=</span> },
    { v: 'changed', label: 'Different values', count: r.counts.changed, icon: <SyncIcon size={14} /> },
    { v: 'added', label: `Only on ${srcName}`, count: r.counts.added, icon: <PlusIcon size={14} /> },
    { v: 'removed', label: `Only on ${tgtName}`, count: r.counts.removed, icon: <MinusIcon size={14} /> },
  ];
  const allSame = !r.counts.added && !r.counts.removed && !r.counts.changed;
  const toggleIgnore = (c: string) => onIgnore(ignore.includes(c) ? ignore.filter(x => x !== c) : [...ignore, c]);

  return (
    <div className="dd-result">
      <div className="dd-res-hd">
        <span className="dd-res-icon"><DatabaseTableIcon size={16} /></span>
        <div className="dd-res-title">
          <h2>{r.table}</h2>
          <span className="dd-res-sub">
            <span className="dd-c-src">{srcName} · {r.sourceSchema}</span><ArrowRightIcon size={10} /><span className="dd-c-tgt">{tgtName} · {r.targetSchema}</span>
            <span className="dd-sep" />{n(r.sourceRows)} · {n(r.targetRows)} rows<span className="dd-sep" />{(r.ms / 1000).toFixed(1)}s
          </span>
        </div>
        <div className="dd-res-tools">
          <span className="dd-key">{keyless ? <><WarningTriangleIcon size={11} />No key</> : <><KeyIcon size={11} />Match by</>}</span>
          <SelectInputView size="md" value={matchBy} onChange={onMatchBy} disabled={running} width={210} menuMinWidth={210}
            options={[{ value: '', label: r.tableKey.length ? `${r.tableKey.join(', ')} (table key)` : 'Whole row (no key)' }, ...allCols.filter(c => r.tableKey.join() !== c).map(c => ({ value: c, label: c }))]} />
          <ButtonView variant="secondary" size="md" iconLeft={<RefreshIcon size={12} />} label="Compare again" loading={running} onClick={onRecompare} />
        </div>
      </div>

      <div className="dd-tiles">
        {tiles.map(t => (
          <button key={t.v} type="button" disabled={t.v === 'same' || !t.count || (keyless && t.v === 'changed')}
            className={`dd-tile dd-tile--${t.v}${view === t.v && t.count ? ' is-on' : ''}`} onClick={() => t.v !== 'same' && onView(t.v)}>
            <span className="dd-tile-icon">{t.icon}</span>
            <b>{n(t.count)}</b><span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="dd-cols">
        <span className="dd-cols-lbl">Columns</span>
        {allCols.filter(c => !r.keyColumns.includes(c)).map(c => (
          <button key={c} type="button" className={`dd-col${ignore.includes(c) ? ' is-off' : ''}`} onClick={() => toggleIgnore(c)}
            title={ignore.includes(c) ? 'Ignored: click to compare it again' : 'Click to ignore it (e.g. updated_at)'}>{c}</button>
        ))}
        {ignoreChanged && <span className="dd-cols-hint">Compare again to apply</span>}
      </div>

      {(r.onlyInSourceColumns.length > 0 || r.onlyInTargetColumns.length > 0 || r.truncated) && (
        <div className="dd-notes">
          {r.onlyInSourceColumns.length > 0 && <div className="dd-note"><WarningTriangleIcon size={12} />Only on {srcName}, not compared: <code>{r.onlyInSourceColumns.join(', ')}</code></div>}
          {r.onlyInTargetColumns.length > 0 && <div className="dd-note"><WarningTriangleIcon size={12} />Only on {tgtName}, not compared: <code>{r.onlyInTargetColumns.join(', ')}</code></div>}
          {r.truncated && <div className="dd-note dd-note--warn"><WarningTriangleIcon size={12} />Read the first {n(200000)} rows of a side only</div>}
        </div>
      )}

      {sync}

      {allSame ? (
        <div className="dd-same"><span className="dd-eq dd-eq--big">=</span>Every row matches{r.ignored.length ? <> (ignoring {r.ignored.join(', ')})</> : null}.</div>
      ) : (
        <Rows r={r} view={view} srcName={srcName} tgtName={tgtName} />
      )}
    </div>
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
        <div className="dd-rows-bar">{bar}<span className="dd-legend"><span className="dd-new">{srcName}</span><span className="dd-old">{tgtName}</span></span></div>
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
        {more}
      </div>
    );
  }
  const cols = [...keyCols, ...r.columns.filter(c => !keyCols.includes(c))];
  return (
    <div className={`dd-rows dd-rows--${view}`}>
      <div className="dd-rows-bar">{bar}</div>
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
