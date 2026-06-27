// Fix SettingsPage.tsx:
// 1. Add StyledSelect component (ditto ck8t, TypeScript)
// 2. Replace native <select> for Type with StyledSelect
// 3. Fix CopilotProviderIcon missing path sub-paths
const fs = require('fs');
const f = 'webview-ui/src/pages/SettingsPage.tsx';
let t = fs.readFileSync(f, 'utf8');

// ── 1. Add import for createPortal ────────────────────────────────────────
t = t.replace(
  "import { useState, useMemo, useCallback } from 'react';",
  "import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';\nimport { createPortal } from 'react-dom';"
);

// ── 2. Fix CopilotProviderIcon: append the 3 missing sub-paths to the path d attr
const oldCopilotPath = `...-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951z" fill="#18181b" />`;

// Find the exact current path ending
const copilotPathEnd = `...-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951z" fill="#18181b" />`;

const COPILOT_MISSING_PATHS = `M7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z`;

// Replace the truncated path with the full path
t = t.replace(
  `-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951z" fill="#18181b" />`,
  `-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951z${COPILOT_MISSING_PATHS}" fill="#18181b" />`
);

// ── 3. Replace native <select> for Type with StyledSelect ─────────────────
t = t.replace(
  `            <label className="bs-custom-provider-label">
              Type
              <select
                className="bs-custom-provider-input"
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value, ...deriveUrlsFromHost(f.host, e.target.value) }))}
              >
                {PROVIDER_TYPE_OPTIONS.map(o => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </label>`,
  `            <label className="bs-custom-provider-label">
              Type
              <StyledSelect
                value={form.type}
                options={PROVIDER_TYPE_OPTIONS.map(o => ({ id: o.id, label: o.label, icon: <o.Icon size={15} /> }))}
                onChange={(id: string) => setForm(f => ({ ...f, type: id, ...deriveUrlsFromHost(f.host, id) }))}
              />
            </label>`
);

// ── 4. Add StyledSelect component before the icons section ────────────────
const STYLED_SELECT_COMPONENT = `
/* ============================================================
 * StyledSelect -- ditto ck8t StyledSelect component
 * ============================================================ */
interface SelectOption {
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

function StyledSelect({ value, options = [], onChange, placeholder, className = '', iconSize = 16, menuMinWidth = 0 }: StyledSelectProps) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find(o => o.id === value) ?? (value ? { id: value, label: value } : null);

  useLayoutEffect(() => {
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

  useEffect(() => {
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

  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (menuRef.current && e?.target && menuRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  return (
    <div ref={triggerRef} className={\`bs-styled-select \${className}\`}>
      <button
        type="button"
        className={\`bs-styled-select-trigger \${open ? 'is-open' : ''}\`}
        onClick={() => setOpen(v => !v)}
      >
        <span className={\`bs-styled-select-value \${!selected ? 'is-placeholder' : ''}\`}>
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
                className={\`bs-styled-select-option \${o.id === value ? 'is-active' : ''}\`}
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

`;

// Insert StyledSelect before the CopilotProviderIcon section
t = t.replace(
  '/* ============================================================\n * Provider brand SVG icons -- ditto ck8t',
  STYLED_SELECT_COMPONENT + '/* ============================================================\n * Provider brand SVG icons -- ditto ck8t'
);

fs.writeFileSync(f, t, 'utf8');
console.log('Done. Lines:', t.split('\n').length);
// Verify key changes
console.log('StyledSelect component added:', t.includes('function StyledSelect'));
console.log('createPortal import:', t.includes("from 'react-dom'"));
console.log('Missing Copilot paths added:', t.includes('M7.635 5.087'));
console.log('Native select removed:', !t.includes('<select\n                className="bs-custom-provider-input"'));
console.log('StyledSelect used:', t.includes('<StyledSelect'));
