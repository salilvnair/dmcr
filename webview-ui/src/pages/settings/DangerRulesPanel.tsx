import React, { useState, useEffect } from 'react';
import { ButtonView, CheckboxView, RefreshIcon, SaveIcon } from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import type { ToastData } from '../../App';
import { DangerIcon } from './icons';

interface DangerRule { label: string; regex: string; scope: 'deployOnly' | 'always'; enabled?: boolean; }
interface DangerRulesFile {
  deployOnlyPatterns: DangerRule[];
  alwaysPatterns: DangerRule[];
  deleteWithoutWhereEnabled: boolean;
  updateWithoutWhereEnabled: boolean;
}

/** dmcr_danger.json in the given folder, with that folder's own path separator */
function rulesFilePath(dir: string): string {
  if (!dir) return 'dmcr_danger.json';
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}dmcr_danger.json`;
}

export function DangerRulesPanel({ addToast }: { addToast: (msg: string, type?: ToastData['type']) => void }) {
  const [rules, setRules] = useState<DangerRulesFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [dangerRulesDir, setDangerRulesDir] = useState('');

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'dangerRulesLoaded') {
        setRules(msg.payload.rules);
        setDangerRulesDir(msg.payload.dangerRulesDir ?? '');
        setLoading(false);
      }
      if (msg?.type === 'dangerRulesSaved')  {
        setDangerRulesDir(msg.payload?.dangerRulesDir ?? dangerRulesDir);
        addToast('Danger rules saved ✓', 'ok');
      }
    };
    window.addEventListener('message', handler);
    postMsg({ type: 'loadDangerRules' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const toggle = (list: 'deployOnlyPatterns' | 'alwaysPatterns', idx: number) => {
    setRules(r => {
      if (!r) return r;
      const arr = r[list].map((p, i) => i === idx ? { ...p, enabled: !(p.enabled ?? true) } : p);
      return { ...r, [list]: arr };
    });
  };

  const setFlag = (key: 'deleteWithoutWhereEnabled' | 'updateWithoutWhereEnabled', val: boolean) => {
    setRules(r => r ? { ...r, [key]: val } : r);
  };

  const handleSave = () => {
    if (!rules) return;
    postMsg({ type: 'saveDangerRules', payload: { rules } });
  };

  // a webview shows no confirm(): the button asks itself (a second click within a few seconds resets)
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { if (!confirmReset) return; const t = setTimeout(() => setConfirmReset(false), 4000); return () => clearTimeout(t); }, [confirmReset]);
  const handleReset = () => {
    if (!confirmReset) { setConfirmReset(true); return; }
    setConfirmReset(false);
    postMsg({ type: 'resetDangerRules' });
    setLoading(true);
  };


  if (loading || !rules) {
    return (
      <div className="bs-settings-pane">
        <div className="bs-settings-section-head">
          <DangerIcon className="bs-ico-sm" />
          <h3 className="bs-settings-h3">Danger Rules</h3>
        </div>
        <div style={{ color: 'var(--dm-c-64748b)', fontSize: 12, padding: '20px 0' }}>Loading danger rules…</div>
      </div>
    );
  }

  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head">
        <DangerIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3">Danger Rules</h3>
      </div>

      <div className="bs-info-banner" style={{ fontSize: 11.5, color: 'var(--bs-info-color, var(--vscode-descriptionForeground))', padding: '8px 12px', borderRadius: 6, background: 'var(--bs-info-bg, var(--vscode-textCodeBlock-background))', marginBottom: 18, lineHeight: 1.6 }}>
        Rules are saved to <code style={{ color: 'var(--vscode-textLink-foreground)', fontSize: 11 }}>dmcr_danger.json</code> in DMCR&apos;s storage folder (below).
        DMCR hands that file to <code style={{ color: 'var(--vscode-textLink-foreground)', fontSize: 11 }}>dmcr.ps1</code> / <code style={{ color: 'var(--vscode-textLink-foreground)', fontSize: 11 }}>dmcr.sh</code> on every run;
        Releases › Set up CI copies it into the repository for the pull-request check.
      </div>

      {/* Rules file location */}
      <div className="bs-field-group" style={{ marginBottom: 22 }}>
        <label className="bs-label">Rules file</label>
        <p className="bs-hint" style={{ marginBottom: 6 }}>Where <code style={{ fontSize: 11 }}>dmcr_danger.json</code> is kept (DMCR&apos;s storage folder, so it survives updates).</p>
        <code style={{ display: 'block', fontSize: 11.5, padding: '6px 10px', borderRadius: 6, background: 'var(--bs-info-bg, var(--vscode-textCodeBlock-background))', wordBreak: 'break-all' }}>{rulesFilePath(dangerRulesDir)}</code>
      </div>

      {/* Deploy-only patterns */}
      <div className="bs-info-section-title" style={{ marginBottom: 8 }}>Deploy-only patterns (blocked in deploy.sql only)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 18 }}>
        {rules.deployOnlyPatterns.map((p, i) => (
          <label key={i} className="bs-danger-pattern-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 8px', borderRadius: 5, cursor: 'pointer', background: 'color-mix(in srgb, var(--dm-c-ffffff) 2%, transparent)' }}>
            <CheckboxView checked={p.enabled ?? true} onChange={() => toggle('deployOnlyPatterns', i)} size="sm" accentColor="var(--dm-c-6366f1)" />
            <span style={{ flex: 1, fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 12 }}>{p.label}</span>
            <span className="bs-danger-pattern-badge" style={{ fontSize: 10, color: 'var(--dm-c-64748b)', background: 'var(--bs-info-bg, var(--vscode-textCodeBlock-background))', padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap' }}>deploy only</span>
          </label>
        ))}
      </div>

      {/* Always patterns */}
      <div className="bs-info-section-title" style={{ marginBottom: 8 }}>Always patterns (blocked in both deploy.sql and revert.sql)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 18 }}>
        {rules.alwaysPatterns.map((p, i) => (
          <label key={i} className="bs-danger-pattern-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 8px', borderRadius: 5, cursor: 'pointer', background: 'color-mix(in srgb, var(--dm-c-ffffff) 2%, transparent)' }}>
            <CheckboxView checked={p.enabled ?? true} onChange={() => toggle('alwaysPatterns', i)} size="sm" accentColor="var(--dm-c-6366f1)" />
            <span style={{ flex: 1, fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 12 }}>{p.label}</span>
            <span className="bs-danger-pattern-badge" style={{ fontSize: 10, color: 'var(--dm-c-64748b)', background: 'var(--bs-info-bg, var(--vscode-textCodeBlock-background))', padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap' }}>always</span>
          </label>
        ))}
      </div>

      {/* Extra checks */}
      <div className="bs-info-section-title" style={{ marginBottom: 8 }}>Extra checks</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 22 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <CheckboxView checked={rules.deleteWithoutWhereEnabled} onChange={v => setFlag('deleteWithoutWhereEnabled', v)} size="sm" accentColor="var(--dm-c-6366f1)" />
          <span style={{ fontSize: 12 }}>Block <strong>DELETE without WHERE</strong> in deploy.sql</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <CheckboxView checked={rules.updateWithoutWhereEnabled} onChange={v => setFlag('updateWithoutWhereEnabled', v)} size="sm" accentColor="var(--dm-c-6366f1)" />
          <span style={{ fontSize: 12 }}>Block <strong>UPDATE without WHERE</strong> in deploy.sql</span>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <ButtonView variant={confirmReset ? 'danger' : 'secondary'} iconLeft={<RefreshIcon size={13} />} label={confirmReset ? 'Click again to reset' : 'Reset to defaults'} onClick={handleReset} />
        <ButtonView variant="primary" iconLeft={<SaveIcon size={13} />} label="Save rules" onClick={handleSave} />
      </div>
    </div>
  );
}
