import { useState, useRef, useEffect, useCallback } from 'react';
import './MultiSelectDropdown.css';

export type MultiSelectItem = { value: string; label: string };

type Props = {
  items: MultiSelectItem[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  className?: string;
  allowCustom?: boolean;
};

// Deterministic color from a pool based on string hash
const CHIP_COLORS = [
  '#6366f1', '#22c55e', '#06b6d4', '#8b5cf6', '#f59e0b',
  '#ec4899', '#14b8a6', '#f472b6', '#a78bfa', '#34d399',
  '#e11d48', '#10b981', '#f87171', '#64748b', '#818cf8',
];

function chipColor(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return CHIP_COLORS[Math.abs(hash) % CHIP_COLORS.length];
}

export default function MultiSelectDropdown({ items, selected, onChange, placeholder = 'Select…', className, allowCustom = false }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const toggle = useCallback((val: string) => {
    if (selected.includes(val)) onChange(selected.filter(v => v !== val));
    else onChange([...selected, val]);
  }, [selected, onChange]);

  const remove = useCallback((val: string) => {
    onChange(selected.filter(v => v !== val));
  }, [selected, onChange]);

  // Position menu (absolute, within .msd-wrap) — flip up if near bottom
  useEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    const position = () => {
      menu.style.width = trigger.offsetWidth + 'px';
      const r = trigger.getBoundingClientRect();
      const h = menu.offsetHeight || 240;
      const spaceBelow = window.innerHeight - r.bottom;
      const goUp = spaceBelow < h + 12 && r.top > h + 12;
      if (goUp) {
        menu.style.top = 'auto';
        menu.style.bottom = (trigger.parentElement!.offsetHeight - trigger.offsetTop) + 'px';
        menu.style.marginBottom = '4px';
      } else {
        menu.style.top = (trigger.offsetTop + trigger.offsetHeight + 4) + 'px';
        menu.style.bottom = 'auto';
        menu.style.marginBottom = '0';
      }
    };
    position();
    const raf = requestAnimationFrame(position);
    return () => cancelAnimationFrame(raf);
  }, [open, filter]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      setFilter('');
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus filter input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const filtered = items.filter(i =>
    i.label.toLowerCase().includes(filter.toLowerCase()) ||
    i.value.toLowerCase().includes(filter.toLowerCase())
  );

  const handleCustomAdd = () => {
    const val = filter.trim();
    if (val && !selected.includes(val)) {
      onChange([...selected, val]);
    }
    setFilter('');
  };

  return (
    <div className={`msd-wrap${className ? ' ' + className : ''}`}>
      <button
        type="button"
        ref={triggerRef}
        className={`msd-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="msd-val">
          {selected.length === 0 ? placeholder : `${selected.length} selected`}
        </span>
        <svg className="msd-arrow" viewBox="0 0 12 7" fill="none">
          <path d="M1 1l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div ref={menuRef} className="msd-menu open">
          <div className="msd-filter-box">
            <input
              ref={inputRef}
              className="msd-filter-input"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter…"
              onKeyDown={e => {
                if (e.key === 'Enter' && allowCustom && filter.trim()) {
                  e.preventDefault();
                  handleCustomAdd();
                }
                if (e.key === 'Escape') { setOpen(false); setFilter(''); }
              }}
            />
            {selected.length > 0 && (
              <button type="button" className="msd-action-btn" onClick={() => onChange([])}>
                Clear all
              </button>
            )}
          </div>
          <div className="msd-items">
            {filtered.map(item => (
              <div
                key={item.value}
                className={`msd-item${selected.includes(item.value) ? ' checked' : ''}`}
                onClick={() => toggle(item.value)}
              >
                <span className={`msd-check${selected.includes(item.value) ? ' on' : ''}`}>
                  {selected.includes(item.value) ? '✓' : ''}
                </span>
                <span className="msd-item-label">{item.label}</span>
              </div>
            ))}
            {filtered.length === 0 && filter.trim() && allowCustom && (
              <div className="msd-item msd-item--add" onClick={handleCustomAdd}>
                <span className="msd-check">+</span>
                <span className="msd-item-label">Add "{filter.trim()}"</span>
              </div>
            )}
            {filtered.length === 0 && !filter.trim() && (
              <div className="msd-empty">No items available</div>
            )}
          </div>
        </div>
      )}

      {/* Chips for selected items */}
      {selected.length > 0 && (
        <div className="msd-chips">
          {selected.map(val => {
            const color = chipColor(val);
            return (
              <span key={val} className="msd-chip" style={{ borderColor: color, color }}>
                <span className="msd-chip-dot" style={{ background: color }} />
                <span className="msd-chip-text">{val}</span>
                <button type="button" className="msd-chip-x" onClick={() => remove(val)} title="Remove">×</button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
