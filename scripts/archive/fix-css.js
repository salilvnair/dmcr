const fs = require('fs');
const f = 'webview-ui/src/index.css';
let t = fs.readFileSync(f, 'utf8');

// Already there?
if (t.includes('.bs-styled-select-trigger')) {
  console.log('CSS already present, skipping');
  process.exit(0);
}

const CSS = `
/* ============================================================
 * StyledSelect -- ditto ck8t
 * ============================================================ */
.bs-styled-select { position: relative; width: 100%; }

.bs-styled-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--bs-input-border);
  background: var(--bs-input-bg);
  color: var(--bs-input-color);
  font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: border-color 150ms, box-shadow 150ms, background 150ms;
}
.bs-styled-select-trigger:hover {
  border-color: var(--bs-input-hover-border);
  background: var(--bs-input-hover-bg);
}
.bs-styled-select-trigger.is-open,
.bs-styled-select-trigger:focus-visible {
  outline: none;
  border-color: var(--bs-accent);
  box-shadow: 0 0 0 3px var(--bs-accent-ring);
  background: var(--bs-input-focus-bg);
}

.bs-styled-select-value {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.bs-styled-select-value.is-placeholder { color: var(--bs-input-placeholder); }

.bs-styled-select-chevron {
  flex-shrink: 0;
  color: #64748b;
  transition: transform 150ms;
}
.bs-styled-select-trigger.is-open .bs-styled-select-chevron {
  transform: rotate(180deg);
}

.bs-styled-select-menu {
  background: var(--bs-dropdown-menu-bg, #2b2b2b);
  border: 1px solid var(--bs-dropdown-menu-border, rgba(148,163,184,0.12));
  border-radius: 9px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.35);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 240px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(99,102,241,0.3) transparent;
  animation: bs-menu-in 140ms cubic-bezier(0.34,1.4,0.64,1);
}
@keyframes bs-menu-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.bs-styled-select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--bs-dropdown-option-color, #cbd5e1);
  font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 100ms;
}
.bs-styled-select-option:hover { background: rgba(99,102,241,0.08); }
.bs-styled-select-option.is-active {
  background: rgba(99,102,241,0.12);
  color: var(--bs-accent);
}

.bs-styled-select-option-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bs-styled-select-opt-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0.8;
  margin-right: 2px;
}
.bs-styled-select-option.is-active .bs-styled-select-opt-icon,
.bs-styled-select-trigger:hover .bs-styled-select-opt-icon {
  opacity: 1;
}

.bs-styled-select-empty {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--bs-input-placeholder);
  font-style: italic;
  text-align: center;
}
`;

// Append before the last line or at end
t = t.trimEnd() + '\n' + CSS + '\n';

fs.writeFileSync(f, t, 'utf8');
console.log('Done. bs-styled-select CSS added.');
console.log('Verify:', t.includes('.bs-styled-select-trigger'));
