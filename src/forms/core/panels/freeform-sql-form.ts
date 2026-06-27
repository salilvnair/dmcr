﻿﻿﻿import * as vscode from "vscode";
import { detectCreateRoutineSignature, lintPostgresSql } from "../../utils/sql-utils";
import { buildFreeformSqlPrompt } from "../../llm/prompts/prompt-template";
import { CHANGE_CARD_CSS, CHANGE_CARD_HTML, CHANGE_CARD_HTML_INNER, CHANGE_CARD_LINT_JS } from "./change-card-template";

type SubmitMessage = {
  type: "submit";
  payload: {
    sql: string;
    includePrevious: boolean;
    previousSql: string;
    changeNameHint: string;
    dbSchema: string;
    dialect: "postgresql";
  };
};

type LintWhich = "current" | "previous";

type LintMessage = {
  type: "lint";
  payload: { id: number; which: LintWhich; sql: string; dialect: "postgresql" };
};

type LintResultMessage = {
  type: "lintResult";
  payload: { id: number; which: LintWhich; ok: boolean; msg: string };
};

type CancelMessage = { type: "cancel" };

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function buildNormalizedRequest(p: SubmitMessage["payload"]): string {
  const sql = String(p.sql ?? "").trim();
  const includePrevious = !!p.includePrevious;
  const previousSql = String(p.previousSql ?? "").trim();
  const deployRoutine = detectCreateRoutineSignature(sql);
  const prevRoutine = includePrevious && previousSql ? detectCreateRoutineSignature(previousSql) : null;

  return buildFreeformSqlPrompt({
    sql,
    includePrevious,
    previousSql,
    changeNameHint: String(p.changeNameHint ?? "").trim(),
    dbSchema: String(p.dbSchema ?? "").trim(),
    deployRoutine,
    prevRoutine,
  });
}

export async function openFreeformSqlForm(opts: {
  extensionUri: vscode.Uri;
  title?: string;
}): Promise<{ normalizedRequest: string; panel: vscode.WebviewPanel } | null> {
  const panel = vscode.window.createWebviewPanel(
    "dmcrFreeformSqlForm",
    opts.title ?? "DMCR: SQL -> verify/revert (PostgreSQL)",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.iconPath = vscode.Uri.joinPath(opts.extensionUri, "images", "bot_icon.png");
  const n = nonce();
  panel.webview.html = getHtml(n);

  return await new Promise<{ normalizedRequest: string; panel: vscode.WebviewPanel } | null>(resolve => {
    const disposables: vscode.Disposable[] = [];
    let settled = false;

    const safeResolve = (v: { normalizedRequest: string; panel: vscode.WebviewPanel } | null) => {
      if (settled) return;
      settled = true;
      if (!v) {
        for (const d of disposables) d.dispose();
      }
      resolve(v);
    };

    disposables.push(panel.onDidDispose(() => {
      for (const d of disposables) d.dispose();
      safeResolve(null);
    }));

    disposables.push(
      panel.webview.onDidReceiveMessage(
        async (msg: SubmitMessage | CancelMessage | LintMessage) => {
          if (!msg || typeof msg !== "object") return;

          if ((msg as any).type === "lint") {
            const m = msg as LintMessage;
            const res = await lintPostgresSql(m.payload.sql);
            const reply: LintResultMessage = {
              type: "lintResult",
              payload: {
                id: m.payload.id,
                which: m.payload.which,
                ok: res.ok,
                msg: res.msg,
              },
            };
            await panel.webview.postMessage(reply);
            return;
          }

          if ((msg as any).type === "reload") {
            panel.webview.html = getHtml(nonce());
            return;
          }

          if (msg.type === "cancel") {
            safeResolve(null);
            panel.dispose();
            return;
          }

          if (msg.type === "submit") {
            if (settled) return;
            const normalized = buildNormalizedRequest(msg.payload);
            panel.webview.postMessage({ type: "showProgress", payload: { message: "Agent is thinking\u2026" } });
            safeResolve({ normalizedRequest: normalized, panel });
          }
        }
      )
    );
  });
}
function getHtml(n: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Freeform SQL → DMCR</title>
  <style nonce="${n}">
    :root {
      /* Standard shared variables (must match DML/DDL for CHANGE_CARD_CSS compatibility) */
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
      /* Freeform form-screen specific */
      --ce-surface:   #0f1117;
      --bg-secondary: #111827;
      --bg-card:      #161d2e;
      --ce-border:    rgba(255,255,255,0.08);
      --text-primary: #e2e8f0;
      --text-secondary:#94a3b8;
      --bs-accent:    #6366f1;
      --bs-input-bg:  rgba(255,255,255,0.04);
      --bs-input-hover-bg: rgba(255,255,255,0.07);
      --bs-input-focus-bg: rgba(255,255,255,0.06);
      --bs-input-border: rgba(255,255,255,0.10);
      --bs-input-hover-border: rgba(255,255,255,0.18);
    }
    :root[data-theme='light'] {
      --bg:         #f8fafc; --bg2: #ffffff; --bg3: #f1f5f9;
      --border:     rgba(0,0,0,0.09); --border2: rgba(99,102,241,0.30);
      --text:       #0f172a; --text2: #475569;
      --accent:     #6366f1; --accent-ring: rgba(99,102,241,0.22);
      --red:        #dc2626; --green: #16a34a;
      --warn-bg:    rgba(161,98,7,0.08); --warn-border: rgba(161,98,7,0.35);
      --ce-surface:   #f8fafc; --bg-secondary: #f1f5f9; --bg-card: #ffffff;
      --ce-border:    rgba(0,0,0,0.09); --text-primary: #0f172a;
      --text-secondary: #475569; --bs-accent: #6366f1;
      --bs-input-bg: #ffffff; --bs-input-hover-bg: #f8fafc; --bs-input-focus-bg: #ffffff;
      --bs-input-border: rgba(0,0,0,0.12); --bs-input-hover-border: rgba(0,0,0,0.20);
    }
    [data-theme='light'] body { color-scheme: light; }
    [data-theme='light'] h2 { color: #0f172a; }
    [data-theme='light'] .card,.bs-card-2 { background: #fff; border-color: rgba(0,0,0,0.09); box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
    [data-theme='light'] .setting-card { background: rgba(99,102,241,0.04); border-color: rgba(99,102,241,0.12); }
    [data-theme='light'] input[type="text"],[data-theme='light'] input:not([type]),[data-theme='light'] select,[data-theme='light'] textarea { background: #fff; border-color: #e2e8f0; color: #0f172a; }
    [data-theme='light'] input[type="text"]:hover,[data-theme='light'] input:not([type]):hover,[data-theme='light'] select:hover,[data-theme='light'] textarea:hover { border-color: #cbd5e1; background: #f8fafc; }
    [data-theme='light'] input::placeholder,[data-theme='light'] textarea::placeholder { color: #94a3b8; }
    [data-theme='light'] button { color: #0f172a; }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      background: var(--bg); color: var(--text);
      font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-size: 13px; line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      margin: 0; padding: 0;
    }
    .wrap { width: 100%; margin: 0 auto; }
    #formScreen { padding: 16px 20px 40px; }
    #progressScreen { padding: 16px 20px; }

    /* ── Page header ── */
    .page-hd { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .page-title { font-size: 15px; font-weight: 700; color: var(--text-primary); margin: 0; letter-spacing: -0.02em; }
    .bs-badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px; color: #a78bfa;
      background: rgba(167,139,250,0.1); border: 1px solid rgba(167,139,250,0.3);
      padding: 1px 7px; border-radius: 3px; font-weight: 700;
    }
    .bs-pill {
      font-size: 11px; padding: 2px 9px; border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.05);
      color: var(--text-secondary);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700;
    }

    /* ── Card ── */
    .bs-card {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--bg2);
      padding: 14px 16px;
      margin: 10px 0;
      box-shadow: 0 4px 16px rgba(0,0,0,0.22);
    }

    /* ── Section titles ── */
    .bs-section-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .bs-section-label {
      font-size: 11px; font-weight: 700; letter-spacing: 0.07em;
      text-transform: uppercase; color: var(--text-secondary);
    }

    /* ── bs-field / bs-label / bs-hint (ck8t exact) ── */
    .bs-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
    .bs-field:last-child { margin-bottom: 0; }
    .bs-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-secondary); }
    .bs-hint { font-size: 10.5px; color: var(--text-secondary); line-height: 1.4; }

    /* ── Inputs / textarea / select — bare elements + .bs-* classes both styled identically ── */
    input[type="text"], input[type="number"], input:not([type]), select, textarea,
    .bs-input, .bs-textarea {
      width: 100%; padding: 7px 10px; min-height: 32px; box-sizing: border-box;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--border);
      border-radius: 7px; color: var(--text);
      font-family: inherit; font-size: 12.5px; line-height: 1.4;
      outline: none;
      transition: border-color 140ms, box-shadow 140ms, background 140ms;
    }
    input[type="text"]:hover, input[type="number"]:hover, input:not([type]):hover,
    select:hover, textarea:hover, .bs-input:hover, .bs-textarea:hover {
      border-color: rgba(255,255,255,0.16); background: rgba(255,255,255,0.07);
    }
    input[type="text"]:focus, input[type="number"]:focus, input:not([type]):focus,
    select:focus, textarea:focus, .bs-input:focus, .bs-textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring);
      background: rgba(255,255,255,0.06);
    }
    input::placeholder, textarea::placeholder,
    .bs-input::placeholder, .bs-textarea::placeholder { color: #4b5563; }
    textarea, .bs-textarea { resize: vertical; min-height: 80px; }
    .bs-code {
      font-family: ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
      font-size: 12.5px; line-height: 1.5; tab-size: 2; min-height: 160px;
    }

    /* ── Buttons (ck8t exact) ── */
    .bs-btn, .bs-btn-primary, .bs-btn-ghost {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 6px; padding: 8px 16px; height: 36px; border-radius: 9px;
      font-size: 13px; font-weight: 500; font-family: inherit;
      letter-spacing: -0.01em;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.05); color: #e2e8f0;
      cursor: pointer; white-space: nowrap;
      transition: all 150ms ease;
    }
    .bs-btn:hover { border-color: rgba(255,255,255,0.14); background: rgba(255,255,255,0.08); color: #f8fafc; }
    .bs-btn:active { background: rgba(255,255,255,0.03); }
    .bs-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(99,102,241,0.35); }
    .bs-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .bs-btn-ghost { background: transparent; border-color: transparent; color: var(--text-secondary); }
    .bs-btn-ghost:hover { background: rgba(148,163,184,0.08); color: var(--text-primary); }
    .bs-btn-primary { background: rgba(99,102,241,0.08); color: #c7d2fe; border-color: rgba(99,102,241,0.2); }
    .bs-btn-primary:hover { background: rgba(99,102,241,0.14); border-color: rgba(99,102,241,0.35); }
    .bs-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
    .bs-btn-accent { background: #4f46e5; border-color: #4338ca; color: #fff; }
    .bs-btn-accent:hover { background: #4338ca; border-color: #3730a3; color: #fff; }
    .bs-btn-danger { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.40); color: #f87171; }
    .bs-btn-danger:hover { background: rgba(239,68,68,0.20); border-color: rgba(239,68,68,0.60); color: #fca5a5; }

    /* ── Warning banner ── */
    .bs-banner {
      border: 1px solid rgba(234,179,8,0.35); background: rgba(234,179,8,0.08);
      border-radius: 8px; padding: 10px 12px 10px 16px; margin-bottom: 12px;
      position: relative; overflow: hidden; font-size: 12.5px;
    }
    .bs-banner::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: rgba(234,179,8,0.6); }
    .bs-banner-title { font-weight: 700; color: #fde047; margin-bottom: 3px; }
    .bs-banner-text { color: var(--text-secondary); line-height: 1.5; }
    .bs-banner-text b { color: var(--text-primary); font-weight: 600; }

    /* ── Checkbox (ck8t bs-check) ── */
    .bs-check {
      -webkit-appearance: none; appearance: none;
      margin: 0; width: 16px; height: 16px; flex: 0 0 16px;
      border: 1.5px solid #475569; border-radius: 4px;
      background: var(--bg-secondary); cursor: pointer; position: relative;
      transition: all 120ms ease;
    }
    .bs-check:hover { border-color: #818cf8; }
    .bs-check:checked { background: #4f46e5; border-color: #4f46e5; }
    .bs-check:checked::after {
      content: ''; position: absolute;
      left: 4px; top: 1px; width: 5px; height: 9px;
      border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
    }
    .bs-check:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }

    /* ── Toggle row (prev version) ── */
    .bs-toggle-row {
      display: flex; align-items: center; gap: 10px; padding: 10px 12px;
      border: 1px solid var(--ce-border); border-radius: 7px;
      background: var(--bs-input-bg); cursor: pointer; margin-top: 12px;
      transition: border-color 140ms, background 140ms;
    }
    .bs-toggle-row:hover { border-color: rgba(255,255,255,0.16); background: var(--bs-input-hover-bg); }
    .bs-toggle-row.is-active { border-color: rgba(99,102,241,0.40); background: rgba(99,102,241,0.06); }
    .bs-toggle-row label { display: flex; align-items: center; gap: 10px; cursor: pointer; flex: 1; font-size: 13px; color: var(--text-primary); }
    .bs-toggle-row .sub { font-size: 11.5px; color: var(--text-secondary); margin-top: 2px; }

    /* ── Lint chip ── */
    .lint-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-height: 22px; }
    .lint-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600;
      border: 1px solid transparent; transition: all 140ms;
    }
    .lint-chip.idle { color: var(--text-secondary); background: rgba(255,255,255,0.04); border-color: var(--ce-border); }
    .lint-chip.good { color: #4ade80; background: rgba(74,222,128,0.08); border-color: rgba(74,222,128,0.30); }
    .lint-chip.bad  { color: #f87171; background: rgba(248,113,113,0.08); border-color: rgba(248,113,113,0.30); }

    /* ── Previous area hidden by default ── */
    #previousArea { display: none; }
    body.has-prev #previousArea { display: block; }

    /* ── Action bar ── */
    .bs-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }

    /* ── Status block ── */
    .bs-status {
      margin-top: 10px; padding: 9px 13px; border-radius: 8px;
      font-size: 12.5px; display: none;
      border: 1px solid var(--ce-border); background: var(--bg-card);
    }
    .bs-status.show { display: block; }
    .bs-status.ok  { border-color: rgba(99,102,241,0.35); color: #a5b4fc; background: rgba(99,102,241,0.07); }
    .bs-status.err { border-color: rgba(239,68,68,0.40); color: #f87171; background: rgba(239,68,68,0.07); }

    /* ── Screen guards (CSP blocks inline style=, so put here) ── */
    #progressScreen, #resultScreen { display: none; }

    /* ── Lint chip hidden when empty ── */
    .lint-chip:empty { display: none; }
    .lint-chip.hidden { display: none; }

    /* ── Result / change card ── */
    ${CHANGE_CARD_CSS}
    .button { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.05); color: #e2e8f0; font-size: 12.5px; font-family: inherit; cursor: pointer; transition: all 120ms; }
    .button:hover { border-color: rgba(255,255,255,0.18); background: rgba(255,255,255,0.09); }
    .button.primary { background: #4f46e5; color: #fff; border-color: #4338ca; }
    .button.primary:hover { background: #4338ca; border-color: #3730a3; }
    .button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .button.danger { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.40); color: #f87171; }
    .button.danger:hover { background: rgba(239,68,68,0.20); border-color: rgba(239,68,68,0.60); color: #fca5a5; }
    .button.small { padding: 4px 10px; font-size: 11.5px; border-radius: 6px; }

    /* ── Progress screen ── */
    .screen-progress { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; gap: 24px; padding: 40px 20px; text-align: center; }
    .prog-icon { width:56px;height:56px;border-radius:50%;background:rgba(99,102,241,0.12);border:2px solid rgba(99,102,241,0.30);display:flex;align-items:center;justify-content:center;animation:progpulse 2s ease-in-out infinite; }
    @keyframes progpulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.1);opacity:.75} }
    .prog-bar { width: 280px; height: 3px; background: rgba(255,255,255,0.07); border-radius: 2px; overflow: hidden; position: relative; }
    .prog-bar::after { content: ''; position: absolute; top: 0; height: 100%; width: 55%; background: linear-gradient(90deg,transparent,#6366f1,transparent); animation: progbar 1.4s ease-in-out infinite; left: -60%; }
    @keyframes progbar { to { left: 160%; } }
    .prog-label { font-size: 13px; color: var(--text2); text-align: center; min-height: 20px; }
    .prog-stream { width: 100%; max-width: 560px; max-height: 110px; overflow: hidden; font-family: ui-monospace,Consolas,monospace; font-size: 10.5px; color: rgba(148,163,184,0.65); background: rgba(0,0,0,0.18); border: 1px solid rgba(99,102,241,0.15); border-radius: 6px; padding: 7px 10px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; display: none; }
    .prog-stream.active { display: block; }
    /* ── Result screen ── */
    .screen-result { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; overflow: hidden; padding: 32px 20px; background: var(--bg); }
    .screen-result > * { width: 100%; max-width: 1008px; }
  </style>
</head>
<body>
<div id="formScreen">
  <div id="genErrBox" class="cc-gen-err" style="display:none;margin-bottom:16px;">
    <div class="cc-gen-err-hd">
      <div class="cc-gen-err-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
      <div class="cc-gen-err-body">
        <div class="cc-gen-err-title">Generation Failed</div>
        <div class="cc-gen-err-msg" id="genErrMsg">An error occurred.</div>
        <div class="cc-gen-err-meta" id="genErrMeta"></div>
      </div>
      <button class="cc-gen-err-toggle" id="genErrToggle" onclick="(function(){var s=document.getElementById('genErrStack');var b=document.getElementById('genErrToggle');if(b.dataset.open==='1'){s.style.display='none';b.textContent='▶ Stack trace';b.dataset.open='0';}else{s.style.display='block';b.textContent='▼ Stack trace';b.dataset.open='1';}})(" style="display:none">▶ Stack trace</button>
    </div>
    <div class="cc-gen-err-stack" id="genErrStack"><pre id="genErrStackPre"></pre></div>
  </div>
  <div class="page-hd">
    <h1 class="page-title">Freeform SQL &rarr; DMCR</h1>
    <span class="bs-badge">SQL</span>
    <span class="bs-pill">PostgreSQL</span>
  </div>

  <div class="bs-banner">
    <div class="bs-banner-title">Heads up</div>
    <div class="bs-banner-text">
      For <b>CREATE OR REPLACE FUNCTION</b>, enable <b>Previous version</b> and paste the old body
      so revert can restore it exactly.
    </div>
  </div>

  <!-- Current SQL -->
  <div class="bs-card">
    <div class="bs-section-row">
      <span class="bs-section-label">Current SQL (deploy)</span>
    </div>
    <textarea id="sqlBox" class="bs-textarea bs-code" spellcheck="false"
      placeholder="-- Paste your SQL here (DDL/DML/function)&#10;-- ALTER TABLE, CREATE FUNCTION, INSERT INTO, etc."></textarea>
    <div class="lint-row">
      <span id="currentLintStatus" class="lint-chip hidden"></span>
      <span id="currentLintHint" class="bs-hint" style="display:none;">PostgreSQL parser checks (extension-side).</span>
    </div>

    <!-- Previous version toggle -->
    <div class="bs-toggle-row" id="prevToggleRow">
      <label>
        <input type="checkbox" class="bs-check" id="prevChk" />
        <div>
          <div><strong>Previous version</strong> (for revert)</div>
          <div class="sub">Enable when replacing an existing function/view &mdash; lets revert restore it exactly.</div>
        </div>
      </label>
    </div>

    <div id="previousArea">
      <div class="bs-section-row" style="margin-top:14px;">
        <span class="bs-section-label">Previous SQL (restore on revert)</span>
      </div>
      <textarea id="previousSqlBox" class="bs-textarea bs-code" spellcheck="false"
        placeholder="-- Paste the PREVIOUS version here"></textarea>
      <div class="lint-row">
        <span id="prevLintStatus" class="lint-chip hidden"></span>
        <span class="bs-hint">Same Postgres parser lint as current SQL.</span>
      </div>
    </div>
  </div>

  <!-- Optional -->
  <div class="bs-card">
    <div class="bs-section-label" style="margin-bottom:10px;">Optional</div>
    <div class="bs-field">
      <label class="bs-label">DB Schema context</label>
      <input id="dbSchema" class="bs-input" placeholder="e.g. public, zp_st &mdash; LLM uses for verify/revert qualification" />
    </div>
    <div class="bs-field">
      <label class="bs-label">Change name hint</label>
      <input id="changeHint" class="bs-input" placeholder="e.g. update_my_fn_logic" />
    </div>
    <div class="bs-hint" style="margin-top:4px;">Tip: Include a uniqueness key in comments so revert can safely delete DML rows.</div>
  </div>

  <!-- Actions -->
  <div class="bs-actions">
    <button class="bs-btn bs-btn-accent" id="generateBtn" type="button">&#x1FA84; Generate DMCR request</button>
    <button class="bs-btn bs-btn-danger" id="cancelBtn" type="button">&#x2715; Cancel</button>
  </div>

  <div id="status" class="bs-status" aria-live="polite"></div>


</div><!-- #formScreen -->

<div id="progressScreen">
  <div class="wrap screen-progress">
    <div class="prog-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>
    <div class="prog-bar"></div>
    <div class="prog-label" id="progLabel">Generating your DMCR change&hellip;</div>
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
      if (window.parent !== window && window.parent.__DMCR_VSCODE_API__) {
        return window.parent.__DMCR_VSCODE_API__;
      }
      try { return acquireVsCodeApi(); } catch(e) { return { postMessage:function(){}, getState:function(){return{};}, setState:function(){} }; }
    })();
    window._dmcrVS = vscode;

    // ── SQL syntax highlighter ──────────────────────────────────────────────────
    function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    var SQL_KW = new Set(['SELECT','FROM','WHERE','INSERT','INTO','UPDATE','DELETE','CREATE','ALTER','DROP','TABLE','VIEW','INDEX','SEQUENCE','FUNCTION','PROCEDURE','TRIGGER','SCHEMA','DATABASE','GRANT','REVOKE','ON','TO','WITH','AS','DISTINCT','ALL','IN','IS','NULL','NOT','AND','OR','BETWEEN','LIKE','ORDER','BY','GROUP','HAVING','LIMIT','OFFSET','INNER','LEFT','RIGHT','FULL','OUTER','JOIN','UNION','EXCEPT','INTERSECT','EXISTS','CASE','WHEN','THEN','ELSE','END','BEGIN','COMMIT','ROLLBACK','SET','DEFAULT','PRIMARY','KEY','FOREIGN','REFERENCES','UNIQUE','CHECK','CONSTRAINT','IF','DO','LANGUAGE','RETURNS','RETURN','DECLARE','EXCEPTION','RAISE','PERFORM','EXECUTE','COALESCE','NULLIF','CAST','SERIAL','BIGSERIAL','INTEGER','INT','BIGINT','SMALLINT','TEXT','VARCHAR','CHAR','BOOLEAN','BOOL','FLOAT','NUMERIC','REAL','TIMESTAMP','TIMESTAMPTZ','DATE','TIME','UUID','JSONB','JSON','BYTEA','VOID','REPLACE','VALUES','RETURNING','CONFLICT','NOTHING','OWNED','CYCLE','MINVALUE','MAXVALUE','START','RESTART','INCREMENT','CACHE','TABLESPACE','USAGE','PRIVILEGES','PUBLIC','CURRENT_USER','TYPE','ENUM','USING','ONLY','PARTITION','OWNER','AUTHORIZATION','ROW','ROWS']);
    function highlightSql(sql) {
      if (!sql) return '';
      var r='',i=0,len=sql.length;
      while(i<len){
        if(sql[i]==='-'&&i+1<len&&sql[i+1]==='-'){var j=i;while(j<len&&sql.charCodeAt(j)!==10)j++;r+='<span style="color:#64748b;font-style:italic">'+escHtml(sql.slice(i,j))+'</span>';i=j;continue;}
        if(sql[i]==='/'&&i+1<len&&sql[i+1]==='*'){var e2=sql.indexOf('*/',i+2);var cm=e2===-1?sql.slice(i):sql.slice(i,e2+2);r+='<span style="color:#64748b;font-style:italic">'+escHtml(cm)+'</span>';i=e2===-1?len:e2+2;continue;}
        if(sql[i]==='$'){var dm=sql.slice(i).match(/^\$([^$]*)\$/);if(dm){var dtag=dm[0];var de=sql.indexOf(dtag,i+dtag.length);if(de!==-1){r+='<span style="color:#86efac">'+escHtml(sql.slice(i,de+dtag.length))+'</span>';i=de+dtag.length;continue;}}}
        if(sql[i]==="'"){var k=i+1;while(k<len){if(sql[k]==="'"&&k+1<len&&sql[k+1]==="'"){k+=2;continue;}if(sql[k]==="'"){k++;break;}k++;}r+='<span style="color:#86efac">'+escHtml(sql.slice(i,k))+'</span>';i=k;continue;}
        if(sql[i]=='"'){var qi=i+1;while(qi<len&&sql[qi]!='"')qi++;if(qi<len)qi++;r+='<span style="color:#93c5fd">'+escHtml(sql.slice(i,qi))+'</span>';i=qi;continue;}
        if(/[0-9]/.test(sql[i])&&(i===0||/[\s\W]/.test(sql[i-1]))){var ni=i;while(ni<len&&/[0-9._eE]/.test(sql[ni]))ni++;r+='<span style="color:#fb923c">'+escHtml(sql.slice(i,ni))+'</span>';i=ni;continue;}
        if(/[a-zA-Z_]/.test(sql[i])){var wi=i;while(wi<len&&/[a-zA-Z0-9_]/.test(sql[wi]))wi++;var w=sql.slice(i,wi);r+=SQL_KW.has(w.toUpperCase())?'<span style="color:#818cf8;font-weight:600">'+escHtml(w)+'</span>':escHtml(w);i=wi;continue;}
        r+=escHtml(sql[i]);i++;
      }
      return r;
    }

    // ── Element refs ──────────────────────────────────────────────────
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
    const sqlBox           = document.getElementById('sqlBox');
    const previousSqlBox   = document.getElementById('previousSqlBox');
    const prevChk          = document.getElementById('prevChk');
    const prevToggleRow    = document.getElementById('prevToggleRow');
    const changeHint       = document.getElementById('changeHint');
    const dbSchemaEl       = document.getElementById('dbSchema');
    const statusEl         = document.getElementById('status');
    const lintChipCurrent  = document.getElementById('currentLintStatus');
    const lintChipPrev     = document.getElementById('prevLintStatus');
    const generateBtn      = document.getElementById('generateBtn');
    const cancelBtn        = document.getElementById('cancelBtn');

    let currentChange = null;
    let currentTab    = 'deploy';

    ${CHANGE_CARD_LINT_JS}
    const ccBrowseBtnEl2 = document.getElementById('ccBrowseBtn');
    if (ccBrowseBtnEl2) {
      ccBrowseBtnEl2.addEventListener('click', function() { vscode.postMessage({ type: 'browseFolder' }); });
    }
    window.addEventListener('message', function(ev) {
      if (ev.data && ev.data.type === 'folderPicked' && ccLocationEl) ccLocationEl.value = ev.data.path || '';
    }, true);


    // ── Screen switching ──────────────────────────────────────────────
    function showScreen(name) {
      if (formScreenEl)     formScreenEl.style.display     = name === 'form'     ? 'block' : 'none';
      if (progressScreenEl) progressScreenEl.style.display = name === 'progress' ? 'block' : 'none';
      if (resultScreenEl)   resultScreenEl.style.display   = name === 'result'   ? 'flex' : 'none';
    }
    showScreen('form'); // always start on form
    showEl(genErrBoxEl, false); // hide error box on start/restart

    function showEl(el, v, displayVal) { if (el) el.style.display = v ? (displayVal || 'block') : 'none'; }

    // ── Change card ───────────────────────────────────────────────────
    function showChangeCard(change) {
      currentChange = change; currentTab = 'deploy';
      _lintMap = { deploy: null, verify: null, revert: null };
      renderLint('deploy');
      if (ccChangeNameEl) ccChangeNameEl.textContent = change.changeName || 'dmcr_change';
      if (ccSqlDisplayEl) ccSqlDisplayEl.innerHTML = highlightSql(change.deploySql || '');
      showEl(ccSavedBoxEl, false);
      if (ccErrBoxEl) { ccErrBoxEl.style.display = 'none'; ccErrBoxEl.textContent = ''; }
      showEl(genErrBoxEl, false);
      if (changeCardEl) changeCardEl.style.display = '';
      document.querySelectorAll('.cc-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'deploy'));
      [['deploy', change.deploySql], ['verify', change.verifySql], ['revert', change.revertSql]].forEach(function(pair, i) {
        setTimeout(function() { vscode.postMessage({ type: 'lintSql', payload: { id: pair[0], sql: pair[1] || '' } }); }, 200 + i * 120);
      });
      showScreen('result');
    }

    document.addEventListener('click', function(e) {
      const tab = e.target.closest && e.target.closest('.cc-tab');
      if (!tab || !currentChange) return;
      currentTab = tab.dataset.tab;
      document.querySelectorAll('.cc-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === currentTab));
      const sql = currentTab === 'deploy' ? currentChange.deploySql
               : currentTab === 'verify'  ? currentChange.verifySql
               : currentChange.revertSql;
      if (ccSqlDisplayEl) ccSqlDisplayEl.innerHTML = highlightSql(sql || '');
      renderLint(currentTab);
    });

    if (ccSaveBtnEl) {
      ccSaveBtnEl.addEventListener('click', function() {
        if (!currentChange) return;
        ccSaveBtnEl.disabled = true; ccSaveBtnEl.textContent = 'Saving\u2026';
        const loc = ccLocationEl ? ccLocationEl.value.trim() : '';
        vscode.postMessage({ type: 'saveChange', payload: Object.assign({}, currentChange, { location: loc }) });
      });
    }
    if (ccRevealBtnEl) {
      ccRevealBtnEl.addEventListener('click', function() {
        const rel = ccFolderRelEl ? ccFolderRelEl.textContent : '';
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
    function setBusy(b) { generateBtn.disabled = b; cancelBtn.disabled = false; }

    window.addEventListener('error', e => setStatus('Error: ' + (e && e.message || String(e)), 'err'));
    window.addEventListener('unhandledrejection', e => setStatus('Error: ' + ((e && e.reason && e.reason.message) || String((e && e.reason) || e)), 'err'));

    // ── Lint chips ────────────────────────────────────────────────────
    function setLint(chip, state, msg) {
      if (!chip) return;
      if (!state || state === 'hidden') {
        chip.className = 'lint-chip hidden'; chip.textContent = ''; return;
      }
      chip.className = 'lint-chip ' + (state === 'good' ? 'good' : state === 'bad' ? 'bad' : 'idle');
      chip.textContent = state === 'good'  ? '\u2713 SQL valid'
                       : state === 'bad'   ? '\u26A0 ' + (msg || 'parse error')
                       : state === 'linting' ? '\u23F3 Linting\u2026'
                       : '';
    }

    let lintSeq = 0;
    const pending = new Map();
    const lintCache = {};
    const lintTimers = {};

    function requestLint(which, sql) {
      const id = ++lintSeq;
      const chip = which === 'current' ? lintChipCurrent : lintChipPrev;
      setLint(chip, 'linting', '');
      vscode.postMessage({ type: 'lint', payload: { id, which, sql: String(sql || ''), dialect: 'postgresql' } });
      return new Promise(resolve => pending.set(id, resolve));
    }

    function scheduleLint(which, sql) {
      if (lintTimers[which]) clearTimeout(lintTimers[which]);
      const chip = which === 'current' ? lintChipCurrent : lintChipPrev;
      if (!sql.trim()) { setLint(chip, 'hidden', ''); lintCache[which] = null; return; }
      setLint(chip, 'linting', '');
      lintTimers[which] = setTimeout(async function() {
        const res = await requestLint(which, sql);
        lintCache[which] = { sql, ...res };
        setLint(chip, res.ok ? 'good' : 'bad', res.msg);
      }, 600);
    }

    async function lintNow(which, sql) {
      if (lintTimers[which]) { clearTimeout(lintTimers[which]); delete lintTimers[which]; }
      const chip = which === 'current' ? lintChipCurrent : lintChipPrev;
      if (!sql.trim()) { setLint(chip, 'hidden', ''); lintCache[which] = null; return { ok: true }; }
      const c = lintCache[which];
      if (c && c.sql === sql) { setLint(chip, c.ok ? 'good' : 'bad', c.msg); return c; }
      const res = await requestLint(which, sql);
      lintCache[which] = { sql, ...res };
      setLint(chip, res.ok ? 'good' : 'bad', res.msg);
      return res;
    }

    window.addEventListener('message', function(event) {
      const msg = event.data; if (!msg) return;
      if (msg.type === 'setTheme') {
        document.documentElement.setAttribute('data-theme', msg.isDark ? 'dark' : 'light');
        return;
      }
      if (msg.type === 'lintResult') {
        const { id, which, ok, msg: text } = msg.payload || {};
        // card-level lint uses string tab ids ('deploy'|'verify'|'revert')
        if (id === 'deploy' || id === 'verify' || id === 'revert') {
          updateLint(id, !!ok, String(text || ''));
        } else {
          const resolve = pending.get(id);
          if (resolve) { pending.delete(id); resolve({ ok: !!ok, msg: String(text || '') }); }
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
        // Log full details to DevTools
        console.error('[DMCR] Generation Error', { message: errMsg, code: errPayload.code, stack: errStack, timestamp: errTime, source: errPayload.source });
        // Populate error UI
        if (genErrMsgEl) genErrMsgEl.textContent = errMsg + errCode;
        const genErrMetaEl = document.getElementById('genErrMeta');
        if (genErrMetaEl) genErrMetaEl.textContent = errTime + (errPayload.source ? '  ·  ' + errPayload.source : '');
        const genErrToggleEl = document.getElementById('genErrToggle');
        const genErrStackPreEl = document.getElementById('genErrStackPre');
        if (genErrStackPreEl) genErrStackPreEl.textContent = errStack;
        if (genErrToggleEl) { genErrToggleEl.style.display = ''; genErrToggleEl.dataset.open = '0'; }
        showEl(genErrBoxEl, true);
        showEl(changeCardEl, false);
        clearStatus();
        // Go back to form screen so Cancel + Generate buttons remain accessible
        showScreen('form');
        // Scroll error into view
        if (genErrBoxEl) genErrBoxEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (msg.type === 'saved') {
        if (ccSaveBtnEl) { ccSaveBtnEl.disabled = true; ccSaveBtnEl.textContent = 'Saved!'; }
        showEl(ccSavedBoxEl, true, 'flex');
        if (ccFolderRelEl && msg.payload) ccFolderRelEl.textContent = msg.payload.folderRel || '';
        showEl(ccErrBoxEl, false);
      } else if (msg.type === 'saveError') {
        if (ccSaveBtnEl) { ccSaveBtnEl.disabled = false; ccSaveBtnEl.textContent = 'Save to workspace'; }
        if (ccErrBoxEl) { ccErrBoxEl.style.display = ''; ccErrBoxEl.textContent = (msg.payload && msg.payload.msg) || 'Save failed.'; }
      } else if (msg.type === 'formActivated') {
        // Tab re-activated — reset to form screen and hide stale errors.
        showEl(genErrBoxEl, false);
        showScreen('form');
      }
    });

    // ── Lint event wiring ─────────────────────────────────────────────
    if (sqlBox) {
      sqlBox.addEventListener('input', () => scheduleLint('current', sqlBox.value));
      sqlBox.addEventListener('blur',  () => lintNow('current', sqlBox.value));
    }
    if (previousSqlBox) {
      previousSqlBox.addEventListener('input', () => { if (prevChk && prevChk.checked) scheduleLint('prev', previousSqlBox.value); });
      previousSqlBox.addEventListener('blur',  () => { if (prevChk && prevChk.checked) lintNow('prev', previousSqlBox.value); });
    }

    // ── Previous version toggle ───────────────────────────────────────
    if (prevChk) {
      prevChk.addEventListener('change', () => {
        const on = prevChk.checked;
        document.body.classList.toggle('has-prev', on);
        if (prevToggleRow) prevToggleRow.classList.toggle('is-active', on);
        clearStatus();
        lintCache['current'] = null;
        if (!on) setLint(lintChipPrev, 'hidden', '');
      });
    }

    // ── Cancel ────────────────────────────────────────────────────────
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    }

    // ── Generate ──────────────────────────────────────────────────────
    if (generateBtn) {
      generateBtn.addEventListener('click', async () => {
        clearStatus();
        const currentSql = sqlBox ? sqlBox.value.trim() : '';
        if (!currentSql) return setStatus('Paste SQL first.', 'err');

        setBusy(true);
        try {
          setStatus('Validating\u2026', 'ok');
          const r1 = await lintNow('current', currentSql);
          if (!r1.ok) { setStatus('Fix SQL issues before generating: ' + r1.msg, 'err'); return; }

          const includePrevious = prevChk && prevChk.checked;
          const prevSql = previousSqlBox ? previousSqlBox.value.trim() : '';
          if (includePrevious) {
            if (!prevSql) { setStatus('Paste previous SQL or disable Previous version.', 'err'); return; }
            const r2 = await lintNow('prev', prevSql);
            if (!r2.ok) { setStatus('Fix previous SQL issues: ' + r2.msg, 'err'); return; }
          }

          setStatus('Generating DMCR change\u2026 \uD83D\uDE80', 'ok');
          vscode.postMessage({
            type: 'submit',
            payload: {
              sql: currentSql,
              includePrevious: !!includePrevious,
              previousSql: includePrevious ? prevSql : '',
              changeNameHint: changeHint ? changeHint.value.trim() : '',
              dbSchema: dbSchemaEl ? dbSchemaEl.value.trim() : '',
              dialect: 'postgresql',
            },
          });
        } catch (e) {
          setStatus('Error: ' + ((e && e.message) || String(e)), 'err');
        } finally {
          setBusy(false);
        }
      });
    }
  </script>

  <div id="dmcr-corner-widget" style="position:fixed;bottom:14px;right:14px;display:flex;gap:6px;z-index:9999;align-items:center;">
    <button id="dmcr-reload-btn" title="Reload form" style="background:none;border:none;padding:5px;cursor:pointer;opacity:0.55;display:flex;align-items:center;border-radius:6px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>
      </svg>
    </button>
    <button id="dmcr-close-btn" title="Close form" style="background:none;border:none;padding:5px;cursor:pointer;opacity:0.55;display:flex;align-items:center;border-radius:6px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>
      </svg>
    </button>
  </div>
  <script nonce="${n}">
    (function() {
      var vs = window._dmcrVS;
      if (!vs) return;
      function wire(id, msgType) {
        var el = document.getElementById(id);
        if (!el) return;
        el.onclick = function() { vs.postMessage({ type: msgType }); };
        el.onmouseenter = function() { el.style.opacity = '1'; };
        el.onmouseleave = function() { el.style.opacity = '0.55'; };
      }
      wire('dmcr-close-btn',  'cancel');
      wire('dmcr-reload-btn', 'reload');
    })();
  </script>
</body>
</html>`;
}

/** Inline iframe form: return raw HTML without opening a panel */
export function getFreeformSqlFormHtml(n: string): string { return getHtml(n); }
/** Inline iframe form: compute normalised LLM request from submit payload */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildFreeformNormalizedRequest(payload: any): string { return buildNormalizedRequest(payload as SubmitMessage['payload']); }
