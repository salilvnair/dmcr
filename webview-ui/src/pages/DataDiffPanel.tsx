import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRightIcon, ButtonView, CheckboxView, ChecklistIcon, CloseIcon, ChevronDownIcon, ChevronRightIcon, CodeBracketsIcon, DatabaseTableIcon, DiffEditorView, EditorView, IconButtonView, EyeIcon, FolderIcon, FolderOpenIcon, HashIcon, KeyIcon, KeyboardIcon, LayersIcon, ModalView, MinusIcon, PlusIcon, RefreshIcon, SearchInputView, SelectInputView, SpinnerIcon, SplitPanelView, SyncIcon, TextInputView, VirtualizedListView, WarningTriangleIcon } from '@salilvnair/dui';
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
type SeqState = { last_value: string; is_called: boolean; start_value: string; increment_by: string; min_value: string; max_value: string; cycle: boolean };
type SeqResult = { kind: 'sequence'; sequence: string; sourceSchema: string; targetSchema: string; source: SeqState; target: SeqState; differs: (keyof SeqState)[]; sourceAhead: boolean; ms: number };
type FnState = { definition: string; result: string };
type FnResult = { kind: 'function'; function: string; sourceSchema: string; targetSchema: string; source: FnState; target: FnState; same: boolean; resultDiffers: boolean; ms: number };
type Sql = { deploy: string; verify: string; revert: string };
type Kind = 'table' | 'view' | 'matview' | 'sequence' | 'function';
type Obj = { name: string; kind: Kind; rows: number };
/** one line of the tree: a folder, or an object in it (on both sides, or only on one) */
type Line = { folder: Kind; count: number; open: boolean } | { obj: Obj; tgtRows: number; only?: 'src' | 'tgt' };
type Side = { serverId: string; schema: string };
type View = 'changed' | 'added' | 'removed';

const ENV_PREFIX = 'dmcr-env-';
const FOLDERS: { kind: Kind; label: string; icon: (size: number) => ReactNode }[] = [
  { kind: 'table', label: 'Tables', icon: z => <DatabaseTableIcon size={z} /> },
  { kind: 'view', label: 'Views', icon: z => <EyeIcon size={z} /> },
  { kind: 'matview', label: 'Materialized views', icon: z => <LayersIcon size={z} /> },
  { kind: 'sequence', label: 'Sequences', icon: z => <HashIcon size={z} /> },
  { kind: 'function', label: 'Functions', icon: z => <CodeBracketsIcon size={z} /> },
];
const ALL_KINDS: Kind[] = ['table', 'view', 'matview', 'sequence', 'function'];
/** an object in the sync list */
const itemKey = (o: { kind: Kind; name: string }) => `${o.kind}|${o.name}`;
const ROW_H = 30;
/** where you left the divider between the tree and the rows (per browser) */
const SPLIT_KEY = 'dmcr.datadiff.split';
const savedSplit = (): number => { try { const v = Number(localStorage.getItem(SPLIT_KEY)); return v > 10 && v < 60 ? v : 22; } catch { return 22; } };
/** which folders of the tree you closed (per browser); a kind added later starts open */
const CLOSED_KEY = 'dmcr.datadiff.closed';
const savedClosed = (): Kind[] => { try { const v = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const n = (x: number) => x.toLocaleString();
/** pg_class.reltuples: an estimate, 0 or -1 until the table is analyzed (then not shown) */
const est = (x: number) => (x > 0 ? `~${n(x)}` : '');

type Props = { servers: { id: string; name: string; connAvailable: boolean }[] };

/**
 * Data Diff: one table's rows on two databases (test vs prod), matched by primary key. The databases on top, the
 * tables on both down the left; pick one and its rows are compared: what is only on one side and what differs,
 * column by column. Then the change that makes the target match, to check and save in Manual.
 */
export default function DataDiffPanel({ servers }: Props) {
  const [src, setSrc] = useState<Side>({ serverId: '', schema: '' });
  const [tgt, setTgt] = useState<Side>({ serverId: '', schema: '' });
  const [schemas, setSchemas] = useState<Record<string, string[]>>({});
  const [tables, setTables] = useState<Record<string, Obj[]>>({});
  const [metaError, setMetaError] = useState<Record<string, string>>({});
  const [table, setTable] = useState('');
  const [kind, setKind] = useState<Kind>('table');
  const [closedFolders, setClosedFolders] = useState<Kind[]>(savedClosed);
  const [query, setQuery] = useState('');
  const [ignore, setIgnore] = useState<string[]>([]);
  /** match rows by this column instead of the table's key ('' = the key) */
  const [matchBy, setMatchBy] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [seq, setSeq] = useState<SeqResult | null>(null);
  const [fn, setFn] = useState<FnResult | null>(null);
  /** what you sync (lookup tables, sequences, functions): the tree shows only these; null until read */
  const [syncList, setSyncList] = useState<string[] | null>(null);
  /** the popup where you type what is in the sync list */
  const [editing, setEditing] = useState(false);
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
          if (p.schema && p.tables) setTables(x => ({ ...x, [`${sid}|${p.schema}`]: (p.tables as Obj[]).map(o => ({ ...o, kind: o.kind ?? 'table' })) }));
          break;
        }
        case 'dataSyncList': setSyncList((p.items as string[]) ?? []); break;
        case 'dataDiffProgress': setProgress(String(p.text ?? '')); break;
        case 'dataDiffResult':
          setRunning(false); setProgress('');
          if (p.ok && (p.result as SeqResult).kind === 'sequence') { setSeq(p.result as SeqResult); setFn(null); setResult(null); setSync((p.sync as typeof sync) ?? null); setError(''); }
          else if (p.ok && (p.result as FnResult).kind === 'function') { setFn(p.result as FnResult); setSeq(null); setResult(null); setSync((p.sync as typeof sync) ?? null); setError(''); }
          else if (p.ok) {
            const r = p.result as Result;
            setSeq(null); setFn(null);
            setResult(r); setSync((p.sync as typeof sync) ?? null); setError('');
            setView(r.counts.changed ? 'changed' : r.counts.added ? 'added' : r.counts.removed ? 'removed' : 'changed');
          } else { setError(String(p.error ?? 'The compare failed')); setResult(null); setSeq(null); setFn(null); setSync(null); }
          break;
      }
    };
    window.addEventListener('message', on);
    postMsg({ type: 'getDmcrConfig' });
    postMsg({ type: 'getDataSyncList' });
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
    setResult(null); setSeq(null); setFn(null); setSync(null); setError('');
    if (serverId) postMsg({ type: 'dataDiffMeta', payload: { serverId, schema: schema || undefined } });
  };

  const label = (id: string) => (id.startsWith(ENV_PREFIX) ? id.slice(ENV_PREFIX.length) : servers.find(s => s.id === id)?.name ?? id);
  const srcName = label(src.serverId) || 'source', tgtName = label(tgt.serverId) || 'target';
  const srcTables = tables[`${src.serverId}|${src.schema}`];
  const tgtTables = tables[`${tgt.serverId}|${tgt.schema}`];
  // both sides by kind and name; what is only on one side is listed too, dimmed (Schema Diff makes those)
  const listed = useMemo(() => new Set(syncList ?? []), [syncList]);
  const lines = useMemo(() => {
    if (!srcTables || !tgtTables) return { all: [] as Line[], both: 0, oneSided: 0 };
    const q = query.trim().toLowerCase();
    const inList = syncFilter(syncList ?? []);
    const t = new Map(tgtTables.map(x => [`${x.kind}|${x.name}`, x]));
    const sk = new Set(srcTables.map(x => `${x.kind}|${x.name}`));
    const all: Line[] = [];
    let both = 0, oneSided = 0;
    for (const f of FOLDERS) {
      const items: { obj: Obj; tgtRows: number; only?: 'src' | 'tgt' }[] = [
        ...srcTables.filter(x => x.kind === f.kind).map(x => { const tt = t.get(`${x.kind}|${x.name}`); return { obj: x, tgtRows: tt?.rows ?? 0, only: tt ? undefined : 'src' as const }; }),
        ...tgtTables.filter(x => x.kind === f.kind && !sk.has(`${x.kind}|${x.name}`)).map(x => ({ obj: { ...x, rows: 0 }, tgtRows: x.rows, only: 'tgt' as const })),
      ].filter(x => inList(x.obj)).sort((x, y) => x.obj.name.localeCompare(y.obj.name));
      both += items.filter(x => !x.only).length; oneSided += items.filter(x => x.only).length;
      const shown = q ? items.filter(x => x.obj.name.toLowerCase().includes(q)) : items;
      if (!shown.length) continue;
      const open = !!q || !closedFolders.includes(f.kind);
      all.push({ folder: f.kind, count: shown.length, open });
      if (open) all.push(...shown);
    }
    return { all, both, oneSided };
  }, [srcTables, tgtTables, query, closedFolders, syncList]);
  const saveList = (next: string[]) => { setSyncList(next); postMsg({ type: 'saveDataSyncList', payload: { items: next } }); };
  const toggleFolder = (k: Kind) => setClosedFolders(cur => {
    const next = cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k];
    try { localStorage.setItem(CLOSED_KEY, JSON.stringify(next)); } catch { /* private window */ }
    return next;
  });
  // the tree's height, for the windowed list (only the lines in view are built)
  const listRef = useRef<HTMLDivElement>(null);
  const [listH, setListH] = useState(400);
  useEffect(() => {
    const el = listRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setListH(el.clientHeight || 400)); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sameSide = !!src.serverId && src.serverId === tgt.serverId && src.schema === tgt.schema;
  const ready = !!src.serverId && !!tgt.serverId && !!src.schema && !!tgt.schema && !sameSide;
  const compare = (t = table, ign = ignore, by = matchBy, k = kind) => {
    if (!ready || !t) return;
    setRunning(true); setError(''); setProgress('Starting');
    postMsg({ type: 'compareTableData', payload: { sourceServerId: src.serverId, targetServerId: tgt.serverId, sourceSchema: src.schema, targetSchema: tgt.schema, table: t, kind: k, ignore: ign, key: by ? [by] : undefined } });
  };
  // an object is compared as soon as you pick it: it only reads
  const open = (o: Obj) => {
    if (running) return;
    setTable(o.name); setKind(o.kind); setIgnore([]); setMatchBy(''); setResult(null); setSeq(null); setFn(null); setSync(null); setDeletes(false); setPreview(false);
    compare(o.name, [], '', o.kind);
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
  } else if (fn) {
    main = <FunctionView d={fn} sync={sync?.keepExtra ?? null} srcName={srcName} tgtName={tgtName} onRecompare={() => compare()} />;
  } else if (seq) {
    main = <SequenceView d={seq} sync={sync?.keepExtra ?? null} srcName={srcName} tgtName={tgtName} onRecompare={() => compare()} />;
  } else if (result) {
    main = (
      <ResultView r={result} srcName={srcName} tgtName={tgtName} view={view} onView={setView}
        ignore={ignore} onIgnore={setIgnore} ignoreChanged={ignoreChanged} onRecompare={() => compare()} running={running}
        matchBy={matchBy} onMatchBy={by => { const ign = ignore.filter(c => c !== by); setMatchBy(by); setIgnore(ign); compare(table, ign, by); }}
        sync={result.counts.added + result.counts.changed + result.counts.removed > 0 ? (
          kind !== 'table'
            ? <div className="dd-note"><WarningTriangleIcon size={12} />A {kind === 'view' ? 'view' : 'materialized view'}'s rows come from its tables: compare those to make {tgtName} match.</div>
            : <SyncCard r={result} sync={sync} srcName={srcName} tgtName={tgtName} deletes={deletes} onDeletes={setDeletes} preview={preview} onPreview={setPreview} />
        ) : null} />
    );
  } else {
    main = (
      <div className="dd-state">
        <CompareArt />
        <h3>{!ready ? (sameSide ? 'Source and target are the same' : 'Pick the two databases') : !listed.size ? 'Choose what you sync' : lines.both ? 'Pick a table, sequence or function' : 'Nothing is on both sides'}</h3>
        <p>{!ready ? 'Choose a database and schema on each side, above.' : !listed.size
          ? <>Lookup tables, sequences and functions you keep the same on <b className="dd-c-src">{srcName}</b> and <b className="dd-c-tgt">{tgtName}</b>. Only those are listed, so busy tables stay out of the way.</>
          : lines.both
          ? <>Its rows on <b className="dd-c-src">{srcName}</b> and <b className="dd-c-tgt">{tgtName}</b> are matched by primary key: you see what is only on one side and which values differ.</>
          : 'Schema Diff shows the tables that are only on one side.'}</p>
        <ul className="dd-facts">
          <li><EyeIcon size={13} />Read-only: nothing is changed</li>
          <li><KeyIcon size={13} />Matched by primary key, or any column you pick</li>
          <li><KeyboardIcon size={13} />One click writes the change that makes {tgtName} match</li>
        </ul>
        {ready && !listed.size && <ButtonView variant="primary" size="md" iconLeft={<ChecklistIcon size={13} />} label="Choose what you sync" onClick={() => setEditing(true)} />}
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

      <SplitPanelView className="dd-body" defaultSplit={savedSplit()} minFirst={220} minSecond={480} accentColor="var(--dm-c-14b8a6)"
        onResizeEnd={v => { try { localStorage.setItem(SPLIT_KEY, String(Math.round(v))); } catch { /* private window */ } }}
        first={
        <aside className="dd-tables">
          <div className="dd-tables-hd">
            <ChecklistIcon size={13} />Sync list
            {srcTables && tgtTables && <span className="dd-count" title="listed, on both sides">{lines.both}</span>}
            <ButtonView variant="ghost" size="md" iconLeft={<ChecklistIcon size={12} />} label="Edit" disabled={!ready || syncList === null || !srcTables || !tgtTables} onClick={() => setEditing(true)} />
          </div>
          <SearchInputView size="md" value={query} onChange={setQuery} placeholder="Find in the sync list" disabled={!lines.all.length && !query} />
          <div className="dd-tables-list" ref={listRef}>
            {!ready ? <div className="dd-tables-empty">Pick both databases</div>
              : !srcTables || !tgtTables ? <div className="dd-tables-empty"><span className="dd-spin"><SpinnerIcon size={14} /></span>Reading the schema</div>
              : !lines.all.length ? <div className="dd-tables-empty">{query ? 'Nothing matches' : 'Nothing in the sync list: Edit to add'}</div>
              : <VirtualizedListView items={lines.all} itemHeight={ROW_H} height={listH} overscan={8} renderItem={l => {
                  if ('folder' in l) {
                    const f = FOLDERS.find(x => x.kind === l.folder)!;
                    return (
                      <button type="button" className="dd-tfolder" onClick={() => toggleFolder(l.folder)}>
                        {l.open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                        {l.open ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />}
                        <span>{f.label}</span><span className="dd-tfolder-n">{l.count}</span>
                      </button>
                    );
                  }
                  const o = l.obj, f = FOLDERS.find(x => x.kind === o.kind)!;
                  const on = o.name === table && o.kind === kind;
                  return (
                    <button type="button" className={`dd-titem${on ? ' is-on' : ''}${l.only ? ' is-one' : ''}`} disabled={!!l.only || (running && !on)}
                      title={l.only ? `Only on ${l.only === 'src' ? srcName : tgtName}: Schema Diff shows it` : o.name} onClick={() => open(o)}>
                      {f.icon(13)}
                      <span className="dd-tname">{o.name}</span>
                      {l.only ? <span className={`dd-only dd-only--${l.only}`}>{l.only === 'src' ? srcName : tgtName}</span>
                        : o.kind !== 'sequence' && o.kind !== 'function' && (o.rows > 0 || l.tgtRows > 0) ? (
                          <span className="dd-trows" title={`about ${n(o.rows)} rows on ${srcName}, ${n(l.tgtRows)} on ${tgtName}`}>
                            <span className="dd-c-src">~{n(o.rows)}</span><span className="dd-c-tgt">~{n(l.tgtRows)}</span>
                          </span>
                        ) : <span />}
                    </button>
                  );
                }} />}
          </div>
          {lines.oneSided > 0 && <div className="dd-tables-ft">{lines.oneSided} only on one side (dimmed): Schema Diff shows {lines.oneSided === 1 ? 'it' : 'them'}</div>}
        </aside>}
        second={<main className="dd-main">{main}</main>} />
      {editing && srcTables && tgtTables && (
        <SyncListModal list={syncList ?? []} objects={[...srcTables, ...tgtTables]} schema={src.schema} onSave={saveList} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

/** a name pattern: * matches any part; a function also by its name alone (without the argument types) */
const globRe = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
const matches = (re: RegExp, o: Obj) => re.test(o.name) || (o.kind === 'function' && re.test(o.name.replace(/\(.*$/, '')));
const isRule = (k: string) => k.startsWith('rule|');
/** what the sync list keeps: objects by name (kind|name) and rules (rule|prefix_*), less what a rule leaves out (rule|!prefix_audit_*) */
function syncFilter(list: string[]) {
  const named = new Set(list.filter(k => !isRule(k)));
  const rules = list.filter(isRule).map(k => k.slice(5));
  const keep = rules.filter(r => !r.startsWith('!')).map(globRe);
  const drop = rules.filter(r => r.startsWith('!')).map(r => globRe(r.slice(1)));
  return (o: Obj) => (named.has(itemKey(o)) || keep.some(re => matches(re, o))) && !drop.some(re => matches(re, o));
}

/**
 * The sync list, typed: names of the tables, views, sequences and functions you keep the same on both, or rules
 * (prefix_* keeps everything with that prefix, also tables made later; !prefix_audit_* leaves those out). A name is looked up
 * in the schema and kept under its kind; a function is found by its name alone.
 */
function SyncListModal({ list, objects, schema, onSave, onClose }: { list: string[]; objects: Obj[]; schema: string; onSave: (next: string[]) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const all = useMemo(() => [...new Map(objects.map(o => [itemKey(o), o])).values()], [objects]);
  const words = text.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  // what the typed words would add, before you add them
  const preview = useMemo(() => {
    const keep = words.filter(w => !w.startsWith('!'));
    if (!keep.length) return [];
    const res = keep.map(globRe);
    return all.filter(o => res.some(re => matches(re, o)));
  }, [text, all]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = () => {
    if (!words.length) return;
    const next = new Set(list), notFound: string[] = [];
    for (const w of words) {
      if (w.includes('*') || w.startsWith('!')) { next.add(`rule|${w}`); continue; }
      const re = globRe(w);
      const hits = all.filter(o => matches(re, o));
      if (!hits.length) notFound.push(w);
      hits.forEach(o => next.add(itemKey(o)));
    }
    onSave([...next]);
    setMissing(notFound);
    setText(notFound.join(', '));
  };
  const known = new Set(all.map(itemKey));
  const rules = list.filter(isRule).map(k => k.slice(5)).sort((a, b) => Number(a.startsWith('!')) - Number(b.startsWith('!')) || a.localeCompare(b));
  const shown = all.filter(syncFilter(list));
  const ruleHits = (r: string) => { const re = globRe(r.replace(/^!/, '')); return all.filter(o => matches(re, o)); };
  return (
    <ModalView open size="lg" onClose={onClose} title="Sync list" headerIcon={<ChecklistIcon size={16} />}
      subtitle="The tables, views, sequences and functions you keep the same on both. Data Diff lists only these.">
      <div className="dd-sl">
        <div className="dd-sl-add">
          <TextInputView size="md" width="fullWidth" value={text} spellCheck={false} placeholder="prefix_*, !prefix_audit_*, table_name, function_name"
            onChange={e => { setText(e.target.value); setMissing([]); }} onKeyDown={e => { if (e.key === 'Enter') add(); }} />
          <ButtonView variant="primary" size="md" iconLeft={<PlusIcon size={12} />} label="Add" disabled={!words.length} onClick={add} />
        </div>
        <div className="dd-sl-hint">
          Names, separated by commas or spaces. <code>prefix_*</code> keeps everything starting <code>prefix_</code>, also what is made later; <code>!prefix_audit_*</code> leaves those out. Looked up in <b>{schema}</b>.
        </div>
        {preview.length > 0 && <div className="dd-sl-preview">Matches {preview.length}: {preview.slice(0, 8).map(o => o.name).join(', ')}{preview.length > 8 ? ', …' : ''}</div>}
        {missing.length > 0 && <div className="dd-note dd-note--warn"><WarningTriangleIcon size={12} />Not in {schema}: {missing.join(', ')}</div>}
        <div className="dd-sl-list">
          {!list.length && <div className="dd-tables-empty">Nothing yet: type a name or a prefix above</div>}
          {rules.length > 0 && (
            <div className="dd-sl-group">
              <div className="dd-tfolder dd-sl-folder"><FolderOpenIcon size={14} /><span>Rules</span><span className="dd-tfolder-n">{rules.length}</span></div>
              {rules.map(r => {
                const hits = ruleHits(r), out = r.startsWith('!');
                return (
                  <div key={r} className={`dd-sl-item${out ? ' is-out' : ''}`}>
                    {out ? <MinusIcon size={13} /> : <PlusIcon size={13} />}
                    <span className="dd-tname">{r}</span>
                    <span className="dd-sl-n" title={hits.map(o => o.name).join(', ')}>{out ? 'leaves out' : 'keeps'} {hits.length}</span>
                    <IconButtonView size="md" icon={<CloseIcon size={12} />} title="Take the rule out" onClick={() => onSave(list.filter(x => x !== `rule|${r}`))} />
                  </div>
                );
              })}
            </div>
          )}
          {FOLDERS.map(f => {
            const items = list.filter(k => k.startsWith(f.kind + '|')).sort();
            if (!items.length) return null;
            return (
              <div key={f.kind} className="dd-sl-group">
                <div className="dd-tfolder dd-sl-folder"><FolderOpenIcon size={14} /><span>{f.label}</span><span className="dd-tfolder-n">{items.length}</span></div>
                {items.map(k => (
                  <div key={k} className="dd-sl-item">
                    {f.icon(13)}
                    <span className="dd-tname">{k.slice(f.kind.length + 1)}</span>
                    {!known.has(k) ? <span className="dd-only">not in {schema}</span> : <span />}
                    <IconButtonView size="md" icon={<CloseIcon size={12} />} title="Take it out of the sync list" onClick={() => onSave(list.filter(x => x !== k))} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div className="dd-sl-ft">
          <span>Data Diff lists {shown.length} object{shown.length === 1 ? '' : 's'} · saved as you add</span>
          <ButtonView variant="primary" size="md" label="Done" onClick={onClose} />
        </div>
      </div>
    </ModalView>
  );
}

/** a sequence on both sides: where each is, how each counts; moving the target forward is the change */
function SequenceView({ d, sync, srcName, tgtName, onRecompare }: { d: SeqResult; sync: Sql | null; srcName: string; tgtName: string; onRecompare: () => void }) {
  const props: { k: keyof SeqState; label: string }[] = [
    { k: 'last_value', label: 'Last value' }, { k: 'is_called', label: 'Called' }, { k: 'increment_by', label: 'Increment' },
    { k: 'start_value', label: 'Start' }, { k: 'min_value', label: 'Min' }, { k: 'max_value', label: 'Max' }, { k: 'cycle', label: 'Cycle' },
  ];
  const same = !d.differs.length;
  const propsDiffer = d.differs.some(k => k !== 'last_value' && k !== 'is_called');
  const valueDiffers = d.differs.some(k => k === 'last_value' || k === 'is_called');
  return (
    <div className="dd-result">
      <div className="dd-res-hd">
        <span className="dd-res-icon"><HashIcon size={16} /></span>
        <div className="dd-res-title">
          <h2>{d.sequence}</h2>
          <span className="dd-res-sub"><span className="dd-c-src">{srcName} · {d.sourceSchema}</span><ArrowRightIcon size={10} /><span className="dd-c-tgt">{tgtName} · {d.targetSchema}</span><span className="dd-sep" />sequence<span className="dd-sep" />{(d.ms / 1000).toFixed(1)}s</span>
        </div>
        <div className="dd-res-tools"><ButtonView variant="secondary" size="md" iconLeft={<RefreshIcon size={12} />} label="Compare again" onClick={onRecompare} /></div>
      </div>
      <div className="dd-scroll">
        <table className="dd-grid">
          <thead><tr><th />{props.map(p => <th key={p.k}>{p.label}</th>)}</tr></thead>
          <tbody>
            {([['src', srcName, d.source], ['tgt', tgtName, d.target]] as const).map(([side, name, st]) => (
              <tr key={side}>
                <td className={`dd-c-${side}`}><b>{name}</b></td>
                {props.map(p => <td key={p.k} className={d.differs.includes(p.k) ? 'is-diff' : ''}>{String(st[p.k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {same && <div className="dd-same"><span className="dd-eq dd-eq--big">=</span>The sequence is at the same place on both.</div>}
      {propsDiffer && <div className="dd-note"><WarningTriangleIcon size={12} />How it counts differs too (increment, start, min, max or cycle): Schema Diff changes that.</div>}
      {valueDiffers && (sync ? (
        <section className="dd-sync">
          <div className="dd-sync-hd">
            <span className="dd-sync-icon"><SyncIcon size={16} /></span>
            <div className="dd-sync-txt">
              <h3>Move {tgtName}'s {d.sequence} forward</h3>
              <p>setval to <code>{d.source.last_value}</code>, where it is on {srcName}; the revert puts it back at <code>{d.target.last_value}</code>. Opens in Manual to self-check and save.</p>
            </div>
            <div className="dd-sync-actions">
              <ButtonView variant="primary" size="md" iconLeft={<KeyboardIcon size={13} />} label="Open in Manual"
                onClick={() => postMsg({ type: 'openFormWithPrefill', payload: { form: 'manual', manual: { name: `sync_${d.sequence}_value`, ...sync, tags: 'data-sync' } } })} />
            </div>
          </div>
        </section>
      ) : (
        <div className="dd-note dd-note--warn"><WarningTriangleIcon size={12} />{tgtName} is ahead of {srcName}: moving a sequence back could hand out values already used, so DMCR does not write that change.</div>
      ))}
    </div>
  );
}

/** a function on both sides: the definitions side by side; putting the source's on the target is the change */
function FunctionView({ d, sync, srcName, tgtName, onRecompare }: { d: FnResult; sync: Sql | null; srcName: string; tgtName: string; onRecompare: () => void }) {
  const short = d.function.replace(/\(.*$/, '');
  return (
    <div className="dd-result dd-result--fn">
      <div className="dd-res-hd">
        <span className="dd-res-icon"><CodeBracketsIcon size={16} /></span>
        <div className="dd-res-title">
          <h2>{d.function}</h2>
          <span className="dd-res-sub"><span className="dd-c-src">{srcName} · {d.sourceSchema}</span><ArrowRightIcon size={10} /><span className="dd-c-tgt">{tgtName} · {d.targetSchema}</span><span className="dd-sep" />function<span className="dd-sep" />{(d.ms / 1000).toFixed(1)}s</span>
        </div>
        <div className="dd-res-tools"><ButtonView variant="secondary" size="md" iconLeft={<RefreshIcon size={12} />} label="Compare again" onClick={onRecompare} /></div>
      </div>
      {d.same ? <div className="dd-same"><span className="dd-eq dd-eq--big">=</span>The function is the same on both.</div> : sync && (
        <section className="dd-sync">
          <div className="dd-sync-hd">
            <span className="dd-sync-icon"><SyncIcon size={16} /></span>
            <div className="dd-sync-txt">
              <h3>Put {srcName}'s {short} on {tgtName}</h3>
              <p>CREATE OR REPLACE with the definition on {srcName}; the revert puts {tgtName}'s back. Opens in Manual to self-check and save.</p>
            </div>
            <div className="dd-sync-actions">
              <ButtonView variant="primary" size="md" iconLeft={<KeyboardIcon size={13} />} label="Open in Manual"
                onClick={() => postMsg({ type: 'openFormWithPrefill', payload: { form: 'manual', manual: { name: `sync_${short}_function`, ...sync, tags: 'data-sync' } } })} />
            </div>
          </div>
          {d.resultDiffers && <div className="dd-note dd-note--warn"><WarningTriangleIcon size={12} />It returns <code>{d.source.result}</code> on {srcName} and <code>{d.target.result}</code> on {tgtName}: the change drops it first, so anything that depends on it must allow that.</div>}
        </section>
      )}
      <div className="dd-fn-diff">
        <div className="dd-fn-sides"><span className="dd-c-src">{srcName}</span><span className="dd-c-tgt">{tgtName}</span></div>
        <DiffEditorView original={d.source.definition} modified={d.target.definition} language="sql" height="100%" readOnly={true} renderSideBySide={true} theme="vs-dark" />
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
            <ButtonView variant="primary" size="md" iconLeft={<KeyboardIcon size={13} />} label="Open in Manual"
              onClick={() => postMsg({ type: 'openFormWithPrefill', payload: { form: 'manual', manual: { name: `sync_${r.table}_data`, ...sql, tags: 'data-sync' } } })} />
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
