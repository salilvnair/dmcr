/**
 * patch-datetime-picker.js
 * Replaces the mc-* MiniCalendar CSS + JS in insert-rows-form.ts
 * with a full dark-themed dtpk-* datetime picker (calendar + time drums).
 */
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'src', 'forms', 'core', 'panels', 'insert-rows-form.ts');
let src = fs.readFileSync(FILE, 'utf8');

// ══════════════════════════════════════════════════════════════════════════════
// 1. CSS — replace the entire mc-* block with dtpk-*
// ══════════════════════════════════════════════════════════════════════════════
const OLD_CSS_START = `    /* ---- MiniCalendar (mc-*) -- ck8t ditto ---- */`;
const OLD_CSS_END   = `    .mc-today-btn:hover { background: rgba(99,102,241,0.12); color: #a5b4fc; }`;

const NEW_CSS = `    /* ══════════════════════════════════════════════
       DTPK – Dark DateTime Picker  (dtpk-*)
       ══════════════════════════════════════════════ */

    /* Trigger pill */
    .dtpk-wrap { position: relative; width: 100%; }
    .dtpk-trigger {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 5px 10px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.10);
      background: rgba(255,255,255,0.04);
      color: #e2e8f0; font-family: inherit; font-size: 12.5px;
      text-align: left; cursor: pointer;
      transition: border-color 140ms, box-shadow 140ms, background 140ms;
    }
    .dtpk-trigger:hover { border-color: rgba(99,102,241,0.45); background: rgba(255,255,255,0.07); }
    .dtpk-trigger.is-open {
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99,102,241,0.22);
    }
    .dtpk-cal-ico { width: 14px; height: 14px; flex-shrink: 0; color: #818cf8; }
    .dtpk-val { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-variant-numeric: tabular-nums; }
    .dtpk-val.ph { color: #4b5563; font-style: italic; }
    .dtpk-clr {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 50%; border: none;
      background: transparent; color: #475569; font-size: 15px; cursor: pointer;
      transition: color 100ms, background 100ms; flex-shrink: 0;
    }
    .dtpk-clr:hover { color: #f87171; background: rgba(239,68,68,0.12); }

    /* Popover card */
    .dtpk-pop {
      position: fixed; z-index: 99999;
      background: #1e1e2e;
      border: 1px solid rgba(99,102,241,0.22);
      border-radius: 14px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04);
      display: none; flex-direction: row; gap: 0; overflow: hidden;
      font-family: inherit;
    }
    .dtpk-pop.open {
      display: flex;
      animation: dtpk-in 200ms cubic-bezier(0.34,1.38,0.64,1) both;
    }
    @keyframes dtpk-in {
      from { opacity: 0; transform: translateY(-8px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0)   scale(1); }
    }

    /* ── Calendar pane (left) ── */
    .dtpk-cal { padding: 14px 14px 10px; display: flex; flex-direction: column; gap: 0; min-width: 220px; }

    .dtpk-cal-hd {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 10px;
    }
    .dtpk-month-lbl {
      font-size: 13px; font-weight: 800; letter-spacing: -0.02em;
      color: #e2e8f0;
    }
    .dtpk-month-lbl span { color: #64748b; font-weight: 400; margin-left: 5px; }
    .dtpk-nav {
      width: 28px; height: 28px; border-radius: 8px; border: none;
      background: rgba(255,255,255,0.04); color: #94a3b8; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 120ms, color 120ms;
    }
    .dtpk-nav:hover { background: rgba(99,102,241,0.16); color: #a5b4fc; }

    .dtpk-dow-row {
      display: grid; grid-template-columns: repeat(7,1fr); gap: 2px;
      margin-bottom: 4px;
    }
    .dtpk-dow {
      text-align: center; font-size: 9.5px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.07em; color: #475569;
      padding: 2px 0;
    }

    .dtpk-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 2px; }
    .dtpk-day {
      display: flex; align-items: center; justify-content: center;
      border: none; border-radius: 8px; background: transparent;
      font-size: 11.5px; color: #cbd5e1; cursor: pointer; padding: 0;
      height: 30px;
      transition: background 120ms, color 120ms, transform 80ms;
    }
    .dtpk-day:hover { background: rgba(99,102,241,0.14); color: #a5b4fc; transform: scale(1.12); }
    .dtpk-day.today {
      color: #818cf8; font-weight: 800;
      box-shadow: inset 0 0 0 1.5px rgba(99,102,241,0.55);
    }
    .dtpk-day.sel {
      background: #6366f1; color: #fff; font-weight: 700;
      box-shadow: 0 3px 10px rgba(99,102,241,0.50);
      transform: scale(1.1);
    }
    .dtpk-day.sel:hover { background: #4f46e5; }
    .dtpk-day.other-month { color: #334155; }
    .dtpk-day.other-month:hover { color: #64748b; background: rgba(255,255,255,0.03); transform: none; }

    .dtpk-cal-ft {
      display: flex; align-items: center; justify-content: space-between;
      padding-top: 8px; margin-top: 8px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .dtpk-today-btn {
      font-size: 11px; font-weight: 600; color: #818cf8; border: none;
      background: transparent; cursor: pointer; padding: 3px 10px; border-radius: 6px;
      transition: background 120ms, color 120ms;
    }
    .dtpk-today-btn:hover { background: rgba(99,102,241,0.12); color: #a5b4fc; }
    .dtpk-done-btn {
      font-size: 11px; font-weight: 700; color: #fff; border: none;
      background: #6366f1; cursor: pointer; padding: 4px 14px; border-radius: 6px;
      transition: background 120ms, box-shadow 120ms;
      box-shadow: 0 2px 8px rgba(99,102,241,0.35);
    }
    .dtpk-done-btn:hover { background: #4f46e5; }

    /* ── Divider between cal and time ── */
    .dtpk-vdiv {
      width: 1px; background: rgba(255,255,255,0.06); flex-shrink: 0; align-self: stretch;
    }

    /* ── Time pane (right, timestamp only) ── */
    .dtpk-time-pane {
      display: flex; flex-direction: column; padding: 14px 12px 10px;
      gap: 8px; min-width: 140px;
    }
    .dtpk-time-title {
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
      color: #475569; padding-bottom: 6px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .dtpk-drums { display: flex; align-items: flex-start; gap: 2px; }
    .dtpk-drum-col { display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .dtpk-drum-lbl { font-size: 8.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: #334155; }

    /* The scrollable drum */
    .dtpk-drum {
      width: 38px; height: 160px;
      overflow-y: scroll; scroll-snap-type: y mandatory;
      scrollbar-width: none;
      border-radius: 10px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.07);
      position: relative;
    }
    .dtpk-drum::-webkit-scrollbar { display: none; }

    /* selection ring overlay */
    .dtpk-drum::before {
      content: ''; pointer-events: none;
      position: sticky; top: 60px; left: 0; right: 0;
      display: block; height: 40px; margin-top: -40px;
      border-top: 1px solid rgba(99,102,241,0.35);
      border-bottom: 1px solid rgba(99,102,241,0.35);
      background: rgba(99,102,241,0.08);
      z-index: 1;
    }

    .dtpk-drum-item {
      height: 40px; display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-variant-numeric: tabular-nums; font-weight: 500;
      color: #64748b; cursor: pointer; scroll-snap-align: start;
      transition: color 100ms, font-weight 100ms;
      user-select: none;
    }
    .dtpk-drum-item.active { color: #e2e8f0; font-weight: 700; font-size: 15px; }
    .dtpk-drum-item:hover { color: #a5b4fc; }

    /* spacers inside drum so first/last items centre */
    .dtpk-drum-space { height: 60px; flex-shrink: 0; scroll-snap-align: none; }

    /* AM/PM column */
    .dtpk-ampm-col { display: flex; flex-direction: column; gap: 4px; margin-top: 20px; }
    .dtpk-ampm-btn {
      width: 38px; padding: 8px 0; border-radius: 7px; border: 1px solid rgba(255,255,255,0.08);
      background: transparent; color: #64748b; font-size: 11px; font-weight: 700;
      cursor: pointer; transition: background 120ms, color 120ms, border-color 120ms;
    }
    .dtpk-ampm-btn.active {
      background: rgba(99,102,241,0.20); color: #a5b4fc;
      border-color: rgba(99,102,241,0.40);
    }
    .dtpk-ampm-btn:hover:not(.active) { border-color: rgba(255,255,255,0.15); color: #94a3b8; }

    .dtpk-sep { font-size: 16px; font-weight: 700; color: #334155; align-self: center; margin-top: 20px; }`;

// Find and replace
const cssStartIdx = src.indexOf(OLD_CSS_START);
const cssEndIdx   = src.indexOf(OLD_CSS_END) + OLD_CSS_END.length;
if (cssStartIdx === -1 || cssEndIdx === -1) { console.error('CSS markers not found'); process.exit(1); }
src = src.slice(0, cssStartIdx) + NEW_CSS + src.slice(cssEndIdx);
console.log('CSS replaced.');

// ══════════════════════════════════════════════════════════════════════════════
// 2. Hint text update (remove "native pickers" mention)
// ══════════════════════════════════════════════════════════════════════════════
src = src.replace(
  'Timestamp/time/date fields use native pickers; interval expects H:MM:SS.',
  'Timestamp/time/date fields use the built-in dark picker; interval expects H:MM:SS.'
);

// ══════════════════════════════════════════════════════════════════════════════
// 3. buildCellEditor — replace native date/time inputs with dtpk
// ══════════════════════════════════════════════════════════════════════════════
const OLD_CELL = `    } else if (col.type === "date") {
      input = el("input", { type: "date", value: currentValue ?? "" });
      input.addEventListener("input", () => onChange(input.value || null));
    } else if (col.type === "time") {
      input = el("input", { type: "time", value: currentValue ?? "" });
      input.step = "1";
      input.addEventListener("input", () => onChange(input.value || null));
    } else if (col.type === "timestamp" || col.type === "timestamptz") {
      input = el("input", { type: "datetime-local", value: currentValue ?? "" });
      input.step = "1";
      input.addEventListener("input", () => onChange(input.value || null));
    }`;

const NEW_CELL = `    } else if (col.type === "date") {
      const picker = dtpk.create({ mode: 'date', value: currentValue, onChange });
      wrap.appendChild(picker.el);
      wrap.appendChild(picker.hidden);
      return wrap;
    } else if (col.type === "time") {
      const picker = dtpk.create({ mode: 'time', value: currentValue, onChange });
      wrap.appendChild(picker.el);
      wrap.appendChild(picker.hidden);
      return wrap;
    } else if (col.type === "timestamp" || col.type === "timestamptz") {
      const picker = dtpk.create({ mode: 'datetime', value: currentValue, onChange });
      wrap.appendChild(picker.el);
      wrap.appendChild(picker.hidden);
      return wrap;
    }`;

src = src.replace(OLD_CELL, NEW_CELL);
console.log('buildCellEditor patched.');

// ══════════════════════════════════════════════════════════════════════════════
// 4. Remove old mc-* JS block (the second <script> injected by add-calendar.js)
//    Replace with the new dtpk JS
// ══════════════════════════════════════════════════════════════════════════════
const OLD_SCRIPT_START = `  <script nonce="\${n}">\n  /* ── MiniCalendar pure JS ── */`;
const OLD_SCRIPT_END   = `  </script>\n</body>`;

const NEW_SCRIPT = `  <script nonce="\${n}">
  /* ══════════════════════════════════════════════════════
     dtpk — Dark DateTime Picker  (vanilla JS, ck8t style)
     ══════════════════════════════════════════════════════ */
  const dtpk = (() => {
    const MONTHS = ['January','February','March','April','May','June','July',
                    'August','September','October','November','December'];
    const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    function pad(n) { return String(n).padStart(2, '0'); }
    function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
    function firstDayOf(y, m) { return new Date(y, m, 1).getDay(); }

    /** Tiny element builder */
    function h(tag, attrs, ...kids) {
      const e = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else e.setAttribute(k, v);
      }
      for (const c of kids) {
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else if (c) e.appendChild(c);
      }
      return e;
    }

    function chevron(dir) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.2');
      svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
      const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      pl.setAttribute('points', dir === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6');
      svg.appendChild(pl); return svg;
    }

    function calIco() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
      svg.className = 'dtpk-cal-ico';
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '3'); rect.setAttribute('y', '4');
      rect.setAttribute('width', '18'); rect.setAttribute('height', '18'); rect.setAttribute('rx', '2');
      const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l1.setAttribute('x1','16'); l1.setAttribute('y1','2'); l1.setAttribute('x2','16'); l1.setAttribute('y2','6');
      const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l2.setAttribute('x1','8');  l2.setAttribute('y1','2'); l2.setAttribute('x2','8');  l2.setAttribute('y2','6');
      const l3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l3.setAttribute('x1','3');  l3.setAttribute('y1','10'); l3.setAttribute('x2','21'); l3.setAttribute('y2','10');
      svg.appendChild(rect); svg.appendChild(l1); svg.appendChild(l2); svg.appendChild(l3);
      return svg;
    }

    /* ── Drum (scroll-snap time column) ── */
    function buildDrum(items, initialIdx) {
      const drum = h('div', { class: 'dtpk-drum' });
      const topSpacer = h('div', { class: 'dtpk-drum-space' });
      drum.appendChild(topSpacer);

      const itemEls = items.map((lbl, i) => {
        const it = h('div', { class: 'dtpk-drum-item', text: lbl });
        if (i === initialIdx) it.classList.add('active');
        drum.appendChild(it);
        return it;
      });

      const botSpacer = h('div', { class: 'dtpk-drum-space' });
      drum.appendChild(botSpacer);

      // Scroll to initial
      function scrollToIdx(idx, smooth) {
        drum.scrollTo({ top: idx * 40, behavior: smooth ? 'smooth' : 'auto' });
      }
      setTimeout(() => scrollToIdx(initialIdx, false), 0);

      let currentIdx = initialIdx;
      const getIdx = () => currentIdx;

      // Sync active class on scroll (debounced)
      let scrollTimer = null;
      drum.addEventListener('scroll', () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          const rawIdx = Math.round(drum.scrollTop / 40);
          const idx = Math.max(0, Math.min(items.length - 1, rawIdx));
          if (idx !== currentIdx) {
            itemEls[currentIdx]?.classList.remove('active');
            itemEls[idx]?.classList.add('active');
            currentIdx = idx;
            drum.dispatchEvent(new Event('change'));
          }
          // snap exactly
          scrollToIdx(idx, true);
        }, 120);
      });

      // Click to select
      itemEls.forEach((el, i) => {
        el.addEventListener('click', () => {
          scrollToIdx(i, true);
        });
      });

      // Set externally
      function setValue(idx) {
        const clamped = Math.max(0, Math.min(items.length - 1, idx));
        itemEls[currentIdx]?.classList.remove('active');
        itemEls[clamped]?.classList.add('active');
        currentIdx = clamped;
        scrollToIdx(clamped, false);
      }

      return { el: drum, getIdx, setValue };
    }

    /* ── Main factory ── */
    function create({ mode, value, onChange }) {
      const today = new Date();
      let selYear  = today.getFullYear();
      let selMonth = today.getMonth();
      let selDay   = today.getDate();
      let ampm     = 'AM';

      // Parse existing value
      if (value) {
        const d = new Date(value.includes('T') ? value : value + 'T00:00:00');
        if (!isNaN(d)) {
          selYear = d.getFullYear(); selMonth = d.getMonth(); selDay = d.getDate();
          if (mode !== 'date') {
            const h24 = d.getHours();
            ampm = h24 >= 12 ? 'PM' : 'AM';
          }
        }
      }

      // Initial time values (from value or now)
      let initH = 12, initM = 0, initS = 0;
      if (value && mode !== 'date') {
        const d = new Date(value.includes('T') ? value : value + 'T00:00:00');
        if (!isNaN(d)) {
          const h24 = d.getHours();
          initH = h24 % 12 || 12; initM = d.getMinutes(); initS = d.getSeconds();
        }
      }

      // ── Hidden input (carries the ISO value back to onChange) ──
      const hidden = h('input', { type: 'hidden', value: value ?? '' });

      // ── Build the trigger pill ──
      const valSpan  = h('span', { class: 'dtpk-val' + (value ? '' : ' ph'),
                                   text: value ? formatDisplay(value, mode) : placeholder(mode) });
      const clrBtn   = h('button', { class: 'dtpk-clr', type: 'button', text: '×' });
      const trigger  = h('button', { class: 'dtpk-trigger', type: 'button' },
                         calIco(), valSpan, clrBtn);

      // ── Build the popover ──
      const pop = h('div', { class: 'dtpk-pop' });

      // ── Calendar pane ──
      const monthLbl = h('span', { class: 'dtpk-month-lbl' });
      const prevBtn  = h('button', { class: 'dtpk-nav', type: 'button' }, chevron('left'));
      const nextBtn  = h('button', { class: 'dtpk-nav', type: 'button' }, chevron('right'));
      const calHd    = h('div', { class: 'dtpk-cal-hd' }, prevBtn, monthLbl, nextBtn);
      const dowRow   = h('div', { class: 'dtpk-dow-row' });
      DAYS.forEach(d => dowRow.appendChild(h('div', { class: 'dtpk-dow', text: d })));
      const grid     = h('div', { class: 'dtpk-grid' });
      const todayBtn = h('button', { class: 'dtpk-today-btn', type: 'button', text: 'Today' });
      const doneBtn  = h('button', { class: 'dtpk-done-btn',  type: 'button', text: 'Done' });
      const calFt    = h('div', { class: 'dtpk-cal-ft' }, todayBtn, doneBtn);
      const calPane  = h('div', { class: 'dtpk-cal' }, calHd, dowRow, grid, calFt);
      pop.appendChild(calPane);

      // ── Time pane (timestamp / time modes) ──
      let hourDrum, minDrum, secDrum, ampmBtns = [];
      if (mode !== 'date') {
        const vdiv = h('div', { class: 'dtpk-vdiv' });
        pop.appendChild(vdiv);

        const hours   = Array.from({ length: 12 }, (_, i) => pad(i + 1));
        const minutes = Array.from({ length: 60 }, (_, i) => pad(i));
        const seconds = Array.from({ length: 60 }, (_, i) => pad(i));

        hourDrum = buildDrum(hours, initH - 1);
        minDrum  = buildDrum(minutes, initM);
        secDrum  = buildDrum(seconds, initS);

        const amBtn = h('button', { class: 'dtpk-ampm-btn' + (ampm === 'AM' ? ' active' : ''), type: 'button', text: 'AM' });
        const pmBtn = h('button', { class: 'dtpk-ampm-btn' + (ampm === 'PM' ? ' active' : ''), type: 'button', text: 'PM' });
        ampmBtns = [amBtn, pmBtn];

        const ampmCol = h('div', { class: 'dtpk-ampm-col' }, amBtn, pmBtn);
        const hCol = h('div', { class: 'dtpk-drum-col' }, h('div', { class: 'dtpk-drum-lbl', text: 'HH' }), hourDrum.el);
        const sep1 = h('span', { class: 'dtpk-sep', text: ':' });
        const mCol = h('div', { class: 'dtpk-drum-col' }, h('div', { class: 'dtpk-drum-lbl', text: 'MM' }), minDrum.el);
        const sep2 = h('span', { class: 'dtpk-sep', text: ':' });
        const sCol = h('div', { class: 'dtpk-drum-col' }, h('div', { class: 'dtpk-drum-lbl', text: 'SS' }), secDrum.el);

        const drums = h('div', { class: 'dtpk-drums' }, hCol, sep1, mCol, sep2, sCol, ampmCol);
        const timePane = h('div', { class: 'dtpk-time-pane' },
          h('div', { class: 'dtpk-time-title', text: 'Time' }),
          drums);
        pop.appendChild(timePane);

        amBtn.addEventListener('click', () => { ampm = 'AM'; amBtn.classList.add('active'); pmBtn.classList.remove('active'); commitValue(); });
        pmBtn.addEventListener('click', () => { ampm = 'PM'; pmBtn.classList.add('active'); amBtn.classList.remove('active'); commitValue(); });
        [hourDrum.el, minDrum.el, secDrum.el].forEach(d => d.addEventListener('change', commitValue));
      }

      // ── State / render ──
      function renderGrid() {
        grid.innerHTML = '';
        monthLbl.innerHTML = MONTHS[selMonth] + ' <span>' + selYear + '</span>';

        const fd   = firstDayOf(selYear, selMonth);
        const dim  = daysInMonth(selYear, selMonth);
        const prevDim = daysInMonth(selYear, selMonth - 1 < 0 ? 11 : selMonth - 1);
        const todayISO = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());

        // Leading blank cells (prev month days, dimmed)
        for (let i = 0; i < fd; i++) {
          const d = prevDim - fd + 1 + i;
          const btn = h('button', { class: 'dtpk-day other-month', type: 'button', text: String(d) });
          grid.appendChild(btn);
        }

        for (let d = 1; d <= dim; d++) {
          const iso = selYear + '-' + pad(selMonth + 1) + '-' + pad(d);
          let cls = 'dtpk-day';
          if (iso === todayISO) cls += ' today';
          if (d === selDay && selYear === selYear && selMonth === selMonth) cls += ' sel';
          const btn = h('button', { class: cls, type: 'button', text: String(d) });
          btn.addEventListener('click', () => { selDay = d; renderGrid(); commitValue(); });
          grid.appendChild(btn);
        }

        // Trailing cells
        const total = fd + dim;
        const trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
        for (let i = 1; i <= trailing; i++) {
          const btn = h('button', { class: 'dtpk-day other-month', type: 'button', text: String(i) });
          grid.appendChild(btn);
        }
      }

      function getTimeISO() {
        if (mode === 'date') return '';
        const hIdx = hourDrum.getIdx();
        const h12 = hIdx + 1;
        let h24 = h12 % 12 + (ampm === 'PM' ? 12 : 0);
        if (h24 === 24) h24 = 12;
        if (h24 === 12 && ampm === 'AM') h24 = 0;
        return 'T' + pad(h24) + ':' + pad(minDrum.getIdx()) + ':' + pad(secDrum.getIdx());
      }

      function commitValue() {
        const dateStr = selYear + '-' + pad(selMonth + 1) + '-' + pad(selDay);
        let iso;
        if (mode === 'date')     iso = dateStr;
        else if (mode === 'time') iso = getTimeISO().slice(1); // HH:MM:SS
        else                     iso = dateStr + getTimeISO();
        hidden.value = iso;
        valSpan.textContent = formatDisplay(iso, mode);
        valSpan.classList.remove('ph');
        onChange(iso || null);
      }

      // ── Position popover ──
      function openPop() {
        renderGrid();
        trigger.classList.add('is-open');
        pop.classList.add('open');
        const r = trigger.getBoundingClientRect();
        const popW = mode === 'date' ? 240 : 400;
        const popH = 320;
        let left = r.left;
        let top  = r.bottom + 6;
        if (left + popW > window.innerWidth - 8)  left = window.innerWidth - popW - 8;
        if (top + popH  > window.innerHeight - 8) top  = r.top - popH - 6;
        pop.style.top  = top  + 'px';
        pop.style.left = left + 'px';
      }
      function closePop() { trigger.classList.remove('is-open'); pop.classList.remove('open'); }

      trigger.addEventListener('click', e => {
        if (e.target === clrBtn || clrBtn.contains(e.target)) return;
        pop.classList.contains('open') ? closePop() : openPop();
      });
      document.addEventListener('mousedown', e => {
        if (!wrap.contains(e.target) && !pop.contains(e.target)) closePop();
      }, true);

      clrBtn.addEventListener('click', e => {
        e.stopPropagation();
        hidden.value = ''; valSpan.textContent = placeholder(mode); valSpan.classList.add('ph');
        onChange(null); closePop();
      });
      prevBtn.addEventListener('click', () => {
        selMonth--; if (selMonth < 0) { selMonth = 11; selYear--; } renderGrid();
      });
      nextBtn.addEventListener('click', () => {
        selMonth++; if (selMonth > 11) { selMonth = 0; selYear++; } renderGrid();
      });
      todayBtn.addEventListener('click', () => {
        selYear = today.getFullYear(); selMonth = today.getMonth(); selDay = today.getDate();
        renderGrid(); commitValue();
      });
      doneBtn.addEventListener('click', () => { commitValue(); closePop(); });

      // ── Outer wrap ──
      const wrap = h('div', { class: 'dtpk-wrap' });
      wrap.appendChild(trigger);
      document.body.appendChild(pop);   // portal to body so no overflow clipping

      return { el: wrap, hidden };
    }

    /* ── Helpers ── */
    function placeholder(mode) {
      if (mode === 'date')     return 'Select date…';
      if (mode === 'time')     return 'Select time…';
      return 'Select date & time…';
    }

    function formatDisplay(iso, mode) {
      if (!iso) return '';
      try {
        if (mode === 'time') return iso;  // HH:MM:SS
        const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
        if (isNaN(d)) return iso;
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const date = months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
        if (mode === 'date') return date;
        const h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        const time = pad(h12) + ':' + pad(m) + ':' + pad(s) + ' ' + ampm;
        return date + '  ' + time;
      } catch { return iso; }
    }

    function pad(n) { return String(n).padStart(2, '0'); }

    return { create };
  })();
  </script>
</body>`;

const scriptStartIdx = src.indexOf(OLD_SCRIPT_START);
const scriptEndIdx   = src.indexOf(OLD_SCRIPT_END) + OLD_SCRIPT_END.length;
if (scriptStartIdx === -1 || scriptEndIdx === -1) { console.error('Script markers not found'); process.exit(1); }
src = src.slice(0, scriptStartIdx) + NEW_SCRIPT + src.slice(scriptEndIdx);
console.log('Script replaced.');

// ══════════════════════════════════════════════════════════════════════════════
// 5. Remove the clock emoji icon for timestamp (no longer needed; picker shows it)
// ══════════════════════════════════════════════════════════════════════════════
src = src.replace(
  `    const icon = el("span", { class: "icon", text: (col.type === "timestamp" || col.type === "timestamptz") ? "ðŸ•'" : "" });`,
  `    const icon = el("span", { class: "icon", text: "" });`
);

fs.writeFileSync(FILE, src, 'utf8');
console.log('Done! Lines:', src.split('\\n').length);
