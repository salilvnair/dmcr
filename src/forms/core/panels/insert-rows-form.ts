﻿import * as vscode from "vscode";
import { buildInsertRowsPrompt, type InsertRow } from "../../llm/prompts/prompt-template";
import { CHANGE_CARD_CSS, CHANGE_CARD_HTML, CHANGE_CARD_HTML_INNER, CHANGE_CARD_LINT_JS } from "./change-card-template";

type ColType =
  | "timestamp"
  | "timestamptz"
  | "date"
  | "time"
  | "interval"
  | "int"
  | "bigint"
  | "numeric"
  | "text"
  | "varchar"
  | "boolean"
  | "custom";

type ColumnSpec = { name: string; type: ColType; customType?: string };

type SubmitMessage = {
  type: "submit";
  payload: {
    table: string;
    columns: ColumnSpec[];
    rows: InsertRow[];
    idempotent: boolean;
    conflictTarget: string; // comma-separated columns
    conflictAction: "do_nothing" | "update";
    conflictUpdateCols: string; // comma-separated columns
    changeNameHint: string;
  };
};

type CancelMessage = { type: "cancel" };

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildNormalizedRequest(p: SubmitMessage["payload"]): string {
  const table = (p.table ?? "").trim();
  const cols = (p.columns ?? [])
    .map(c => ({
      name: (c.name ?? "").trim(),
      type:
        c.type === "custom"
          ? (c.customType ?? "").trim()
          : c.type === "varchar"
            ? ((c.customType ?? "").trim() || "varchar(255)")
            : c.type,
    }))
    .filter(c => c.name && c.type);
  const rows = (p.rows ?? []).filter(r => r && typeof r === "object");

  return buildInsertRowsPrompt({
    table,
    columns: cols,
    rows: rows as InsertRow[],
    idempotent: !!p.idempotent,
    conflictTarget: (p.conflictTarget ?? "").trim(),
    conflictAction: p.conflictAction ?? "do_nothing",
    conflictUpdateCols: (p.conflictUpdateCols ?? "").trim(),
    changeNameHint: (p.changeNameHint ?? "").trim(),
  });
}

export async function openInsertRowsForm(opts: {
  extensionUri: vscode.Uri;
  title?: string;
}): Promise<{ normalizedRequest: string; panel: vscode.WebviewPanel } | null> {
  const panel = vscode.window.createWebviewPanel(
    "dmcrInsertRowsForm",
    opts.title ?? "DMCR: Insert rows (PostgreSQL)",
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
      panel.webview.onDidReceiveMessage((msg: SubmitMessage | CancelMessage) => {
        if (!msg || typeof msg !== "object") return;

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
      })
    );
  });
}

function getHtml(n: string): string {
  const typeOptions: Array<{ value: ColType; label: string }> = [
    { value: "timestamp", label: "timestamp" },
    { value: "timestamptz", label: "timestamptz" },
    { value: "date", label: "date" },
    { value: "time", label: "time" },
    { value: "interval", label: "interval (H:MM:SS)" },
    { value: "int", label: "int" },
    { value: "bigint", label: "bigint" },
    { value: "numeric", label: "numeric" },
    { value: "boolean", label: "boolean" },
    { value: "text", label: "text" },
    { value: "varchar", label: "varchar(n)" },
    { value: "custom", label: "custom\u2026" },
  ];

  const typeItemsJson = JSON.stringify(typeOptions.map(o => ({ value: o.value, label: o.label })));
  const typeOptionsHtml = typeOptions
    .map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DMCR Insert Rows</title>

  <style nonce="${n}">
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
    :root[data-theme='light'] {
      --bg:         #f8fafc; --bg2:  #ffffff; --bg3: #f1f5f9;
      --border:     rgba(0,0,0,0.09); --border2: rgba(99,102,241,0.30);
      --text:       #0f172a; --text2: #475569;
      --accent:     #6366f1; --accent-ring: rgba(99,102,241,0.22);
      --red:        #dc2626; --green: #16a34a;
      --warn-bg:    rgba(161,98,7,0.08); --warn-border: rgba(161,98,7,0.35);
    }
    [data-theme='light'] body { color-scheme: light; }
    [data-theme='light'] h2 { color: #0f172a; }
    [data-theme='light'] .card { background: #fff; border-color: rgba(0,0,0,0.09); box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
    [data-theme='light'] .setting-card { background: rgba(99,102,241,0.04); border-color: rgba(99,102,241,0.12); }
    [data-theme='light'] .setting-card:has(input:checked) { background: rgba(99,102,241,0.08); }
    [data-theme='light'] input[type="text"],[data-theme='light'] input[type="number"],[data-theme='light'] input:not([type]),[data-theme='light'] select,[data-theme='light'] textarea { background: #fff; border-color: #e2e8f0; color: #0f172a; }
    [data-theme='light'] input[type="text"]:hover,[data-theme='light'] input[type="number"]:hover,[data-theme='light'] input:not([type]):hover,[data-theme='light'] select:hover,[data-theme='light'] textarea:hover { border-color: #cbd5e1; background: #f8fafc; }
    [data-theme='light'] input::placeholder,[data-theme='light'] textarea::placeholder { color: #94a3b8; }
    [data-theme='light'] button { color: #0f172a; }
    [data-theme='light'] .sd-menu { background: #fff; border-color: rgba(0,0,0,0.10); box-shadow: 0 8px 24px rgba(0,0,0,0.10); }
    [data-theme='light'] .sd-trigger { background: #ffffff; border-color: #e2e8f0; color: #1e293b; }
    [data-theme='light'] .sd-trigger:hover { background: #f8fafc; border-color: #cbd5e1; }
    [data-theme='light'] .sd-trigger.open { background: #ffffff; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.18); }
    [data-theme='light'] .sd-val { color: #1e293b; }
    [data-theme='light'] .sd-item { color: #475569; }
    [data-theme='light'] .sd-item:hover { background: rgba(99,102,241,0.07); color: #0f172a; }
    [data-theme='light'] .sd-item.selected { background: rgba(99,102,241,0.12); color: #4f46e5; }
    *, *::before, *::after { box-sizing: border-box; }

    body {
      margin: 0; padding: 14px 16px 32px;
      background: var(--bg); color: var(--text);
      font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px; line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { width: 100%; max-width: 100%; margin: 0; padding: 0 4px; }

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
      width: 100%; padding: 7px 10px; min-height: 32px; box-sizing: border-box;
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
      background: #4f46e5; color: #fff;
      border-color: #4338ca;
    }
    button.primary:hover { background: #4338ca; border-color: #3730a3; color: #fff; }
    button.primary:active { background: #3730a3; }

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
    /* -- Custom styled dropdown -- */
    .sd-wrap { position: relative; }
    .sd-trigger {
      display: flex; align-items: center; justify-content: space-between;
      width: 100%; padding: 7px 10px; min-height: 32px;
      background: rgba(255,255,255,0.05); border: 1px solid var(--border);
      border-radius: 7px; color: var(--text); font-family: inherit; font-size: 12.5px;
      cursor: pointer; text-align: left;
      transition: border-color 140ms, box-shadow 140ms, background 140ms;
    }
    .sd-trigger:hover { border-color: rgba(255,255,255,0.16); background: rgba(255,255,255,0.07); }
    .sd-trigger.open { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); background: rgba(255,255,255,0.06); }
    .sd-val { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sd-arrow { width: 12px; height: 12px; color: #64748b; flex-shrink: 0; margin-left: 8px; transition: transform 140ms; }
    .sd-trigger.open .sd-arrow { transform: rotate(180deg); color: var(--accent); }
    .sd-menu { position: fixed; z-index: 9999; min-width: 200px; background: #1e2535; border: 1px solid rgba(99,102,241,0.25); border-radius: 10px; padding: 4px; box-shadow: 0 16px 48px rgba(0,0,0,0.55); display: none; }
    .sd-menu.open { display: block; }
    .sd-item { padding: 7px 12px; border-radius: 6px; font-size: 12.5px; color: var(--text2); cursor: pointer; transition: all 100ms; }
    .sd-item:hover { background: rgba(99,102,241,0.12); color: var(--text); }
    .sd-item.selected { background: rgba(99,102,241,0.18); color: #c7d2fe; }

    /* -- Progress screen -- */
    .screen-progress { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; gap: 24px; text-align: center; min-height: 80vh; }
    .prog-icon { width: 56px; height: 56px; border-radius: 50%; background: rgba(99,102,241,0.12); border: 2px solid rgba(99,102,241,0.30); display: flex; align-items: center; justify-content: center; animation: progpulse 2s ease-in-out infinite; }
    @keyframes progpulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.1);opacity:.75} }
    .prog-bar { width: 280px; height: 3px; background: rgba(255,255,255,0.07); border-radius: 2px; overflow: hidden; position: relative; }
    .prog-bar::after { content: ''; position: absolute; top: 0; height: 100%; width: 55%; background: linear-gradient(90deg, transparent 0%, #6366f1 50%, transparent 100%); animation: progsweep 1.8s linear infinite; }
    @keyframes progsweep { 0%{left:-55%} 100%{left:110%} }
    .prog-label { font-size: 14px; color: var(--text2); font-weight: 500; }
    .prog-stream { width: 100%; max-width: 560px; max-height: 110px; overflow: hidden; font-family: ui-monospace,Consolas,monospace; font-size: 10.5px; color: rgba(148,163,184,0.65); background: rgba(0,0,0,0.18); border: 1px solid rgba(99,102,241,0.15); border-radius: 6px; padding: 7px 10px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; display: none; }
    .prog-stream.active { display: block; }
    ${CHANGE_CARD_CSS}

    /* ── table grid ── */
    .grid { overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
    table { width: 100%; border-collapse: collapse; min-width: max-content; }
    th, td {
      border-bottom: 1px solid var(--border); padding: 5px 8px; vertical-align: middle; text-align: left;
    }
    th { font-size: 11.5px; font-weight: 600; color: var(--text2); background: rgba(255,255,255,0.02); }
    tr:last-child td { border-bottom: none; }
    /* Ensure all cell editors share the same rendered height */
    td > .cellWrap { display: flex; align-items: stretch; width: 100%; }
    td > .cellWrap > input,
    td > .cellWrap > select,
    td > .cellWrap > .dtpk-wrap { flex: 1; min-width: 0; }
    td > .cellWrap > .dtpk-wrap > .dtpk-trigger { width: 100%; height: 32px; }

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
    .col-field { display: flex; flex-direction: column; gap: 3px; }
    .col-field-label { font-size: 10.5px; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: .04em; }
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

    /* ══════════════════════════════════════════════
       DTPK – Dark DateTime Picker  (dtpk-*)
       ══════════════════════════════════════════════ */

    /* Trigger pill */
    .dtpk-wrap { position: relative; width: 100%; }
    .dtpk-trigger {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 7px 10px; min-height: 32px; border-radius: 7px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.05);
      color: var(--text); font-family: inherit; font-size: 12.5px; line-height: 1.4;
      text-align: left; cursor: pointer; box-sizing: border-box;
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
      width: 28px; height: 28px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.10);
      background: rgba(255,255,255,0.04); color: #94a3b8; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; font-weight: 600; line-height: 1;
      transition: background 120ms, color 120ms, border-color 120ms;
    }
    .dtpk-nav:hover { background: rgba(99,102,241,0.16); color: #a5b4fc; border-color: rgba(99,102,241,0.35); }

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
      scroll-padding-top: 60px;
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

    /* AM/PM column — aligns to selection ring: label(~16px) + gap(4px) + spacer(60px) = 80px */
    .dtpk-ampm-col { display: flex; flex-direction: column; gap: 4px; margin-top: 80px; }
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

    /* sep aligns with selection ring center: label(~16px) + gap(4px) + spacer(60px) + half-ring(20px) - half-sep(~10px) = 90px */
    .dtpk-sep { font-size: 16px; font-weight: 700; color: #475569; align-self: flex-start; margin-top: 90px; }

    /* -- Custom styled dropdown (sd-*) -- */
    .sd-wrap { position: relative; }
    .sd-trigger {
      display: flex; align-items: center; justify-content: space-between;
      width: 100%; padding: 7px 10px; min-height: 32px;
      background: rgba(255,255,255,0.05); border: 1px solid var(--border);
      border-radius: 7px; color: var(--text); font-family: inherit; font-size: 12.5px;
      cursor: pointer; text-align: left;
      transition: border-color 140ms, box-shadow 140ms, background 140ms;
    }
    .sd-trigger:hover { border-color: rgba(255,255,255,0.16); background: rgba(255,255,255,0.07); }
    .sd-trigger.open { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); background: rgba(255,255,255,0.06); }
    .sd-val { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sd-arrow { width: 12px; height: 12px; color: #64748b; flex-shrink: 0; margin-left: 8px; transition: transform 140ms; }
    .sd-trigger.open .sd-arrow { transform: rotate(180deg); color: var(--accent); }
    .sd-menu {
      position: fixed; z-index: 9999; min-width: 200px;
      background: #1e2535; border: 1px solid rgba(99,102,241,0.25);
      border-radius: 10px; padding: 4px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.55); display: none;
    }
    .sd-menu.open { display: block; }
    .sd-item { padding: 7px 12px; border-radius: 6px; font-size: 12.5px; color: var(--text2); cursor: pointer; transition: all 100ms; }
    .sd-item:hover { background: rgba(99,102,241,0.12); color: var(--text); }
    .sd-item.selected { background: rgba(99,102,241,0.18); color: #c7d2fe; }
  </style>
</head>

<body>
<div id="formScreen">
  <div class="wrap">
    <div id="genErrBox" class="cc-gen-err" style="display:none;">
      <div class="cc-gen-err-hd">
        <div class="cc-gen-err-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
        <div class="cc-gen-err-body">
          <div class="cc-gen-err-title">Generation Failed</div>
          <div class="cc-gen-err-msg" id="genErrMsg">An error occurred.</div>
          <div class="cc-gen-err-meta" id="genErrMeta"></div>
        </div>
        <button class="cc-gen-err-toggle" id="genErrToggle" onclick="(function(){var s=document.getElementById('genErrStack');var b=document.getElementById('genErrToggle');if(b.dataset.open==='1'){s.style.display='none';b.textContent='? Stack trace';b.dataset.open='0';}else{s.style.display='block';b.textContent='? Stack trace';b.dataset.open='1';}})()" style="display:none">? Stack trace</button>
      </div>
      <div class="cc-gen-err-stack" id="genErrStack"><pre id="genErrStackPre"></pre></div>
    </div>
    Insert rows <span class="badge dml">DML</span> <span class="pill">PostgreSQL</span>
    <div class="hint mini">
      Step 1: define columns (name + type). Step 2: add one or more data rows.
      Timestamp/time/date fields use the built-in dark picker; interval expects H:MM:SS.
    </div>
    <div class="banner" role="note" aria-label="Tip">
      <div class="bannerTitle">Tip</div>
      <div class="bannerText">
        Keep <b>Idempotent</b> enabled to generate safer &ldquo;re-runnable&rdquo; deploy SQL using <b>ON CONFLICT</b>.
      </div>
    </div>
    <div class="card">
      <div class="section-title">Target</div>
      <div class="row" style="grid-template-columns: 1fr max-content;">
        <input id="tableName" placeholder="schema.table (e.g. public.wfm_chat_metrics)" />
        <button class="secondary" id="loadExampleBtn" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg>Load example</button>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Columns</div>
      <div id="columns"></div>
      <div class="top-actions">
        <button class="secondary" id="addColBtn" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><path d="M12 5v14M5 12h14"/></svg>Add column</button>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Rows</div>
      <div class="grid">
        <table>
          <thead>
            <tr id="rowHeader"></tr>
          </thead>
          <tbody id="rowBody"></tbody>
        </table>
      </div>
      <div class="top-actions">
        <button class="secondary" id="addRowBtn" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><path d="M12 5v14M5 12h14"/></svg>Add row</button>
        <button class="danger small" id="clearRowsBtn" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>Clear rows</button>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Idempotency (recommended)</div>
      <div class="setting-card">
        <input type="checkbox" class="bs-check" id="idempotentChk" checked />
        <div>
          <div class="title">Idempotent (use ON CONFLICT)</div>
          <div class="desc">
            If enabled, add conflict target + action so deploy can be re-run safely.
          </div>
        </div>
      </div>

      <div class="row" style="grid-template-columns: 1fr 1fr;">
        <input id="conflictTarget" placeholder="Conflict target columns (comma-separated), e.g. timestamp" />
        <div class="sd-wrap" id="conflictActionWrap">
          <button type="button" class="sd-trigger" id="conflictActionTrigger">
            <span class="sd-val" id="conflictActionVal">ON CONFLICT DO NOTHING</span>
            <svg class="sd-arrow" viewBox="0 0 12 7" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <input type="hidden" id="conflictAction" value="do_nothing" />
        </div>
      </div>

      <div class="row" style="grid-template-columns: 1fr;">
        <input id="conflictUpdateCols" placeholder="If UPDATE: columns to update (comma-separated), blank = all non-key" />
      </div>
    </div>

    <div class="setting-card" style="margin-bottom:0;">
      <label style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:4px;display:block;">Change name hint (optional)</label>
      <input id="changeNameHint" placeholder="e.g. seed_threshold_level_rows" style="width:100%;box-sizing:border-box;" />
    </div>

    <div class="actions">
      <button class="primary" id="generateBtn" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>Generate DMCR request</button>
      <button class="danger" id="cancelBtn" type="button">&#x2715; Cancel</button>
    </div>
    <div id="status" class="status" aria-live="polite"></div>
  </div>


</div><!-- #formScreen -->

<div id="progressScreen" style="display:none;">
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
    // -- Screen switching + change card JS --
    function makeStyledDropdown(wrapperId, inputId, valId, items, menuClass) {
      const wrap = document.getElementById(wrapperId);
      const hidden = document.getElementById(inputId);
      const valEl = document.getElementById(valId);
      if (!wrap || !hidden || !valEl) return;
      const trigger = wrap.querySelector('.sd-trigger');
      const menu = document.createElement('div');
      menu.className = 'sd-menu' + (menuClass ? ' ' + menuClass : '');
      document.body.appendChild(menu);
      function setVal(v) {
        const opt = items.find(function(o){return o.value===v;});
        hidden.value = v;
        valEl.textContent = opt?opt.label:v;
        menu.querySelectorAll('.sd-item').forEach(function(el){el.classList.toggle('selected',el.dataset.value===v);});
        hidden.dispatchEvent(new Event('change'));
      }
      items.forEach(function(item){
        const div=document.createElement('div');
        div.className='sd-item';div.dataset.value=item.value;div.textContent=item.label;
        div.addEventListener('click',function(){setVal(item.value);close();});
        menu.appendChild(div);
      });
      function open(){
        document.querySelectorAll('.sd-menu.open').forEach(function(m){m.classList.remove('open');});
        document.querySelectorAll('.sd-trigger.open').forEach(function(t){t.classList.remove('open');});
        trigger.classList.add('open');menu.classList.add('open');
        const r=trigger.getBoundingClientRect();
        menu.style.minWidth=r.width+'px';
        const h=menu.scrollHeight||200;
        const goUp=window.innerHeight-r.bottom<h+8&&r.top>h+8;
        menu.style.top=(goUp?r.top-h-4:r.bottom+4)+'px';
        menu.style.left=r.left+'px';
      }
      function close(){trigger.classList.remove('open');menu.classList.remove('open');}
      trigger.addEventListener('click',function(){if(trigger.classList.contains('open'))close();else open();});
      document.addEventListener('mousedown',function(e){if(!trigger.contains(e.target)&&!menu.contains(e.target))close();});
      setVal(hidden.value||items[0].value);
      return {setValue:setVal,getValue:function(){return hidden.value;}};
    }

    const formScreenEl=document.getElementById('formScreen');
    const progressScreenEl=document.getElementById('progressScreen');
    const resultScreenEl=document.getElementById('resultScreen');
    const progLabelEl=document.getElementById('progLabel');
    const progStreamEl=document.getElementById('progStream');
    const genErrBoxEl=document.getElementById('genErrBox');
    const genErrMsgEl=document.getElementById('genErrMsg');
    const changeCardEl=document.getElementById('changeCard');
    const ccChangeNameEl=document.getElementById('ccChangeName');
    const ccLocationEl=document.getElementById('ccLocation');
    const ccBrowseBtnEl=document.getElementById('ccBrowseBtn');
    if(ccBrowseBtnEl){ccBrowseBtnEl.addEventListener('click',function(){vscode.postMessage({type:'browseFolder'});});}
    window.addEventListener('message',function(e){if(e.data&&e.data.type==='folderPicked'&&ccLocationEl)ccLocationEl.value=e.data.path||'';},true);
    const ccSaveBtnEl=document.getElementById('ccSaveBtn');
    const ccSavedBoxEl=document.getElementById('ccSavedBox');
    const ccFolderRelEl=document.getElementById('ccFolderRel');
    const ccRevealBtnEl=document.getElementById('ccRevealBtn');
    const ccErrBoxEl=document.getElementById('ccErrBox');
    const ccCloseBtnEl=document.getElementById('ccCloseBtn');
    const ccSqlDisplayEl=document.getElementById('ccSqlDisplay');
    let currentChange=null;let currentTab='deploy';

    ${CHANGE_CARD_LINT_JS}

    function showScreen(name){
      if(formScreenEl)formScreenEl.style.display=name==='form'?'block':'none';
      if(progressScreenEl)progressScreenEl.style.display=name==='progress'?'block':'none';
      if(resultScreenEl)resultScreenEl.style.display=name==='result'?'block':'none';
    }

    function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
    var SQL_KW=new Set(['SELECT','FROM','WHERE','INSERT','INTO','UPDATE','DELETE','CREATE','ALTER','DROP','TABLE','VIEW','INDEX','SEQUENCE','FUNCTION','PROCEDURE','TRIGGER','SCHEMA','DATABASE','GRANT','REVOKE','ON','TO','WITH','AS','DISTINCT','ALL','IN','IS','NULL','NOT','AND','OR','BETWEEN','LIKE','ORDER','BY','GROUP','HAVING','LIMIT','OFFSET','INNER','LEFT','RIGHT','FULL','OUTER','JOIN','UNION','EXCEPT','INTERSECT','EXISTS','CASE','WHEN','THEN','ELSE','END','BEGIN','COMMIT','ROLLBACK','SET','DEFAULT','PRIMARY','KEY','FOREIGN','REFERENCES','UNIQUE','CHECK','CONSTRAINT','IF','DO','LANGUAGE','RETURNS','RETURN','DECLARE','EXCEPTION','RAISE','PERFORM','EXECUTE','COALESCE','NULLIF','CAST','SERIAL','BIGSERIAL','INTEGER','INT','BIGINT','SMALLINT','TEXT','VARCHAR','CHAR','BOOLEAN','BOOL','FLOAT','NUMERIC','REAL','TIMESTAMP','TIMESTAMPTZ','DATE','TIME','UUID','JSONB','JSON','BYTEA','VOID','REPLACE','VALUES','RETURNING','CONFLICT','NOTHING','OWNED','CYCLE','MINVALUE','MAXVALUE','START','RESTART','INCREMENT','CACHE','TABLESPACE','USAGE','PRIVILEGES','PUBLIC','CURRENT_USER','TYPE','ENUM','USING','ONLY','PARTITION','OWNER','AUTHORIZATION','ROW','ROWS']);
    function highlightSql(sql){
      if(!sql)return '';var r='',i=0,len=sql.length;
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

    function showChangeCard(change){
      currentChange=change;currentTab='deploy';
      _lintMap={deploy:null,verify:null,revert:null};
      renderLint('deploy');
      if(ccChangeNameEl)ccChangeNameEl.textContent=change.changeName||'dmcr_change';
      if(ccSqlDisplayEl)ccSqlDisplayEl.innerHTML=highlightSql(change.deploySql||'');
      if(ccSavedBoxEl)ccSavedBoxEl.style.display='none';
      if(ccErrBoxEl){ccErrBoxEl.style.display='none';ccErrBoxEl.textContent='';}
      if(genErrBoxEl)genErrBoxEl.style.display='none';
      if(changeCardEl)changeCardEl.style.display='';
      document.querySelectorAll('.cc-tab').forEach(function(t){t.classList.toggle('active',t.dataset.tab==='deploy');});
      [['deploy',change.deploySql],['verify',change.verifySql],['revert',change.revertSql]].forEach(function(pair,i){
        setTimeout(function(){vscode.postMessage({type:'lintSql',payload:{id:pair[0],sql:pair[1]||''}});},200+i*120);
      });
      showScreen('result');
    }

    document.addEventListener('click',function(e){
      const tab=e.target.closest&&e.target.closest('.cc-tab');
      if(!tab||!currentChange)return;
      currentTab=tab.dataset.tab;
      document.querySelectorAll('.cc-tab').forEach(function(t){t.classList.toggle('active',t.dataset.tab===currentTab);});
      const sql=currentTab==='deploy'?currentChange.deploySql:currentTab==='verify'?currentChange.verifySql:currentChange.revertSql;
      if(ccSqlDisplayEl)ccSqlDisplayEl.innerHTML=highlightSql(sql||'');
      renderLint(currentTab);
    });

    if(ccSaveBtnEl){ccSaveBtnEl.addEventListener('click',function(){
      if(!currentChange)return;
      ccSaveBtnEl.disabled=true;ccSaveBtnEl.textContent='Saving\u2026';
      const loc=ccLocationEl?ccLocationEl.value.trim():'';
      vscode.postMessage({type:'saveChange',payload:Object.assign({},currentChange,{location:loc})});
    });}
    if(ccRevealBtnEl){ccRevealBtnEl.addEventListener('click',function(){
      const rel=ccFolderRelEl?ccFolderRelEl.textContent:'';
      if(rel)vscode.postMessage({type:'revealFolder',payload:{folderRel:rel}});
    });}
    if(ccCloseBtnEl){ccCloseBtnEl.addEventListener('click',function(){vscode.postMessage({type:'cancel'});});}

    window.addEventListener('message',function(event){
      const msg=event.data;if(!msg)return;
      if(msg.type==='setTheme'){
        document.documentElement.setAttribute('data-theme',msg.isDark?'dark':'light');
        return;
      }
      if(msg.type==='lintResult'){
        var _lKey=msg.payload&&msg.payload.id;updateLint(_lKey,msg.payload.ok,msg.payload.msg||'');
      }else if(msg.type==='showProgress'){
        if(progLabelEl&&msg.payload&&msg.payload.message)progLabelEl.textContent=msg.payload.message;
        showScreen('progress');
      }else if(msg.type==='progressUpdate'){
        if(progLabelEl&&msg.payload&&msg.payload.text)progLabelEl.textContent=msg.payload.text;
      }else if(msg.type==='streamChunk'){
        if(progStreamEl&&msg.payload&&msg.payload.text){
          progStreamEl.classList.add('active');
          progStreamEl.textContent=msg.payload.text.slice(-400);
          progStreamEl.scrollTop=progStreamEl.scrollHeight;
        }
      }else if(msg.type==='generationDone'){
        showChangeCard(msg.payload);
      }else if(msg.type==='generationError'){
        const errPayload=msg.payload||{};
        const errMsg=errPayload.message||'Generation failed.';
        const errStack=errPayload.stack||errMsg;
        const errCode=errPayload.code?' ['+errPayload.code+']':'';
        const errTime=errPayload.timestamp||new Date().toISOString();
        console.error('[DMCR] Generation Error',{message:errMsg,code:errPayload.code,stack:errStack,timestamp:errTime,source:errPayload.source});
        if(genErrMsgEl)genErrMsgEl.textContent=errMsg+errCode;
        const genErrMetaEl2=document.getElementById('genErrMeta');
        if(genErrMetaEl2)genErrMetaEl2.textContent=errTime;
        const genErrStackPreEl2=document.getElementById('genErrStackPre');
        const genErrToggleEl2=document.getElementById('genErrToggle');
        if(genErrStackPreEl2){genErrStackPreEl2.textContent=errStack;}
        if(genErrToggleEl2){genErrToggleEl2.style.display='';genErrToggleEl2.dataset.open='0';}
        if(genErrBoxEl)genErrBoxEl.style.display='';
        if(changeCardEl)changeCardEl.style.display='none';
        clearStatus();
        showScreen('form');
      }else if(msg.type==='saved'){
      }else if(msg.type==='saved'){
        if(ccSaveBtnEl){ccSaveBtnEl.disabled=false;ccSaveBtnEl.textContent='Saved!';}
        if(ccSavedBoxEl)ccSavedBoxEl.style.display='flex';
        if(ccFolderRelEl&&msg.payload)ccFolderRelEl.textContent=msg.payload.folderRel||'';
        if(ccErrBoxEl)ccErrBoxEl.style.display='none';
        if(ccSaveBtnEl){ccSaveBtnEl.textContent='Saved!';ccSaveBtnEl.disabled=true;}
      }else if(msg.type==='saveError'){
        if(ccSaveBtnEl){ccSaveBtnEl.disabled=false;ccSaveBtnEl.textContent='Save to workspace';}
        if(ccErrBoxEl){ccErrBoxEl.style.display='';ccErrBoxEl.textContent=(msg.payload&&msg.payload.msg)||'Save failed.';}
      }else if(msg.type==='formActivated'){
        // Tab re-activated — reset to form screen and hide stale errors.
        var geEl=document.getElementById('genErrBox');if(geEl)geEl.style.display='none';
        showScreen('form');
      }
    });
  const statusEl = document.getElementById("status");
  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.className = "status show" + (kind ? (" " + kind) : "");
  }
  function clearStatus() {
    if (!statusEl) return;
    statusEl.textContent = "";
    statusEl.className = "status";
  }

  window.addEventListener("error", (e) => {
    setStatus("Webview error: " + (e?.message || String(e)), "error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    setStatus("Unhandled promise: " + (e?.reason?.message || String(e?.reason || e)), "error");
  });


  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "value") e.value = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) e.appendChild(c);
    return e;
  }

  function normalizeColName(s) {
    return (s || "").trim();
  }

  const columnsState = [];
  const rowsState = [];

  function addColumn(initial = {}) {
    columnsState.push({
      name: initial.name || "",
      type: initial.type || "int",
      customType: initial.customType || ""
    });
    renderColumns();
    renderGrid();
  }

  function removeColumn(idx) {
    columnsState.splice(idx, 1);
    for (const r of rowsState) {
      const keys = Object.keys(r);
      for (const k of keys) {
        if (!columnsState.find(c => c.name === k)) delete r[k];
      }
    }
    renderColumns();
    renderGrid();
  }

  function addRow(initial = {}) {
    rowsState.push({ ...initial });
    renderGrid();
  }

  function clearRows() {
    rowsState.length = 0;
    renderGrid();
  }

  const typeItems = ${typeItemsJson};
  function getTypeLabel(v) {
    const item = typeItems.find(function(o){return o.value===v;});
    return item ? item.label : v;
  }

  function renderColumns() {
    document.querySelectorAll('.sd-menu.col-type-dd').forEach(function(m){m.remove();});
    const root = document.getElementById("columns");
    root.innerHTML = "";

    columnsState.forEach((c, idx) => {
        const nameInput = el("input", { value: c.name, placeholder: "column_name" });
        nameInput.addEventListener("input", () => {
        c.name = nameInput.value;
        renderGrid();
        });

        const typeWrapperId = 'colTypeWrap' + idx;
        const typeInputId = 'colType' + idx;
        const typeValId = 'colTypeVal' + idx;
        const typeDropWrap = document.createElement('div');
        typeDropWrap.className = 'sd-wrap';
        typeDropWrap.id = typeWrapperId;
        const typeTrigger = document.createElement('button');
        typeTrigger.type = 'button';
        typeTrigger.className = 'sd-trigger';
        const typeValSpan = document.createElement('span');
        typeValSpan.className = 'sd-val';
        typeValSpan.id = typeValId;
        typeValSpan.textContent = getTypeLabel(c.type);
        const typeArrow = document.createElementNS('http://www.w3.org/2000/svg','svg');
        typeArrow.setAttribute('class','sd-arrow'); typeArrow.setAttribute('viewBox','0 0 12 7'); typeArrow.setAttribute('fill','none');
        const typeArrowPath = document.createElementNS('http://www.w3.org/2000/svg','path');
        typeArrowPath.setAttribute('d','M1 1l5 5 5-5'); typeArrowPath.setAttribute('stroke','currentColor'); typeArrowPath.setAttribute('stroke-width','1.5'); typeArrowPath.setAttribute('stroke-linecap','round'); typeArrowPath.setAttribute('stroke-linejoin','round');
        typeArrow.appendChild(typeArrowPath);
        typeTrigger.appendChild(typeValSpan); typeTrigger.appendChild(typeArrow);
        const typeHidden = document.createElement('input');
        typeHidden.type = 'hidden'; typeHidden.id = typeInputId; typeHidden.value = c.type;
        typeDropWrap.appendChild(typeTrigger); typeDropWrap.appendChild(typeHidden);

        const removeBtn = el("button", {
        class: "danger ghost small",
        type: "button",
        text: "Remove",
        });
        removeBtn.addEventListener("click", () => removeColumn(idx));

        const customActive = c.type === "varchar" || c.type === "custom";

        const nameWrap = el("div", { class: "col-field" });
        const nameLabel = el("label", { class: "col-field-label", text: "Column name" });
        nameWrap.append(nameLabel, nameInput);
        const typeWrap = el("div", { class: "col-field" });
        const typeLabel = el("label", { class: "col-field-label", text: "Data type" });
        typeWrap.append(typeLabel, typeDropWrap);
        const children = [nameWrap, typeWrap];

        if (customActive) {
        const customInput = el("input", {
            value: c.customType,
            placeholder:
            c.type === "varchar"
                ? "varchar(n) e.g. varchar(100)"
                : "custom type e.g. numeric(12,2)",
        });
        customInput.addEventListener("input", () => {
            c.customType = customInput.value;
        });
        const customWrap = el("div", { class: "col-field" });
        const customLabel = el("label", { class: "col-field-label", text: "Type detail" });
        customWrap.append(customLabel, customInput);
        children.push(customWrap);
        }

        children.push(removeBtn);

        const rowClass = customActive ? "colRow hasCustom" : "colRow";
        const row = el("div", { class: rowClass }, children);
        root.appendChild(row);
    });
    // init column-type dropdowns after all rows are in DOM
    columnsState.forEach(function(c, idx) {
      const dd = makeStyledDropdown('colTypeWrap' + idx, 'colType' + idx, 'colTypeVal' + idx, typeItems, 'col-type-dd');
      if (dd) {
        const hidden = document.getElementById('colType' + idx);
        if (hidden) {
          hidden.addEventListener('change', function() {
            columnsState[idx].type = hidden.value;
            renderColumns();
            renderGrid();
          });
        }
      }
    });
  }

  function formatTimestampForSql(value) {
    if (!value) return null;
    return value.replace("T", " ") + (value.length === 16 ? ":00" : "");
  }

  function buildCellEditor(col, currentValue, onChange) {
    const wrap = el("div", { class: "cellWrap" });

    let input;

    if (col.type === "int" || col.type === "bigint" || col.type === "numeric") {
      input = el("input", { type: "number", value: currentValue ?? "" });
      if (col.type === "int" || col.type === "bigint") input.step = "1";
      input.addEventListener("input", () => onChange(input.value === "" ? null : input.value));
    } else if (col.type === "boolean") {
      input = el("select", {});
      input.innerHTML = '<option value="">NULL</option><option value="true">true</option><option value="false">false</option>';
      input.value = currentValue === true ? "true" : currentValue === false ? "false" : "";
      input.addEventListener("change", () => {
        if (input.value === "") onChange(null);
        else onChange(input.value === "true");
      });
    } else if (col.type === "date") {
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
    } else if (col.type === "interval") {
      input = el("input", { type: "text", value: currentValue ?? "", placeholder: "H:MM:SS (e.g. 0:29:13)" });
      input.addEventListener("input", () => onChange(input.value || null));
    } else {
      input = el("input", { type: "text", value: currentValue ?? "" });
      input.addEventListener("input", () => onChange(input.value === "" ? null : input.value));
    }

    wrap.appendChild(input);
    return wrap;
  }

  function renderGrid() {
    // Remove stale popup elements from previous renders to prevent DOM leak and stale listeners
    document.querySelectorAll('.dtpk-pop').forEach(p => p.remove());

    const header = document.getElementById("rowHeader");
    const body = document.getElementById("rowBody");
    header.innerHTML = "";
    body.innerHTML = "";

    const cols = columnsState
      .map(c => ({ name: normalizeColName(c.name), type: c.type, customType: c.customType }))
      .filter(c => c.name);

    header.appendChild(el("th", { text: "#" }));
    cols.forEach(c => header.appendChild(el("th", { text: c.name })));
    header.appendChild(el("th", { text: "" }));

    rowsState.forEach((row, idx) => {
      const tr = document.createElement("tr");
      const numTd = el("td", { text: String(idx + 1) });
      numTd.style.cssText = 'width:32px;text-align:center;color:var(--text2);font-size:11.5px;font-weight:600;';
      tr.appendChild(numTd);

      cols.forEach(col => {
        const td = document.createElement("td");
        const current = row[col.name] ?? null;

        const editor = buildCellEditor(col, current, (v) => {
          row[col.name] = v;
        });

        td.appendChild(editor);
        tr.appendChild(td);
      });

      const tdActions = document.createElement("td");
      tdActions.className = "actionsCell";

      const delBtn = el("button", { class: "danger small", type: "button", text: "? Remove" });
      delBtn.addEventListener("click", () => {
        rowsState.splice(idx, 1);
        renderGrid();
      });

      tdActions.appendChild(delBtn);
      tr.appendChild(tdActions);

      body.appendChild(tr);
    });
  }

  function buildPayload() {
    const table = (document.getElementById("tableName").value || "").trim();

    const columns = columnsState
      .map(c => ({
        name: normalizeColName(c.name),
        type: c.type,
        customType: (c.customType || "").trim()
      }))
      .filter(c => c.name);

    const rows = rowsState.map(r => {
      const out = {};
      for (const c of columns) {
        const v = r[c.name];
        if (v === undefined) out[c.name] = null;
        else if (v === null) out[c.name] = null;
        else if (c.type === "timestamp" || c.type === "timestamptz") out[c.name] = formatTimestampForSql(String(v));
        else out[c.name] = v;
      }
      return out;
    });

    const idempotent = !!document.getElementById("idempotentChk").checked;
    const conflictTarget = (document.getElementById("conflictTarget").value || "").trim();
    const conflictAction = document.getElementById("conflictAction").value;
    const conflictUpdateCols = (document.getElementById("conflictUpdateCols").value || "").trim();
    const changeNameHint = (document.getElementById("changeNameHint")?.value || "").trim();

    return { table, columns, rows, idempotent, conflictTarget, conflictAction, conflictUpdateCols, changeNameHint };
  }

  function validate(p) {
    if (!p.table) return "Enter a target table (schema.table).";
    if (!p.columns.length) return "Add at least one column.";
    for (const c of p.columns) {
      const t = (c.type === "custom" || c.type === "varchar") ? (c.customType || "").trim() : c.type;
      if (!t) return "Every column must have a type (or custom type).";
    }
    if (!p.rows.length) return "Add at least one data row.";
    return null;
  }

  document.getElementById("addColBtn").addEventListener("click", () => addColumn({}));
  document.getElementById("addRowBtn").addEventListener("click", () => addRow({}));
  document.getElementById("clearRowsBtn").addEventListener("click", () => clearRows());
  document.getElementById("cancelBtn").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));

  document.getElementById("generateBtn").addEventListener("click", () => {
    clearStatus();

    let p;
    try {
      p = buildPayload();
    } catch (e) {
      setStatus("Failed to build payload: " + (e?.message || String(e)), "error");
      return;
    }

    const err = validate(p);
    if (err) {
      setStatus(err, "error");
      return;
    }

    setStatus("Submitting request\u2026", "ok");
    vscode.postMessage({ type: "submit", payload: p });
  });

  document.getElementById("loadExampleBtn").addEventListener("click", () => {
    document.getElementById("tableName").value = "public.wfm_chat_metrics";
    columnsState.length = 0;
    rowsState.length = 0;

    addColumn({ name: "timestamp", type: "timestamp" });
    addColumn({ name: "chats_in_queue", type: "int" });
    addColumn({ name: "trending_percent_of_abandons", type: "int" });
    addColumn({ name: "longest_wait_time", type: "interval" });
    addColumn({ name: "average_time_in_queue", type: "interval" });
    addColumn({ name: "trending_avg", type: "interval" });
    addColumn({ name: "active_chats", type: "int" });

    addRow({
      "timestamp": "2025-11-07T10:00:00",
      "chats_in_queue": 41,
      "trending_percent_of_abandons": 8,
      "longest_wait_time": "0:29:13",
      "average_time_in_queue": "0:09:31",
      "trending_avg": "0:04:20",
      "active_chats": 91
    });
  });

  // init conflictAction dropdown
  makeStyledDropdown('conflictActionWrap', 'conflictAction', 'conflictActionVal', [
    { value: 'do_nothing', label: 'ON CONFLICT DO NOTHING' },
    { value: 'update', label: 'ON CONFLICT DO UPDATE' },
  ]);

  // -- init columns/rows after dtpk is defined (below) --

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
      const clrBtn   = h('button', { class: 'dtpk-clr', type: 'button', text: '\u00D7' });
      const trigger  = h('button', { class: 'dtpk-trigger', type: 'button' },
                         calIco(), valSpan, clrBtn);

      // ── Build the popover ──
      const pop = h('div', { class: 'dtpk-pop' });

      // ── Calendar pane ──
      const monthLbl = h('span', { class: 'dtpk-month-lbl' });
      const prevBtn  = h('button', { class: 'dtpk-nav', type: 'button', text: '\u2039' });
      const nextBtn  = h('button', { class: 'dtpk-nav', type: 'button', text: '\u203A' });
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
        if (!pop.isConnected) return; // picker was removed from DOM (stale after renderGrid)
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
      if (mode === 'date')     return 'Select date\u2026';
      if (mode === 'time')     return 'Select time\u2026';
      return 'Select date & time\u2026';
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

  // ── Default columns and one empty row (dtpk is now defined above) ──
  addColumn({ name: "timestamp", type: "timestamp" });
  addColumn({ name: "chats_in_queue", type: "int" });
  addRow({});
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
export function getInsertRowsFormHtml(n: string): string { return getHtml(n); }
/** Inline iframe form: compute normalised LLM request from submit payload */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildInsertRowsNormalizedRequest(payload: any): string { return buildNormalizedRequest(payload as SubmitMessage['payload']); }