import React, { useState, useEffect } from 'react';
import {
  ButtonView, CheckboxView, CheckIcon, CloseIcon, FolderIcon, FolderOpenIcon, IconButtonView, PlusIcon,
  RefreshIcon, SaveIcon, SelectInputView, ConnectIcon, TextInputView, ServerIcon, BranchIcon, ClockIcon,
  LockIcon, SettingsIcon, LayersIcon, ChevronDownIcon, ChevronRightIcon,
} from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import type { ToastData } from '../../App';
import { WorkspaceIcon } from './icons';
import { DtSelect } from './shared';
import DbaProfileField from './DbaProfileField';
import './DmcrConfigPanel.css';
import { ChangeIdLabel } from '../runner/views/ChangeIdLabel';
import { CopyCmd } from '../runner/views/GitViews';
import { openChanges } from '../../components/ChangeViewerHost';

interface EnvConn { name: string; connUrl: string; schema?: string; password?: string; hasPassword?: boolean; }
interface EnvRule { promoteFrom: string; outOfOrder: string; approval?: string; approvers?: string; }

interface DmcrConfigState {
  env: string;
  changesDir: string;
  psqlPath: string;
  lockTimeout: string;
  statementTimeout: string;
  runHistoryLimit: string;
  // Every environment, any names, any number: URL (no password) in cfg, password in the OS keychain
  envs: EnvConn[];
  compareConnUrl: string;
  checksumPolicy: string;
  envRules: Record<string, EnvRule>;
  cfgPath: string;
  gitRemoteUrl: string;
  gitAutoCommit: boolean;
  gitBranch: string;
}

const PASSWORD_SENTINEL = '••••••••••••';

/** Badge colour of an environment: prod red, test amber, dev blue, others violet. */
const envColor = (name: string) =>
  /prod/i.test(name) ? 'var(--dm-c-ef4444)' : /test|qa|stag|uat/i.test(name) ? 'var(--dm-c-f59e0b)' : /dev|local/i.test(name) ? 'var(--dm-c-3b82f6)' : 'var(--dm-c-8b5cf6)';
const ENV_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RESERVED_ENV_NAMES = ['dmcr', 'envs', 'compare', 'placeholders'];

type TestConnState = { status: 'idle' | 'testing' | 'ok' | 'fail'; message?: string };

export function DmcrConfigPanel({ addToast }: { addToast: (msg: string, type?: ToastData['type']) => void }) {
  const [cfg, setCfg] = useState<DmcrConfigState>({
    env: '', changesDir: '', psqlPath: '', lockTimeout: '30s', statementTimeout: '5min',
    runHistoryLimit: '50',
    envs: [], compareConnUrl: '', checksumPolicy: '', envRules: {},
    cfgPath: '', gitRemoteUrl: '', gitAutoCommit: false, gitBranch: '',
  });
  const [saving, setSaving] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<{ value: string; label: string }[]>([]);
  const [fetchingBranches, setFetchingBranches] = useState(false);
  const [connTest, setConnTest] = useState<Record<string, TestConnState>>({});
  const [changeFolders, setChangeFolders] = useState<Array<{ name: string; files: string[]; commit?: { hash: string; subject: string; when: string; author: string } }> | null>(null);
  const [changeTotal, setChangeTotal] = useState(0);
  const [changeFoldersLoading, setChangeFoldersLoading] = useState(false);
  const [changeFoldersError, setChangeFoldersError] = useState('');
  // where the changes folder really is (absolute), from the folder listing
  const [changesAbs, setChangesAbs] = useState('');
  // list the changes folder once the panel knows it (the full path comes with the list)
  const listedRef = React.useRef(false);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'dmcrConfig') {
        const p = msg.payload as DmcrConfigState;
        setCfg(prev => ({
          ...prev,
          env:              p.env              ?? '',
          changesDir:       p.changesDir       ?? '',
          psqlPath:         p.psqlPath         ?? '',
          lockTimeout:      p.lockTimeout      ?? '30s',
          statementTimeout: p.statementTimeout ?? '5min',
          runHistoryLimit:  p.runHistoryLimit  ?? '50',
          compareConnUrl:   p.compareConnUrl   ?? '',
          // Show the sentinel only when a password is already stored
          envs:             (p.envs ?? []).map(e => ({ ...e, password: e.hasPassword ? PASSWORD_SENTINEL : '' })),
          checksumPolicy:   p.checksumPolicy   ?? '',
          envRules:         p.envRules         ?? {},
          cfgPath:          p.cfgPath          ?? '',
          gitRemoteUrl:     p.gitRemoteUrl     ?? '',
          gitAutoCommit:    p.gitAutoCommit    ?? false,
          gitBranch:        p.gitBranch        ?? '',
        }));
        if (p.gitRemoteUrl) {
          postMsg({ type: 'fetchGitBranches', payload: { url: p.gitRemoteUrl } });
        }
      }
      if (msg?.type === 'gitBranches') {
        setFetchingBranches(false);
        const branches: string[] = msg.payload?.branches ?? [];
        setRemoteBranches(branches.map((b: string) => ({ value: b, label: b })));
      }
      if (msg?.type === 'dmcrConfigSaved') {
        setSaving(false);
        setCfg(prev => ({
          ...prev,
          cfgPath:         msg.payload?.cfgPath         ?? prev.cfgPath,
          envs: prev.envs.map(e => {
            const stored = msg.payload?.hasPassword?.[e.name.trim()] ?? !!(e.password || e.hasPassword);
            return { ...e, hasPassword: stored, password: stored ? PASSWORD_SENTINEL : '' };
          }),
        }));
        addToast('dmcr.cfg saved ✓  Password stored in OS keychain', 'ok');
      }
      if (msg?.type === 'testDbConnectionResult') {
        const { ok, message, env } = msg.payload as { ok: boolean; message: string; env: string };
        const result: TestConnState = { status: ok ? 'ok' : 'fail', message };
        setConnTest(prev => ({ ...prev, [env]: result }));
      }
      if (msg?.type === 'dmcrConfigError') {
        setSaving(false);
        addToast(`Save failed: ${msg.payload?.message ?? 'unknown error'}`, 'error');
      }
      if (msg?.type === 'folderPicked' && msg?.payload?.requestId === 'dmcrConfig:changesDir') {
        setCfg(prev => ({ ...prev, changesDir: msg.payload?.path ?? prev.changesDir }));
      }
      if (msg?.type === 'filePicked' && msg?.payload?.requestId === 'dmcrConfig:psql') {
        setCfg(prev => ({ ...prev, psqlPath: msg.payload?.path ?? prev.psqlPath }));
      }
      if (msg?.type === 'lsChangesResult' && msg?.payload?.requestId === 'dmcrConfig') {
        setChangeFoldersLoading(false);
        if (msg.payload?.error) {
          setChangeFoldersError(msg.payload.error);
          setChangeFolders(null);
        } else {
          setChangeFolders(msg.payload?.folders ?? []);
          setChangeFoldersError('');
          if (msg.payload?.changesDir) setChangesAbs(String(msg.payload.changesDir));
          setChangeTotal(Number(msg.payload?.total ?? msg.payload?.folders?.length ?? 0));
        }
      }
    };
    window.addEventListener('message', handler);
    postMsg({ type: 'getDmcrConfig' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const envNames = cfg.envs.map(e => e.name.trim()).filter(Boolean);
  /** What is wrong with the environment list, if anything (Save stays off until it is fixed). */
  const envProblem = (() => {
    if (!envNames.length) return 'Add at least one environment.';
    if (cfg.envs.some(e => !e.name.trim())) return 'Every environment needs a name.';
    const bad = envNames.find(n => !ENV_NAME_RE.test(n) || RESERVED_ENV_NAMES.includes(n));
    if (bad) return `"${bad}" can't be an environment name: start with a letter, then letters, digits, _ or -; not ${RESERVED_ENV_NAMES.join(', ')}.`;
    const dup = envNames.find((n, i) => envNames.indexOf(n) !== i);
    if (dup) return `Two environments are called "${dup}".`;
    return '';
  })();
  const setRule = (envName: string, patch: Partial<EnvRule>) =>
    setCfg(prev => ({ ...prev, envRules: { ...prev.envRules, [envName]: { ...{ promoteFrom: '', outOfOrder: '' }, ...prev.envRules[envName], ...patch } } }));
  const updateEnv = (i: number, patch: Partial<EnvConn>) =>
    setCfg(prev => {
      const old = prev.envs[i]?.name;
      const envs = prev.envs.map((e, j) => j === i ? { ...e, ...patch } : e);
      // renaming the active environment keeps it active
      const env = patch.name !== undefined && prev.env === old ? patch.name : prev.env;
      return { ...prev, envs, env };
    });
  const removeEnv = (i: number) =>
    setCfg(prev => {
      const gone = prev.envs[i]?.name;
      const envs = prev.envs.filter((_, j) => j !== i);
      // the active one removed: the first left becomes active; rules pointing at it are cleared
      const env = prev.env === gone ? (envs[0]?.name ?? '') : prev.env;
      const envRules = Object.fromEntries(Object.entries(prev.envRules)
        .filter(([n]) => n !== gone)
        .map(([n, r]) => [n, r.promoteFrom === gone ? { ...r, promoteFrom: '' } : r]));
      return { ...prev, envs, env, envRules };
    });

  const set = (key: keyof DmcrConfigState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setCfg(prev => ({ ...prev, [key]: e.target.value }));

  const handleSave = () => {
    setSaving(true);
    // Safety net: if no response arrives within 8s, unblock the button
    const bail = setTimeout(() => setSaving(false), 8000);
    const origHandler = (e: MessageEvent) => {
      if (e.data?.type === 'dmcrConfigSaved' || e.data?.type === 'dmcrConfigError') {
        clearTimeout(bail);
        window.removeEventListener('message', origHandler);
      }
    };
    window.addEventListener('message', origHandler);
    postMsg({
      type: 'saveDmcrConfig',
      payload: {
        env:              envNames.includes(cfg.env.trim()) ? cfg.env.trim() : envNames[0],
        changesDir:       cfg.changesDir.trim(),
        psqlPath:         cfg.psqlPath.trim(),
        lockTimeout:      cfg.lockTimeout.trim() || '30s',
        statementTimeout: cfg.statementTimeout.trim() || '5min',
        runHistoryLimit:  parseInt(cfg.runHistoryLimit) > 0 ? parseInt(cfg.runHistoryLimit) : 50,
        compareConnUrl:   cfg.compareConnUrl.trim() || null,
        // the whole list: an environment left out is removed from dmcr.cfg with its stored password
        envs:             cfg.envs.filter(e => e.name.trim()).map(e => ({
          name: e.name.trim(), connUrl: e.connUrl.trim(), schema: (e.schema ?? '').trim(),
          password: !e.password || e.password === PASSWORD_SENTINEL ? null : e.password.trim(),
        })),
        checksumPolicy:   cfg.checksumPolicy,
        envRules:         Object.fromEntries(envNames.map(n => [n, cfg.envRules[n] ?? { promoteFrom: '', outOfOrder: '' }])),
        gitRemoteUrl:     cfg.gitRemoteUrl.trim(),
        gitAutoCommit:    cfg.gitAutoCommit,
        gitBranch:        cfg.gitBranch.trim(),
      },
    });
  };

  /** A section: icon, title, one plain line; the details live in tooltips */
  const Card = ({ icon, title, hint, children, aside }: { icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode; aside?: React.ReactNode }) => (
    <section className="dc-card">
      <div className="dc-card-head"><span className="dc-card-icon">{icon}</span><div className="dc-card-titles"><b>{title}</b>{hint && <span>{hint}</span>}</div>{aside}</div>
      <div className="dc-card-body">{children}</div>
    </section>
  );
  /** A labelled row: label (with an optional tooltip) on the left, the control on the right */
  const Row = ({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) => (
    <div className="dc-row"><label className="dc-row-label" title={tip}>{label}{tip && <span className="dc-tip">?</span>}</label><div className="dc-row-ctl">{children}</div></div>
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  const showMissingWorkspaceBanner = cfg.changesDir === '' && cfg.cfgPath !== '';
  useEffect(() => {
    if (!cfg.changesDir || listedRef.current) return;
    listedRef.current = true;
    setChangeFoldersLoading(true);
    postMsg({ type: 'lsChanges', payload: { requestId: 'dmcrConfig', latest: 25, commits: true } });
  }, [cfg.changesDir]);
  const refreshFolders = () => {
    setChangeFoldersLoading(true); setChangeFolders(null); setChangeFoldersError('');
    postMsg({ type: 'lsChanges', payload: { requestId: 'dmcrConfig', latest: 25, commits: true } });
  };

  return (
    <div className="bs-settings-pane dc-pane">
      <div className="dc-title">
        <WorkspaceIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3" style={{ margin: 0 }}>DMCR Config</h3>
        <span className="dc-title-sub">Where your changes live and which databases they go to</span>
      </div>
      <div className="dc-saved-to" title="Database URLs are saved here without passwords; passwords go to your OS keychain only">
        <LockIcon size={12} /><span>Saved to</span><CopyCmd cmd={cfg.cfgPath || 'scripts/runner/dmcr.cfg'} /><span className="dc-muted">· passwords in your OS keychain</span>
      </div>

      {showMissingWorkspaceBanner && (
        <div className="dc-warn">Set the <b>Changes folder</b> below and save, so DMCR knows where to create changes.</div>
      )}

      <Card icon={<SettingsIcon size={15} />} title="Basics" hint="Who you are and which database the Runner uses">
        <DbaProfileField />
        <Row label="Active environment" tip="The database the Runner and Releases use unless you pick another">
          <DtSelect value={cfg.env} onChange={v => setCfg(prev => ({ ...prev, env: v }))}
            options={envNames.map(n => ({ value: n, label: n, badge: n.toUpperCase(), badgeColor: envColor(n) }))} />
        </Row>
      </Card>

      <Card icon={<FolderOpenIcon size={15} />} title="Changes folder" hint="Where change folders are created, newest 25 below"
        aside={cfg.changesDir ? <ButtonView variant="ghost" loading={changeFoldersLoading} iconLeft={changeFoldersLoading ? undefined : <RefreshIcon size={12} />}
          label={changeFoldersLoading ? 'Loading…' : changeFolders ? `${changeFolders.length} of ${changeTotal}` : 'Show'} onClick={refreshFolders} /> : undefined}>
        <div className="dc-inline">
          <TextInputView size="md" width="fullWidth" value={cfg.changesDir} onChange={e => setCfg(prev => ({ ...prev, changesDir: e.target.value }))} placeholder="db/changes (relative to the workspace, or a full path)" spellCheck={false} />
          <ButtonView variant="secondary" iconLeft={<FolderOpenIcon size={14} />} label="Browse" onClick={() => postMsg({ type: 'pickFolder', payload: { requestId: 'dmcrConfig:changesDir' } })} />
        </div>
        {changesAbs && <div className="dc-path"><FolderOpenIcon size={13} /><span className="dc-path-label">Full path</span><CopyCmd cmd={changesAbs} /></div>}
        {changeFoldersError && <p className="dc-error">{changeFoldersError}</p>}
        {changeFolders && (
          <div className="dc-list">
            {changeFolders.length === 0 ? <p className="dc-muted" style={{ padding: '8px 12px', margin: 0 }}>No change folders yet.</p> : changeFolders.map(f => {
              const hasDeploy = f.files.some(n => n.startsWith('deploy'));
              const hasRevert = f.files.some(n => n.startsWith('revert'));
              return (
                <div key={f.name} className="dc-change" onClick={() => openChanges([f.name])} title={`Open ${f.name}`}>
                  <span style={{ color: 'var(--dm-c-4ade80)', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}><FolderIcon size={12} /></span>
                  <span style={{ flexShrink: 0 }}><ChangeIdLabel id={f.name} static /></span>
                  {f.commit
                    ? <span className="dc-commit" title={`${f.commit.hash} · ${f.commit.subject} · ${f.commit.author} · ${f.commit.when}`}>
                        <span className="dc-commit-hash">{f.commit.hash}</span><span className="dc-commit-msg">{f.commit.subject}</span><span className="dc-commit-when">{f.commit.when}</span>
                      </span>
                    : <span className="dc-commit dc-commit--none">not committed</span>}
                  {hasDeploy && <span className="dc-file dc-file--deploy">deploy</span>}
                  {hasRevert && <span className="dc-file dc-file--revert">revert</span>}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card icon={<ServerIcon size={15} />} title="Environments" hint="One per database: its address, schema and password"
        aside={<ButtonView variant="secondary" iconLeft={<PlusIcon size={12} />} label="Add" onClick={() => setCfg(prev => ({ ...prev, envs: [...prev.envs, { name: '', connUrl: '' }] }))} />}>
        <div className="dc-envs">
          {cfg.envs.map((env, i) => {
            const name = env.name.trim();
            const color = envColor(name);
            const test = connTest[name] ?? { status: 'idle' as const };
            return (
              <div key={i} data-testid={`env-card-${name || i}`} className="dc-env" style={{ borderColor: `color-mix(in srgb, ${color} 30%, transparent)` }}>
                <div className="dc-env-head">
                  <span className="dc-env-tag" style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)`, borderColor: `color-mix(in srgb, ${color} 32%, transparent)` }}>{(name || 'new').toUpperCase()}</span>
                  {cfg.env === name && name && <span className="dc-pill dc-pill--active">active</span>}
                  {env.hasPassword && <span className="dc-pill dc-pill--ok"><CheckIcon size={10} />password saved</span>}
                  <IconButtonView size="md" variant="ghost" icon={<CloseIcon size={13} />} tooltip={`Remove ${name || 'this environment'}`} color="var(--dm-c-ef4444)" style={{ marginLeft: 'auto' }} onClick={() => removeEnv(i)} />
                </div>
                <Row label="Name" tip="Short name used everywhere, e.g. test or prod">
                  <TextInputView size="md" width="fullWidth" aria-label="Environment name" value={env.name} onChange={e => updateEnv(i, { name: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} placeholder="test" spellCheck={false} />
                </Row>
                <Row label="Database URL" tip="postgresql://user@host:5432/db, without the password (saved to dmcr.cfg)">
                  <div className="dc-inline">
                    <TextInputView size="md" width="fullWidth" aria-label="Connection URL" value={env.connUrl}
                      onChange={e => { updateEnv(i, { connUrl: e.target.value }); setConnTest(prev => ({ ...prev, [name]: { status: 'idle' } })); }}
                      placeholder={`postgresql://user@host:5432/${name || 'db'}`} autoComplete="off" spellCheck={false} />
                    <ButtonView variant="secondary" iconLeft={test.status === 'testing' ? undefined : <ConnectIcon size={12} />} loading={test.status === 'testing'}
                      label={test.status === 'testing' ? 'Testing…' : 'Test'} disabled={!name || !env.connUrl.trim() || test.status === 'testing'}
                      onClick={() => { setConnTest(prev => ({ ...prev, [name]: { status: 'testing' } })); postMsg({ type: 'testDbConnection', payload: { conn: env.connUrl.trim(), env: name } }); }}
                      title="Test the connection (save first if you just typed the password)" />
                  </div>
                </Row>
                <Row label="Schema" tip="Fills ${schema} in your SQL here (e.g. zp_st on test, zp on prod), so the same files work everywhere">
                  <TextInputView size="md" width="fullWidth" aria-label="Schema" value={env.schema ?? ''} onChange={e => updateEnv(i, { schema: e.target.value.toLowerCase().replace(/[^a-z0-9_$]/g, '') })} placeholder="zp_st (optional)" spellCheck={false} />
                </Row>
                <Row label="Password" tip="Stored only in your OS keychain, never in a file">
                  <TextInputView size="md" width="fullWidth" type="password" aria-label="Password" value={env.password ?? ''}
                    onChange={e => updateEnv(i, { password: e.target.value })}
                    onFocus={() => { if (env.password === PASSWORD_SENTINEL) updateEnv(i, { password: '' }); }}
                    onBlur={() => { if (!env.password && env.hasPassword) updateEnv(i, { password: PASSWORD_SENTINEL }); }}
                    placeholder={env.hasPassword ? 'saved · type to replace' : 'password'} autoComplete="new-password" spellCheck={false} />
                </Row>
                {test.status === 'ok' && <div className="dc-test dc-test--ok"><CheckIcon size={12} />Connected · {test.message}</div>}
                {test.status === 'fail' && <div className="dc-test dc-test--bad"><CloseIcon size={12} />{test.message}</div>}
              </div>
            );
          })}
        </div>
        {envProblem && <p data-testid="env-problem" className="dc-error">{envProblem}</p>}
        <Row label="Compare database" tip="Optional extra database for Schema Diff's AI mode (full URL with password)">
          <TextInputView size="md" width="fullWidth" value={cfg.compareConnUrl} onChange={e => setCfg(prev => ({ ...prev, compareConnUrl: e.target.value }))} placeholder="optional, for Schema Diff" spellCheck={false} />
        </Row>
      </Card>

      <Card icon={<LayersIcon size={15} />} title="Release rules" hint="What each environment checks before a deploy (hover a column for details)">
        <div data-testid="release-pipeline" className="dc-rules">
          <span className="dc-rules-h">Environment</span>
          <span className="dc-rules-h" title="Deploy here only what already ran in that environment, with identical files">Promote from <span className="dc-tip">?</span></span>
          <span className="dc-rules-h" title="Block a change older than one already applied here">Older changes <span className="dc-tip">?</span></span>
          <span className="dc-rules-h" title="Each change needs a DBA sign-off for this environment (Releases > Approve); an edit after it needs a new one">Sign-off <span className="dc-tip">?</span></span>
          <span className="dc-rules-h" title="DBAs allowed to sign off, comma separated; empty = any DBA. Whoever made or asked for a change never signs it off">Who signs off <span className="dc-tip">?</span></span>
          {envNames.map(n => (
            <React.Fragment key={n}>
              <span className="dc-env-tag" style={{ justifySelf: 'start', color: envColor(n), background: `color-mix(in srgb, ${envColor(n)} 12%, transparent)`, borderColor: `color-mix(in srgb, ${envColor(n)} 32%, transparent)` }}>{n.toUpperCase()}</span>
              <DtSelect value={cfg.envRules[n]?.promoteFrom ?? ''} onChange={v => setRule(n, { promoteFrom: v })}
                options={[{ value: '', label: 'anything' }, ...envNames.filter(o => o !== n).map(o => ({ value: o, label: `only what ran on ${o}` }))]} />
              <DtSelect value={cfg.envRules[n]?.outOfOrder || 'allow'} onChange={v => setRule(n, { outOfOrder: v })}
                options={[{ value: 'allow', label: 'allowed' }, { value: 'block', label: 'blocked' }]} />
              <DtSelect value={cfg.envRules[n]?.approval || ''} onChange={v => setRule(n, { approval: v })}
                options={[{ value: '', label: 'not needed' }, { value: 'required', label: 'required' }]} />
              <TextInputView size="md" width="fullWidth" value={cfg.envRules[n]?.approvers ?? ''} onChange={e => setRule(n, { approvers: e.target.value })}
                placeholder={cfg.envRules[n]?.approval === 'required' ? 'any DBA' : '—'} disabled={cfg.envRules[n]?.approval !== 'required'} spellCheck={false} />
            </React.Fragment>
          ))}
        </div>
        <Row label="Edited after deploy" tip="What happens when files of an applied change are edited later">
          <DtSelect value={cfg.checksumPolicy || 'warn'} onChange={v => setCfg(prev => ({ ...prev, checksumPolicy: v }))}
            options={[{ value: 'warn', label: 'warn and continue (default)' }, { value: 'block', label: 'block the deploy' }, { value: 'repair', label: 'accept the edit (logged)' }]} />
        </Row>
      </Card>

      <Card icon={<BranchIcon size={15} />} title="Git" hint="Where change folders are committed and pushed">
        <Row label="Remote URL" tip="HTTPS or SSH URL of the repository; used by auto-commit and /sync">
          <TextInputView size="md" width="fullWidth" value={cfg.gitRemoteUrl} onChange={e => setCfg(prev => ({ ...prev, gitRemoteUrl: e.target.value }))} placeholder="https://github.com/org/repo.git" spellCheck={false} />
        </Row>
        <Row label="Branch" tip="Branch to push to and pull from; empty = the branch you are on">
          <div className="dc-inline">
            {remoteBranches.length > 0
              ? <SelectInputView size="md" width="100%" options={[{ value: '', label: '(current branch)' }, ...remoteBranches]} value={cfg.gitBranch} onChange={v => setCfg(prev => ({ ...prev, gitBranch: v }))} />
              : <TextInputView size="md" width="fullWidth" value={cfg.gitBranch} onChange={e => setCfg(prev => ({ ...prev, gitBranch: e.target.value }))} placeholder="current branch" spellCheck={false} />}
            <ButtonView variant="secondary" iconLeft={fetchingBranches ? undefined : <RefreshIcon size={12} />} loading={fetchingBranches} label="Fetch"
              disabled={!cfg.gitRemoteUrl.trim() || fetchingBranches} title="Fetch the remote's branches"
              onClick={() => { setFetchingBranches(true); postMsg({ type: 'fetchGitBranches', payload: { url: cfg.gitRemoteUrl.trim() } }); }} />
          </div>
        </Row>
        <Row label="Auto-commit" tip="Commit (with an AI message) and push every new change as soon as it is generated">
          <label className="dc-check"><CheckboxView checked={cfg.gitAutoCommit} onChange={checked => setCfg(prev => ({ ...prev, gitAutoCommit: checked }))} size="md" />Commit and push each new change</label>
        </Row>
      </Card>

      <section className="dc-card">
        <button type="button" className="dc-card-head dc-card-toggle" onClick={() => setShowAdvanced(v => !v)}>
          <span className="dc-card-icon"><ClockIcon size={15} /></span>
          <div className="dc-card-titles"><b>Advanced</b><span>psql, timeouts, Runner history</span></div>
          {showAdvanced ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        </button>
        {showAdvanced && (
          <div className="dc-card-body">
            <Row label="psql program" tip="Full path to psql; empty = use psql from PATH">
              <div className="dc-inline">
                <TextInputView size="md" width="fullWidth" value={cfg.psqlPath} onChange={e => setCfg(prev => ({ ...prev, psqlPath: e.target.value }))} placeholder="from PATH" spellCheck={false} />
                <ButtonView variant="secondary" iconLeft={<FolderOpenIcon size={14} />} label="Browse" onClick={() => postMsg({ type: 'pickFile', payload: { requestId: 'dmcrConfig:psql', filters: { 'psql': ['exe', ''] } } })} />
              </div>
            </Row>
            <Row label="Lock wait" tip="Give up when a table lock is not free after this long, e.g. 5s or 30s">
              <TextInputView size="md" width="sm" value={cfg.lockTimeout} onChange={e => setCfg(prev => ({ ...prev, lockTimeout: e.target.value }))} placeholder="30s" />
            </Row>
            <Row label="Statement limit" tip="Stop any statement that runs longer than this, e.g. 5min">
              <TextInputView size="md" width="sm" value={cfg.statementTimeout} onChange={e => setCfg(prev => ({ ...prev, statementTimeout: e.target.value }))} placeholder="5min" />
            </Row>
            <Row label="Runner history" tip="How many recent runs the Runner keeps (default 50)">
              <TextInputView size="md" width="sm" type="number" min={5} max={500} value={cfg.runHistoryLimit} onChange={e => setCfg(prev => ({ ...prev, runHistoryLimit: e.target.value }))} placeholder="50" />
            </Row>
          </div>
        )}
      </section>

      <div className="dc-savebar">
        <ButtonView variant="primary" iconLeft={<SaveIcon size={13} />} loading={saving} label={saving ? 'Saving…' : 'Save'} onClick={handleSave} disabled={saving || !!envProblem} />
        <span className="dc-muted">Writes dmcr.cfg · passwords go to your OS keychain</span>
      </div>
    </div>
  );
}
