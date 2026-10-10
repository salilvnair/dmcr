import { useState, useRef, useEffect, useCallback } from 'react';
import { ButtonView, CheckboxView, CloseIcon, PlusIcon, SearchIcon } from '@salilvnair/dui';
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
  'var(--dm-c-6366f1)', 'var(--dm-c-22c55e)', 'var(--dm-c-06b6d4)', 'var(--dm-c-8b5cf6)', 'var(--dm-c-f59e0b)',
  'var(--dm-c-ec4899)', 'var(--dm-c-14b8a6)', 'var(--dm-c-f472b6)', 'var(--dm-c-a78bfa)', 'var(--dm-c-34d399)',
  'var(--dm-c-e11d48)', 'var(--dm-c-10b981)', 'var(--dm-c-f87171)', 'var(--dm-c-64748b)', 'var(--dm-c-818cf8)',
];

function chipColor(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return CHIP_COLORS[Math.abs(hash) % CHIP_COLORS.length];
}

/** Multi-select with checkboxes, styled like the dui SelectInputView (same input colors, menu surface and rows). */
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
      const h = menu.offsetHeight || 280;
      const spaceBelow = window.innerHeight - r.bottom;
      const goUp = spaceBelow < h + 12 && r.top > h + 12;
      if (goUp) {
        menu.style.top = 'auto';
        menu.style.bottom = (trigger.parentElement!.offsetHeight - trigger.offsetTop) + 'px';
        menu.style.marginBottom = '6px';
      } else {
        menu.style.top = (trigger.offsetTop + trigger.offsetHeight + 6) + 'px';
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
        className={`msd-trigger${open ? ' open' : ''}${selected.length ? ' has-value' : ''}`}
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
        <div ref={menuRef} className="msd-menu open" role="listbox" aria-multiselectable="true">
          <div className="msd-filter-box">
            <span className="msd-filter-field">
              <SearchIcon size={13} />
              <input
                ref={inputRef}
                className="msd-filter-input"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder={allowCustom ? 'Filter, or type a change id and press Enter' : 'Filter'}
                spellCheck={false}
                onKeyDown={e => {
                  if (e.key === 'Enter' && allowCustom && filter.trim()) {
                    e.preventDefault();
                    handleCustomAdd();
                  }
                  if (e.key === 'Escape') { setOpen(false); setFilter(''); }
                }}
              />
            </span>
            {selected.length > 0 && (
              <ButtonView type="button" variant="ghost" iconLeft={<CloseIcon size={11} />} label="Clear" onClick={() => onChange([])} />
            )}
          </div>
          <div className="msd-items">
            {filtered.map(item => {
              const on = selected.includes(item.value);
              return (
                <div
                  key={item.value}
                  role="option"
                  aria-selected={on}
                  className={`msd-item${on ? ' checked' : ''}`}
                  onClick={() => toggle(item.value)}
                >
                  <span className="msd-check" onClick={e => e.stopPropagation()}>
                    <CheckboxView size="sm" checked={on} onChange={() => toggle(item.value)} />
                  </span>
                  <span className="msd-item-label">{item.label}</span>
                </div>
              );
            })}
            {filtered.length === 0 && filter.trim() && allowCustom && (
              <div className="msd-item msd-item--add" onClick={handleCustomAdd}>
                <span className="msd-check msd-check--add"><PlusIcon size={12} /></span>
                <span className="msd-item-label">Add "{filter.trim()}"</span>
              </div>
            )}
            {filtered.length === 0 && !(filter.trim() && allowCustom) && (
              <div className="msd-empty">{filter.trim() ? 'No match' : 'No items available'}</div>
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
              <span key={val} className="msd-chip" style={{ borderColor: `color-mix(in srgb, ${color} 55%, transparent)`, color, background: `color-mix(in srgb, ${color} 10%, transparent)` }}>
                <span className="msd-chip-dot" style={{ background: color }} />
                <span className="msd-chip-text">{val}</span>
                <button type="button" className="msd-chip-x" onClick={() => remove(val)} title="Remove"><CloseIcon size={10} /></button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
