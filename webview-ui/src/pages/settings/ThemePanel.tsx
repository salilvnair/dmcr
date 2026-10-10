import { useState } from 'react';
import { RadioCardView } from '@salilvnair/dui';
import type { AppTheme } from '../../types';
import { ThemeIcon } from './icons';
import { BUILT_IN_PALETTES, type AppSeeds } from '../../services/theme/palette';
import { currentPaletteId, selectPalette } from '../../services/theme/apply';
import { postMsg } from '../../vscode';

/** A small picture of a palette: ground, surface card with text lines, accent and status dots. */
function Swatch({ s }: { s: AppSeeds }) {
  return (
    <span className="theme-swatch" style={{ background: s.ground, borderColor: s.border }}>
      <span className="theme-swatch-card" style={{ background: s.surface, borderColor: s.border }}>
        <span style={{ background: s.text, width: '70%' }} />
        <span style={{ background: s.muted, width: '45%' }} />
        <span className="theme-swatch-dots">
          {[s.accent, s.success, s.warning, s.error, s.info].map((c, i) => <i key={i} style={{ background: c }} />)}
        </span>
      </span>
    </span>
  );
}

export function ThemePanel({ theme = 'dark', effectiveDark = true, onThemeChange }: { theme?: AppTheme; effectiveDark?: boolean; onThemeChange?: (t: AppTheme) => void }) {
  const [palette, setPalette] = useState(currentPaletteId());
  const mode = effectiveDark ? 'dark' : 'light';
  const choose = (id: string) => {
    setPalette(id);
    selectPalette(id, mode);
    postMsg({ type: 'savePalette', payload: { palette: id } });
  };
  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head">
        <ThemeIcon className="bs-ico-sm" style={{ color: 'var(--bs-accent-muted)' }} />
        <span>Theme</span>
      </div>
      <p className="theme-note">
        <strong>Mode</strong> picks dark or light (<strong>System</strong> follows your OS or VS Code). The <strong>palette</strong> picks the colours: text, backgrounds, fields, accent and status, each with a dark and a light half.
      </p>

      <div className="theme-section-label">Mode</div>
      <RadioCardView size="md" columns={3} accentColor="#6366f1" value={theme} onChange={v => onThemeChange?.(v as AppTheme)}
        options={[
          { value: 'system', label: 'System', description: 'Follow your OS / VS Code preference' },
          { value: 'dark', label: 'Dark', description: 'Dark mode (default)' },
          { value: 'light', label: 'Light', description: 'Light mode' },
        ]} />

      <div className="theme-section-label" style={{ marginTop: 22 }}>Palette <span>showing the {mode} half</span></div>
      <RadioCardView size="md" columns={5} accentColor="#6366f1" value={palette} onChange={choose}
        options={BUILT_IN_PALETTES.map(p => ({
          value: p.id,
          label: p.label,
          description: p.id === 'dmcr' ? 'As DMCR ships' : undefined,
          icon: <Swatch s={mode === 'dark' ? p.dark : p.light} />,
        }))} />
      <p className="theme-note" style={{ marginTop: 14 }}>Changes take effect immediately and are saved automatically.</p>
    </div>
  );
}
