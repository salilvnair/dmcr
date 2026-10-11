import React, { useState, useEffect } from 'react';
import {
  ButtonView, CheckboxView, CheckIcon, CloseIcon, FolderIcon, FolderOpenIcon, IconButtonView, PlusIcon,
  RefreshIcon, SaveIcon, SelectInputView, ConnectIcon,
} from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import type { ToastData } from '../../App';
import { WorkspaceIcon } from './icons';
import { DtSelect } from './shared';
import DbaProfileField from './DbaProfileField';

interface EnvConn { name: string; connUrl: string; password?: string; hasPassword?: boolean; }
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
  const [changeFolders, setChangeFolders] = useState<Array<{ name: string; files: string[] }> | null>(null);
  const [changeFoldersLoading, setChangeFoldersLoading] = useState(false);
  const [changeFoldersError, setChangeFoldersError] = useState('');

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
          name: e.name.trim(), connUrl: e.connUrl.trim(),
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

  const field = (label: string, hint: string, key: keyof DmcrConfigState, placeholder?: string, extra?: React.ReactNode) => (
    <div className="bs-field-group">
      <label className="bs-label">{label}</label>
      {hint && <p className="bs-hint">{hint}</p>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          className="bs-input"
          type="text"
          value={cfg[key] as string}
          onChange={set(key)}
          placeholder={placeholder ?? ''}
          style={{ flex: 1 }}
        />
        {extra}
      </div>
    </div>
  );

  const showMissingWorkspaceBanner = cfg.changesDir === '' && cfg.cfgPath !== '';

  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head">
        <WorkspaceIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3">DMCR Config</h3>
      </div>

      {showMissingWorkspaceBanner && (
        <div style={{
          marginBottom: 14, padding: '10px 14px', borderRadius: 8,
          border: '1px solid color-mix(in srgb, var(--dm-c-fbbf24) 40%, transparent)', background: 'color-mix(in srgb, var(--dm-c-fbbf24) 6%, transparent)',
          display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--dm-c-fbbf24)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <div style={{ lineHeight: 1.5 }}>
            <span style={{ fontWeight: 700, color: 'var(--dm-c-fbbf24)' }}>Changes directory not configured.</span>
            <span style={{ color: 'var(--text-secondary, var(--dm-c-94a3b8))' }}> Set the <strong>Changes directory</strong> field below and save to enable change generation.</span>
          </div>
        </div>
      )}

      <div className="bs-info-banner" style={{ fontSize: 11.5, color: 'var(--bs-info-color, var(--vscode-descriptionForeground))', padding: '8px 12px', borderRadius: 6, background: 'var(--bs-info-bg, var(--vscode-textCodeBlock-background))', marginBottom: 18, lineHeight: 1.6 }}>
        Saved to <code style={{ color: 'var(--vscode-textLink-foreground)', fontSize: 11 }}>
          {cfg.cfgPath || 'scripts/runner/dmcr.cfg (inside extension)'}
        </code>.
        Connection URLs (without passwords) are written to the cfg file.
        Passwords are stored only in <strong>OS Keychain</strong> via VS Code SecretStorage.
      </div>

      {/* ── General ── */}
      <div className="bs-info-section-title" style={{ margin: '0 0 12px' }}>General</div>

      <DbaProfileField />

      <div className="bs-field-group" style={{ marginBottom: 20 }}>
        <label className="bs-label">Active environment</label>
        <p className="bs-hint" style={{ marginBottom: 8 }}>Which connection to use when running the runner tab.</p>
        <DtSelect
          value={cfg.env}
          onChange={v => setCfg(prev => ({ ...prev, env: v }))}
          options={envNames.map(n => ({ value: n, label: n, badge: n.toUpperCase(), badgeColor: envColor(n) }))}
        />
      </div>

      {field(
        'Changes directory',
        'Absolute or workspace-relative path where DMCR change folders will be created.',
        'changesDir',
        'db/changes',
        <ButtonView
          variant="secondary"
          iconLeft={<FolderOpenIcon size={14} style={{ color: 'var(--bs-status-warn, var(--dm-c-f59e0b))' }} />}
          label="Browse"
          onClick={() => postMsg({ type: 'pickFolder', payload: { requestId: 'dmcrConfig:changesDir' } })}
          title="Browse"
          style={{ flexShrink: 0 }}
        />,
      )}

      {/* ── Changes folder browser (D9.3) ── */}
      {cfg.changesDir && (
        <div style={{ marginBottom: 12 }}>
          <ButtonView
            variant="ghost"
            loading={changeFoldersLoading}
            iconLeft={changeFoldersLoading ? undefined : (changeFolders ? <RefreshIcon size={12} /> : <FolderOpenIcon size={12} />)}
            label={changeFoldersLoading ? 'Loading…' : (changeFolders
              ? `Refresh (${changeFolders.length} changes)`
              : 'Browse changes folder')}
            onClick={() => {
              setChangeFoldersLoading(true);
              setChangeFolders(null);
              setChangeFoldersError('');
              postMsg({ type: 'lsChanges', payload: { requestId: 'dmcrConfig' } });
            }}
          />
          {changeFoldersError && <p style={{ fontSize: 11, color: 'var(--dm-c-f87171)', margin: '4px 0 0' }}>{changeFoldersError}</p>}
          {changeFolders && (
            <div style={{ marginTop: 8, maxHeight: 200, overflowY: 'auto', background: 'var(--bg-secondary, color-mix(in srgb, var(--dm-c-ffffff) 3%, transparent))', borderRadius: 6, border: '1px solid color-mix(in srgb, var(--dm-c-ffffff) 7%, transparent)', padding: '4px 0' }}>
              {changeFolders.length === 0 ? (
                <p style={{ fontSize: 11, color: 'var(--dm-c-64748b)', padding: '8px 12px', margin: 0 }}>No change folders found.</p>
              ) : changeFolders.map(f => {
                const hasDeploy = f.files.some(n => n.startsWith('deploy'));
                const hasRevert = f.files.some(n => n.startsWith('revert'));
                return (
                  <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', fontSize: 11, fontFamily: 'monospace', borderBottom: '1px solid color-mix(in srgb, var(--dm-c-ffffff) 4%, transparent)' }}>
                    <span style={{ color: 'var(--dm-c-4ade80)', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}><FolderIcon size={12} /></span>
                    <span style={{ flex: 1, color: 'var(--text-primary, var(--dm-c-e2e8f0))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    {hasDeploy && <span style={{ color: 'var(--dm-c-818cf8)', fontSize: 10, padding: '1px 4px', background: 'color-mix(in srgb, var(--dm-c-6366f1) 12%, transparent)', borderRadius: 3 }}>deploy</span>}
                    {hasRevert && <span style={{ color: 'var(--dm-c-fb923c)', fontSize: 10, padding: '1px 4px', background: 'color-mix(in srgb, var(--dm-c-fb923c) 12%, transparent)', borderRadius: 3 }}>revert</span>}
                    <span style={{ color: 'var(--dm-c-475569)', fontSize: 10 }}>{f.files.length} file{f.files.length !== 1 ? 's' : ''}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {field(
        'psql path',
        'Absolute path to the psql executable on Windows or macOS. Leave blank to rely on PATH.',
        'psqlPath',
        'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe or /opt/homebrew/bin/psql',
        <ButtonView
          variant="secondary"
          iconLeft={<FolderOpenIcon size={14} style={{ color: 'var(--bs-status-warn, var(--dm-c-f59e0b))' }} />}
          label="Browse"
          onClick={() => postMsg({ type: 'pickFile', payload: { requestId: 'dmcrConfig:psql', filters: { 'psql': ['exe', ''] } } })}
          title="Browse"
          style={{ flexShrink: 0 }}
        />,
      )}

      {/* ── Git Integration ── */}
      <div className="bs-info-section-title" style={{ margin: '20px 0 12px' }}>Git Integration</div>

      {field(
        'GitHub Remote URL',
        'HTTPS or SSH URL for the git remote. Used by auto-commit and /sync.',
        'gitRemoteUrl',
        'https://github.com/org/repo.git',
      )}

      <div className="bs-field-group" style={{ marginBottom: 16 }}>
        <label className="bs-label">Branch</label>
        <p className="bs-hint">Target branch for push/pull. Leave empty to use the currently checked-out branch.</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {remoteBranches.length > 0 ? (
            <div style={{ flex: 1 }}>
              <SelectInputView size="md"
                width="100%"
                options={[{ value: '', label: '(use current branch)' }, ...remoteBranches]}
                value={cfg.gitBranch}
                onChange={v => setCfg(prev => ({ ...prev, gitBranch: v }))}
              />
            </div>
          ) : (
            <input
              className="bs-input"
              type="text"
              value={cfg.gitBranch}
              onChange={e => setCfg(prev => ({ ...prev, gitBranch: e.target.value }))}
              placeholder="main"
              style={{ flex: 1 }}
            />
          )}
          <ButtonView
            variant="secondary"
            iconLeft={fetchingBranches ? undefined : <RefreshIcon size={12} />}
            loading={fetchingBranches}
            label="Fetch"
            disabled={!cfg.gitRemoteUrl.trim() || fetchingBranches}
            onClick={() => {
              setFetchingBranches(true);
              postMsg({ type: 'fetchGitBranches', payload: { url: cfg.gitRemoteUrl.trim() } });
            }}
            title="Fetch branches from remote"
            style={{ flexShrink: 0 }}
          />
        </div>
      </div>

      <div className="bs-field-group" style={{ marginBottom: 20 }}>
        <label className="bs-label" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <CheckboxView
            checked={cfg.gitAutoCommit}
            onChange={checked => setCfg(prev => ({ ...prev, gitAutoCommit: checked }))}
            size="md"
          />
          Auto-commit on change generation
        </label>
        <p className="bs-hint" style={{ marginLeft: 26 }}>
          When enabled, DMCR will automatically <code>git add</code>, generate an AI commit message, <code>commit</code>, and <code>push</code> after every successful change generation. Disable to use manual <code>/sync</code> instead.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <div className="bs-field-group" style={{ flex: 1 }}>
          <label className="bs-label">Lock timeout</label>
          <p className="bs-hint">Abort if waiting on a lock longer than this. Examples: <code>5s</code>, <code>30s</code></p>
          <input className="bs-input" type="text" value={cfg.lockTimeout} onChange={set('lockTimeout')} placeholder="30s" />
        </div>
        <div className="bs-field-group" style={{ flex: 1 }}>
          <label className="bs-label">Statement timeout</label>
          <p className="bs-hint">Abort any statement running longer than this. Examples: <code>5min</code>, <code>30s</code></p>
          <input className="bs-input" type="text" value={cfg.statementTimeout} onChange={set('statementTimeout')} placeholder="5min" />
        </div>
      </div>

      <div className="bs-field-group" style={{ marginBottom: 20 }}>
        <label className="bs-label">Recent runs limit</label>
        <p className="bs-hint">Maximum number of recent runs shown in the Runner tab history panel. Default: <code>50</code>.</p>
        <input className="bs-input" type="number" min={5} max={500} value={cfg.runHistoryLimit} onChange={set('runHistoryLimit')} placeholder="50" style={{ width: 100 }} />
      </div>

      {/* ── Connections ── */}
      <div className="bs-info-section-title" style={{ margin: '20px 0 14px' }}>Database connections</div>

      <p className="bs-hint" style={{ marginBottom: 12 }}>
        One card per environment: name it, give its URL <em>without</em> password (written to <code>dmcr.cfg</code>, safe to commit)
        and its password (OS keychain only, as <code>dmcr.&lt;name&gt;Password</code>). Add as many as you need; remove one with
        the <strong>×</strong>, and Save takes it out of <code>dmcr.cfg</code> with its stored password.
      </p>
      {cfg.envs.map((env, i) => {
        const name = env.name.trim();
        const color = envColor(name);
        const test = connTest[name] ?? { status: 'idle' as const };
        return (
          <div key={i} data-testid={`env-card-${name || i}`} className="bs-field-group" style={{ marginBottom: 18, padding: '10px 12px', borderRadius: 8, border: `1px solid color-mix(in srgb, ${color} 22%, transparent)` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{
                fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8,
                color, background: `color-mix(in srgb, ${color} 10%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`, padding: '2px 8px', borderRadius: 10,
              }}>{(name || 'new').toUpperCase()}</span>
              <input
                className="bs-input"
                type="text"
                aria-label="Environment name"
                value={env.name}
                onChange={e => updateEnv(i, { name: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })}
                placeholder="name, e.g. test"
                style={{ width: 160, fontFamily: 'ui-monospace,monospace', fontSize: 12 }}
                spellCheck={false}
              />
              {cfg.env === name && name && (
                <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--dm-c-6366f1)', background: 'color-mix(in srgb, var(--dm-c-6366f1) 12%, transparent)', padding: '2px 8px', borderRadius: 10 }}>active</span>
              )}
              {env.hasPassword && (
                <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--dm-c-22c55e)', background: 'color-mix(in srgb, var(--dm-c-22c55e) 12%, transparent)', padding: '2px 8px', borderRadius: 10, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <CheckIcon size={10} />Password in OS keychain
                </span>
              )}
              <IconButtonView size="md"
                variant="ghost"
                icon={<CloseIcon size={13} />}
                tooltip={`Remove ${name || 'this environment'}`}
                color="var(--dm-c-ef4444)"
                style={{ marginLeft: 'auto' }}
                onClick={() => removeEnv(i)}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <input
                className="bs-input"
                type="text"
                aria-label="Connection URL"
                value={env.connUrl}
                onChange={e => { updateEnv(i, { connUrl: e.target.value }); setConnTest(prev => ({ ...prev, [name]: { status: 'idle' } })); }}
                placeholder={`postgresql://user@host:5432/${name || 'dbname'}?sslmode=require  (no password)`}
                style={{ flex: 1, fontFamily: 'ui-monospace,monospace', fontSize: 12 }}
                autoComplete="off"
                spellCheck={false}
              />
              <ButtonView
                variant="secondary"
                iconLeft={test.status === 'testing' ? undefined : <ConnectIcon size={12} />}
                loading={test.status === 'testing'}
                label={test.status === 'testing' ? 'Testing…' : 'Test'}
                disabled={!name || !env.connUrl.trim() || test.status === 'testing'}
                onClick={() => { setConnTest(prev => ({ ...prev, [name]: { status: 'testing' } })); postMsg({ type: 'testDbConnection', payload: { conn: env.connUrl.trim(), env: name } }); }}
                title="Test connection (save first if you just entered the password)"
                style={{ flexShrink: 0 }}
              />
            </div>
            <input
              className="bs-input"
              type="password"
              aria-label="Password"
              value={env.password ?? ''}
              onChange={e => updateEnv(i, { password: e.target.value })}
              onFocus={() => { if (env.password === PASSWORD_SENTINEL) updateEnv(i, { password: '' }); }}
              onBlur={() => { if (!env.password && env.hasPassword) updateEnv(i, { password: PASSWORD_SENTINEL }); }}
              placeholder={env.hasPassword ? 'Password — leave blank to keep existing' : `Password — stored only in OS Keychain as dmcr.${name || '<name>'}Password`}
              autoComplete="new-password"
              spellCheck={false}
            />
            {test.status === 'ok' && <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--dm-c-10b981)', display: 'flex', alignItems: 'center', gap: 5 }}><CheckIcon size={12} style={{ flexShrink: 0 }} /><span>Connected — {test.message}</span></div>}
            {test.status === 'fail' && <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--dm-c-ef4444)', display: 'flex', alignItems: 'flex-start', gap: 5 }}><CloseIcon size={12} style={{ flexShrink: 0, marginTop: 2 }} /><span>Connection failed: {test.message}</span></div>}
          </div>
        );
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <ButtonView
          variant="ghost"
          iconLeft={<PlusIcon size={12} />}
          label="Add environment"
          onClick={() => setCfg(prev => ({ ...prev, envs: [...prev.envs, { name: '', connUrl: '' }] }))}
        />
        {envProblem && <span data-testid="env-problem" style={{ fontSize: 11.5, color: 'var(--dm-c-ef4444)' }}>{envProblem}</span>}
      </div>

      {/* Compare Target (Schema Diff) */}
      <div className="bs-field-group" style={{ marginTop: 12 }}>
        <label className="bs-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ background: 'var(--dm-c-7c3aed)', color: 'var(--dm-c-ffffff)', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, letterSpacing: '0.04em' }}>COMPARE</span>
          Compare Target
        </label>
        <p className="bs-hint">Optional second DB for Schema Diff (AI mode). Full connection URL including password. Used as the compare target in <em>Schema Diff → AI mode</em>.</p>
        <input
          className="bs-input"
          type="text"
          value={cfg.compareConnUrl}
          onChange={set('compareConnUrl')}
          placeholder="postgresql://user:pass@host:5432/dbname  (compare / PROD target)"
          style={{ flex: 1 }}
        />
      </div>

      {/* ── Release pipeline: promotion gate, out-of-order guard, checksum policy ── */}
      <div className="bs-info-section-title" style={{ margin: '24px 0 10px' }}>Release pipeline</div>
      <p className="bs-hint" style={{ marginBottom: 10 }}>
        <strong>Promote from</strong>: the runner deploys to this environment only changes already applied in the source
        environment with byte-identical deploy, verify and revert files — checked for the whole plan before anything runs.{' '}
        <strong>Out of order</strong>: block a pending change that sorts before one already applied.{' '}
        <strong>Approval</strong>: every change needs a sign-off for this environment before it deploys (Releases &gt; Approve);
        an edit after the sign-off needs a new one. <strong>Approvers</strong>: the DBA names allowed to sign off (comma separated,
        empty = any DBA); whoever created or requested a change never approves it.
      </p>
      <div data-testid="release-pipeline" style={{ display: 'grid', gridTemplateColumns: 'minmax(80px,auto) 1fr 1fr 1fr 1.4fr', gap: '8px 12px', alignItems: 'center', marginBottom: 14 }}>
        <span className="bs-hint" style={{ margin: 0 }}>Environment</span>
        <span className="bs-hint" style={{ margin: 0 }}>Promote from</span>
        <span className="bs-hint" style={{ margin: 0 }}>Out of order</span>
        <span className="bs-hint" style={{ margin: 0 }}>Approval</span>
        <span className="bs-hint" style={{ margin: 0 }}>Approvers</span>
        {envNames.map(n => (
          <React.Fragment key={n}>
            <code style={{ fontSize: 12 }}>{n}</code>
            <DtSelect
              value={cfg.envRules[n]?.promoteFrom ?? ''}
              onChange={v => setRule(n, { promoteFrom: v })}
              options={[{ value: '', label: '— no gate —' }, ...envNames.filter(o => o !== n).map(o => ({ value: o, label: o }))]}
            />
            <DtSelect
              value={cfg.envRules[n]?.outOfOrder || 'allow'}
              onChange={v => setRule(n, { outOfOrder: v })}
              options={[{ value: 'allow', label: 'allow' }, { value: 'block', label: 'block' }]}
            />
            <DtSelect
              value={cfg.envRules[n]?.approval || ''}
              onChange={v => setRule(n, { approval: v })}
              options={[{ value: '', label: 'not required' }, { value: 'required', label: 'required' }]}
            />
            <input
              className="bs-input"
              value={cfg.envRules[n]?.approvers ?? ''}
              onChange={e => setRule(n, { approvers: e.target.value })}
              placeholder={cfg.envRules[n]?.approval === 'required' ? 'any DBA (or: maria.lopez, tom.okafor)' : '—'}
              disabled={cfg.envRules[n]?.approval !== 'required'}
              spellCheck={false}
            />
          </React.Fragment>
        ))}
      </div>
      <div className="bs-field-group" style={{ marginBottom: 6 }}>
        <label className="bs-label">Checksum policy</label>
        <p className="bs-hint">When files of an applied change are edited afterwards: <code>warn</code> and continue, <code>block</code> the deploy, or <code>repair</code> (accept the edit, recorded in <code>dmcr.event_log</code>).</p>
        <DtSelect
          value={cfg.checksumPolicy || 'warn'}
          onChange={v => setCfg(prev => ({ ...prev, checksumPolicy: v }))}
          options={[{ value: 'warn', label: 'warn (default)' }, { value: 'block', label: 'block' }, { value: 'repair', label: 'repair' }]}
        />
      </div>

      <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
        <ButtonView
          variant="primary"
          iconLeft={<SaveIcon size={13} />}
          loading={saving}
          label={saving ? 'Saving…' : 'Save & Write Cfg'}
          onClick={handleSave}
          disabled={saving || !!envProblem}
        />
        <span style={{ fontSize: 11, color: 'var(--text-secondary, var(--dm-c-64748b))' }}>
          Writes <code>scripts/runner/dmcr.cfg</code> · password stored in OS keychain only
        </span>
      </div>
    </div>
  );
}
