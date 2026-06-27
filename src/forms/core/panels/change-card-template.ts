/**
 * Shared change-card HTML + CSS used by all 3 inline iframe forms
 * (DDL / DML / Freeform SQL).
 *
 * Mirrors the DmcrChangeRenderer.css / DmcrChangeRenderer.tsx styles
 * exactly so all surfaces look identical. One place to maintain.
 */

/** CSS block to embed inside a <style> tag in each form's getHtml(). */
export const CHANGE_CARD_CSS = `
    /* ── Screen guards ── */
    #progressScreen, #resultScreen { display: none; }
    #resultScreen { position: fixed !important; inset: 0; z-index: 50; }

    /* ── Result screen backdrop ── */
    .screen-result {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100vh; overflow: hidden; padding: 32px 20px; background: var(--bg);
    }
    .screen-result > * { width: 100%; max-width: 1008px; }

    /* ── Change card — matches DmcrChangeRenderer exactly ── */
    .change-card {
      display: flex; flex-direction: column; overflow: hidden;
      height: 560px; min-height: 560px; max-height: 560px;
      width: 100%; max-width: 900px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(99,102,241,0.25); border-radius: 10px;
    }

    /* Header: folder icon + change name + subtitle */
    .cc-header {
      display: flex; align-items: center; gap: 12px; padding: 12px 16px;
      border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .cc-icon {
      width: 38px; height: 38px; border-radius: 9px; flex-shrink: 0;
      background: rgba(99,102,241,0.12); border: 1px solid rgba(99,102,241,0.25);
      display: flex; align-items: center; justify-content: center; color: #818cf8;
    }
    .cc-title { flex: 1; min-width: 0; }
    .cc-name {
      font-size: 13px; font-weight: 700; color: #86efac;
      font-family: ui-monospace,'Cascadia Code',Consolas,monospace; letter-spacing: 0.02em;
    }
    .cc-subtitle { font-size: 11.5px; color: var(--text2); margin-top: 2px; }

    /* Save-location row */
    .cc-loc {
      padding: 8px 14px; border-bottom: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 5px; flex-shrink: 0;
    }
    .cc-loc > label { font-size: 11px; font-weight: 600; color: var(--text2); }
    .cc-loc input[type=text] { background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.14); }

    /* Tabs — pill style matching DmcrChangeRenderer */
    .cc-tabs {
      display: flex; gap: 4px; padding: 8px 10px 0;
      border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02);
      flex-shrink: 0;
    }
    .cc-tab {
      padding: 5px 14px; border: none; border-radius: 6px 6px 0 0; margin-bottom: -1px;
      background: transparent; color: var(--text2); font-size: 12px; font-weight: 600;
      cursor: pointer; transition: background 120ms, color 120ms; font-family: inherit;
    }
    .cc-tab:hover { background: rgba(99,102,241,0.08); color: var(--text); }
    .cc-tab.active { background: rgba(99,102,241,0.18); color: #818cf8; border-bottom: 2px solid #6366f1; }

    /* SQL scrollable area */
    .cc-sql {
      background: transparent; border: none; border-radius: 0;
      padding: 14px 16px;
      font-family: ui-monospace,'Cascadia Code','JetBrains Mono',Consolas,monospace;
      font-size: 12.5px; line-height: 1.6; color: #e2e8f0;
      white-space: pre-wrap; word-break: break-word;
      overflow-y: auto; margin: 0; flex: 1; min-height: 0;
      scrollbar-width: thin; scrollbar-color: rgba(99,102,241,0.4) transparent;
    }
    .cc-sql::-webkit-scrollbar { width: 7px; }
    .cc-sql::-webkit-scrollbar-track { background: transparent; }
    .cc-sql::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.35); border-radius: 4px; }
    .cc-sql::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,0.55); }

    /* Footer — lint status left, buttons right — matches DmcrChangeRenderer */
    .cc-footer {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 7px 14px; border-top: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap;
    }
    .cc-lint {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; font-style: italic; color: #9ca3af;
    }
    .cc-lint.ok  { color: #4ade80; font-style: normal; }
    .cc-lint.err { color: #f87171; font-style: normal; }
    .cc-lint-spinner {
      display: inline-block; width: 11px; height: 11px;
      border: 2px solid rgba(255,255,255,0.15); border-top-color: #9ca3af;
      border-radius: 50%; animation: cc-spin 0.7s linear infinite; flex-shrink: 0;
    }
    @keyframes cc-spin { to { transform: rotate(360deg); } }
    .cc-footer-btns { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

    /* Saved confirmation — footer-2 bar at very bottom of card */
    .cc-saved {
      display: flex; align-items: center; gap: 8px; padding: 8px 14px;
      border-top: 1px solid rgba(74,222,128,0.22); border-radius: 0 0 10px 10px;
      background: rgba(74,222,128,0.07); color: var(--green);
      font-size: 12.5px; flex-wrap: wrap; flex-shrink: 0;
    }
    .cc-saved-path { font-family: ui-monospace,monospace; font-size: 12px; color: var(--text); }
    .cc-err { padding: 8px 14px; border-radius: 8px; background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.30); color: var(--red); font-size: 12.5px; flex-shrink: 0; display: none; }

    /* Generation error box (shown in formScreen) */
    .cc-gen-err { border-radius: 10px; background: rgba(248,113,113,0.07); border: 1px solid rgba(248,113,113,0.35); color: #f87171; margin-bottom: 12px; overflow: hidden; }
    .cc-gen-err-hd { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; }
    .cc-gen-err-ico { flex-shrink: 0; margin-top: 1px; }
    .cc-gen-err-body { flex: 1; min-width: 0; }
    .cc-gen-err-title { font-size: 13px; font-weight: 700; color: #fca5a5; margin-bottom: 2px; }
    .cc-gen-err-msg { font-size: 12px; color: #f87171; word-break: break-word; }
    .cc-gen-err-meta { font-size: 10.5px; color: #be123c; margin-top: 4px; font-family: ui-monospace,monospace; }
    .cc-gen-err-toggle { margin-left: auto; flex-shrink: 0; background: rgba(248,113,113,0.15); border: 1px solid rgba(248,113,113,0.25); border-radius: 5px; color: #f87171; font-size: 10.5px; padding: 2px 8px; cursor: pointer; font-family: inherit; white-space: nowrap; }
    .cc-gen-err-toggle:hover { background: rgba(248,113,113,0.25); }
    .cc-gen-err-stack { display: none; border-top: 1px solid rgba(248,113,113,0.20); padding: 10px 16px 12px; background: rgba(0,0,0,0.25); }
    .cc-gen-err-stack pre { margin: 0; font-family: ui-monospace,"Cascadia Code",Consolas,monospace; font-size: 10.5px; color: #fca5a5; white-space: pre-wrap; word-break: break-all; line-height: 1.55; max-height: 220px; overflow-y: auto; }

    /* ── Light-theme overrides for the change card (all forms) ── */
    [data-theme='light'] .change-card { background: #ffffff; border-color: rgba(99,102,241,0.20); box-shadow: 0 4px 20px rgba(15,23,42,0.08); }
    [data-theme='light'] .cc-header { border-bottom-color: #e2e8f0; }
    [data-theme='light'] .cc-icon { background: #eef2ff; border-color: #c7d2fe; color: #4f46e5; }
    [data-theme='light'] .cc-name { color: #16a34a; }
    [data-theme='light'] .cc-subtitle { color: #64748b; }
    [data-theme='light'] .cc-loc { border-bottom-color: #e2e8f0; }
    [data-theme='light'] .cc-loc > label { color: #64748b; }
    [data-theme='light'] .cc-loc input[type=text] { background: #ffffff; border-color: #cbd5e1 !important; color: #1e293b; }
    [data-theme='light'] .cc-loc input[type=text]:focus { border-color: #6366f1 !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.14); }
    [data-theme='light'] #ccBrowseBtn { background: #ffffff !important; border-color: #cbd5e1 !important; color: #334155 !important; }
    [data-theme='light'] #ccBrowseBtn:hover { background: #f1f5f9 !important; border-color: #94a3b8 !important; }
    [data-theme='light'] .cc-tabs { border-bottom-color: #e2e8f0; background: #f8fafc; }
    [data-theme='light'] .cc-tab { color: #64748b; }
    [data-theme='light'] .cc-tab:hover { background: rgba(99,102,241,0.06); color: #1e293b; }
    [data-theme='light'] .cc-tab.active { background: #eef2ff; color: #4f46e5; border-bottom-color: #6366f1; }
    [data-theme='light'] .cc-sql { color: #1e293b; scrollbar-color: rgba(99,102,241,0.30) transparent; }
    [data-theme='light'] .cc-sql::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.25); }
    [data-theme='light'] .cc-footer { border-top-color: #e2e8f0; }
    [data-theme='light'] .cc-lint { color: #64748b; }
    [data-theme='light'] .cc-lint.ok { color: #16a34a; }
    [data-theme='light'] .cc-lint.err { color: #dc2626; }
    [data-theme='light'] .cc-lint-spinner { border-color: rgba(0,0,0,0.12); border-top-color: #64748b; }
    [data-theme='light'] .cc-saved { background: #f0fdf4; border-top-color: rgba(22,163,74,0.22); color: #15803d; }
    [data-theme='light'] .cc-saved-path { color: #0f172a; }
    [data-theme='light'] .cc-err { background: #fef2f2; border-color: rgba(220,38,38,0.25); color: #dc2626; }
    [data-theme='light'] .cc-gen-err { background: #fef2f2; border-color: rgba(220,38,38,0.25); color: #dc2626; }
    [data-theme='light'] .cc-gen-err-hd { background: transparent; }
    [data-theme='light'] .cc-gen-err-title { color: #dc2626; }
    [data-theme='light'] .cc-gen-err-msg { color: #b91c1c; }
    [data-theme='light'] .cc-gen-err-meta { color: #6b7280; }
    [data-theme='light'] .cc-gen-err-toggle { background: rgba(220,38,38,0.08); border-color: rgba(220,38,38,0.20); color: #dc2626; }
    [data-theme='light'] .cc-gen-err-stack { background: #fef2f2; border-top-color: rgba(220,38,38,0.15); }
    [data-theme='light'] .cc-gen-err-stack pre { color: #b91c1c; }
    [data-theme='light'] .screen-result { background: var(--bg); }

    /* ── Shared button styles (used across all forms via .button class) ── */
    .button { display:inline-flex; align-items:center; gap:6px; padding:7px 15px; border-radius:7px; border:1px solid transparent; font-size:12.5px; font-weight:600; font-family:inherit; cursor:pointer; transition:all 120ms; }
    .button:disabled { opacity:0.45; cursor:not-allowed; }
    .button.primary { background:#4f46e5; color:#fff; border-color:#4338ca; box-shadow:0 1px 6px rgba(99,102,241,0.30); }
    .button.primary:hover:not(:disabled) { background:#4338ca; }
    .button.danger  { background:rgba(239,68,68,0.10); color:#f87171; border-color:rgba(239,68,68,0.30); }
    .button.danger:hover:not(:disabled)  { background:rgba(239,68,68,0.20); }
    .button.small   { padding:4px 10px; font-size:11.5px; background:rgba(255,255,255,0.07); color:var(--text2); border-color:var(--border); }
    .button.small:hover:not(:disabled)  { background:rgba(255,255,255,0.12); }
    [data-theme='light'] .button.primary { background:#6366f1; border-color:#4f46e5; box-shadow:0 1px 4px rgba(99,102,241,0.25); }
    [data-theme='light'] .button.primary:hover:not(:disabled) { background:#4f46e5; }
    [data-theme='light'] .button.danger  { background:#fef2f2; color:#dc2626; border-color:rgba(220,38,38,0.30); }
    [data-theme='light'] .button.danger:hover:not(:disabled)  { background:#fee2e2; }
    [data-theme='light'] .button.small   { background:#ffffff; color:#475569; border-color:#cbd5e1; }
    [data-theme='light'] .button.small:hover:not(:disabled)   { background:#f1f5f9; }
`.trimStart();

/** The folder SVG icon used in the card header */
const FOLDER_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const BROWSE_ICON = `<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='#f59e0b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'/></svg>`;
const CHECK_ICON  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

/**
 * Just the .change-card div — used by forms that wrap their own resultScreen/screen-result divs.
 */
export const CHANGE_CARD_HTML_INNER = `<div class="change-card" id="changeCard" style="display:none;">

      <!-- Header: icon + change name + subtitle -->
      <div class="cc-header">
        <div class="cc-icon">${FOLDER_ICON}</div>
        <div class="cc-title">
          <div class="cc-name" id="ccChangeName">change_name</div>
          <div class="cc-subtitle">Review SQL, then save to your workspace</div>
        </div>
      </div>

      <!-- Save-location input -->
      <div class="cc-loc">
        <label>Save location (relative to workspace root)</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="text" id="ccLocation" placeholder="db/changes (leave empty for workspace setting)" style="flex:1;" />
          <button type="button" id="ccBrowseBtn" title="Browse folder"
            style="flex-shrink:0;display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:7px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap;transition:all 120ms;">
            ${BROWSE_ICON}Browse
          </button>
        </div>
      </div>

      <!-- SQL tabs -->
      <div class="cc-tabs">
        <button type="button" class="cc-tab active" data-tab="deploy">deploy.sql</button>
        <button type="button" class="cc-tab" data-tab="verify">verify.sql</button>
        <button type="button" class="cc-tab" data-tab="revert">revert.sql</button>
      </div>

      <!-- SQL display -->
      <pre class="cc-sql" id="ccSqlDisplay"></pre>

      <!-- Save error -->
      <div id="ccErrBox" class="cc-err" style="display:none;"></div>

      <!-- Footer: lint status (left) + buttons (right) -->
      <div class="cc-footer">
        <div class="cc-lint" id="ccLintStatus">
          <span class="cc-lint-spinner" id="ccLintSpinner"></span>
          <span id="ccLintMsg">Linting\u2026</span>
        </div>
        <div class="cc-footer-btns">
          <button type="button" class="button danger" id="ccCloseBtn">&#x2715; Cancel</button>
          <button type="button" class="button primary" id="ccSaveBtn">&#x1F4BE; Save to workspace</button>
        </div>
      </div>

      <!-- Footer 2: saved confirmation bar (hidden until save) -->
      <div id="ccSavedBox" class="cc-saved" style="display:none;">
        ${CHECK_ICON}
        <span>Saved to</span>
        <span class="cc-saved-path" id="ccFolderRel"></span>
        <button type="button" class="button small" id="ccRevealBtn">Reveal in Explorer</button>
      </div>

    </div>`;

/**
 * The #resultScreen HTML block — identical structure across DDL / DML / Freeform.
 * Embed this verbatim inside the form's <body> (after #formScreen, #progressScreen).
 */
export const CHANGE_CARD_HTML = `
<div id="resultScreen">
  <div class="wrap screen-result">
    <div id="genErrBox_result" class="cc-gen-err" style="display:none;"><!-- error moved to formScreen --></div>
    ${CHANGE_CARD_HTML_INNER}
  </div>
</div>`.trimStart();

/**
 * Shared JS for the lint-status footer (embed in the form's <script nonce="..."> block).
 * Call updateLint(tabKey, ok, msg) when a lintResult message arrives.
 */
export const CHANGE_CARD_LINT_JS = `
    var _lintMap = { deploy: null, verify: null, revert: null };
    function updateLint(tab, ok, msg) {
      _lintMap[tab] = { ok: ok, msg: msg };
      renderLint(currentTab);
    }
    function renderLint(tab) {
      var el = document.getElementById('ccLintStatus');
      var sp = document.getElementById('ccLintSpinner');
      var tx = document.getElementById('ccLintMsg');
      if (!el || !sp || !tx) return;
      var state = _lintMap[tab];
      if (!state) {
        el.className = 'cc-lint'; sp.style.display = ''; tx.textContent = tab + '.sql — linting\u2026';
      } else if (state.ok) {
        el.className = 'cc-lint ok'; sp.style.display = 'none'; tx.textContent = tab + '.sql syntax OK';
      } else {
        el.className = 'cc-lint err'; sp.style.display = 'none'; tx.textContent = state.msg || (tab + '.sql has errors');
      }
    }
`.trimStart();
