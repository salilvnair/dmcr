// Add pure-JS MiniCalendar CSS + JS to the 3 form files
// The insert-rows form has timestamp/date type columns — we add a calendar
// trigger on date inputs in the row data table.
const fs = require('fs');

const CALENDAR_CSS = `
    /* ---- MiniCalendar (mc-*) -- ck8t ditto ---- */
    .mc-wrap { position: relative; display: inline-block; width: 100%; }
    .mc-trigger {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 6px 10px; border-radius: 7px;
      border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.05);
      color: #e2e8f0; font-family: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
      transition: border-color 140ms, box-shadow 140ms, background 140ms;
    }
    .mc-trigger:hover { border-color: rgba(255,255,255,0.20); background: rgba(255,255,255,0.08); }
    .mc-trigger.is-open { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.22); }
    .mc-trigger:disabled { opacity: 0.5; cursor: not-allowed; }
    .mc-ico { width: 14px; height: 14px; flex-shrink: 0; color: #6366f1; }
    .mc-trigger-val { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mc-trigger-val.is-placeholder { color: #4b5563; }
    .mc-clear {
      width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center;
      border: none; background: transparent; color: #64748b; font-size: 14px; cursor: pointer;
      border-radius: 50%; transition: color 100ms, background 100ms;
    }
    .mc-clear:hover { color: #f87171; background: rgba(239,68,68,0.10); }
    .mc-popover {
      position: fixed; z-index: 99999; width: 228px;
      background: #2b2b2b; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.50); padding: 10px;
      display: none; flex-direction: column; gap: 6px;
      animation: mc-drop-in 160ms cubic-bezier(0.34,1.4,0.64,1);
    }
    .mc-popover.is-open { display: flex; }
    @keyframes mc-drop-in {
      from { opacity: 0; transform: translateY(-6px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .mc-header {
      display: flex; align-items: center; justify-content: space-between;
      padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .mc-month-label { font-size: 12.5px; font-weight: 700; color: #e2e8f0; }
    .mc-nav {
      width: 26px; height: 26px; border: none; border-radius: 6px; background: transparent;
      color: #94a3b8; cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: background 120ms, color 120ms;
    }
    .mc-nav:hover { background: rgba(99,102,241,0.14); color: #a5b4fc; }
    .mc-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 1px; margin-top: 4px; }
    .mc-dow { text-align: center; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #475569; padding: 2px 0; }
    .mc-day {
      display: flex; align-items: center; justify-content: center;
      aspect-ratio: 1; border: none; border-radius: 6px; background: transparent;
      font-size: 11.5px; color: #e2e8f0; cursor: pointer;
      transition: background 120ms, color 120ms, transform 80ms;
    }
    .mc-day:hover { background: rgba(99,102,241,0.15); color: #a5b4fc; transform: scale(1.1); }
    .mc-day.is-today { color: #818cf8; font-weight: 700; box-shadow: inset 0 0 0 1px rgba(99,102,241,0.45); }
    .mc-day.is-selected { background: #6366f1; color: #fff; font-weight: 700; box-shadow: 0 2px 8px rgba(99,102,241,0.4); transform: scale(1.08); }
    .mc-day.is-selected:hover { background: #4f46e5; }
    .mc-footer { display: flex; justify-content: center; padding-top: 4px; }
    .mc-today-btn {
      font-size: 11px; font-weight: 600; color: #818cf8; border: none; background: transparent;
      cursor: pointer; padding: 3px 10px; border-radius: 5px; transition: background 120ms;
    }
    .mc-today-btn:hover { background: rgba(99,102,241,0.12); color: #a5b4fc; }
`;

const CALENDAR_JS = `
  /* ── MiniCalendar pure JS ── */
  (function() {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

    function pad(n) { return String(n).padStart(2,'0'); }
    function daysInMonth(y,m) { return new Date(y,m+1,0).getDate(); }
    function firstDay(y,m) { return new Date(y,m,1).getDay(); }

    function buildCalendar(wrap, hiddenInput) {
      const today = new Date();
      let year = today.getFullYear(), month = today.getMonth();
      let selected = null;

      const trigger  = wrap.querySelector('.mc-trigger');
      const trigVal  = wrap.querySelector('.mc-trigger-val');
      const clearBtn = wrap.querySelector('.mc-clear');
      const popover  = wrap.querySelector('.mc-popover');
      const monthLbl = wrap.querySelector('.mc-month-label');
      const grid     = wrap.querySelector('.mc-grid');
      const prevBtn  = wrap.querySelector('.mc-prev');
      const nextBtn  = wrap.querySelector('.mc-next');
      const todayBtn = wrap.querySelector('.mc-today-btn');

      function open() {
        trigger.classList.add('is-open');
        popover.classList.add('is-open');
        const r = trigger.getBoundingClientRect();
        const viewH = window.innerHeight;
        const menuH = 290;
        const goUp = viewH - r.bottom < menuH + 8 && r.top > menuH + 8;
        popover.style.top  = goUp ? (r.top - menuH - 4) + 'px' : (r.bottom + 4) + 'px';
        popover.style.left = r.left + 'px';
        render();
      }
      function close() {
        trigger.classList.remove('is-open');
        popover.classList.remove('is-open');
      }

      trigger.addEventListener('click', function(e) {
        if (e.target === clearBtn || clearBtn.contains(e.target)) return;
        popover.classList.contains('is-open') ? close() : open();
      });
      clearBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        selected = null; hiddenInput.value = ''; trigVal.textContent = '';
        trigVal.classList.add('is-placeholder'); close();
        hiddenInput.dispatchEvent(new Event('change'));
      });
      document.addEventListener('mousedown', function(e) {
        if (!wrap.contains(e.target) && !popover.contains(e.target)) close();
      });
      prevBtn.addEventListener('click', function() {
        month--; if (month<0){month=11;year--;} render();
      });
      nextBtn.addEventListener('click', function() {
        month++; if (month>11){month=0;year++;} render();
      });
      todayBtn.addEventListener('click', function() {
        const now=new Date(); year=now.getFullYear(); month=now.getMonth();
        selectDay(now.getDate());
      });

      function selectDay(d) {
        selected = {y:year,m:month,d:d};
        const iso = year+'-'+pad(month+1)+'-'+pad(d);
        hiddenInput.value = iso;
        trigVal.textContent = iso;
        trigVal.classList.remove('is-placeholder');
        close();
        hiddenInput.dispatchEvent(new Event('change'));
      }

      function render() {
        monthLbl.textContent = MONTHS[month]+' '+year;
        grid.innerHTML = DAYS.map(d=>'<div class="mc-dow">'+d+'</div>').join('');
        const start = firstDay(year,month), total = daysInMonth(year,month);
        for (let i=0;i<start;i++) grid.innerHTML += '<div></div>';
        for (let day=1;day<=total;day++) {
          const btn = document.createElement('button');
          btn.type = 'button'; btn.className = 'mc-day'; btn.textContent = day;
          const isToday = today.getFullYear()===year&&today.getMonth()===month&&today.getDate()===day;
          const isSel   = selected&&selected.y===year&&selected.m===month&&selected.d===day;
          if (isToday) btn.classList.add('is-today');
          if (isSel)   btn.classList.add('is-selected');
          btn.addEventListener('click', ()=>selectDay(day));
          grid.appendChild(btn);
        }
      }
    }

    function mcHtml(id, placeholder) {
      return '<div class="mc-wrap" data-mc-id="'+id+'">' +
        '<button type="button" class="mc-trigger">' +
          '<svg class="mc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' +
          '</svg>' +
          '<span class="mc-trigger-val is-placeholder">'+(placeholder||'YYYY-MM-DD')+'</span>' +
          '<button type="button" class="mc-clear" title="Clear">&times;</button>' +
        '</button>' +
        '<div class="mc-popover">' +
          '<div class="mc-header">' +
            '<button type="button" class="mc-nav mc-prev"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>' +
            '<span class="mc-month-label"></span>' +
            '<button type="button" class="mc-nav mc-next"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>' +
          '</div>' +
          '<div class="mc-grid"></div>' +
          '<div class="mc-footer"><button type="button" class="mc-today-btn">Today</button></div>' +
        '</div>' +
      '</div>';
    }
    window.__mc = { html: mcHtml, init: buildCalendar };
  })();
`;

// ─── Patch insert-rows form (date inputs in value cells need calendars) ────────
let insFile = fs.readFileSync('src/dmcr-insert-rows-form.ts','utf8');

// Add calendar CSS inside style block
insFile = insFile.replace(
  '  </style>',
  CALENDAR_CSS + '  </style>'
);

// Add calendar JS before </body>
insFile = insFile.replace(
  '</body>',
  `  <script nonce="\${n}">${CALENDAR_JS}  </script>\n</body>`
);

fs.writeFileSync('src/dmcr-insert-rows-form.ts', insFile, 'utf8');
console.log('insert-rows: calendar CSS+JS added');

// ─── Patch add-columns form (date columns — no date inputs in the form itself, but add for completeness) ──
let addFile = fs.readFileSync('src/dmcr-add-columns-form.ts','utf8');
addFile = addFile.replace('  </style>', CALENDAR_CSS + '  </style>');
addFile = addFile.replace('</body>', `  <script nonce="\${n}">${CALENDAR_JS}  </script>\n</body>`);
fs.writeFileSync('src/dmcr-add-columns-form.ts', addFile, 'utf8');
console.log('add-columns: calendar CSS+JS added');

// ─── Patch freeform form (no date inputs, but add for consistency) ──────────
let freeFile = fs.readFileSync('src/dmcr-freeform-sql-form.ts','utf8');
freeFile = freeFile.replace('  </style>', CALENDAR_CSS + '  </style>');
freeFile = freeFile.replace('</body>', `  <script nonce="\${n}">${CALENDAR_JS}  </script>\n</body>`);
fs.writeFileSync('src/dmcr-freeform-sql-form.ts', freeFile, 'utf8');
console.log('freeform: calendar CSS+JS added');

console.log('All done.');
