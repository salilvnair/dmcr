/**
 * PillTabs — animated sliding-pill tab bar.
 * Ported from DevTrack. Supports custom accent colors and dark/light mode.
 */
import React, { useRef, useState, useLayoutEffect } from 'react';

export type PillTab = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  badge?: number | string | null;
};

type PillTabsProps = {
  tabs: PillTab[];
  active: string;
  onChange: (id: string) => void;
  size?: 'sm' | 'md' | 'lg';
  /** Accent color for the active pill and text. Default: 'var(--dm-c-6366f1)' (indigo) */
  accentColor?: string;
  /** Theme mode. Auto-detects from data-theme if not specified. */
  theme?: 'dark' | 'light';
};

export default function PillTabs({ tabs, active, onChange, size = 'md', accentColor = 'var(--dm-c-6366f1)', theme }: PillTabsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pill, setPill] = useState<{ left: number; width: number; noTransition: boolean } | null>(null);
  const firstMount = useRef(true);

  // Auto-detect theme from DOM
  const resolvedTheme = theme ?? (typeof document !== 'undefined' && document.querySelector('[data-theme="light"]') ? 'light' : 'dark');

  const tabsKey = tabs.map(t => `${t.id}:${t.badge ?? ''}`).join('|');

  useLayoutEffect(() => {
    const el = tabRefs.current[active];
    if (!el || !containerRef.current) return;
    const cr = containerRef.current.getBoundingClientRect();
    const tr = el.getBoundingClientRect();
    const noTransition = firstMount.current;
    firstMount.current = false;
    setPill({ left: tr.left - cr.left, width: tr.width, noTransition });
  }, [active, tabsKey]);

  const pad = size === 'lg' ? '6px 16px' : size === 'sm' ? '4px 9px' : '5px 13px';
  const fz = size === 'lg' ? 12.5 : size === 'sm' ? 11 : 11.5;

  // Theme-aware colors
  const containerBg = resolvedTheme === 'light' ? 'color-mix(in srgb, var(--dm-c-000000) 4%, transparent)' : 'color-mix(in srgb, var(--dm-c-ffffff) 4%, transparent)';
  const pillBg = resolvedTheme === 'light' ? `color-mix(in srgb, ${accentColor} 8%, transparent)` : `color-mix(in srgb, ${accentColor} 10%, transparent)`;
  const pillBorder = `1px solid color-mix(in srgb, ${accentColor} 27%, transparent)`;
  const activeColor = resolvedTheme === 'light' ? accentColor : 'var(--dm-c-ffffff)';
  const inactiveColor = resolvedTheme === 'light' ? 'var(--dm-c-64748b)' : 'var(--vscode-descriptionForeground, var(--dm-c-94a3b8))';

  return (
    <div ref={containerRef} style={{
      position: 'relative', display: 'inline-flex',
      background: containerBg, borderRadius: 9, padding: 3, gap: 0,
    }}>
      {pill && <div style={{
        position: 'absolute', top: 3, height: 'calc(100% - 6px)',
        background: pillBg, border: pillBorder, borderRadius: 7,
        boxShadow: resolvedTheme === 'light' ? '0 1px 4px color-mix(in srgb, var(--dm-c-000000) 8%, transparent)' : '0 1px 6px color-mix(in srgb, var(--dm-c-000000) 25%, transparent)',
        left: pill.left, width: pill.width,
        transition: pill.noTransition ? 'none' : 'left 0.22s cubic-bezier(0.34,1.56,0.64,1), width 0.22s cubic-bezier(0.34,1.56,0.64,1)',
        pointerEvents: 'none', zIndex: 0,
      }} />}
      {tabs.map(t => (
        <button key={t.id}
          ref={el => { tabRefs.current[t.id] = el; }}
          onClick={() => onChange(t.id)}
          style={{
            position: 'relative', zIndex: 1,
            padding: pad, borderRadius: 7,
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: fz, fontWeight: active === t.id ? 600 : 500,
            color: active === t.id ? activeColor : inactiveColor,
            transition: 'color 0.15s', whiteSpace: 'nowrap',
            display: 'flex', alignItems: 'center', gap: (t.icon || t.badge != null) ? 5 : 0,
          }}
        >
          {t.icon}
          {t.label}
          {t.badge != null && (
            <span style={{
              fontSize: fz - 1.5, fontWeight: 700, padding: '1px 5px', borderRadius: 9999,
              background: active === t.id ? 'color-mix(in srgb, var(--dm-c-ef4444) 85%, transparent)' : 'color-mix(in srgb, var(--dm-c-ef4444) 70%, transparent)',
              color: 'var(--dm-c-ffffff)',
              minWidth: 16, textAlign: 'center', lineHeight: '14px',
            }}>{t.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}
