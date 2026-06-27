import React, { useState } from 'react';
import { postMsg } from '../../vscode';
import { WarnIcon } from './icons';

// Re-export StyledSelect from its canonical location in components/
export { StyledSelect } from '../../components/StyledSelect';
export type { SelectOption } from '../../components/StyledSelect';

export function SqliteBanner({ error }: { error?: string }) {
  const [rebuilding, setRebuilding] = useState(false);
  const handleFix = () => {
    setRebuilding(true);
    postMsg({ type: 'rebuildSqlite' });
    setTimeout(() => setRebuilding(false), 5000);
  };
  return (
    <div className="bs-sqlite-banner">
      <WarnIcon style={{ flexShrink: 0, marginTop: 2, color: '#fbbf24', width: 16, height: 16 }} />
      <div className="bs-sqlite-banner-body">
        <div>
          <strong>SQLite unavailable</strong> -- native binary ABI mismatch.
          Click Install SQLite on the Home page or fix below.
        </div>
        {error && (
          <div style={{ fontSize: 10.5, color: 'var(--text-secondary, #94a3b8)', marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>
            {error.slice(0, 120)}
          </div>
        )}
        <div className="bs-sqlite-banner-actions">
          <button className="bs-btn-sm bs-btn-secondary" onClick={handleFix} disabled={rebuilding}>
            {rebuilding ? 'Rebuilding...' : 'Fix SQLite'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* â”€â”€ DtSelect â€” custom-styled select for env picker â”€â”€ */
interface DtOption {
  value: string;
  label: string;
  badge?: string;
  badgeColor?: string;
}

export function DtSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: DtOption[] }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selected = options.find(o => o.value === value) ?? options[0];

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', minWidth: 180 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', padding: '7px 10px',
          background: 'var(--bs-input-bg)',
          border: `1px solid ${open ? '#6366f1' : 'var(--bs-input-border)'}`,
          borderRadius: 7, color: 'var(--text-primary)', cursor: 'pointer',
          fontSize: 12.5, fontFamily: 'inherit', textAlign: 'left',
          boxShadow: open ? '0 0 0 3px rgba(99,102,241,0.20)' : 'none',
          transition: 'border-color 140ms, box-shadow 140ms',
        }}
      >
        {selected?.badge && (
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.7,
            color: selected.badgeColor ?? '#818cf8',
            background: `${selected.badgeColor ?? '#818cf8'}18`,
            border: `1px solid ${selected.badgeColor ?? '#818cf8'}40`,
            padding: '1px 7px', borderRadius: 8,
          }}>{selected.badge}</span>
        )}
        <span style={{ flex: 1 }}>{selected?.label ?? value}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: '100%', zIndex: 1000,
          background: 'var(--bs-dropdown-menu-bg)', border: '1px solid var(--bs-dropdown-menu-border)',
          borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          overflow: 'hidden',
        }}>
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '8px 12px',
                background: opt.value === value ? 'rgba(99,102,241,0.15)' : 'transparent',
                border: 'none', color: opt.value === value ? '#818cf8' : 'var(--bs-dropdown-option-color)',
                cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit', textAlign: 'left',
                transition: 'background 100ms',
              }}
              onMouseEnter={e => { if (opt.value !== value) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bs-dropdown-hover-bg)'; }}
              onMouseLeave={e => { if (opt.value !== value) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            >
              {opt.badge && (
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: 0.7,
                  color: opt.badgeColor ?? '#818cf8',
                  background: `${opt.badgeColor ?? '#818cf8'}18`,
                  border: `1px solid ${opt.badgeColor ?? '#818cf8'}40`,
                  padding: '1px 7px', borderRadius: 8,
                }}>{opt.badge}</span>
              )}
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

