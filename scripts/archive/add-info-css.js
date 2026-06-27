const fs = require('fs');
const f = 'webview-ui/src/index.css';
let t = fs.readFileSync(f, 'utf8');

// Don't double-add
if (t.includes('.bs-info-grid')) { console.log('Already present, skip'); process.exit(0); }

const APPEND = `
/* ============================================================
 * DB Config + Memory Footprint info cards
 * ============================================================ */
.bs-info-section-title {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
  color: #475569; margin: 0 0 10px;
}
.bs-info-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
}
.bs-info-grid--4 { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
.bs-info-card {
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.07);
  background: rgba(255,255,255,0.03);
}
.bs-info-card--warn { border-color: rgba(251,191,36,0.35); background: rgba(251,191,36,0.06); }
.bs-info-card-label { font-size: 10.5px; font-weight: 600; color: #64748b; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
.bs-info-card-value { font-size: 15px; font-weight: 700; color: #e2e8f0; line-height: 1.2; }
.bs-info-card-sub { font-size: 10.5px; color: #64748b; margin-top: 3px; }
.bs-mono { font-family: 'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace; }

/* Progress bar */
.bs-progress-row { display: flex; align-items: center; gap: 10px; }
.bs-progress-label { font-size: 11px; font-weight: 600; color: #64748b; width: 36px; flex-shrink: 0; }
.bs-progress-bar {
  flex: 1; height: 6px; border-radius: 999px;
  background: rgba(255,255,255,0.07); overflow: hidden;
}
.bs-progress-fill { height: 100%; border-radius: 999px; transition: width 400ms ease; }
.bs-progress-pct { font-size: 11px; color: #64748b; min-width: 38px; text-align: right; }

/* Key-value row */
.bs-kv-row {
  display: flex; align-items: baseline; gap: 12px;
  padding: 5px 8px; border-radius: 6px;
  border: 1px solid transparent;
  transition: background 100ms;
}
.bs-kv-row:hover { background: rgba(255,255,255,0.03); border-color: rgba(255,255,255,0.06); }
.bs-kv-key { font-size: 11.5px; color: #64748b; min-width: 100px; flex-shrink: 0; }
.bs-kv-val { font-size: 12px; color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Path row */
.bs-path-row {
  display: flex; flex-direction: column; gap: 3px;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.02);
}
.bs-path-label { font-size: 10.5px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
.bs-path-value { font-size: 11.5px; color: #94a3b8; word-break: break-all; }

/* Table list */
.bs-table-list { display: flex; flex-direction: column; gap: 4px; }
.bs-table-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 10px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.02);
  transition: background 120ms;
}
.bs-table-row:hover { background: rgba(99,102,241,0.06); border-color: rgba(99,102,241,0.18); }
.bs-table-name { font-size: 12.5px; font-weight: 600; color: #a5b4fc; }
.bs-table-count { font-size: 11px; color: #64748b; }

/* ============================================================
 * MiniCalendar (mc-*) — ck8t ditto, dark only
 * ============================================================ */
.mc-wrap { position: relative; width: 100%; }

.mc-trigger {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--bs-input-border);
  background: var(--bs-input-bg);
  color: var(--bs-input-color);
  font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
  font-size: 12px; text-align: left; cursor: pointer;
  transition: border-color 150ms, box-shadow 150ms, background 150ms;
}
.mc-trigger:hover { border-color: var(--bs-input-hover-border); background: var(--bs-input-hover-bg); }
.mc-trigger.is-open, .mc-trigger:focus-visible {
  outline: none; border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99,102,241,0.15);
  background: var(--bs-input-focus-bg);
}
.mc-trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.mc-ico { width: 14px; height: 14px; flex-shrink: 0; color: #6366f1; }
.mc-trigger-val { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-trigger-val.is-placeholder { color: var(--bs-input-placeholder); }
.mc-clear {
  margin-left: auto; width: 16px; height: 16px;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: transparent; border-radius: 50%;
  color: #64748b; font-size: 14px; cursor: pointer; flex-shrink: 0;
  transition: color 100ms, background 100ms;
}
.mc-clear:hover { color: #f87171; background: rgba(239,68,68,0.10); }
.mc-popover {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 200;
  width: 230px;
  background: #2b2b2b;
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,0.40);
  padding: 10px;
  display: flex; flex-direction: column; gap: 6px;
  animation: mc-drop-in 180ms cubic-bezier(0.34,1.4,0.64,1);
}
@keyframes mc-drop-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.mc-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 2px 4px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.mc-month-label { font-size: 12.5px; font-weight: 600; color: #e2e8f0; letter-spacing: 0.02em; }
.mc-nav {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 6px; border: none;
  background: transparent; color: #94a3b8; cursor: pointer;
  transition: background 120ms, color 120ms;
}
.mc-nav:hover { background: rgba(99,102,241,0.14); color: #a5b4fc; }
.mc-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; }
.mc-dow {
  text-align: center; font-size: 9.5px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: #64748b; padding: 3px 0;
}
.mc-day {
  display: flex; align-items: center; justify-content: center;
  width: 100%; aspect-ratio: 1; border: none; border-radius: 6px; background: transparent;
  font-size: 11.5px; color: #e2e8f0; cursor: pointer;
  transition: background 120ms, color 120ms, transform 80ms;
}
.mc-day:hover { background: rgba(99,102,241,0.15); color: #a5b4fc; transform: scale(1.10); }
.mc-day.is-today { color: #818cf8; font-weight: 700; box-shadow: inset 0 0 0 1px rgba(99,102,241,0.45); }
.mc-day.is-selected {
  background: #6366f1; color: #fff; font-weight: 700;
  box-shadow: 0 2px 8px rgba(99,102,241,0.45); transform: scale(1.08);
}
.mc-day.is-selected:hover { background: #4f46e5; transform: scale(1.12); }
.mc-time-row {
  display: flex; align-items: center; gap: 6px;
  padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06);
}
.mc-time-label { font-size: 10.5px; color: #94a3b8; flex: 1; }
.mc-time-input {
  width: 40px; padding: 3px 4px; text-align: center;
  border-radius: 5px; border: 1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.05); color: #e2e8f0;
  font-size: 12px; font-variant-numeric: tabular-nums; outline: none;
}
.mc-time-input:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.20); }
.mc-time-sep { color: #94a3b8; font-weight: 600; }
.mc-time-ok {
  padding: 3px 8px; border-radius: 5px; border: none;
  background: rgba(99,102,241,0.20); color: #a5b4fc;
  font-size: 11px; font-weight: 600; cursor: pointer; transition: background 120ms;
}
.mc-time-ok:hover { background: rgba(99,102,241,0.32); }
.mc-footer { display: flex; justify-content: center; padding-top: 4px; }
.mc-today-btn {
  font-size: 11px; font-weight: 600; color: #818cf8;
  border: none; background: transparent; cursor: pointer;
  padding: 3px 10px; border-radius: 5px; transition: background 120ms, color 120ms;
}
.mc-today-btn:hover { background: rgba(99,102,241,0.12); color: #a5b4fc; }
`;

t = t.trimEnd() + '\n' + APPEND + '\n';
fs.writeFileSync(f, t, 'utf8');
console.log('index.css appended. Lines:', t.split('\n').length);
console.log('bs-info-grid:', t.includes('.bs-info-grid'));
console.log('mc-wrap:', t.includes('.mc-wrap'));
