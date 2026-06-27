import { lintPostgresSql } from "../../utils/sql-utils";
import { buildSchemaDiffPrompt } from "../../llm/prompts/prompt-template";
import { CHANGE_CARD_CSS, CHANGE_CARD_HTML_INNER, CHANGE_CARD_LINT_JS } from "./change-card-template";

type SubmitMessage = {
  type: "submit";
  payload: {
    fromSchema: string;
    toSchema: string;
    fromSchemaHint?: string;
    toSchemaHint?: string;
    schemaHint?: string;  // legacy single-schema fallback
    changeNameHint: string;
    metaTags?: string;
    metaRequires?: string;
    metaAuthor?: string;
  };
};

type LintMessage = {
  type: "lint";
  payload: { id: number; which: string; sql: string };
};

type CancelMessage = { type: "cancel" };

export function buildSchemaDiffNormalizedRequest(p: SubmitMessage["payload"]): string {
  return buildSchemaDiffPrompt({
    fromSchema: String(p.fromSchema ?? "").trim(),
    toSchema:   String(p.toSchema   ?? "").trim(),
    fromSchemaHint: String(p.fromSchemaHint ?? "").trim() || undefined,
    toSchemaHint: String(p.toSchemaHint ?? "").trim() || undefined,
    schemaHint: String(p.schemaHint ?? "").trim() || undefined,
    changeNameHint: String(p.changeNameHint ?? "").trim() || undefined,
    metaTags: String(p.metaTags ?? "").trim() || undefined,
    metaRequires: String(p.metaRequires ?? "").trim() || undefined,
    metaAuthor: String(p.metaAuthor ?? "").trim() || undefined,
  });
}

export function getSchemaDiffFormHtml(nonce: string): string {
  return getHtml(nonce);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML
// ─────────────────────────────────────────────────────────────────────────────
function getHtml(n: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';"><meta name="color-scheme" content="dark light">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DMCR: Schema Diff</title>
<style nonce="${n}">
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    /* Standard shared variables — must match DDL/DML/Freeform for CHANGE_CARD_CSS compatibility */
    --bg:       #0f1117;
    --bg2:      #161b27;
    --bg3:      #1e2535;
    --border:   rgba(255,255,255,0.08);
    --border2:  rgba(99,102,241,0.25);
    --text:     #e2e8f0;
    --text2:    #94a3b8;
    --dim:      #64748b;
    --accent:   #6366f1;
    --accent2:  #818cf8;
    --accent-ring: rgba(99,102,241,0.22);
    --green:    #4ade80;
    --amber:    #fbbf24;
    --red:      #f87171;
    --font-mono: ui-monospace,'Cascadia Code','JetBrains Mono',Consolas,monospace;
  }
  :root[data-theme='light'] {
    --bg:        #f8fafc; --bg2: #ffffff; --bg3: #f1f5f9;
    --border:    rgba(0,0,0,0.09); --border2: rgba(99,102,241,0.30);
    --text:      #0f172a; --text2: #475569; --dim: #64748b;
    --accent:    #6366f1; --accent2: #4f46e5; --accent-ring: rgba(99,102,241,0.22);
    --green:     #16a34a; --amber:   #b45309; --red: #dc2626;
    --font-mono: ui-monospace,'Cascadia Code','JetBrains Mono',Consolas,monospace;
  }
  [data-theme='light'] body { color-scheme: light; }
  [data-theme='light'] .bs-card { background: #fff; border-color: rgba(0,0,0,0.09); box-shadow: 0 2px 10px rgba(15,23,42,0.06); }
  [data-theme='light'] .diff-pane { background: #fff; border-color: rgba(0,0,0,0.09); }
  [data-theme='light'] .diff-pane-hd { background: rgba(0,0,0,0.025); border-color: rgba(0,0,0,0.09); }
  [data-theme='light'] .diff-pane textarea { color: #0f172a; }
  [data-theme='light'] .diff-pane textarea::placeholder { color: #94a3b8; }
  [data-theme='light'] .swap-btn { background: #f1f5f9; border-color: rgba(0,0,0,0.09); color: #64748b; }
  [data-theme='light'] .swap-btn:hover { background: #eef2ff; border-color: rgba(99,102,241,0.30); color: #4f46e5; }
  [data-theme='light'] .bs-input { background: #ffffff; border-color: #cbd5e1; color: #0f172a; }
  [data-theme='light'] .bs-input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.14); }
  [data-theme='light'] .bs-input::placeholder { color: #94a3b8; }
  [data-theme='light'] .bs-hint { color: #64748b; }
  [data-theme='light'] .bs-label { color: #64748b; }
  [data-theme='light'] .bs-section-label { color: #64748b; }
  [data-theme='light'] .bs-banner { background: rgba(161,98,7,0.06); border-color: rgba(161,98,7,0.25); }
  [data-theme='light'] .bs-banner-text { color: #475569; }
  [data-theme='light'] .bs-banner-text b { color: #0f172a; }
  [data-theme='light'] .page-hd { border-bottom-color: rgba(0,0,0,0.09); }
  [data-theme='light'] .page-title { color: #0f172a; }
  [data-theme='light'] .bs-badge { background: rgba(99,102,241,0.10); color: #4f46e5; border-color: rgba(99,102,241,0.25); }
  [data-theme='light'] .bs-btn-accent { background: #6366f1; border-color: #4f46e5; }
  [data-theme='light'] .bs-btn-danger { background: #fef2f2; color: #dc2626; border-color: rgba(220,38,38,0.25); }
  [data-theme='light'] .bs-btn-danger:hover:not(:disabled) { background: #fee2e2; }
  [data-theme='light'] .bs-status.ok  { background: #eef2ff; border-color: rgba(99,102,241,0.25); color: #4f46e5; }
  [data-theme='light'] .bs-status.err { background: #fef2f2; border-color: rgba(220,38,38,0.25); color: #dc2626; }
  [data-theme='light'] .lint-chip.good { color: #16a34a; }
  [data-theme='light'] .lint-chip.bad  { color: #dc2626; }
  [data-theme='light'] .prog-label { color: #64748b; }
  [data-theme='light'] .prog-stream { background: rgba(0,0,0,0.03); border-color: rgba(99,102,241,0.15); color: rgba(71,85,105,0.8); }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: 'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  body { padding: 0 0 40px; }

  /* ── Header ── */
  .page-hd { display: flex; align-items: center; gap: 8px; padding: 14px 20px 10px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .page-title { font-size: 15px; font-weight: 700; color: var(--text); }
  .bs-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; background: rgba(99,102,241,0.15); color: var(--accent2); border: 1px solid rgba(99,102,241,0.3); }
  .bs-pill  { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 20px; font-size: 11px; font-weight: 600; background: rgba(74,222,128,0.08); color: #4ade80; border: 1px solid rgba(74,222,128,0.2); }

  /* ── Banner ── */
  .bs-banner { margin: 12px 20px; padding: 10px 14px; border-radius: 8px; background: rgba(251,191,36,0.07); border: 1px solid rgba(251,191,36,0.25); border-left: 3px solid #fbbf24; }
  .bs-banner-title { font-size: 12.5px; font-weight: 700; color: #fbbf24; margin-bottom: 3px; }
  .bs-banner-text  { font-size: 12px; color: #94a3b8; }
  .bs-banner-text b { color: #e2e8f0; }

  /* ── Cards ── */
  .bs-card { margin: 0 20px 14px; padding: 14px 16px; border-radius: 10px; background: var(--bg2); border: 1px solid var(--border); }

  /* ── Two-column diff layout ── */
  .diff-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 0 20px 14px; }
  @media (max-width: 680px) { .diff-cols { grid-template-columns: 1fr; } }
  .diff-pane { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
  .diff-pane-hd { padding: 8px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.15); }
  .diff-pane-label { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; color: var(--dim); text-transform: uppercase; }
  .diff-pane-label.from { color: var(--accent2); }
  .diff-pane-label.to   { color: var(--text2); }
  .diff-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .diff-dot.from { background: var(--accent); }
  .diff-dot.to   { background: var(--dim); }
  .diff-pane textarea { flex: 1; min-height: 260px; padding: 12px 14px; background: transparent; border: none; color: var(--text); font-family: var(--font-mono); font-size: 12px; line-height: 1.6; resize: none; outline: none; }
  .diff-pane textarea::placeholder { color: rgba(148,163,184,0.4); }
  .diff-pane-footer { padding: 5px 12px; border-top: 1px solid var(--border); min-height: 26px; display: flex; align-items: center; }

  /* ── Fields ── */
  .bs-field { margin-bottom: 10px; }
  .bs-field:last-child { margin-bottom: 0; }
  .bs-label { display: block; font-size: 11px; font-weight: 600; color: var(--dim); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
  .bs-input { width: 100%; padding: 7px 10px; border-radius: 7px; border: 1px solid var(--border); background: rgba(255,255,255,0.03); color: var(--text); font-size: 12.5px; font-family: inherit; outline: none; transition: border-color 120ms; }
  .bs-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(99,102,241,0.18); }
  .bs-hint { font-size: 11px; color: var(--dim); margin-top: 3px; }
  .bs-section-label { font-size: 11px; font-weight: 700; color: var(--dim); text-transform: uppercase; letter-spacing: 0.06em; }

  /* ── Swap button ── */
  .swap-row { display: flex; justify-content: center; margin: 0 20px 0; }
  .swap-btn { display: inline-flex; align-items: center; margin-bottom: 10px; gap: 6px; padding: 5px 14px; border-radius: 20px; border: 1px solid var(--border); background: var(--bg3); color: var(--dim); font-size: 11.5px; cursor: pointer; transition: all 120ms; font-family: inherit; }
  .swap-btn:hover { border-color: rgba(99,102,241,0.4); color: var(--accent2); background: rgba(99,102,241,0.08); }

  /* ── Lint chip ── */
  .lint-chip { font-size: 11px; font-weight: 500; }
  .lint-chip.good    { color: #4ade80; }
  .lint-chip.bad     { color: #f87171; }
  .lint-chip.linting { color: var(--dim); }
  .lint-chip.hidden  { display: none; }

  /* ── Actions ── */
  .bs-actions { display: flex; align-items: center; gap: 10px; padding: 0 20px 12px; flex-wrap: wrap; }
  .bs-btn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 18px; border-radius: 8px; border: 1px solid transparent; font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; transition: all 120ms; }
  .bs-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .bs-btn-accent { background: #4f46e5; color: #fff; border-color: #4338ca; box-shadow: 0 2px 8px rgba(99,102,241,0.3); }
  .bs-btn-accent:hover:not(:disabled) { background: #4338ca; }
  .bs-btn-danger { background: rgba(239,68,68,0.12); color: #f87171; border-color: rgba(239,68,68,0.35); }
  .bs-btn-danger:hover:not(:disabled) { background: rgba(239,68,68,0.20); }

  /* ── Status ── */
  .bs-status { display: none; margin: 0 20px 10px; padding: 7px 12px; border-radius: 7px; border: 1px solid transparent; font-size: 12px; }
  .bs-status.show { display: block; }
  .bs-status.ok  { border-color: rgba(99,102,241,0.35); color: var(--accent2); background: rgba(99,102,241,0.07); }
  .bs-status.err { border-color: rgba(239,68,68,0.40); color: #f87171; background: rgba(239,68,68,0.07); }

  /* ── Progress screen ── */
  .screen-progress { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; gap: 24px; padding: 40px 20px; text-align: center; }
  .prog-icon { width:56px;height:56px;border-radius:50%;background:rgba(99,102,241,0.12);border:2px solid rgba(99,102,241,0.30);display:flex;align-items:center;justify-content:center;animation:progpulse 2s ease-in-out infinite; }
  @keyframes progpulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.1);opacity:.75} }
  .prog-bar { width: 280px; height: 3px; background: rgba(255,255,255,0.07); border-radius: 2px; overflow: hidden; position: relative; }
  .prog-bar::after { content: ''; position: absolute; top: 0; height: 100%; width: 55%; background: linear-gradient(90deg,transparent,#6366f1,transparent); animation: progbar 1.4s ease-in-out infinite; left: -60%; }
  @keyframes progbar { to { left: 160%; } }
  .prog-label { font-size: 13px; color: var(--text2); text-align: center; min-height: 20px; }
  .prog-stream { width: 100%; max-width: 560px; max-height: 110px; overflow: hidden; font-family: var(--font-mono); font-size: 10.5px; color: rgba(148,163,184,0.65); background: rgba(0,0,0,0.18); border: 1px solid rgba(99,102,241,0.15); border-radius: 6px; padding: 7px 10px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; display: none; }
  .prog-stream.active { display: block; }

  ${CHANGE_CARD_CSS}
</style>
</head>
<body>

<div id="formScreen">
  <div id="genErrBox" class="cc-gen-err" style="display:none;">
    <div class="cc-gen-err-hd">
      <div class="cc-gen-err-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
      <div class="cc-gen-err-body">
        <div class="cc-gen-err-title">Generation Failed</div>
        <div class="cc-gen-err-msg" id="genErrMsg">An error occurred.</div>
        <div class="cc-gen-err-meta" id="genErrMeta"></div>
      </div>
      <button class="cc-gen-err-toggle" id="genErrToggle" onclick="(function(){var s=document.getElementById('genErrStack');var b=document.getElementById('genErrToggle');if(b.dataset.open==='1'){s.style.display='none';b.textContent='\u25bc Stack trace';b.dataset.open='0';}else{s.style.display='block';b.textContent='\u25b2 Stack trace';b.dataset.open='1';}})()" style="display:none">\u25bc Stack trace</button>
    </div>
    <div class="cc-gen-err-stack" id="genErrStack"><pre id="genErrStackPre"></pre></div>
  </div>
  <div class="page-hd">
    <h1 class="page-title">Schema Diff &rarr; DMCR</h1>
    <span class="bs-badge">DIFF</span>
    <span class="bs-pill">PostgreSQL</span>
  </div>

  <div class="bs-banner">
    <div class="bs-banner-title">How it works</div>
    <div class="bs-banner-text">
        Paste your <b>Current Schema</b> (left — what the DB has <em>today</em>) and your <b>Target Schema</b> (right — what you <em>want</em> it to be).
      DMCR will diff them and generate a <b>deploy / verify / revert</b> change covering every structural difference.
    </div>
  </div>

  <!-- Two-pane diff editor -->
  <div class="diff-cols">
    <div class="diff-pane">
      <div class="diff-pane-hd">
        <span class="diff-dot from"></span>
        <span class="diff-pane-label from">Current Schema</span>
      </div>
      <textarea id="fromBox" spellcheck="false"
        placeholder="-- Current schema: what the database looks like TODAY&#10;-- e.g. CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);"></textarea>
      <div class="diff-pane-footer">
        <span id="fromLint" class="lint-chip hidden"></span>
      </div>
    </div>
    <div class="diff-pane">
      <div class="diff-pane-hd">
        <span class="diff-dot to"></span>
        <span class="diff-pane-label to">Target Schema</span>
      </div>
      <textarea id="toBox" spellcheck="false"
        placeholder="-- Target schema: what you WANT the database to look like&#10;-- e.g. CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT, email TEXT NOT NULL);"></textarea>
      <div class="diff-pane-footer">
        <span id="toLint" class="lint-chip hidden"></span>
      </div>
    </div>
  </div>

  <div class="swap-row">
    <button type="button" id="swapBtn" class="swap-btn">&#x21C6; Swap schemas</button>
  </div>

  <!-- Options -->
  <div class="bs-card" style="margin-top:14px;">
    <div class="bs-section-label" style="margin-bottom:10px;">Optional</div>
    <div class="bs-field">
      <label class="bs-label">Default schema</label>
      <input id="schemaHint" class="bs-input" placeholder="e.g. public, zp_st — qualifies unqualified names in verify/revert SQL" />
    </div>
    <div class="bs-field">
      <label class="bs-label">Change name hint</label>
      <input id="changeHint" class="bs-input" placeholder="e.g. add_email_to_users" />
    </div>
    <div class="bs-hint" style="margin-top:6px;">
      Tip: The AI will name the change automatically from the diff. Use the hint only if you want a specific name.
    </div>
  </div>

  <div class="bs-actions">
    <button class="bs-btn bs-btn-accent" id="generateBtn" type="button">&#x1FA84; Generate DMCR change</button>
    <button class="bs-btn bs-btn-danger" id="cancelBtn" type="button">&#x2715; Cancel</button>
  </div>
  <div id="status" class="bs-status" aria-live="polite"></div>
</div><!-- #formScreen -->

<div id="progressScreen" style="display:none;">
  <div class="wrap screen-progress">
    <div class="prog-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>
    <div class="prog-bar"></div>
    <div class="prog-label" id="progLabel">Diffing schemas and generating change&hellip;</div>
    <div class="prog-stream" id="progStream"></div>
  </div>
</div>

<div id="resultScreen" style="display:none;">
  <div class="wrap screen-result">
    <div id="genErrBox_result" class="cc-gen-err" style="display:none;"><!-- error moved to formScreen --></div>
    ${CHANGE_CARD_HTML_INNER}
  </div>
</div>

<script nonce="${n}">
  const vscode = (function() {
    if (window.parent !== window && window.parent.__DMCR_VSCODE_API__) return window.parent.__DMCR_VSCODE_API__;
    try { return acquireVsCodeApi(); } catch(e) { return { postMessage:function(){}, getState:function(){return{};}, setState:function(){} }; }
  })();

  // ── Element refs ───────────────────────────────────────────────────
  const formScreenEl     = document.getElementById('formScreen');
  const progressScreenEl = document.getElementById('progressScreen');
  const resultScreenEl   = document.getElementById('resultScreen');
  const progLabelEl      = document.getElementById('progLabel');
  const progStreamEl     = document.getElementById('progStream');
  const genErrBoxEl      = document.getElementById('genErrBox');
  const genErrMsgEl      = document.getElementById('genErrMsg');
  const changeCardEl     = document.getElementById('changeCard');
  const ccChangeNameEl   = document.getElementById('ccChangeName');
  const ccLocationEl     = document.getElementById('ccLocation');
  const ccSaveBtnEl      = document.getElementById('ccSaveBtn');
  const ccSavedBoxEl     = document.getElementById('ccSavedBox');
  const ccFolderRelEl    = document.getElementById('ccFolderRel');
  const ccRevealBtnEl    = document.getElementById('ccRevealBtn');
  const ccErrBoxEl       = document.getElementById('ccErrBox');
  const ccCloseBtnEl     = document.getElementById('ccCloseBtn');
  const ccSqlDisplayEl   = document.getElementById('ccSqlDisplay');
  const fromBox          = document.getElementById('fromBox');
  const toBox            = document.getElementById('toBox');
  const schemaHintEl     = document.getElementById('schemaHint');
  const changeHintEl     = document.getElementById('changeHint');
  const statusEl         = document.getElementById('status');
  const fromLintEl       = document.getElementById('fromLint');
  const toLintEl         = document.getElementById('toLint');
  const generateBtn      = document.getElementById('generateBtn');
  const cancelBtn        = document.getElementById('cancelBtn');
  const ccBrowseBtnEl    = document.getElementById('ccBrowseBtn');

  // ── Screen management ─────────────────────────────────────────────
  function showScreen(name) {
    if (formScreenEl)     formScreenEl.style.display     = name === 'form'     ? 'block' : 'none';
    if (progressScreenEl) progressScreenEl.style.display = name === 'progress' ? 'block' : 'none';
    if (resultScreenEl)   resultScreenEl.style.display   = name === 'result'   ? 'flex'  : 'none';
  }

  // ── Shared lint footer (from CHANGE_CARD_LINT_JS) ─────────────────
  var currentTab = 'deploy';
  ${CHANGE_CARD_LINT_JS}

  // ── Result card tabs ──────────────────────────────────────────────
  var changeSql = { deploy: '', verify: '', revert: '' };

  document.querySelectorAll('.cc-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.cc-tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentTab = btn.getAttribute('data-tab');
      if (ccSqlDisplayEl) ccSqlDisplayEl.textContent = changeSql[currentTab] || '';
      renderLint(currentTab);
    });
  });

  function showChangeCard(payload) {
    changeSql = { deploy: payload.deploySql || '', verify: payload.verifySql || '', revert: payload.revertSql || '' };
    currentTab = 'deploy';
    _lintMap = { deploy: null, verify: null, revert: null };
    renderLint('deploy');
    if (ccChangeNameEl)  ccChangeNameEl.textContent  = payload.changeName || 'change';
    if (ccSqlDisplayEl)  ccSqlDisplayEl.textContent  = changeSql['deploy'];
    if (ccLocationEl)    ccLocationEl.value = payload.suggestedLocation || '';
    document.querySelectorAll('.cc-tab').forEach(function(b) { b.classList.remove('active'); });
    var dep = document.querySelector('.cc-tab[data-tab="deploy"]');
    if (dep) dep.classList.add('active');
    if (ccSaveBtnEl) { ccSaveBtnEl.disabled = false; ccSaveBtnEl.textContent = '\uD83D\uDCBE Save to workspace'; }
    showEl(ccSavedBoxEl, false);
    if (ccErrBoxEl) ccErrBoxEl.style.display = 'none';
    showEl(genErrBoxEl, false);
    if (changeCardEl) changeCardEl.style.display = '';
    [['deploy', payload.deploySql], ['verify', payload.verifySql], ['revert', payload.revertSql]].forEach(function(pair, i) {
      setTimeout(function() { vscode.postMessage({ type: 'lintSql', payload: { id: pair[0], sql: pair[1] || '' } }); }, 200 + i * 120);
    });
    showScreen('result');
  }

  function showEl(el, v, displayVal) { if (el) el.style.display = v ? (displayVal || 'flex') : 'none'; }

  // ── Save / Browse / Reveal ────────────────────────────────────────
  if (ccSaveBtnEl) {
    ccSaveBtnEl.addEventListener('click', function() {
      ccSaveBtnEl.disabled = true;
      ccSaveBtnEl.textContent = 'Saving\u2026';
      vscode.postMessage({ type: 'saveChange', payload: {
        changeName: ccChangeNameEl ? ccChangeNameEl.textContent : '',
        deploySql:  changeSql.deploy,
        verifySql:  changeSql.verify,
        revertSql:  changeSql.revert,
        location:   ccLocationEl ? ccLocationEl.value.trim() : '',
      }});
    });
  }
  if (ccBrowseBtnEl) {
    ccBrowseBtnEl.addEventListener('click', function() {
      vscode.postMessage({ type: 'browseFolder' });
    });
  }
  if (ccRevealBtnEl) {
    ccRevealBtnEl.addEventListener('click', function() {
      var rel = ccFolderRelEl ? ccFolderRelEl.textContent : '';
      if (rel) vscode.postMessage({ type: 'revealFolder', payload: { folderRel: rel } });
    });
  }
  if (ccCloseBtnEl) {
    ccCloseBtnEl.addEventListener('click', function() { vscode.postMessage({ type: 'cancel' }); });
  }

  // ── Status helpers ────────────────────────────────────────────────
  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'bs-status show' + (kind ? ' ' + kind : '');
  }
  function clearStatus() { statusEl.textContent = ''; statusEl.className = 'bs-status'; }

  window.addEventListener('error', function(e) { setStatus('Error: ' + (e && e.message || String(e)), 'err'); });
  window.addEventListener('unhandledrejection', function(e) { setStatus('Error: ' + ((e && e.reason && e.reason.message) || String((e && e.reason) || e)), 'err'); });

  // ── Lint helpers ──────────────────────────────────────────────────
  var lintSeq = 0;
  var pending = new Map();
  var lintTimers = {};

  function setLint(chip, state, msg) {
    if (!chip) return;
    if (!state || state === 'hidden') { chip.className = 'lint-chip hidden'; chip.textContent = ''; return; }
    chip.className = 'lint-chip ' + (state === 'good' ? 'good' : state === 'bad' ? 'bad' : 'linting');
    chip.textContent = state === 'good' ? '\u2713 SQL valid' : state === 'bad' ? '\u26A0 ' + (msg || 'parse error') : '\u23F3 Linting\u2026';
  }

  function requestLint(which, sql) {
    var id = ++lintSeq;
    var chip = which === 'from' ? fromLintEl : toLintEl;
    setLint(chip, 'linting', '');
    vscode.postMessage({ type: 'lint', payload: { id: id, which: which, sql: String(sql || ''), dialect: 'postgresql' } });
    return new Promise(function(resolve) { pending.set(id, resolve); });
  }

  function scheduleLint(which, sql) {
    if (lintTimers[which]) clearTimeout(lintTimers[which]);
    var chip = which === 'from' ? fromLintEl : toLintEl;
    if (!sql.trim()) { setLint(chip, 'hidden', ''); return; }
    setLint(chip, 'linting', '');
    lintTimers[which] = setTimeout(function() {
      requestLint(which, sql).then(function(res) { setLint(chip, res.ok ? 'good' : 'bad', res.msg); });
    }, 700);
  }

  // ── Swap button ───────────────────────────────────────────────────
  var swapBtn = document.getElementById('swapBtn');
  if (swapBtn) {
    swapBtn.addEventListener('click', function() {
      var tmp = fromBox.value;
      fromBox.value = toBox.value;
      toBox.value = tmp;
      scheduleLint('from', fromBox.value);
      scheduleLint('to', toBox.value);
    });
  }

  // ── Lint wiring ───────────────────────────────────────────────────
  if (fromBox) {
    fromBox.addEventListener('input', function() { scheduleLint('from', fromBox.value); });
    fromBox.addEventListener('blur',  function() { if (fromBox.value.trim()) requestLint('from', fromBox.value).then(function(res) { setLint(fromLintEl, res.ok ? 'good' : 'bad', res.msg); }); });
  }
  if (toBox) {
    toBox.addEventListener('input', function() { scheduleLint('to', toBox.value); });
    toBox.addEventListener('blur',  function() { if (toBox.value.trim()) requestLint('to', toBox.value).then(function(res) { setLint(toLintEl, res.ok ? 'good' : 'bad', res.msg); }); });
  }

  // ── Generate ──────────────────────────────────────────────────────
  if (generateBtn) {
    generateBtn.addEventListener('click', function() {
      var from = fromBox ? fromBox.value.trim() : '';
      var to   = toBox   ? toBox.value.trim()   : '';
      if (!from && !to) { setStatus('Paste at least one schema to diff.', 'err'); return; }
      clearStatus();
      showEl(genErrBoxEl, false);
      vscode.postMessage({ type: 'submit', payload: {
        fromSchema:     from,
        toSchema:       to,
        schemaHint:     schemaHintEl ? schemaHintEl.value.trim() : '',
        changeNameHint: changeHintEl ? changeHintEl.value.trim() : '',
      }});
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', function() { vscode.postMessage({ type: 'cancel' }); });
  }

  // ── Message handler ───────────────────────────────────────────────
  window.addEventListener('message', function(event) {
    var msg = event.data; if (!msg) return;
    if (msg.type === 'setTheme') {
      document.documentElement.setAttribute('data-theme', msg.isDark ? 'dark' : 'light');
      return;
    }
    if (msg.type === 'lintResult') {
      var id = msg.payload && msg.payload.id;
      if (typeof id === 'string' && ['deploy','verify','revert'].includes(id)) {
        updateLint(id, !!msg.payload.ok, String(msg.payload.msg || ''));
      } else {
        var resolve = pending.get(id);
        if (resolve) { pending.delete(id); resolve({ ok: !!msg.payload.ok, msg: String(msg.payload.msg || '') }); }
      }
    } else if (msg.type === 'showProgress') {
      if (progLabelEl && msg.payload && msg.payload.message) progLabelEl.textContent = msg.payload.message;
      showScreen('progress');
    } else if (msg.type === 'progressUpdate') {
      if (progLabelEl && msg.payload && msg.payload.text) progLabelEl.textContent = msg.payload.text;
    } else if (msg.type === 'streamChunk') {
      if (progStreamEl && msg.payload && msg.payload.text) {
        progStreamEl.classList.add('active');
        progStreamEl.textContent = msg.payload.text.slice(-400);
        progStreamEl.scrollTop = progStreamEl.scrollHeight;
      }
    } else if (msg.type === 'generationDone') {
      showChangeCard(msg.payload);
    } else if (msg.type === 'generationError') {
      const errPayload = msg.payload || {};
      const errMsg = errPayload.message || 'Generation failed.';
      const errStack = errPayload.stack || errMsg;
      const errCode = errPayload.code ? ' [' + errPayload.code + ']' : '';
      const errTime = errPayload.timestamp || new Date().toISOString();
      console.error('[DMCR] Generation Error', { message: errMsg, code: errPayload.code, stack: errStack, timestamp: errTime, source: errPayload.source });
      if (genErrMsgEl) genErrMsgEl.textContent = errMsg + errCode;
      const genErrMetaEl = document.getElementById('genErrMeta');
      if (genErrMetaEl) genErrMetaEl.textContent = errTime + (errPayload.source ? '  \u00b7  ' + errPayload.source : '');
      const genErrToggleEl = document.getElementById('genErrToggle');
      const genErrStackPreEl = document.getElementById('genErrStackPre');
      if (genErrStackPreEl) genErrStackPreEl.textContent = errStack;
      if (genErrToggleEl) { genErrToggleEl.style.display = ''; genErrToggleEl.dataset.open = '0'; }
      showEl(genErrBoxEl, true, 'flex');
      showEl(changeCardEl, false);
      showScreen('form');
      if (genErrBoxEl) genErrBoxEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (msg.type === 'saved') {
      if (ccSaveBtnEl) { ccSaveBtnEl.disabled = true; ccSaveBtnEl.textContent = 'Saved!'; }
      showEl(ccSavedBoxEl, true, 'flex');
      if (ccFolderRelEl && msg.payload) ccFolderRelEl.textContent = msg.payload.folderRel || '';
      showEl(ccErrBoxEl, false, 'block');
    } else if (msg.type === 'saveError') {
      if (ccSaveBtnEl) { ccSaveBtnEl.disabled = false; ccSaveBtnEl.textContent = 'Save to workspace'; }
      if (ccErrBoxEl) { ccErrBoxEl.style.display = ''; ccErrBoxEl.textContent = (msg.payload && msg.payload.msg) || 'Save failed.'; }
    } else if (msg.type === 'folderPicked') {
      if (ccLocationEl && msg.payload && msg.payload.folderRel) ccLocationEl.value = msg.payload.folderRel;
    } else if (msg.type === 'formActivated') {
      // Tab re-activated — reset to form screen and hide stale errors.
      showEl(genErrBoxEl, false);
      showScreen('form');
    }
  });
</script>
</body>
</html>`;
}

// ── Message handler (extension-side, for standalone panel mode) ───────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _handleLint(msg: LintMessage): Promise<ReturnType<typeof lintPostgresSql>> {
  return lintPostgresSql(msg.payload.sql);
}
