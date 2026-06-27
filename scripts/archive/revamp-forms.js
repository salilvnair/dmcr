// Revamp all 3 DMCR form files with ck8t block/canvas styling
const fs = require('fs');

// ── Shared CSS block (embedded in each form's <style nonce="..."> tag) ──
const SHARED_CSS = `
    /* ---- ck8t block/canvas design system ---- */
    :root {
      --bg:         #0f1117;
      --bg2:        #161b27;
      --bg3:        #1e2535;
      --border:     rgba(255,255,255,0.08);
      --border2:    rgba(99,102,241,0.25);
      --text:       #e2e8f0;
      --text2:      #94a3b8;
      --accent:     #6366f1;
      --accent-ring:rgba(99,102,241,0.22);
      --red:        #f87171;
      --green:      #4ade80;
      --warn-bg:    rgba(234,179,8,0.10);
      --warn-border:rgba(234,179,8,0.35);
    }
    *, *::before, *::after { box-sizing: border-box; }

    body {
      margin: 0; padding: 14px 16px 32px;
      background: var(--bg); color: var(--text);
      font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px; line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 1060px; margin: 0 auto; }

    /* ── headings ── */
    h2 {
      margin: 0 0 4px; font-size: 17px; font-weight: 800;
      letter-spacing: -0.02em; color: #f1f5f9;
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .hint { color: var(--text2); margin: 4px 0 14px; font-size: 12.5px; }
    .section-title {
      font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--text2); margin: 0 0 10px;
    }
    .sectionRow {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; margin-bottom: 10px;
    }
    .sectionRow .section-title { margin: 0; }

    /* ── card / panel ── */
    .card {
      border: 1px solid var(--border);
      background: var(--bg2);
      border-radius: 12px;
      padding: 14px 16px;
      margin: 10px 0;
      box-shadow: 0 4px 16px rgba(0,0,0,0.22);
    }
    .mini { font-size: 12px; color: var(--text2); }

    /* ── inputs / textarea ── */
    input[type="text"], input[type="number"], input:not([type]), select, textarea {
      width: 100%; padding: 7px 10px; min-height: 32px;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--border);
      border-radius: 7px; color: var(--text);
      font-family: inherit; font-size: 12.5px; line-height: 1.4;
      outline: none;
      transition: border-color 140ms, box-shadow 140ms, background 140ms;
    }
    input[type="text"]:hover, input[type="number"]:hover, input:not([type]):hover,
    select:hover, textarea:hover {
      border-color: rgba(255,255,255,0.16); background: rgba(255,255,255,0.07);
    }
    input[type="text"]:focus, input[type="number"]:focus, input:not([type]):focus,
    select:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring);
      background: rgba(255,255,255,0.06);
    }
    input::placeholder, textarea::placeholder { color: #4b5563; }
    textarea { resize: vertical; min-height: 80px; }

    /* native select arrow */
    select {
      appearance: none; -webkit-appearance: none;
      padding-right: 30px; cursor: pointer;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='7' viewBox='0 0 12 7'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%2364748b' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
    }
    select:focus {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='7' viewBox='0 0 12 7'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236366f1' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
    }
    option { background: #1e2535; color: var(--text); }

    /* ── field wrapper ── */
    .field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .field > label {
      font-size: 11.5px; font-weight: 600; color: var(--text2); letter-spacing: 0.01em;
    }

    /* ── buttons ── */
    button {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 6px; padding: 7px 14px; min-height: 32px;
      border-radius: 8px; font-size: 12.5px; font-weight: 500;
      font-family: inherit; white-space: nowrap; cursor: pointer;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.05); color: var(--text);
      transition: all 140ms ease;
    }
    button:hover { border-color: rgba(255,255,255,0.16); background: rgba(255,255,255,0.09); color: #f8fafc; }
    button:active { background: rgba(255,255,255,0.03); transform: translateY(1px); }
    button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
    button:disabled { opacity: 0.40; cursor: not-allowed; transform: none; }

    button.small { padding: 5px 10px; min-height: 28px; font-size: 12px; border-radius: 6px; }

    button.primary {
      background: rgba(99,102,241,0.12); color: #c7d2fe;
      border-color: rgba(99,102,241,0.28);
    }
    button.primary:hover { background: rgba(99,102,241,0.22); border-color: rgba(99,102,241,0.45); color: #e0e7ff; }
    button.primary:active { background: rgba(99,102,241,0.08); }

    button.secondary { background: transparent; color: var(--text2); border-color: var(--border); }
    button.secondary:hover { background: rgba(255,255,255,0.05); color: var(--text); border-color: rgba(255,255,255,0.16); }

    button.danger { background: transparent; color: var(--red); border-color: rgba(239,68,68,0.35); }
    button.danger:hover { background: rgba(239,68,68,0.10); border-color: rgba(239,68,68,0.55); }

    button.ghost { background: transparent; border-color: transparent; color: var(--text2); }
    button.ghost:hover { background: rgba(255,255,255,0.05); color: var(--text); border-color: var(--border); }

    /* ── custom checkbox (ck8t bs-check style) ── */
    .bs-check {
      -webkit-appearance: none; appearance: none;
      margin: 0; width: 17px; height: 17px; flex: 0 0 17px;
      border: 1.5px solid #475569; border-radius: 5px;
      background: var(--bg3); cursor: pointer; position: relative;
      transition: all 120ms ease;
    }
    .bs-check:hover { border-color: #818cf8; }
    .bs-check:checked { background: #4f46e5; border-color: #4f46e5; }
    .bs-check:checked::after {
      content: ''; position: absolute;
      left: 5px; top: 1px; width: 5px; height: 9px;
      border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
    }
    .bs-check:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }

    /* ── check-row card (ck8t bs-check-row style) ── */
    .setting-card {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 10px; background: rgba(99,102,241,0.03);
      cursor: pointer; transition: all 120ms ease; margin-top: 10px;
    }
    .setting-card:hover { border-color: #475569; background: rgba(99,102,241,0.06); }
    .setting-card:has(input:checked) { border-color: var(--accent); background: rgba(99,102,241,0.10); }
    .setting-card .title { font-size: 13px; font-weight: 600; color: var(--text); line-height: 1.3; }
    .setting-card .desc { margin-top: 4px; font-size: 12px; color: var(--text2); line-height: 1.4; }

    /* ── inline checkbox row ── */
    .checkbox-row {
      display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-top: 10px;
    }
    .checkbox-row label { display: inline-flex; gap: 8px; align-items: center; cursor: pointer; font-size: 12.5px; }

    /* ── pill / badge ── */
    .pill {
      display: inline-flex; align-items: center; padding: 2px 9px;
      border-radius: 999px; border: 1px solid rgba(255,255,255,0.10);
      background: rgba(255,255,255,0.05); color: var(--text2);
      font-family: ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
      font-size: 11px; font-weight: 700;
    }
    .badge {
      display: inline-flex; align-items: center; padding: 2px 9px;
      border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.03em;
    }
    .badge.sql {
      border: 1px solid rgba(167,139,250,0.4); background: rgba(167,139,250,0.12); color: #c4b5fd;
    }
    .badge.warn {
      border: 1px solid var(--warn-border); background: var(--warn-bg); color: #fde047;
    }

    /* ── warning banner ── */
    .banner {
      border: 1px solid var(--warn-border); background: var(--warn-bg);
      border-radius: 10px; padding: 10px 12px 10px 16px; margin: 10px 0 12px;
      position: relative; overflow: hidden; font-size: 12.5px;
    }
    .banner::before {
      content: ''; position: absolute; left: 0; top: 0; bottom: 0;
      width: 4px; background: var(--warn-border);
    }
    .bannerTitle { font-weight: 700; color: #fde047; }
    .bannerText { margin-top: 3px; color: var(--text2); }
    .bannerText b { color: var(--text); font-weight: 700; }

    /* ── status block ── */
    .status {
      margin-top: 10px; padding: 8px 12px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--bg2);
      font-size: 12px; display: none;
    }
    .status.show { display: block; }
    .status.error { border-color: rgba(239,68,68,0.45); color: var(--red); background: rgba(239,68,68,0.07); }
    .status.ok { border-color: rgba(99,102,241,0.35); color: #a5b4fc; background: rgba(99,102,241,0.07); }

    /* ── table grid ── */
    .grid { overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
    table { width: 100%; border-collapse: collapse; min-width: 720px; }
    th, td {
      border-bottom: 1px solid var(--border); padding: 9px 10px; vertical-align: top; text-align: left;
    }
    th { font-size: 11.5px; font-weight: 600; color: var(--text2); background: rgba(255,255,255,0.02); }
    tr:last-child td { border-bottom: none; }

    /* ── layout helpers ── */
    .row {
      display: grid; grid-template-columns: 2fr 2fr auto auto;
      gap: 10px; align-items: end; margin-top: 10px;
    }
    .row > * { min-width: 0; }
    .tableHeaderRow {
      display: grid;
      grid-template-columns: minmax(220px, 40%) 1fr max-content max-content;
      gap: 10px; align-items: end; margin-top: 10px;
    }
    .tableHeaderRow > * { min-width: 0; }
    .colDefRow {
      display: grid; grid-template-columns: 4fr 2fr 3fr max-content;
      gap: 10px; align-items: end; margin-top: 10px;
    }
    .colDefRow > * { min-width: 0; }
    .colRow {
      display: grid;
      grid-template-columns: minmax(260px,2.8fr) minmax(200px,1.6fr) max-content;
      gap: 10px; align-items: center; margin-top: 10px;
    }
    .colRow.hasCustom {
      grid-template-columns: minmax(260px,2.4fr) minmax(200px,1.4fr) minmax(260px,2.4fr) max-content;
    }
    .colRow > * { min-width: 0; }
    .top-actions { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
    .actions { display: flex; gap: 8px; margin-top: 14px; margin-bottom: 24px; flex-wrap: wrap; }
    .seqTop { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
    .seqActions { display: flex; gap: 8px; flex-wrap: wrap; }
    .seqParamsGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; align-items: start; }

    @media (max-width: 820px) {
      .row, .tableHeaderRow, .colDefRow, .seqParamsGrid { grid-template-columns: 1fr; }
      .tableHeaderRow .spacer { display: none; }
    }

    /* ── code textarea ── */
    textarea.code {
      font-family: ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
      font-size: 12.5px; line-height: 1.5; tab-size: 2; min-height: 120px;
    }

    /* ── lint / validate button ── */
    button.validateBtn {
      padding: 3px 10px; min-height: 26px; border-radius: 999px; font-size: 11.5px; font-weight: 700;
    }
    button.validateBtn.ok { color: var(--green); border-color: rgba(74,222,128,0.35); background: rgba(74,222,128,0.08); }
    button.validateBtn.err { color: var(--red); border-color: rgba(248,113,113,0.35); background: rgba(248,113,113,0.08); }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helper: replace the <style nonce="..."> block in a form file
// ─────────────────────────────────────────────────────────────────────────────
function replaceStyle(src, newCSS) {
  // Match: <style nonce="${n}"> ... </style>
  return src.replace(
    /<style nonce="\$\{n\}"[\s\S]*?<\/style>/,
    `<style nonce="\${n}">${newCSS}  </style>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch each form file
// ─────────────────────────────────────────────────────────────────────────────
const files = [
  'src/dmcr-add-columns-form.ts',
  'src/dmcr-insert-rows-form.ts',
  'src/dmcr-freeform-sql-form.ts',
];

for (const f of files) {
  let src = fs.readFileSync(f, 'utf8');
  const patched = replaceStyle(src, SHARED_CSS);
  if (patched === src) {
    console.error(`WARN: style block not found in ${f}`);
  } else {
    fs.writeFileSync(f, patched, 'utf8');
    console.log(`OK: patched ${f}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Also patch HTML to use bs-check for checkboxes in add-columns + insert-rows
// ─────────────────────────────────────────────────────────────────────────────

// add-columns: replace setting-card checkbox input[type="checkbox"] to use bs-check class
let addCols = fs.readFileSync('src/dmcr-add-columns-form.ts', 'utf8');
// Replace all checkbox inputs that don't already have bs-check
addCols = addCols.replace(
  /<input type="checkbox"((?!bs-check)[^>]*)>/g,
  '<input type="checkbox" class="bs-check"$1>'
);
fs.writeFileSync('src/dmcr-add-columns-form.ts', addCols, 'utf8');

let insertRows = fs.readFileSync('src/dmcr-insert-rows-form.ts', 'utf8');
insertRows = insertRows.replace(
  /<input type="checkbox"((?!bs-check)[^>]*)>/g,
  '<input type="checkbox" class="bs-check"$1>'
);
fs.writeFileSync('src/dmcr-insert-rows-form.ts', insertRows, 'utf8');

let freeform = fs.readFileSync('src/dmcr-freeform-sql-form.ts', 'utf8');
freeform = freeform.replace(
  /<input type="checkbox"((?!bs-check)[^>]*)>/g,
  '<input type="checkbox" class="bs-check"$1>'
);
// Add code class to SQL textareas
freeform = freeform.replace(
  /(<textarea[^>]*id="sql"[^>]*)(>)/g,
  '$1 class="code"$2'
);
freeform = freeform.replace(
  /(<textarea[^>]*id="prevSql"[^>]*)(>)/g,
  '$1 class="code"$2'
);
fs.writeFileSync('src/dmcr-freeform-sql-form.ts', freeform, 'utf8');
console.log('All form files patched.');
