import React, { useState } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

interface StyledSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (id: string) => void;
  placeholder?: string;
  className?: string;
  iconSize?: number;
  menuMinWidth?: number;
}

export function StyledSelect({ value, options = [], onChange, placeholder, className = '', iconSize = 16, menuMinWidth = 0 }: StyledSelectProps) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const selected = options.find(o => o.id === value) ?? (value ? { id: value, label: value } : null);

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const menuH = Math.min(240, options.length * 36 + 8);
    const spaceBelow = viewportH - r.bottom;
    const goUp = spaceBelow < menuH + 8 && r.top > menuH + 8;
    setMenuStyle({
      position: 'fixed',
      top: goUp ? r.top - menuH - 4 : r.bottom + 4,
      left: r.left,
      minWidth: Math.max(r.width, menuMinWidth),
      width: 'max-content',
      zIndex: 99999,
    });
  }, [open, options.length, menuMinWidth]);

  React.useEffect(() => {
    if (!open) return;
    function onOut(e: MouseEvent) {
      const t = e.target as Node;
      if (
        triggerRef.current && !triggerRef.current.contains(t) &&
        menuRef.current && !menuRef.current.contains(t)
      ) setOpen(false);
    }
    document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (menuRef.current && e?.target && menuRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  return (
    <div ref={triggerRef} className={`bs-styled-select ${className}`}>
      <button
        type="button"
        className={`bs-styled-select-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen(v => !v)}
      >
        <span className={`bs-styled-select-value ${!selected ? 'is-placeholder' : ''}`}>
          {selected?.icon && (
            <span className="bs-styled-select-opt-icon" style={{ width: iconSize, height: iconSize }}>
              {selected.icon}
            </span>
          )}
          {selected ? selected.label : (placeholder ?? 'Select...')}
        </span>
        <svg className="bs-styled-select-chevron" width="12" height="7" viewBox="0 0 12 7" fill="none" aria-hidden="true">
          <path d="M1 1l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && createPortal(
        <div ref={menuRef} className="bs-styled-select-menu" style={menuStyle}>
          {options.length === 0 ? (
            <div className="bs-styled-select-empty">No options</div>
          ) : (
            options.map(o => (
              <button
                key={o.id}
                type="button"
                className={`bs-styled-select-option ${o.id === value ? 'is-active' : ''}`}
                onClick={() => { onChange(o.id); setOpen(false); }}
              >
                {o.icon && (
                  <span className="bs-styled-select-opt-icon" style={{ width: iconSize, height: iconSize }}>
                    {o.icon}
                  </span>
                )}
                <span className="bs-styled-select-option-label">{o.label}</span>
                {o.id === value && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true" style={{ flexShrink: 0, color: '#818cf8' }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
