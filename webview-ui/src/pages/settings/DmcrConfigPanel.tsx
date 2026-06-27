import React, { useState, useEffect } from 'react';
import { postMsg } from '../../vscode';
import type { ToastData } from '../../App';
import { WorkspaceIcon, FolderPickerIcon, EyeIcon, EyeOffIcon } from './icons';
import { DtSelect } from './shared';
import StyledDropdown from '../../components/StyledDropdown';
import type { DropdownItem } from '../../components/StyledDropdown';

interface ExtraEnv { name: string; connUrl: string; }

interface DmcrConfigState {
  env: string;
  changesDir: string;
  psqlPath: string;
  lockTimeout: string;
  statementTimeout: string;
  runHistoryLimit: string;
  // New model: URL (no password) stored in cfg, password stored in OS keychain
  devConnUrl: string;
  devPassword: string;
  prodConnUrl: string;
  prodPassword: string;
  hasDevPassword: boolean;
  hasProdPassword: boolean;
  compareConnUrl: string;
  extraEnvs: ExtraEnv[];
  // Legacy flags for old installs that stored the full URL in keychain
  hasDevConn: boolean;
  hasProdConn: boolean;
  cfgPath: string;
  gitRemoteUrl: string;
  gitAutoCommit: boolean;
  gitBranch: string;
}

const PASSWORD_SENTINEL = '••••••••••••';

type TestConnState = { status: 'idle' | 'testing' | 'ok' | 'fail'; message?: string };

export function DmcrConfigPanel({ addToast }: { addToast: (msg: string, type?: ToastData['type']) => void }) {
  const [cfg, setCfg] = useState<DmcrConfigState>({
    env: 'dev', changesDir: '', psqlPath: '', lockTimeout: '30s', statementTimeout: '5min',
    runHistoryLimit: '50',
    devConnUrl: '', devPassword: '', prodConnUrl: '', prodPassword: '',
    compareConnUrl: '', extraEnvs: [],
    hasDevPassword: false, hasProdPassword: false,
    hasDevConn: false, hasProdConn: false,
    cfgPath: '', gitRemoteUrl: '', gitAutoCommit: false, gitBranch: '',
  });
  const [showDevKey,  setShowDevKey]  = useState(false);
  const [showProdKey, setShowProdKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<DropdownItem[]>([]);
  const [fetchingBranches, setFetchingBranches] = useState(false);
  const [devConnTest,  setDevConnTest]  = useState<TestConnState>({ status: 'idle' });
  const [prodConnTest, setProdConnTest] = useState<TestConnState>({ status: 'idle' });
  const [changeFolders, setChangeFolders] = useState<Array<{ name: string; files: string[] }> | null>(null);
  const [changeFoldersLoading, setChangeFoldersLoading] = useState(false);
  const [changeFoldersError, setChangeFoldersError] = useState('');

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'dmcrConfig') {
        const p = msg.payload as DmcrConfigState & { extraEnvs?: ExtraEnv[] };
        setCfg(prev => ({
          ...prev,
          env:              p.env              ?? 'dev',
          changesDir:       p.changesDir       ?? '',
          psqlPath:         p.psqlPath         ?? '',
          lockTimeout:      p.lockTimeout      ?? '30s',
          statementTimeout: p.statementTimeout ?? '5min',
          runHistoryLimit:  p.runHistoryLimit  ?? '50',
          devConnUrl:       p.devConnUrl       ?? '',
          prodConnUrl:      p.prodConnUrl      ?? '',
          compareConnUrl:   p.compareConnUrl   ?? '',
          extraEnvs:        p.extraEnvs        ?? [],
          hasDevPassword:   p.hasDevPassword   ?? false,
          hasProdPassword:  p.hasProdPassword  ?? false,
          hasDevConn:       p.hasDevConn       ?? false,
          hasProdConn:      p.hasProdConn      ?? false,
          cfgPath:          p.cfgPath          ?? '',
          gitRemoteUrl:     p.gitRemoteUrl     ?? '',
          gitAutoCommit:    p.gitAutoCommit    ?? false,
          gitBranch:        p.gitBranch        ?? '',
          // Show sentinel only when a password is already stored
          devPassword:  prev.devPassword  || (p.hasDevPassword  ? PASSWORD_SENTINEL : ''),
          prodPassword: prev.prodPassword || (p.hasProdPassword ? PASSWORD_SENTINEL : ''),
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
          hasDevPassword:  msg.payload?.hasDevPassword  ?? prev.hasDevPassword,
          hasProdPassword: msg.payload?.hasProdPassword ?? prev.hasProdPassword,
          cfgPath:         msg.payload?.cfgPath         ?? prev.cfgPath,
          devPassword:  prev.hasDevPassword  || msg.payload?.hasDevPassword  ? PASSWORD_SENTINEL : '',
          prodPassword: prev.hasProdPassword || msg.payload?.hasProdPassword ? PASSWORD_SENTINEL : '',
        }));
        addToast('dmcr.cfg saved ✓  Password stored in OS keychain', 'ok');
      }
      if (msg?.type === 'testDbConnectionResult') {
        const { ok, message, env } = msg.payload as { ok: boolean; message: string; env: 'dev' | 'prod' };
        const setter = env === 'prod' ? setProdConnTest : setDevConnTest;
        setter({ status: ok ? 'ok' : 'fail', message });
      }
      if (msg?.type === 'dmcrConfigError') {
        setSaving(false);
        addToast(`Save failed: ${msg.payload?.message ?? 'unknown error'}`, 'error');
      }
      if (msg?.type === 'folderPicked') {
        setCfg(prev => ({ ...prev, changesDir: msg.payload?.path ?? prev.changesDir }));
      }
      if (msg?.type === 'filePicked') {
        setCfg(prev => ({ ...prev, psqlPath: msg.payload?.path ?? prev.psqlPath }));
      }
      if (msg?.type === 'lsChangesResult') {
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
        env:              cfg.env.trim(),
        changesDir:       cfg.changesDir.trim(),
        psqlPath:         cfg.psqlPath.trim(),
        lockTimeout:      cfg.lockTimeout.trim() || '30s',
        statementTimeout: cfg.statementTimeout.trim() || '5min',
        runHistoryLimit:  parseInt(cfg.runHistoryLimit) > 0 ? parseInt(cfg.runHistoryLimit) : 50,
        devConnUrl:       cfg.devConnUrl.trim()  || null,
        devPassword:      cfg.devPassword  === PASSWORD_SENTINEL ? null : cfg.devPassword.trim()  || null,
        prodConnUrl:      cfg.prodConnUrl.trim() || null,
        prodPassword:     cfg.prodPassword === PASSWORD_SENTINEL ? null : cfg.prodPassword.trim() || null,
        compareConnUrl:   cfg.compareConnUrl.trim() || null,
        extraEnvs:        cfg.extraEnvs.filter(e => e.name.trim()),
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

  const connField = (
    envLabel: 'DEV' | 'PROD',
    accentColor: string,
    connUrlKey: 'devConnUrl' | 'prodConnUrl',
    passwordKey: 'devPassword' | 'prodPassword',
    hasPassword: boolean,
    hasLegacyConn: boolean,
    showKey: boolean,
    setShowKey: (v: boolean) => void,
    testState: TestConnState,
    setTestState: (s: TestConnState) => void,
  ) => {
    const envName      = envLabel === 'DEV' ? 'dev' : 'prod';
    const keychainKey  = envLabel === 'DEV' ? 'dmcr.devPassword' : 'dmcr.prodPassword';
    const hasAnySecret = hasPassword || hasLegacyConn;

    const handleTestConn = () => {
      const connUrl = cfg[connUrlKey].trim();
      if (!connUrl && !hasAnySecret) return;
      setTestState({ status: 'testing' });
      postMsg({ type: 'testDbConnection', payload: { conn: connUrl, env: envName } });
    };

    return (
      <div className="bs-field-group" style={{ marginBottom: 24 }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{
            fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8,
            color: accentColor, background: `${accentColor}18`,
            border: `1px solid ${accentColor}40`, padding: '2px 8px', borderRadius: 10,
          }}>{envLabel}</span>
          <span className="bs-label" style={{ margin: 0 }}>{envName} connection</span>
          {hasAnySecret && (
            <span style={{ fontSize: 10, fontWeight: 500, color: '#22c55e', background: 'rgba(34,197,94,0.12)', padding: '2px 8px', borderRadius: 10 }}>
              ✓ Saved in secure OS storage
            </span>
          )}
        </div>

        {/* Connection URL (no password) */}
        <p className="bs-hint" style={{ marginBottom: 4 }}>
          Connection URL <em>without</em> password — written to <code>dmcr.cfg</code> (safe to commit).
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <input
            className="bs-input"
            type="text"
            value={cfg[connUrlKey]}
            onChange={e => { set(connUrlKey)(e); setTestState({ status: 'idle' }); }}
            placeholder={`postgresql://user@host:5432/${envName.toLowerCase()}db?sslmode=require`}
            style={{ flex: 1, borderColor: `${accentColor}40`, fontFamily: 'ui-monospace,monospace', fontSize: 12 }}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className="bs-btn-sm bs-btn-success"
            onClick={handleTestConn}
            disabled={testState.status === 'testing' || (!cfg[connUrlKey].trim() && !hasAnySecret)}
            title="Test connection"
            style={{ flexShrink: 0 }}
          >
            {testState.status === 'testing' ? (
              <>
                <span style={{ display: 'inline-block', width: 11, height: 11, borderRadius: '50%', border: '2px solid #10b98160', borderTopColor: '#10b981', animation: 'spin 0.7s linear infinite' }} />
                Testing…
              </>
            ) : 'Test'}
          </button>
        </div>

        {/* Password field */}
        <p className="bs-hint" style={{ marginBottom: 4 }}>
          Password — stored only in OS Keychain, never written to disk.
          Leave blank to keep existing.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="bs-input"
            type="password"
            value={cfg[passwordKey]}
            onChange={e => { set(passwordKey)(e); }}
            onFocus={() => {
              if (cfg[passwordKey] === PASSWORD_SENTINEL) setCfg(prev => ({ ...prev, [passwordKey]: '' }));
            }}
            onBlur={() => {
              if (!cfg[passwordKey] && hasPassword) setCfg(prev => ({ ...prev, [passwordKey]: PASSWORD_SENTINEL }));
            }}
            placeholder={hasPassword ? 'Leave blank to keep existing' : 'Enter password'}
            style={{ flex: 1, borderColor: `${accentColor}40` }}
            autoComplete="new-password"
            spellCheck={false}
          />
          {/* Eye button shows the OS keychain key name — never reveals the value */}
          <button
            className="bs-btn-sm"
            onClick={() => setShowKey(!showKey)}
            title={showKey ? 'Hide keychain key' : 'Show keychain key name'}
            style={{ flexShrink: 0 }}
          >
            {showKey ? <EyeOffIcon style={{ width: 15, height: 15 }} /> : <EyeIcon style={{ width: 15, height: 15 }} />}
          </button>
        </div>

        {/* Keychain key name badge — shown when eye is open */}
        {showKey && (
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
            <span style={{ color: 'var(--vscode-descriptionForeground)' }}>OS Keychain key:</span>
            <code style={{
              background: 'rgba(99,102,241,0.12)', color: '#818cf8',
              border: '1px solid rgba(99,102,241,0.3)',
              padding: '2px 8px', borderRadius: 6, fontSize: 11, letterSpacing: 0.3,
            }}>{keychainKey}</code>
            <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 10.5 }}>
              (open <strong>Keychain Access</strong> on macOS to inspect)
            </span>
          </div>
        )}

        {/* Test result */}
        {testState.status === 'ok' && (
          <div style={{ marginTop: 6, fontSize: 11.5, color: '#10b981', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span>✓</span><span>Connected — {testState.message}</span>
          </div>
        )}
        {testState.status === 'fail' && (
          <div style={{ marginTop: 6, fontSize: 11.5, color: '#ef4444', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
            <span>✗</span><span>Connection failed: {testState.message}</span>
          </div>
        )}
      </div>
    );
  };

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
          border: '1px solid rgba(251,191,36,.4)', background: 'rgba(251,191,36,.06)',
          display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <div style={{ lineHeight: 1.5 }}>
            <span style={{ fontWeight: 700, color: '#fbbf24' }}>Changes directory not configured.</span>
            <span style={{ color: 'var(--text-secondary, #94a3b8)' }}> Set the <strong>Changes directory</strong> field below and save to enable change generation.</span>
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

      <div className="bs-field-group" style={{ marginBottom: 20 }}>
        <label className="bs-label">Active environment</label>
        <p className="bs-hint" style={{ marginBottom: 8 }}>Which connection to use when running the runner tab.</p>
        <DtSelect
          value={cfg.env}
          onChange={v => setCfg(prev => ({ ...prev, env: v }))}
          options={[
            { value: 'dev',  label: 'dev',  badge: 'DEV',  badgeColor: '#3b82f6' },
            { value: 'prod', label: 'prod', badge: 'PROD', badgeColor: '#ef4444' },
            ...cfg.extraEnvs.filter(e => e.name.trim()).map(e => ({
              value: e.name, label: e.name,
              badge: e.name.toUpperCase(), badgeColor: '#8b5cf6',
            })),
          ]}
        />
      </div>

      {field(
        'Changes directory',
        'Absolute or workspace-relative path where DMCR change folders will be created.',
        'changesDir',
        'db/changes',
        <button className="bs-btn-sm" onClick={() => postMsg({ type: 'pickFolder' })} title="Browse"
          style={{ flexShrink: 0 }}>
          <FolderPickerIcon style={{ width: 16, height: 16, color: 'var(--bs-status-warn, #f59e0b)' }} /> Browse
        </button>,
      )}

      {/* ── Changes folder browser (D9.3) ── */}
      {cfg.changesDir && (
        <div style={{ marginBottom: 12 }}>
          <button
            className="bs-btn-sm bs-btn-ghost"
            style={{ fontSize: 11 }}
            onClick={() => {
              setChangeFoldersLoading(true);
              setChangeFolders(null);
              setChangeFoldersError('');
              postMsg({ type: 'lsChanges', payload: {} });
            }}
          >
            {changeFoldersLoading ? 'Loading…' : (changeFolders ? `↺ Refresh (${changeFolders.length} changes)` : '📂 Browse changes folder')}
          </button>
          {changeFoldersError && <p style={{ fontSize: 11, color: '#f87171', margin: '4px 0 0' }}>{changeFoldersError}</p>}
          {changeFolders && (
            <div style={{ marginTop: 8, maxHeight: 200, overflowY: 'auto', background: 'var(--bg-secondary, rgba(255,255,255,0.03))', borderRadius: 6, border: '1px solid rgba(255,255,255,0.07)', padding: '4px 0' }}>
              {changeFolders.length === 0 ? (
                <p style={{ fontSize: 11, color: '#64748b', padding: '8px 12px', margin: 0 }}>No change folders found.</p>
              ) : changeFolders.map(f => {
                const hasDeploy = f.files.some(n => n.startsWith('deploy'));
                const hasRevert = f.files.some(n => n.startsWith('revert'));
                return (
                  <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', fontSize: 11, fontFamily: 'monospace', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <span style={{ color: '#4ade80', flexShrink: 0 }}>📁</span>
                    <span style={{ flex: 1, color: 'var(--text-primary, #e2e8f0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    {hasDeploy && <span style={{ color: '#818cf8', fontSize: 10, padding: '1px 4px', background: 'rgba(99,102,241,0.12)', borderRadius: 3 }}>deploy</span>}
                    {hasRevert && <span style={{ color: '#fb923c', fontSize: 10, padding: '1px 4px', background: 'rgba(251,146,60,0.12)', borderRadius: 3 }}>revert</span>}
                    <span style={{ color: '#475569', fontSize: 10 }}>{f.files.length} file{f.files.length !== 1 ? 's' : ''}</span>
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
        <button className="bs-btn-sm" onClick={() => postMsg({ type: 'pickFile', payload: { filters: { 'psql': ['exe', ''] } } })} title="Browse"
          style={{ flexShrink: 0 }}>
          <FolderPickerIcon style={{ width: 16, height: 16, color: 'var(--bs-status-warn, #f59e0b)' }} /> Browse
        </button>,
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
              <StyledDropdown
                items={[{ value: '', label: '(use current branch)' }, ...remoteBranches]}
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
          <button
            className="bs-btn-sm"
            disabled={!cfg.gitRemoteUrl.trim() || fetchingBranches}
            onClick={() => {
              setFetchingBranches(true);
              postMsg({ type: 'fetchGitBranches', payload: { url: cfg.gitRemoteUrl.trim() } });
            }}
            title="Fetch branches from remote"
            style={{ flexShrink: 0 }}
          >
            {fetchingBranches ? '⏳' : '🔄'} Fetch
          </button>
        </div>
      </div>

      <div className="bs-field-group" style={{ marginBottom: 20 }}>
        <label className="bs-label" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={cfg.gitAutoCommit}
            onChange={e => setCfg(prev => ({ ...prev, gitAutoCommit: e.target.checked }))}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
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

      {connField('DEV',  '#3b82f6', 'devConnUrl',  'devPassword',  cfg.hasDevPassword,  cfg.hasDevConn,  showDevKey,  setShowDevKey,  devConnTest,  setDevConnTest)}
      {connField('PROD', '#ef4444', 'prodConnUrl', 'prodPassword', cfg.hasProdPassword, cfg.hasProdConn, showProdKey, setShowProdKey, prodConnTest, setProdConnTest)}

      {/* Compare Target (Schema Diff) */}
      <div className="bs-field-group" style={{ marginTop: 12 }}>
        <label className="bs-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ background: '#7c3aed', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, letterSpacing: '0.04em' }}>COMPARE</span>
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

      {/* ── Extra environments (D11.8 multi-env) ── */}
      {cfg.extraEnvs.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div className="bs-info-section-title" style={{ marginBottom: 10 }}>Extra environments</div>
          {cfg.extraEnvs.map((env, i) => (
            <div key={i} className="bs-field-group" style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{
                  fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8,
                  color: '#8b5cf6', background: 'rgba(139,92,246,0.12)',
                  border: '1px solid rgba(139,92,246,0.3)', padding: '2px 8px', borderRadius: 10,
                }}>ENV</span>
                <input
                  className="bs-input"
                  type="text"
                  value={env.name}
                  onChange={e => {
                    const updated = [...cfg.extraEnvs];
                    updated[i] = { ...updated[i], name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') };
                    setCfg(prev => ({ ...prev, extraEnvs: updated }));
                  }}
                  placeholder="env name (e.g. st, uat)"
                  style={{ width: 140, fontFamily: 'ui-monospace,monospace', fontSize: 12 }}
                />
                <button
                  className="bs-btn-sm"
                  title="Remove environment"
                  style={{ marginLeft: 'auto', color: '#ef4444' }}
                  onClick={() => setCfg(prev => ({ ...prev, extraEnvs: prev.extraEnvs.filter((_, j) => j !== i) }))}
                >&#x2715;</button>
              </div>
              <input
                className="bs-input"
                type="text"
                value={env.connUrl}
                onChange={e => {
                  const updated = [...cfg.extraEnvs];
                  updated[i] = { ...updated[i], connUrl: e.target.value };
                  setCfg(prev => ({ ...prev, extraEnvs: updated }));
                }}
                placeholder="postgresql://user@host:5432/dbname?sslmode=require"
                style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12 }}
              />
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: cfg.extraEnvs.length > 0 ? 8 : 16 }}>
        <button
          className="bs-btn-sm bs-btn-ghost"
          style={{ fontSize: 11 }}
          onClick={() => setCfg(prev => ({ ...prev, extraEnvs: [...prev.extraEnvs, { name: '', connUrl: '' }] }))}
        >
          + Add environment
        </button>
      </div>

      <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="bs-btn-sm bs-btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save & Write Cfg'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-secondary, #64748b)' }}>
          Writes <code>scripts/runner/dmcr.cfg</code> · password stored in OS keychain only
        </span>
      </div>
    </div>
  );
}
