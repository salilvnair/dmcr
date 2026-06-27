import React from 'react';
import type { AppTheme } from '../../types';
import { ThemeIcon } from './icons';

export function ThemePanel({ theme = 'dark', onThemeChange }: { theme?: AppTheme; onThemeChange?: (t: AppTheme) => void }) {
  const options: { value: AppTheme; label: string; desc: string }[] = [
    { value: 'system', label: 'System', desc: 'Follow your OS / VS Code preference' },
    { value: 'dark',   label: 'Dark',   desc: 'Dark mode (default)' },
    { value: 'light',  label: 'Light',  desc: 'Light mode' },
  ];
  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head">
        <ThemeIcon className="bs-ico-sm" style={{ color: '#818cf8' }} />
        <span>Theme</span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary, #94a3b8)', marginBottom: 20, lineHeight: 1.6 }}>
        Choose how DMCR looks. <strong>System</strong> automatically follows your OS or VS Code colour preference.
      </p>
      <div className="theme-pill-row">
        {options.map(opt => (
          <button
            key={opt.value}
            className={`theme-pill${theme === opt.value ? ' active' : ''}`}
            onClick={() => onThemeChange?.(opt.value)}
          >
            <span className="theme-pill-label">{opt.label}</span>
            <span className="theme-pill-desc">{opt.desc}</span>
          </button>
        ))}
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--text-secondary, #64748b)', marginTop: 16 }}>
        Current: <strong style={{ color: 'var(--text-primary, #e5e7eb)' }}>{theme.charAt(0).toUpperCase() + theme.slice(1)}</strong>.
        {' '}Changes take effect immediately and are saved automatically.
      </p>
    </div>
  );
}
