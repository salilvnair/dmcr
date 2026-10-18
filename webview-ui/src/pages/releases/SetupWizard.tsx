import { useEffect, useState } from 'react';
import { ButtonView, TextInputView, LoaderView, ReleaseIcon, UserSingleIcon, CheckCircleIcon, WarningTriangleIcon, LayersIcon, RefreshIcon } from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import './SetupWizard.css';

type CaptureResult = { captureId: string; exitCode: number | null; data: Record<string, unknown> | unknown[] };
type EnvState = 'checking' | 'missing' | 'running' | 'ready' | 'error';
type EnvConn = { name: string; connUrl: string; schema?: string };

const envColor = (env: string) => (/prod/i.test(env) ? 'var(--dm-c-ef4444)' : /test|st|stag|uat/i.test(env) ? 'var(--dm-c-f59e0b)' : 'var(--dm-c-3b82f6)');
const msgOf = (r: CaptureResult) => { const d = r.data as Record<string, unknown>; return String(d?.message ?? `exit ${r.exitCode}`); };

/**
 * Releases before DMCR can work here: the DBA name, then every environment set up (the dmcr registry and the
 * environment's schema from DMCR Config). Each part shows its own progress; when all are done the page opens.
 */
export function SetupWizard({ envs: envsIn, dbaName, capture, onOpenSettings, onDone }: {
  envs: string[]; dbaName: string;
  capture: (args: string[]) => Promise<CaptureResult>;
  onOpenSettings: () => void; onDone: () => void;
}) {
  // pipeline order: test first, prod last
  const envs = [...envsIn].sort((x, y) => Number(/prod/i.test(x)) - Number(/prod/i.test(y)));
  const [name, setName] = useState(dbaName);
  const [savedName, setSavedName] = useState(dbaName);
  const [savingName, setSavingName] = useState(false);
  const [conns, setConns] = useState<Record<string, EnvConn>>({});
  const [state, setState] = useState<Record<string, EnvState>>(() => Object.fromEntries(envs.map(e => [e, 'checking' as EnvState])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [runningAll, setRunningAll] = useState(false);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: { dbaName?: string; envs?: EnvConn[] } };
      if (m?.type === 'dbaProfile') { const n = String(m.payload?.dbaName ?? ''); setSavedName(n); setName(prev => prev || n); setSavingName(false); }
      if (m?.type === 'dmcrConfig') setConns(Object.fromEntries((m.payload?.envs ?? []).map(c => [c.name, c])));
    };
    window.addEventListener('message', on);
    postMsg({ type: 'getDmcrConfig' });
    return () => window.removeEventListener('message', on);
  }, []);

  // is each environment set up? (status fails with "registry not found" when it is not)
  const check = async () => {
    setState(Object.fromEntries(envs.map(e => [e, 'checking' as EnvState])));
    await Promise.all(envs.map(async e => {
      const r = await capture(['status', '--env', e]);
      const ok = r.exitCode === 0;
      const missing = !ok && /registry not found/i.test(msgOf(r));
      setState(s => ({ ...s, [e]: ok ? 'ready' : missing ? 'missing' : 'error' }));
      if (!ok && !missing) setErrors(x => ({ ...x, [e]: msgOf(r) }));
    }));
  };
  useEffect(() => { void check(); }, [envs.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const setUp = async (e: string) => {
    setState(s => ({ ...s, [e]: 'running' })); setErrors(x => ({ ...x, [e]: '' }));
    const r = await capture(['init', '--env', e]);
    if (r.exitCode === 0) setState(s => ({ ...s, [e]: 'ready' }));
    else { setState(s => ({ ...s, [e]: 'error' })); setErrors(x => ({ ...x, [e]: msgOf(r) })); }
  };
  const setUpAll = async () => {
    setRunningAll(true);
    for (const e of envs) if (state[e] === 'missing' || state[e] === 'error') await setUp(e);
    setRunningAll(false);
  };
  const saveName = () => { if (!name.trim()) return; setSavingName(true); postMsg({ type: 'saveDbaProfile', payload: { dbaName: name.trim() } }); };

  const nameDone = !!savedName.trim();
  const envsDone = envs.length > 0 && envs.every(e => state[e] === 'ready');
  const checking = envs.some(e => state[e] === 'checking');
  const allDone = nameDone && envsDone;
  const readyCount = envs.filter(e => state[e] === 'ready').length;

  return (
    <div className="sw-page" data-testid="setup-wizard">
      <div className="sw-card">
        <div className="sw-head">
          <span className="sw-ring"><span className="sw-glow" />{allDone ? <CheckCircleIcon size={30} /> : <ReleaseIcon size={30} />}</span>
          <div>
            <h2>{allDone ? 'DMCR is ready' : 'Set up DMCR'}</h2>
            <p>{allDone ? 'Your name is set and every environment has its registry and schema.' : 'Two things before Releases can plan, deploy and roll back: who you are, and each database set up once.'}</p>
          </div>
        </div>

        <ol className="sw-steps">
          <li className={`sw-step${nameDone ? ' is-done' : ' is-current'}`}>
            <span className="sw-num">{nameDone ? <CheckCircleIcon size={16} /> : 1}</span>
            <div className="sw-body">
              <b>Your DBA name</b>
              <span className="sw-sub">Recorded on every change you build and deploy</span>
              <div className="sw-row">
                <TextInputView value={name} placeholder="DBA name" iconLeft={<UserSingleIcon size={13} />} spellCheck={false} autoComplete="off"
                  onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveName(); }} style={{ width: 280 }} />
                <ButtonView variant={name.trim() !== savedName ? 'primary' : 'ghost'} accentColor="var(--dm-c-6366f1)" loading={savingName}
                  disabled={!name.trim() || name.trim() === savedName} iconLeft={nameDone && name.trim() === savedName ? <CheckCircleIcon size={13} /> : undefined}
                  label={nameDone && name.trim() === savedName ? 'Saved' : 'Save'} onClick={saveName} />
              </div>
            </div>
          </li>

          <li className={`sw-step${envsDone ? ' is-done' : nameDone ? ' is-current' : ''}`}>
            <span className="sw-num">{envsDone ? <CheckCircleIcon size={16} /> : 2}</span>
            <div className="sw-body">
              <b>Set up each environment</b>
              <span className="sw-sub">Creates the dmcr registry (what is applied where) and the environment's schema from DMCR Config, once per database</span>
              <div className="sw-envs">
                {envs.map(e => {
                  const c = conns[e]; const st = state[e];
                  return (
                    <div key={e} className={`sw-env sw-env--${st}`}>
                      <span className="sw-env-badge" style={{ color: envColor(e), borderColor: `color-mix(in srgb, ${envColor(e)} 40%, transparent)`, background: `color-mix(in srgb, ${envColor(e)} 12%, transparent)` }}>{e.toUpperCase()}</span>
                      <span className="sw-env-db"><LayersIcon size={12} />{c ? <>{c.connUrl.replace(/^postgres(ql)?:\/\/[^@]*@/, '')}{c.schema ? <> · schema <code>{c.schema}</code></> : null}</> : '…'}</span>
                      <span className="sw-env-state">
                        {st === 'checking' && <><LoaderView variant="spinner" size="sm" /> Checking</>}
                        {st === 'running' && <><LoaderView variant="spinner" size="sm" /> Creating dmcr{c?.schema ? ` and ${c.schema}` : ''}…</>}
                        {st === 'ready' && <><CheckCircleIcon size={13} /> Ready</>}
                        {st === 'missing' && 'Not set up'}
                        {st === 'error' && <><WarningTriangleIcon size={13} /> Failed</>}
                      </span>
                      {(st === 'missing' || st === 'error') && <ButtonView size="md" variant="secondary" label={`Set up ${e}`} disabled={!nameDone || runningAll} onClick={() => void setUp(e)} />}
                      {errors[e] && <pre className="sw-err">{errors[e]}</pre>}
                    </div>
                  );
                })}
              </div>
              <div className="sw-row">
                {!envsDone && <ButtonView variant="primary" accentColor="var(--dm-c-6366f1)" label={runningAll ? 'Setting up…' : `Set up all (${envs.length - readyCount})`} loading={runningAll}
                  disabled={!nameDone || checking || runningAll} title={!nameDone ? 'Save your DBA name first' : undefined} onClick={() => void setUpAll()} />}
                <ButtonView variant="ghost" iconLeft={<RefreshIcon size={12} />} label="Check again" disabled={runningAll || checking} onClick={() => void check()} />
                <ButtonView variant="ghost" label="Edit in DMCR Config" onClick={onOpenSettings} />
              </div>
            </div>
          </li>
        </ol>

        <div className="sw-foot">
          <span className="sw-progress">{(nameDone ? 1 : 0) + readyCount} of {envs.length + 1} done</span>
          <ButtonView variant="primary" accentColor="var(--dm-c-22c55e)" label="Open Releases" disabled={!allDone} onClick={onDone} />
        </div>
      </div>
    </div>
  );
}
