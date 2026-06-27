import React, { useState, useEffect } from 'react';
import { postMsg } from '../../vscode';
import type { ToastData } from '../../App';
import { DangerIcon, FolderPickerIcon } from './icons';

interface DangerRule { label: string; regex: string; scope: 'deployOnly' | 'always'; enabled?: boolean; }
interface DangerRulesFile {
  deployOnlyPatterns: DangerRule[];
  alwaysPatterns: DangerRule[];
  deleteWithoutWhereEnabled: boolean;
  updateWithoutWhereEnabled: boolean;
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
      if (msg?.type === 'dangerRulesFolderPicked') {
        setDangerRulesDir(msg.payload.path);
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
    postMsg({ type: 'saveDangerRules', payload: { rules, dangerRulesDir: dangerRulesDir.trim() } });
  };

  const handleReset = () => {
    if (!confirm('Reset all danger rules to built-in defaults?')) return;
    postMsg({ type: 'resetDangerRules' });
    setLoading(true);
  };

  const handlePickFolder = () => {
    postMsg({ type: 'pickDangerRulesFolder' });
  };

  if (loading || !rules) {
    return (
      <div className="bs-settings-pane">
        <div className="bs-settings-section-head">
          <DangerIcon className="bs-ico-sm" />
          <h3 className="bs-settings-h3">Danger Rules</h3>
        </div>
        <div style={{ color: '#64748b', fontSize: 12, padding: '20px 0' }}>Loading danger rules…</div>
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
        Rules saved to <code style={{ color: 'var(--vscode-textLink-foreground)', fontSize: 11 }}>dmcr_danger.json</code> in the configured directory (default: workspace root).
        Commit this file so the team shares the same restrictions.{' '}
        <code style={{ color: 'var(--vscode-textLink-foreground)', fontSize: 11 }}>dmcr.ps1</code> reads it automatically on startup.
      </div>

      {/* Rules file location */}
      <div className="bs-field-group" style={{ marginBottom: 22 }}>
        <label className="bs-label">Rules directory</label>
        <p className="bs-hint" style={{ marginBottom: 6 }}>Path where <code style={{ fontSize: 11 }}>dmcr_danger.json</code> is stored. Leave empty to use the workspace root. Can be absolute or workspace-relative.</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="bs-input"
            type="text"
            value={dangerRulesDir}
            onChange={e => setDangerRulesDir(e.target.value)}
            placeholder="(workspace root)"
            style={{ flex: 1 }}
          />
          <button
            className="bs-btn-sm"
            onClick={handlePickFolder}
            title="Browse for folder"
            style={{ flexShrink: 0 }}
          >
            <FolderPickerIcon style={{ width: 16, height: 16, color: 'var(--bs-status-warn, #f59e0b)' }} />
            Browse
          </button>
        </div>
      </div>

      {/* Deploy-only patterns */}
      <div className="bs-info-section-title" style={{ marginBottom: 8 }}>Deploy-only patterns (blocked in deploy.sql only)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 18 }}>
        {rules.deployOnlyPatterns.map((p, i) => (
          <label key={i} className="bs-danger-pattern-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 8px', borderRadius: 5, cursor: 'pointer', background: 'rgba(255,255,255,0.02)' }}>
            <input type="checkbox" checked={p.enabled ?? true} onChange={() => toggle('deployOnlyPatterns', i)} style={{ accentColor: '#6366f1', width: 14, height: 14, flexShrink: 0 }} />
            <span style={{ flex: 1, fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 12 }}>{p.label}</span>
            <span className="bs-danger-pattern-badge" style={{ fontSize: 10, color: '#64748b', background: 'var(--bs-info-bg, var(--vscode-textCodeBlock-background))', padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap' }}>deploy only</span>
          </label>
        ))}
      </div>

      {/* Always patterns */}
      <div className="bs-info-section-title" style={{ marginBottom: 8 }}>Always patterns (blocked in both deploy.sql and revert.sql)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 18 }}>
        {rules.alwaysPatterns.map((p, i) => (
          <label key={i} className="bs-danger-pattern-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 8px', borderRadius: 5, cursor: 'pointer', background: 'rgba(255,255,255,0.02)' }}>
            <input type="checkbox" checked={p.enabled ?? true} onChange={() => toggle('alwaysPatterns', i)} style={{ accentColor: '#6366f1', width: 14, height: 14, flexShrink: 0 }} />
            <span style={{ flex: 1, fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 12 }}>{p.label}</span>
            <span className="bs-danger-pattern-badge" style={{ fontSize: 10, color: '#64748b', background: 'var(--bs-info-bg, var(--vscode-textCodeBlock-background))', padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap' }}>always</span>
          </label>
        ))}
      </div>

      {/* Extra checks */}
      <div className="bs-info-section-title" style={{ marginBottom: 8 }}>Extra checks</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 22 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={rules.deleteWithoutWhereEnabled} onChange={e => setFlag('deleteWithoutWhereEnabled', e.target.checked)} style={{ accentColor: '#6366f1', width: 14, height: 14, flexShrink: 0 }} />
          <span style={{ fontSize: 12 }}>Block <strong>DELETE without WHERE</strong> in deploy.sql</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={rules.updateWithoutWhereEnabled} onChange={e => setFlag('updateWithoutWhereEnabled', e.target.checked)} style={{ accentColor: '#6366f1', width: 14, height: 14, flexShrink: 0 }} />
          <span style={{ fontSize: 12 }}>Block <strong>UPDATE without WHERE</strong> in deploy.sql</span>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="bs-btn-sm bs-btn-secondary" onClick={handleReset}>Reset to defaults</button>
        <button className="bs-btn-sm bs-btn-success" onClick={handleSave}>Save rules</button>
      </div>
    </div>
  );
}
