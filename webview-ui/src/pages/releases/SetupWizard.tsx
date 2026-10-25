import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ButtonView, TextInputView, LoaderView, ReleaseIcon, UserSingleIcon, CheckCircleIcon, WarningTriangleIcon, LayersIcon, RefreshIcon,
  FolderOpenIcon, SparkleIcon, ConnectIcon, SaveIcon, PlusIcon, ShieldAlertIcon, TogglePillView,
} from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import type { CaptureResult } from './useDmcrSetup';
import './SetupWizard.css';

type EnvState = 'checking' | 'missing' | 'running' | 'ready' | 'error';
type EnvConn = { name: string; connUrl: string; schema?: string; password?: string; hasPassword?: boolean; isNew?: boolean };
type RawCfg = Record<string, unknown> & { changesDir?: string; envs?: EnvConn[] };
const SENTINEL = '••••••••••••';

/** A name that reads as production (dmcr.cfg's guess when none is chosen): prod, production, prd, live, trunk, main, master */
const PROD_NAME_RE = /prod|prd|live|trunk|^main$|^master$/i;
/** Production red, test amber, others blue; `prod` is the production environment's name */
const envColor = (env: string, prod: string) => (env && env === prod ? 'var(--dm-c-ef4444)' : /test|st|stag|uat/i.test(env) ? 'var(--dm-c-f59e0b)' : 'var(--dm-c-3b82f6)');
const msgOf = (r: CaptureResult) => { const d = r.data as Record<string, unknown>; return String(d?.message ?? `exit ${r.exitCode}`); };
/** Production last, the rest as they are */
const pipeline = (names: string[], prod: string) => [...names].sort((x, y) => Number(x === prod) - Number(y === prod));
const badgeStyle = (e: string, prod: string) => ({ color: envColor(e, prod), borderColor: `color-mix(in srgb, ${envColor(e, prod)} 40%, transparent)`, background: `color-mix(in srgb, ${envColor(e, prod)} 12%, transparent)` });

/**
 * The first run of DMCR: everything it needs before any tab makes sense, in one place.
 * 1 DBA name · 2 changes folder · 3 databases (URL, schema, password, test) · 4 AI provider · 5 set up each database.
 * Each step lights up when it is next and turns green when done; DMCR opens when all are.
 */
export function SetupWizard({ envs: envsIn, dbaName, capture, ai, onOpenSettings, onOpenAi, onDone }: {
  envs: string[]; dbaName: string;
  capture: (args: string[]) => Promise<CaptureResult>;
  ai: { ready: boolean; label: string; model?: string };
  onOpenSettings: () => void; onOpenAi: () => void; onDone: () => void;
}) {
  // ── 1 DBA name ──
  const [name, setName] = useState(dbaName);
  const [savedName, setSavedName] = useState(dbaName);
  const [savingName, setSavingName] = useState(false);
  // ── 2, 3 dmcr.cfg: changes folder and databases ──
  const raw = useRef<RawCfg | null>(null);
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [changesDir, setChangesDir] = useState('');
  const [savedChangesDir, setSavedChangesDir] = useState('');
  const [conns, setConns] = useState<EnvConn[]>([]);
  const [savedConns, setSavedConns] = useState('');
  const [savingCfg, setSavingCfg] = useState<'' | 'folder' | 'envs'>('');
  const [cfgError, setCfgError] = useState('');
  const [tests, setTests] = useState<Record<string, { status: 'testing' | 'ok' | 'fail'; message?: string }>>({});
  // the production environment: chosen here (or in DMCR Config), else read from the names
  const [production, setProduction] = useState('');
  const [prodSet, setProdSet] = useState(false);
  const [savedProd, setSavedProd] = useState('');
  const namedConns = conns.map(c => c.name.trim()).filter(Boolean);
  const prodName = prodSet ? (namedConns.includes(production) ? production : '') : (namedConns.find(n => PROD_NAME_RE.test(n)) ?? '');
  // ── 5 set up each database ──
  const envs = pipeline(conns.length ? conns.map(c => c.name) : envsIn, prodName);
  const [state, setState] = useState<Record<string, EnvState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [editing, setEditing] = useState<Set<number>>(new Set());

  const connKey = (cs: EnvConn[]) => JSON.stringify(cs.map(c => [c.name.trim(), c.connUrl.trim(), (c.schema ?? '').trim(), c.password && c.password !== SENTINEL ? 'new' : '']));

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: Record<string, unknown> };
      const p = m?.payload ?? {};
      if (m?.type === 'dbaProfile') { const n = String(p.dbaName ?? ''); setSavedName(n); setName(prev => prev || n); setSavingName(false); }
      if (m?.type === 'dmcrConfig') {
        const cfg = p as RawCfg;
        raw.current = cfg;
        const list = cfg.envs ?? [];
        const prod = String((cfg as { production?: string }).production ?? '');
        setProduction(prod); setProdSet(!!(cfg as { productionSet?: boolean }).productionSet); setSavedProd(prod);
        const cs = pipeline(list.map(c => c.name), prod).map(n => list.find(c => c.name === n)!).map(c => ({ ...c, password: c.hasPassword ? SENTINEL : '' }));
        setConns(cs); setSavedConns(connKey(cs));
        setChangesDir(String(cfg.changesDir ?? '')); setSavedChangesDir(String(cfg.changesDir ?? ''));
        setCfgLoaded(true);
      }
      if (m?.type === 'dmcrConfigSaved') { setSavingCfg(''); setCfgError(''); postMsg({ type: 'getDmcrConfig' }); postMsg({ type: 'getReleaseData' }); }
      if (m?.type === 'dmcrConfigError') { setSavingCfg(''); setCfgError(String(p.message ?? 'Save failed')); }
      if (m?.type === 'folderPicked' && p.requestId === 'setup:changesDir' && p.path) setChangesDir(String(p.path));
      if (m?.type === 'testDbConnectionResult') { const env = String(p.env ?? ''); setTests(t => ({ ...t, [env]: { status: p.ok ? 'ok' : 'fail', message: String(p.message ?? '') } })); }
    };
    window.addEventListener('message', on);
    postMsg({ type: 'getDmcrConfig' });
    postMsg({ type: 'getDbaProfile' });
    return () => window.removeEventListener('message', on);
  }, []);

  /** Saves dmcr.cfg as DMCR Config does: everything as it is, with this step's fields changed. */
  const saveCfg = (what: 'folder' | 'envs') => {
    const r = raw.current; if (!r) return;
    setSavingCfg(what); setCfgError('');
    const names = conns.map(c => c.name.trim()).filter(Boolean);
    postMsg({ type: 'saveDmcrConfig', payload: {
      env: names.includes(String(r.env ?? '')) ? r.env : names[0],
      changesDir: (what === 'folder' ? changesDir : savedChangesDir).trim(),
      psqlPath: r.psqlPath ?? '', lockTimeout: r.lockTimeout || '30s', statementTimeout: r.statementTimeout || '5min',
      runHistoryLimit: Number(r.runHistoryLimit) > 0 ? Number(r.runHistoryLimit) : 50,
      compareConnUrl: r.compareConnUrl || null,
      envs: conns.filter(c => c.name.trim()).map(c => ({ name: c.name.trim(), connUrl: c.connUrl.trim(), schema: (c.schema ?? '').trim(),
        password: !c.password || c.password === SENTINEL ? null : c.password.trim() })),
      checksumPolicy: r.checksumPolicy ?? '',
      production: what === 'envs' ? prodName : String((r as { production?: string }).production ?? ''),
      envRules: Object.fromEntries(names.map(n => [n, ((r.envRules as Record<string, unknown>) ?? {})[n] ?? { promoteFrom: '', outOfOrder: '' }])),
      gitRemoteUrl: r.gitRemoteUrl ?? '', gitAutoCommit: !!r.gitAutoCommit, gitBranch: r.gitBranch ?? '',
    } });
  };

  // is each database set up? (status fails with "registry not found" when it is not)
  const check = async (list = envs) => {
    setState(Object.fromEntries(list.map(e => [e, 'checking' as EnvState])));
    await Promise.all(list.map(async e => {
      const r = await capture(['status', '--env', e]);
      const ok = r.exitCode === 0;
      const missing = !ok && /registry not found/i.test(msgOf(r));
      setState(s => ({ ...s, [e]: ok ? 'ready' : missing ? 'missing' : 'error' }));
      setErrors(x => ({ ...x, [e]: ok || missing ? '' : msgOf(r) }));
    }));
  };
  const envsKey = envs.join(',') + '|' + savedConns;
  useEffect(() => { if (envs.length && cfgLoaded) void check(); }, [envsKey, cfgLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const setUp = async (e: string) => {
    setState(s => ({ ...s, [e]: 'running' })); setErrors(x => ({ ...x, [e]: '' }));
    const r = await capture(['init', '--env', e]);
    if (r.exitCode === 0) setState(s => ({ ...s, [e]: 'ready' }));
    else { setState(s => ({ ...s, [e]: 'error' })); setErrors(x => ({ ...x, [e]: msgOf(r) })); }
  };
  const setUpAll = async () => {
    setRunningAll(true);
    for (const e of envs) if (state[e] !== 'ready') await setUp(e);
    setRunningAll(false);
  };
  const saveName = () => { if (!name.trim()) return; setSavingName(true); postMsg({ type: 'saveDbaProfile', payload: { dbaName: name.trim() } }); };
  const setConn = (i: number, patch: Partial<EnvConn>) => setConns(cs => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  // a new database: test first, then prod, then a name of your own
  const addConn = () => setConns(cs => {
    const used = new Set(cs.map(c => c.name.trim().toLowerCase()));
    const name = !used.has('test') ? 'test' : !used.has('prod') ? 'prod' : '';
    return [...cs, { name, connUrl: '', schema: '', password: '', isNew: true }];
  });

  // ── what is done ──
  const nameDone = !!savedName.trim();
  const folderDone = !!savedChangesDir.trim();
  // a production choice not saved yet counts as a change to the databases step
  const envsDirty = connKey(conns) !== savedConns || prodName !== savedProd;
  const connNames = conns.map(c => c.name.trim().toLowerCase());
  const connsValid = conns.length > 0 && conns.every(c => c.name.trim() && /^[a-z][a-z0-9_-]*$/i.test(c.name.trim()) && c.connUrl.trim()) && new Set(connNames).size === connNames.length;
  const connsDone = connsValid && !envsDirty;
  const aiDone = ai.ready;
  const setupDone = envs.length > 0 && envs.every(e => state[e] === 'ready');
  const checking = envs.some(e => (state[e] ?? 'checking') === 'checking');
  // the order a first run goes in: a database first, then where changes live, who you are, the AI, and set up
  const parts = [connsDone, folderDone, nameDone, aiDone, setupDone];
  const doneCount = parts.filter(Boolean).length;
  const allDone = parts.every(Boolean);
  const current = parts.findIndex(x => !x);
  // the current step is open; a done one folds to a line with Edit; a later one waits its turn
  const summaries = [
    conns.map(c => `${c.name}${c.schema ? ` · ${c.schema}` : ''}`).join(', '),
    savedChangesDir,
    savedName,
    ai.ready ? `${ai.label}${ai.model ? ` · ${ai.model}` : ''}` : '',
    envs.map(e => e).join(', ') + ' ready',
  ];
  const step = (i: number, title: string, sub: string, body: ReactNode) => {
    const done = parts[i]; const isCurrent = i === current; const open = isCurrent || editing.has(i);
    const later = !done && !isCurrent && !open;
    return (
      <li className={`sw-step${done ? ' is-done' : ''}${isCurrent ? ' is-current' : ''}${open ? ' is-open' : ''}${later ? ' is-later' : ''}`}>
        <span className="sw-num">{done ? <CheckCircleIcon size={15} /> : i + 1}</span>
        <div className="sw-body">
          <div className="sw-step-head">
            <b>{title}</b>
            {done && !open && <span className="sw-summary">{summaries[i]}</span>}
            {done && <button type="button" className="sw-edit" onClick={() => setEditing(x => { const n = new Set(x); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>{open ? 'Done' : 'Edit'}</button>}
          </div>
          {open && <><span className="sw-sub">{sub}</span>{body}</>}
        </div>
      </li>
    );
  };
  // saved and unchanged: a calm chip; otherwise the Save button
  const saveBtn = (dirty: boolean, done: boolean, busy: boolean, disabled: boolean, onClick: () => void, label = 'Save') => (
    done && !dirty && !busy
      ? <span className="sw-saved"><CheckCircleIcon size={13} />Saved</span>
      : <ButtonView variant="primary" accentColor="var(--dm-c-6366f1)" loading={busy} disabled={disabled} label={label} onClick={onClick} />
  );

  return (
    <div className="sw-page" data-testid="setup-wizard">
      <div className="sw-card">
        <div className="sw-head">
          <span className="sw-ring">{allDone ? <CheckCircleIcon size={30} /> : <ReleaseIcon size={30} />}</span>
          <div>
            <h2>{allDone ? 'DMCR is ready' : 'Set up DMCR'}</h2>
            <p>{allDone ? 'Everything DMCR needs is in place.' : 'What DMCR needs before any tab can work: your databases, where changes live, who you are, an AI, and each database set up once.'}</p>
          </div>
        </div>

        <ol className="sw-steps">
          {step(0, 'Your databases', 'Per environment: the connection (no password in it), the schema its SQL runs in, and the password (kept in the OS keychain)', (<>
            <div className="sw-conns">
              {conns.map((c, i) => {
                const t = tests[c.name];
                return (
                  <div key={i} className="sw-conn" style={{ ['--env' as string]: envColor(c.name, prodName) }}>
                    {c.isNew
                      ? <TextInputView value={c.name} placeholder="name" spellCheck={false} onChange={e => setConn(i, { name: e.target.value.trim().toLowerCase() })} />
                      : <span className="sw-env-badge" style={badgeStyle(c.name, prodName)}>{c.name.toUpperCase()}</span>}
                    <TextInputView value={c.connUrl} placeholder="postgresql://user@host:5432/database" spellCheck={false} onChange={e => setConn(i, { connUrl: e.target.value })} />
                    <TextInputView value={c.schema ?? ''} placeholder="schema" spellCheck={false} onChange={e => setConn(i, { schema: e.target.value })} />
                    <TextInputView type="password" value={c.password ?? ''} placeholder="password" onChange={e => setConn(i, { password: e.target.value })} />
                    <ButtonView variant="secondary" iconLeft={t?.status === 'testing' ? undefined : <ConnectIcon size={12} />} loading={t?.status === 'testing'} label="Test"
                      disabled={!c.connUrl.trim()} onClick={() => { setTests(x => ({ ...x, [c.name]: { status: 'testing' } })); postMsg({ type: 'testDbConnection', payload: { conn: c.connUrl.trim(), env: c.name } }); }} />
                    {(() => {
                      const n = c.name.trim(); const on = !!n && n === prodName;
                      return (
                        <TogglePillView testId={`env-production-${n || i}`} active={on} variant={on ? 'go' : 'default'} accentColor="var(--dm-c-ef4444)" disabled={!n}
                          icon={<ShieldAlertIcon size={11} />} className="sw-prod-pill"
                          title={on ? `${n} is production: Import, Never send to prod and the shipped marks follow it. Click if it is not` : `Mark ${n || 'this database'} as production (only one is)`}
                          onClick={() => { setProduction(on ? '' : n); setProdSet(true); }}>
                          {on ? 'Production' : 'Production?'}
                        </TogglePillView>
                      );
                    })()}
                    {t && t.status !== 'testing' && <span className={`sw-test sw-test--${t.status}`}>{t.status === 'ok' ? <CheckCircleIcon size={12} /> : <WarningTriangleIcon size={12} />}{t.message}</span>}
                  </div>
                );
              })}
              {cfgLoaded && !conns.length && <div className="sw-sub">No database yet: add the first one (test), then prod.</div>}
            </div>
            <div className="sw-row">
              <ButtonView variant="secondary" iconLeft={<PlusIcon size={12} />} label={conns.length ? 'Add database' : 'Add your first database'} onClick={addConn} />
              {saveBtn(envsDirty, connsDone, savingCfg === 'envs', !envsDirty || !connsValid, () => saveCfg('envs'), 'Save databases')}
              <ButtonView variant="ghost" label="More in DMCR Config" onClick={onOpenSettings} />
              {cfgError && <span className="sw-test sw-test--fail"><WarningTriangleIcon size={12} />{cfgError}</span>}
            </div>
          </>))}

          {step(1, 'Changes folder', 'Where change folders are created: relative to the workspace, or a full path', (
            <div className="sw-row">
              <TextInputView value={changesDir} placeholder="db/changes" iconLeft={<FolderOpenIcon size={13} />} spellCheck={false}
                onChange={e => setChangesDir(e.target.value)} style={{ width: 420 }} />
              <ButtonView variant="secondary" label="Browse" onClick={() => postMsg({ type: 'pickFolder', payload: { requestId: 'setup:changesDir' } })} />
              {saveBtn(changesDir.trim() !== savedChangesDir, folderDone, savingCfg === 'folder', !cfgLoaded || !changesDir.trim() || changesDir.trim() === savedChangesDir, () => saveCfg('folder'))}
            </div>
          ))}

          {step(2, 'Your DBA name', 'Recorded on every change you build and deploy', (
            <div className="sw-row">
              <TextInputView value={name} placeholder="DBA name" iconLeft={<UserSingleIcon size={13} />} spellCheck={false} autoComplete="off"
                onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveName(); }} style={{ width: 300 }} />
              {saveBtn(name.trim() !== savedName, nameDone, savingName, !name.trim() || name.trim() === savedName, saveName)}
            </div>
          ))}

          {step(3, 'AI provider', 'Writes deploy, verify and revert in the DDL, DML, Freeform and Assistant tabs', (
            <div className="sw-row">
              <span className={`sw-ai${aiDone ? ' is-ok' : ''}`}><SparkleIcon size={13} />{aiDone ? <>{ai.label}{ai.model ? <span className="sw-ai-model">{ai.model}</span> : null}</> : 'No AI provider with a key yet'}</span>
              <ButtonView variant={aiDone ? 'ghost' : 'primary'} accentColor="var(--dm-c-6366f1)" label={aiDone ? 'Change' : 'Choose a provider'} onClick={onOpenAi} />
            </div>
          ))}

          {step(4, 'Set up each database', 'Creates the dmcr registry (what is applied where) and the environment\'s schema, once per database', (<>
            <div className="sw-envs">
              {envs.map(e => {
                const c = conns.find(x => x.name === e); const st = state[e] ?? 'checking';
                return (
                  <div key={e} className={`sw-env sw-env--${st}`} style={{ ['--env' as string]: envColor(e, prodName) }}>
                    <span className="sw-env-badge" style={badgeStyle(e, prodName)}>{e.toUpperCase()}</span>
                    <span className="sw-env-db"><LayersIcon size={12} />{c ? <>{c.connUrl.replace(/^postgres(ql)?:\/\/[^@]*@/, '')}{c.schema ? <> · schema <code>{c.schema}</code></> : null}</> : '…'}</span>
                    <span className="sw-env-state">
                      {st === 'checking' && <><LoaderView variant="spinner" size="sm" /> Checking</>}
                      {st === 'running' && <><LoaderView variant="spinner" size="sm" /> Creating dmcr{c?.schema ? ` and ${c.schema}` : ''}…</>}
                      {st === 'ready' && <><CheckCircleIcon size={13} /> Ready</>}
                      {st === 'missing' && 'Not set up'}
                      {st === 'error' && <><WarningTriangleIcon size={13} /> Failed</>}
                    </span>
                    {(st === 'missing' || st === 'error') && <ButtonView size="md" variant="secondary" label={`Set up ${e}`} disabled={!nameDone || !connsDone || runningAll} onClick={() => void setUp(e)} />}
                    {errors[e] && <pre className="sw-err">{errors[e]}</pre>}
                  </div>
                );
              })}
            </div>
            <div className="sw-row">
              {!setupDone && <ButtonView variant="primary" accentColor="var(--dm-c-6366f1)" label={runningAll ? 'Setting up…' : `Set up all (${envs.filter(e => state[e] !== 'ready').length})`} loading={runningAll}
                disabled={!nameDone || !connsDone || checking || runningAll} title={!nameDone ? 'Save your DBA name first' : !connsDone ? 'Save your databases first' : undefined} onClick={() => void setUpAll()} />}
              <ButtonView variant="ghost" iconLeft={<RefreshIcon size={12} />} label="Check again" disabled={runningAll || checking} onClick={() => void check()} />
            </div>
          </>))}
        </ol>

        <div className="sw-foot">
          <span className="sw-progress"><span className="sw-progress-bar"><i style={{ width: `${(doneCount / parts.length) * 100}%` }} /></span>{doneCount} of {parts.length} done</span>
          <ButtonView className="sw-open" variant="primary" label="Open DMCR" disabled={!allDone} onClick={onDone} />
        </div>
      </div>
    </div>
  );
}
