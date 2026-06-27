import { useState, useRef, useEffect, useCallback } from 'react';
import './StyledDropdown.css';

export type DropdownItem = { value: string; label: string };

type Props = {
  items: DropdownItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

export default function StyledDropdown({ items, value, onChange, className }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = items.find(i => i.value === value);

  // Position menu (absolute, within .sd-wrap) — flip up if near bottom
  useEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    const position = () => {
      menu.style.width = trigger.offsetWidth + 'px';
      const r = trigger.getBoundingClientRect();
      const h = menu.offsetHeight || menu.scrollHeight || 200;
      const spaceBelow = window.innerHeight - r.bottom;
      const goUp = spaceBelow < h + 12 && r.top > h + 12;
      if (goUp) {
        menu.style.top = 'auto';
        menu.style.bottom = '100%';
        menu.style.marginTop = '0';
        menu.style.marginBottom = '4px';
      } else {
        menu.style.top = '100%';
        menu.style.bottom = 'auto';
        menu.style.marginTop = '4px';
        menu.style.marginBottom = '0';
      }
    };
    position();
    const raf = requestAnimationFrame(position);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = useCallback((v: string) => {
    onChange(v);
    setOpen(false);
  }, [onChange]);

  return (
    <div className={`sd-wrap${className ? ' ' + className : ''}`}>
      <button
        type="button"
        ref={triggerRef}
        className={`sd-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="sd-val">{selected?.label ?? value}</span>
        <svg className="sd-arrow" viewBox="0 0 12 7" fill="none">
          <path d="M1 1l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div ref={menuRef} className="sd-menu open">
          {items.map(item => (
            <div
              key={item.value}
              className={`sd-item${item.value === value ? ' selected' : ''}`}
              onClick={() => handleSelect(item.value)}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
