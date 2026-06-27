import * as vscode from "vscode";
import { buildAddColumnsPrompt } from "../../llm/prompts/prompt-template";
import { CHANGE_CARD_CSS, CHANGE_CARD_HTML, CHANGE_CARD_HTML_INNER, CHANGE_CARD_LINT_JS } from "./change-card-template";

type ColumnSpec = { name: string; type: string };
type TableSpec = { table: string; columns: ColumnSpec[] };

type TableAction = "alter" | "create" | "sequence" | "grant-tables" | "grant-sequences" | "create-schema";

type SubmitMessage = {
  type: "submit";
  payload: {
    tableAction: TableAction;
    defaultSchema: string;
    changeNameHint: string;

    tables: TableSpec[];
    sameColumnsForAllTables: boolean;

    tableGrantEnabled: boolean;
    tableGrantRole: string;
    tableGrantPrivs: Array<"SELECT" | "INSERT" | "UPDATE" | "DELETE">;

    schemaEnabled: boolean;
    schemaName: string;
    schemaGrantEnabled: boolean;
    schemaGrantRole: string;
    schemaGrantPrivs: Array<"USAGE" | "CREATE">;

    sequenceEnabled: boolean;
    sequenceName: string;
    sequenceStartWith: string;
    sequenceIncrementBy: string;
    sequenceMinValue: string;
    sequenceMaxValue: string;
    sequenceCache: string;

    sequenceGrantEnabled: boolean;
    sequenceGrantRole: string;
    sequenceGrantPrivs: Array<"USAGE" | "SELECT" | "UPDATE">;
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

function uniqUpper(list: string[]) {
  const set = new Set<string>();
  for (const x of list) {
    const v = String(x || "").trim().toUpperCase();
    if (v) set.add(v);
  }
  return [...set];
}

function buildNormalizedRequest(p: SubmitMessage["payload"]): string {
  const tableAction: TableAction = p.tableAction ?? "alter";
  const sequenceOnly = tableAction === "sequence";
  const grantTablesOnly = tableAction === "grant-tables";
  const grantSeqOnly = tableAction === "grant-sequences";
  const createSchemaOnly = tableAction === "create-schema";

  const normalizeSchema = (s: string) => {
    const trimmed = String(s ?? "").trim();
    if (!trimmed) return "";
    return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  };
  const defaultSchema = normalizeSchema(p.defaultSchema ?? "");
  const qualify = (name: string) => {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) return "";
    if (!defaultSchema) return trimmed;
    if (trimmed.includes(".")) return trimmed;
    return `${defaultSchema}.${trimmed}`;
  };

  // For grant-tables, tables don't need columns
  const cleanTables = (p.tables ?? [])
    .map(t => ({
      table: qualify((t.table ?? "").trim()),
      columns: (t.columns ?? [])
        .map(c => ({ name: (c.name ?? "").trim(), type: (c.type ?? "").trim() }))
        .filter(c => c.name && c.type),
    }))
    .filter(t => t.table && (grantTablesOnly || t.columns.length > 0));

  const seqNameRaw = (p.sequenceName ?? "").trim();

  return buildAddColumnsPrompt({
    tableAction,
    cleanTables,
    changeNameHint: (p.changeNameHint ?? "").trim(),
    tableGrantEnabled: !!(grantTablesOnly || p.tableGrantEnabled),
    tableGrantRole: (p.tableGrantRole ?? "").trim(),
    tableGrantPrivs: uniqUpper(p.tableGrantPrivs ?? []),
    schemaEnabled: !!(createSchemaOnly || p.schemaEnabled),
    schemaName: (p.schemaName ?? "").trim(),
    schemaGrantEnabled: !!p.schemaGrantEnabled,
    schemaGrantRole: (p.schemaGrantRole ?? "").trim(),
    schemaGrantPrivs: uniqUpper(p.schemaGrantPrivs ?? []),
    sequenceEnabled: !!(sequenceOnly || grantSeqOnly || p.sequenceEnabled),
    seqName: seqNameRaw ? qualify(seqNameRaw) : "",
    startWith: (p.sequenceStartWith ?? "").trim(),
    incBy: (p.sequenceIncrementBy ?? "").trim(),
    minVal: (p.sequenceMinValue ?? "").trim(),
    maxVal: (p.sequenceMaxValue ?? "").trim(),
    cache: (p.sequenceCache ?? "").trim(),
    seqGrantEnabled: !!(grantSeqOnly || p.sequenceGrantEnabled),
    seqGrantRole: (p.sequenceGrantRole ?? "").trim(),
    seqGrantPrivs: uniqUpper(p.sequenceGrantPrivs ?? []),
  });
}

export async function openAddColumnsForm(opts: { extensionUri: vscode.Uri; title?: string }): Promise<{ normalizedRequest: string; panel: vscode.WebviewPanel } | null> {
  const panel = vscode.window.createWebviewPanel(
    "dmcrAddColumnsForm",
    opts.title ?? "DMCR: Schema Builder (PostgreSQL)",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
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
        // Only clean up disposables on cancel/close, not on submit (panel stays open)
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
          // Show progress screen in the form panel, keep it open
          panel.webview.postMessage({ type: "showProgress", payload: { message: "Agent is thinking\u2026" } });
          safeResolve({ normalizedRequest: normalized, panel });
        }
      })
    );
  });
}

function getHtml(n: string): string {
  const commonTypes = [
    "varchar(100)",
    "varchar(255)",
    "text",
    "date",
    "timestamp",
    "timestamptz",
    "boolean",
    "int",
    "bigint",
    "decimal",
    "decimal(12,2)",
    "decimal(5,3)",
    "numeric",
    "numeric(12,2)",
    "uuid",
    "jsonb",
  ];

  const optionsHtml = [
    ...commonTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`),
    `<option value="__custom__">custom…</option>`,
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DMCR Schema Builder</title>

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
    .wrap { width: 100%; margin: 0 auto; }

    /* -- headings -- */
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

    /* -- card / panel -- */
    .card {
      border: 1px solid var(--border);
      background: var(--bg2);
      border-radius: 12px;
      padding: 14px 16px;
      margin: 10px 0;
      box-shadow: 0 4px 16px rgba(0,0,0,0.22);
    }
    .mini { font-size: 12px; color: var(--text2); }

    /* -- inputs / textarea -- */
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

    /* -- field wrapper -- */
    .field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .field > label {
      font-size: 11.5px; font-weight: 600; color: var(--text2); letter-spacing: 0.01em;
    }

    /* -- buttons -- */
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

    /* -- custom checkbox (ck8t bs-check style) -- */
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

    /* -- check-row card (ck8t bs-check-row style) -- */
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

    /* -- inline checkbox row -- */
    .checkbox-row {
      display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-top: 10px;
    }
    .checkbox-row label { display: inline-flex; gap: 8px; align-items: center; cursor: pointer; font-size: 12.5px; }

    /* -- pill / badge -- */
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

    /* -- warning banner -- */
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

    /* -- status block -- */
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
    .sd-menu {
      position: fixed; z-index: 9999; min-width: 200px;
      background: #1e2535; border: 1px solid rgba(99,102,241,0.25);
      border-radius: 10px; padding: 4px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.55); display: none;
      max-height: 260px; overflow-y: auto;
    }
    .sd-menu.open { display: block; }
    .sd-item { padding: 7px 12px; border-radius: 6px; font-size: 12.5px; color: var(--text2); cursor: pointer; transition: all 100ms; }
    .sd-item:hover { background: rgba(99,102,241,0.12); color: var(--text); }
    .sd-item.selected { background: rgba(99,102,241,0.18); color: #c7d2fe; }

    /* -- Progress screen -- */
    .screen-progress {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 40px 20px; gap: 24px; text-align: center; min-height: 80vh;
    }
    .prog-icon {
      width: 56px; height: 56px; border-radius: 50%;
      background: rgba(99,102,241,0.12); border: 2px solid rgba(99,102,241,0.30);
      display: flex; align-items: center; justify-content: center;
      animation: progpulse 2s ease-in-out infinite;
    }
    @keyframes progpulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.1);opacity:.75} }
    .prog-bar { width: 280px; height: 3px; background: rgba(255,255,255,0.07); border-radius: 2px; overflow: hidden; position: relative; }
    .prog-bar::after {
      content: ''; position: absolute; top: 0; height: 100%; width: 55%;
      background: linear-gradient(90deg, transparent 0%, #6366f1 50%, transparent 100%);
      animation: progsweep 1.8s linear infinite;
    }
    @keyframes progsweep { 0%{left:-55%} 100%{left:110%} }
    .prog-label { font-size: 14px; color: var(--text2); font-weight: 500; }
    .prog-stream { width: 100%; max-width: 560px; max-height: 110px; overflow: hidden; font-family: ui-monospace,Consolas,monospace; font-size: 10.5px; color: rgba(148,163,184,0.65); background: rgba(0,0,0,0.18); border: 1px solid rgba(99,102,241,0.15); border-radius: 6px; padding: 7px 10px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; display: none; }
    .prog-stream.active { display: block; }
    ${CHANGE_CARD_CSS}

    /* -- table grid -- */
    .grid { overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
    table { width: 100%; border-collapse: collapse; min-width: 720px; }
    th, td {
      border-bottom: 1px solid var(--border); padding: 9px 10px; vertical-align: top; text-align: left;
    }
    th { font-size: 11.5px; font-weight: 600; color: var(--text2); background: rgba(255,255,255,0.02); }
    tr:last-child td { border-bottom: none; }

    /* -- layout helpers -- */
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

    /* -- code textarea -- */
    textarea.code {
      font-family: ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
      font-size: 12.5px; line-height: 1.5; tab-size: 2; min-height: 120px;
    }

    /* -- lint / validate button -- */
    button.validateBtn {
      padding: 3px 10px; min-height: 26px; border-radius: 999px; font-size: 11.5px; font-weight: 700;
    }
    button.validateBtn.ok { color: var(--green); border-color: rgba(74,222,128,0.35); background: rgba(74,222,128,0.08); }
    button.validateBtn.err { color: var(--red); border-color: rgba(248,113,113,0.35); background: rgba(248,113,113,0.08); }

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
    <h2>
      Schema Builder
      <span class="badge ddl">DDL</span>
      <span class="pill">PostgreSQL</span>
    </h2>

    <div class="hint mini">
        Default schema auto-qualifies table/sequence names (if you don't type schema.). If 'Create schema' is enabled and schema name is blank, it auto-fills from Default schema.
    </div>
    <div class="banner" role="note" aria-label="Tip">
      <div class="bannerTitle">Heads up</div>
      <div class="bannerText">
        Use <b>ALTER TABLE</b> to add columns safely (nullable first). Use <b>CREATE SEQUENCE</b> mode when you only need a sequence.
      </div>
    </div>

    <div class="card">
        <div class="section-title">Mode</div>

        <div class="row" style="grid-template-columns: 1fr 1fr;">
        <div class="field">
            <label>Action</label>
            <div class="sd-wrap" id="tableActionWrap">
              <button type="button" class="sd-trigger" id="tableActionTrigger">
                <span class="sd-val" id="tableActionVal">CREATE TABLE</span>
                <svg class="sd-arrow" viewBox="0 0 12 7" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <input type="hidden" id="tableAction" value="create" />
            </div>
        </div>

        <div class="field">
            <label>Default schema (optional)</label>
            <input id="defaultSchema" placeholder="e.g. wfm_st" />
        </div>
        <div class="field">
            <label>Change name hint (optional)</label>
            <input id="changeNameHint" placeholder="e.g. add_threshold_level_cols" />
        </div>
        </div>

        <div id="tablesArea">

        <div id="grantTablesObjArea" style="display:none;">
          <div class="field">
            <label>Table name(s) to grant on</label>
            <textarea id="grantTableNames" rows="3" placeholder="e.g. wfm_st.employee&#10;wfm_st.shift&#10;(one per line or comma-separated)"></textarea>
          </div>
        </div>

        <div id="tableDefsOnlyArea">
        <div class="setting-card">
            <input type="checkbox" class="bs-check" id="sameColsChk" checked />
            <div>
            <div class="title">Use same columns for all tables</div>
            <div class="desc">Copies columns from the first table; disables other column editors.</div>
            </div>
        </div>

        <div class="top-actions">
            <button class="secondary" id="addTableBtn" type="button">&#x2B; Add table</button>
            <button class="secondary" id="duplicateLastTableBtn" type="button">&#x2398; Duplicate last table</button>
        </div>

        <div id="tables"></div>
        </div>

        <div class="setting-card" id="tableGrantArea">
            <input type="checkbox" class="bs-check" id="tableGrantEnabled" />
            <div>
            <div class="title">Add GRANTs for tables</div>
            <div class="desc">Generates: GRANT SELECT/INSERT/UPDATE/DELETE ON schema.table TO role;</div>

            <div class="row" style="grid-template-columns: 1fr;">
                <div class="field">
                <label>Role</label>
                <input id="tableGrantRole" placeholder="e.g. zp_st" />
                </div>
            </div>

            <div class="checkbox-row">
                <label><input type="checkbox" class="bs-check" id="tPrivSelect" /> SELECT</label>
                <label><input type="checkbox" class="bs-check" id="tPrivInsert" /> INSERT</label>
                <label><input type="checkbox" class="bs-check" id="tPrivUpdate" /> UPDATE</label>
                <label><input type="checkbox" class="bs-check" id="tPrivDelete" /> DELETE</label>
            </div>
            </div>
        </div>
        </div>
    </div>

    <div class="card" id="schemaCard">
        <div class="section-title">Schema</div>

        <div class="setting-card">
        <input type="checkbox" class="bs-check" id="schemaEnabled" />
        <div>
            <div class="title">Create schema</div>
            <div class="desc">Generates: CREATE SCHEMA IF NOT EXISTS schema_name;</div>

            <div class="row" style="grid-template-columns: 1fr;">
            <div class="field">
                <label>Schema name</label>
                <input id="schemaName" placeholder="e.g. wfm_st" />
            </div>
            </div>

            <div class="setting-card" style="margin-top: 10px;">
            <input type="checkbox" class="bs-check" id="schemaGrantEnabled" />
            <div>
                <div class="title">Add GRANTs for schema</div>
                <div class="desc">Generates: GRANT USAGE/CREATE ON SCHEMA schema_name TO role;</div>

                <div class="row" style="grid-template-columns: 1fr;">
                <div class="field">
                    <label>Role</label>
                    <input id="schemaGrantRole" placeholder="e.g. zp_st" />
                </div>
                </div>

                <div class="checkbox-row">
                <label><input type="checkbox" class="bs-check" id="sPrivUsage" /> USAGE</label>
                <label><input type="checkbox" class="bs-check" id="sPrivCreate" /> CREATE</label>
                </div>
            </div>
            </div>

        </div>
        </div>
    </div>

    <div class="card" id="sequenceCard">
        <div class="section-title">Sequence</div>

        <div id="seqCreationArea">
        <div class="seqTop">
        <div class="setting-card" style="margin: 0;">
            <input type="checkbox" class="bs-check" id="sequenceEnabled" />
            <div>
            <div class="title">Create sequence</div>
            <div class="desc">Generates CREATE SEQUENCE ... START/INCREMENT/MIN/MAX/CACHE.</div>
            </div>
        </div>

        <div class="seqActions">
            <button class="secondary" id="loadSeqExampleBtn" type="button">&#x1F4CB; Load example</button>
        </div>
        </div>

        <div class="seqParamsGrid">
        <div class="field">
            <label>Sequence name</label>
            <input id="sequenceName" placeholder="e.g. seq_wfm_ahod_threshold_level" />
        </div>

        <div class="field">
            <label>CACHE</label>
            <input id="sequenceCache" placeholder="default 1" />
        </div>

        <div class="field">
            <label>START WITH</label>
            <input id="sequenceStartWith" placeholder="default 1" />
        </div>

        <div class="field">
            <label>INCREMENT BY</label>
            <input id="sequenceIncrementBy" placeholder="default 1" />
        </div>

        <div class="field">
            <label>MINVALUE</label>
            <input id="sequenceMinValue" placeholder="blank = NO MINVALUE" />
        </div>

        <div class="field">
            <label>MAXVALUE</label>
            <input id="sequenceMaxValue" placeholder="blank = NO MAXVALUE" />
        </div>
        </div>
        </div>

        <div class="setting-card" id="seqGrantArea">
        <input type="checkbox" class="bs-check" id="sequenceGrantEnabled" />
        <div>
            <div class="title">Add GRANTs for sequence</div>
            <div class="desc">Generates: GRANT USAGE/SELECT/UPDATE ON SEQUENCE seq_name TO role;</div>

            <div id="grantSeqNameArea" style="display:none;">
            <div class="row" style="grid-template-columns: 1fr;">
              <div class="field">
                <label>Sequence name to grant on</label>
                <input id="grantSeqName" placeholder="e.g. wfm_st.seq_employee_id" />
              </div>
            </div>
            </div>

            <div class="row" style="grid-template-columns: 1fr;">
            <div class="field">
                <label>Role</label>
                <input id="sequenceGrantRole" placeholder="e.g. zp_st" />
            </div>
            </div>

            <div class="checkbox-row">
            <label><input type="checkbox" class="bs-check" id="qPrivUsage" /> USAGE</label>
            <label><input type="checkbox" class="bs-check" id="qPrivSelect" /> SELECT</label>
            <label><input type="checkbox" class="bs-check" id="qPrivUpdate" /> UPDATE</label>
            </div>
        </div>
        </div>
    </div>

    <div class="actions">
        <button class="primary" id="generateBtn" type="button">&#x1FA84; Generate DMCR request</button>
        <button class="secondary" id="cancelBtn" type="button">&#x2715; Cancel</button>
    </div>
    <div id="status" class="status" aria-live="polite"></div>
  </div>


</div><!-- #formScreen -->

<div id="progressScreen" style="display:none;">
  <div class="wrap screen-progress">
    <div class="prog-icon">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
      </svg>
    </div>
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
    // -- Custom styled dropdown helper --
    function makeStyledDropdown(wrapperId, inputId, valId, items) {
      const wrap = document.getElementById(wrapperId);
      const hidden = document.getElementById(inputId);
      const valEl = document.getElementById(valId);
      if (!wrap || !hidden || !valEl) return;

      const trigger = wrap.querySelector('.sd-trigger');
      if (!trigger) return;
      const menu = document.createElement('div');
      menu.className = 'sd-menu';
      document.body.appendChild(menu);

      function setVal(v) {
        const opt = items.find(function(o) { return o.value === v; });
        hidden.value = v;
        valEl.textContent = opt ? opt.label : v;
        menu.querySelectorAll('.sd-item').forEach(function(el) {
          el.classList.toggle('selected', el.dataset.value === v);
        });
        hidden.dispatchEvent(new Event('change'));
      }

      items.forEach(function(item) {
        const div = document.createElement('div');
        div.className = 'sd-item';
        div.dataset.value = item.value;
        div.textContent = item.label;
        div.addEventListener('click', function() { setVal(item.value); close(); });
        menu.appendChild(div);
      });

      function position() {
        const r = trigger.getBoundingClientRect();
        const menuH = Math.min(menu.scrollHeight || 260, 260);
        const spaceBelow = window.innerHeight - r.bottom;
        const goUp = spaceBelow < menuH + 8 && r.top > menuH + 8;
        menu.style.top = (goUp ? r.top - menuH - 4 : r.bottom + 4) + 'px';
        menu.style.left = r.left + 'px';
        menu.style.minWidth = r.width + 'px';
      }
      function open() {
        document.querySelectorAll('.sd-menu.open').forEach(function(m) { m.classList.remove('open'); });
        document.querySelectorAll('.sd-trigger.open').forEach(function(t) { t.classList.remove('open'); });
        trigger.classList.add('open');
        menu.classList.add('open');
        position();
        document.addEventListener('scroll', onScroll, true);
      }
      function close() {
        trigger.classList.remove('open');
        menu.classList.remove('open');
        document.removeEventListener('scroll', onScroll, true);
      }
      function onScroll() { position(); }
      trigger.addEventListener('click', function() {
        if (trigger.classList.contains('open')) close(); else open();
      });
      document.addEventListener('mousedown', function(e) {
        if (!trigger.contains(e.target) && !menu.contains(e.target)) close();
      });
      // Initialize display
      setVal(hidden.value || items[0].value);
      return { setValue: setVal, getValue: function() { return hidden.value; } };
    }

    // Init the tableAction dropdown
    const tableActionDropdown = makeStyledDropdown('tableActionWrap', 'tableAction', 'tableActionVal', [
      { value: 'create', label: 'CREATE TABLE' },
      { value: 'alter', label: 'ALTER TABLE \u2014 add columns' },
      { value: 'sequence', label: 'CREATE SEQUENCE' },
      { value: 'grant-tables', label: 'GRANT \u2014 table privileges' },
      { value: 'grant-sequences', label: 'GRANT \u2014 sequence privileges' },
      { value: 'create-schema', label: 'CREATE SCHEMA' },
    ]);

    // -- Screen switching --
    const formScreenEl = document.getElementById('formScreen');
    const progressScreenEl = document.getElementById('progressScreen');
    const resultScreenEl = document.getElementById('resultScreen');
    const progLabelEl = document.getElementById('progLabel');
    const progStreamEl = document.getElementById('progStream');
    const ccBrowseBtnEl = document.getElementById('ccBrowseBtn');
    if (ccBrowseBtnEl) {
      ccBrowseBtnEl.addEventListener('click', function() {
        vscode.postMessage({ type: 'browseFolder' });
      });
    }
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'folderPicked' && ccLocationEl) {
        ccLocationEl.value = e.data.path || '';
      }
    }, true);
    const genErrBoxEl = document.getElementById('genErrBox');
    const genErrMsgEl = document.getElementById('genErrMsg');
    const changeCardEl = document.getElementById('changeCard');
    const ccChangeNameEl = document.getElementById('ccChangeName');
    const ccLocationEl = document.getElementById('ccLocation');
    const ccSaveBtnEl = document.getElementById('ccSaveBtn');
    const ccSavedBoxEl = document.getElementById('ccSavedBox');
    const ccFolderRelEl = document.getElementById('ccFolderRel');
    const ccRevealBtnEl = document.getElementById('ccRevealBtn');
    const ccErrBoxEl = document.getElementById('ccErrBox');
    const ccCloseBtnEl = document.getElementById('ccCloseBtn');
    const ccSqlDisplayEl = document.getElementById('ccSqlDisplay');

    let currentChange = null;
    let currentTab = 'deploy';

    ${CHANGE_CARD_LINT_JS}

    function showScreen(name) {
      if (formScreenEl) formScreenEl.style.display = name === 'form' ? 'block' : 'none';
      if (progressScreenEl) progressScreenEl.style.display = name === 'progress' ? 'block' : 'none';
      if (resultScreenEl) resultScreenEl.style.display = name === 'result' ? 'flex' : 'none';
    }

    function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    var SQL_KW = new Set(['SELECT','FROM','WHERE','INSERT','INTO','UPDATE','DELETE','CREATE','ALTER','DROP','TABLE','VIEW','INDEX','SEQUENCE','FUNCTION','PROCEDURE','TRIGGER','SCHEMA','DATABASE','GRANT','REVOKE','ON','TO','WITH','AS','DISTINCT','ALL','IN','IS','NULL','NOT','AND','OR','BETWEEN','LIKE','ORDER','BY','GROUP','HAVING','LIMIT','OFFSET','INNER','LEFT','RIGHT','FULL','OUTER','JOIN','UNION','EXCEPT','INTERSECT','EXISTS','CASE','WHEN','THEN','ELSE','END','BEGIN','COMMIT','ROLLBACK','SET','DEFAULT','PRIMARY','KEY','FOREIGN','REFERENCES','UNIQUE','CHECK','CONSTRAINT','IF','DO','LANGUAGE','RETURNS','RETURN','DECLARE','EXCEPTION','RAISE','PERFORM','EXECUTE','COALESCE','NULLIF','CAST','SERIAL','BIGSERIAL','INTEGER','INT','BIGINT','SMALLINT','TEXT','VARCHAR','CHAR','BOOLEAN','BOOL','FLOAT','NUMERIC','REAL','TIMESTAMP','TIMESTAMPTZ','DATE','TIME','UUID','JSONB','JSON','BYTEA','VOID','REPLACE','VALUES','RETURNING','CONFLICT','NOTHING','OWNED','CYCLE','MINVALUE','MAXVALUE','START','RESTART','INCREMENT','CACHE','TABLESPACE','USAGE','PRIVILEGES','PUBLIC','CURRENT_USER','TYPE','ENUM','USING','ONLY','PARTITION','OWNER','AUTHORIZATION','ROW','ROWS']);
    function highlightSql(sql) {
      if (!sql) return '';
      var r='',i=0,len=sql.length;
      while(i<len){
        if(sql[i]==='-'&&i+1<len&&sql[i+1]==='-'){var j=i;while(j<len&&sql.charCodeAt(j)!==10)j++;r+='<span style="color:#64748b;font-style:italic">'+escHtml(sql.slice(i,j))+'</span>';i=j;continue;}
        if(sql[i]==='/'&&i+1<len&&sql[i+1]==='*'){var e2=sql.indexOf('*/',i+2);var cm=e2===-1?sql.slice(i):sql.slice(i,e2+2);r+='<span style="color:#64748b;font-style:italic">'+escHtml(cm)+'</span>';i=e2===-1?len:e2+2;continue;}
        if(sql[i]==='$'){var dm=sql.slice(i).match(/^\\$([^$]*)\\$/);if(dm){var dtag=dm[0];var de=sql.indexOf(dtag,i+dtag.length);if(de!==-1){r+='<span style="color:#86efac">'+escHtml(sql.slice(i,de+dtag.length))+'</span>';i=de+dtag.length;continue;}}}
        if(sql[i]==="'"){var k=i+1;while(k<len){if(sql[k]==="'"&&k+1<len&&sql[k+1]==="'"){k+=2;continue;}if(sql[k]==="'"){k++;break;}k++;}r+='<span style="color:#86efac">'+escHtml(sql.slice(i,k))+'</span>';i=k;continue;}
        if(sql[i]=='"'){var qi=i+1;while(qi<len&&sql[qi]!='"')qi++;if(qi<len)qi++;r+='<span style="color:#93c5fd">'+escHtml(sql.slice(i,qi))+'</span>';i=qi;continue;}
        if(/[0-9]/.test(sql[i])&&(i===0||/[\\s\\W]/.test(sql[i-1]))){var ni=i;while(ni<len&&/[0-9._eE]/.test(sql[ni]))ni++;r+='<span style="color:#fb923c">'+escHtml(sql.slice(i,ni))+'</span>';i=ni;continue;}
        if(/[a-zA-Z_]/.test(sql[i])){var wi=i;while(wi<len&&/[a-zA-Z0-9_]/.test(sql[wi]))wi++;var w=sql.slice(i,wi);r+=SQL_KW.has(w.toUpperCase())?'<span style="color:#818cf8;font-weight:600">'+escHtml(w)+'</span>':escHtml(w);i=wi;continue;}
        r+=escHtml(sql[i]);i++;
      }
      return r;
    }

    function showChangeCard(change) {
      currentChange = change;
      currentTab = 'deploy';
      _lintMap = { deploy: null, verify: null, revert: null };
      renderLint('deploy');
      if (ccChangeNameEl) ccChangeNameEl.textContent = change.changeName || 'dmcr_change';
      if (ccSqlDisplayEl) ccSqlDisplayEl.innerHTML = highlightSql(change.deploySql || '');
      if (ccSavedBoxEl) ccSavedBoxEl.style.display = 'none';
      if (ccErrBoxEl) { ccErrBoxEl.style.display = 'none'; ccErrBoxEl.textContent = ''; }
      if (genErrBoxEl) genErrBoxEl.style.display = 'none';
      if (changeCardEl) changeCardEl.style.display = '';
      // Reset tabs
      document.querySelectorAll('.cc-tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === 'deploy');
      });
      // Kick off lint for all 3 tabs
      [['deploy', change.deploySql], ['verify', change.verifySql], ['revert', change.revertSql]].forEach(function(pair, i) {
        setTimeout(function() { vscode.postMessage({ type: 'lintSql', payload: { id: pair[0], sql: pair[1] || '' } }); }, 200 + i * 120);
      });
      showScreen('result');
    }

    // Tab switching
    document.addEventListener('click', function(e) {
      const tab = e.target.closest && e.target.closest('.cc-tab');
      if (!tab || !currentChange) return;
      currentTab = tab.dataset.tab;
      document.querySelectorAll('.cc-tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === currentTab);
      });
      const sql = currentTab === 'deploy' ? currentChange.deploySql
                : currentTab === 'verify' ? currentChange.verifySql
                : currentChange.revertSql;
      if (ccSqlDisplayEl) ccSqlDisplayEl.innerHTML = highlightSql(sql || '');
      renderLint(currentTab);
    });

    // Save button
    if (ccSaveBtnEl) {
      ccSaveBtnEl.addEventListener('click', function() {
        if (!currentChange) return;
        ccSaveBtnEl.disabled = true;
        ccSaveBtnEl.textContent = 'Saving\u2026';
        const loc = ccLocationEl ? ccLocationEl.value.trim() : '';
        vscode.postMessage({ type: 'saveChange', payload: Object.assign({}, currentChange, { location: loc }) });
      });
    }

    // Reveal button
    if (ccRevealBtnEl) {
      ccRevealBtnEl.addEventListener('click', function() {
        const rel = ccFolderRelEl ? ccFolderRelEl.textContent : '';
        if (rel) vscode.postMessage({ type: 'revealFolder', payload: { folderRel: rel } });
      });
    }

    // Close button
    if (ccCloseBtnEl) {
      ccCloseBtnEl.addEventListener('click', function() {
        vscode.postMessage({ type: 'cancel' });
      });
    }

    // Handle messages from extension
    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'setTheme') {
        document.documentElement.setAttribute('data-theme', msg.isDark ? 'dark' : 'light');
        return;
      }
      if (msg.type === 'showProgress') {
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
      } else if (msg.type === 'lintResult') {
        var which = msg.payload && msg.payload.id; // id is 'deploy'|'verify'|'revert'
        updateLint(which, msg.payload.ok, msg.payload.msg);
      } else if (msg.type === 'generationDone') {
        showChangeCard(msg.payload);
      } else if (msg.type === 'generationError') {
        const errPayload = msg.payload || {};
        const errMsg = errPayload.message || 'Generation failed.';
        const errStack = errPayload.stack || errMsg;
        const errCode = errPayload.code ? ' [' + errPayload.code + ']' : '';
        const errTime = errPayload.timestamp || new Date().toISOString();
        console.error('[DMCR] Generation Error', { message: errMsg, code: errPayload.code, stack: errStack, timestamp: errTime, source: errPayload.source });
        if (genErrBoxEl) {
          if (genErrMsgEl) genErrMsgEl.textContent = errMsg + errCode;
          const metaEl = document.getElementById('genErrMeta');
          if (metaEl) metaEl.textContent = errTime;
          const stackPreEl = document.getElementById('genErrStackPre');
          const toggleEl = document.getElementById('genErrToggle');
          if (stackPreEl) stackPreEl.textContent = errStack;
          if (toggleEl) { toggleEl.style.display = ''; toggleEl.dataset.open = '0'; }
          genErrBoxEl.style.display = '';
        }
        if (changeCardEl) changeCardEl.style.display = 'none';
        clearStatus();
        showScreen('form');
      } else if (msg.type === 'saved') {
        if (ccSaveBtnEl) { ccSaveBtnEl.disabled = false; ccSaveBtnEl.textContent = 'Save to workspace'; }
        if (ccSavedBoxEl) ccSavedBoxEl.style.display = 'flex';
        if (ccFolderRelEl && msg.payload) ccFolderRelEl.textContent = msg.payload.folderRel || '';
        if (ccErrBoxEl) ccErrBoxEl.style.display = 'none';
        if (ccSaveBtnEl) { ccSaveBtnEl.textContent = 'Saved!'; ccSaveBtnEl.disabled = true; }
      } else if (msg.type === 'saveError') {
        if (ccSaveBtnEl) { ccSaveBtnEl.disabled = false; ccSaveBtnEl.textContent = 'Save to workspace'; }
        if (ccErrBoxEl) { ccErrBoxEl.style.display = ''; ccErrBoxEl.textContent = (msg.payload && msg.payload.msg) || 'Save failed.'; }
      } else if (msg.type === 'formActivated') {
        // Tab re-activated — reset to form screen so the user can interact.
        // (Form might be stuck on progress/result from a prior session.)
        if (genErrBoxEl) genErrBoxEl.style.display = 'none';
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

    function normalizeSchema(s) {
      let t = String(s || "").trim();
      if (!t) return "";
      if (t.endsWith(".")) t = t.slice(0, -1);
      return t;
    }

    const defaultSchemaEl = document.getElementById("defaultSchema");
    const schemaEnabledEl = document.getElementById("schemaEnabled");
    const schemaNameEl = document.getElementById("schemaName");

    // Keep schemaName in sync with defaultSchema until the user edits schemaName manually.
    let schemaNameUserEdited = false;
    let schemaNameAutoValue = "";
    let settingSchemaName = false;

    function setSchemaNameAuto(v) {
      if (!schemaNameEl) return;
      settingSchemaName = true;
      schemaNameEl.value = v;
      settingSchemaName = false;
      schemaNameAutoValue = v;
    }

    function maybeAutofillSchemaName() {
      const def = normalizeSchema(defaultSchemaEl?.value);
      if (!def || !schemaNameEl) return;

      const current = String(schemaNameEl.value || "").trim();

      // If user has manually edited schemaName, stop syncing.
      if (schemaNameUserEdited) return;

      // If schemaName has some value that isn't our auto-value, treat it as user-edited.
      if (current && schemaNameAutoValue && current !== schemaNameAutoValue) {
        schemaNameUserEdited = true;
        return;
      }

      // Otherwise keep syncing as default schema changes
      setSchemaNameAuto(def);
    }

    if (schemaNameEl) {
      schemaNameEl.addEventListener("input", () => {
        if (settingSchemaName) return;

        const v = String(schemaNameEl.value || "").trim();
        if (!v) {
          // If user clears it, allow syncing again.
          schemaNameUserEdited = false;
          schemaNameAutoValue = "";
          return;
        }

        // Anything that isn't the auto-filled value counts as manual override.
        if (schemaNameAutoValue && v === schemaNameAutoValue) return;
        schemaNameUserEdited = true;
      });
    }

    if (defaultSchemaEl) {
      defaultSchemaEl.addEventListener("input", () => {
        maybeAutofillSchemaName();
      });
    }

    if (schemaEnabledEl) {
      schemaEnabledEl.addEventListener("change", () => {
        if (schemaEnabledEl.checked) maybeAutofillSchemaName();
      });
    }

    const tableActionEl = document.getElementById("tableAction");
    const tablesAreaEl = document.getElementById("tablesArea");
    const tableDefsOnlyAreaEl = document.getElementById("tableDefsOnlyArea");
    const grantTablesObjAreaEl = document.getElementById("grantTablesObjArea");
    const grantSeqNameAreaEl = document.getElementById("grantSeqNameArea");
    const schemaCardEl = document.getElementById("schemaCard");
    const seqCardEl = document.getElementById("sequenceCard");
    const seqCreationAreaEl = document.getElementById("seqCreationArea");
    const sequenceEnabledEl = document.getElementById("sequenceEnabled");
    const tableGrantEnabledEl = document.getElementById("tableGrantEnabled");

    function getTableAction() {
      return String(tableActionEl?.value || "");
    }

    function applyModeUi() {
      const action = getTableAction();

      // Show/hide sections based on selected action
      const showTablesArea  = action === 'create' || action === 'alter' || action === 'grant-tables';
      const showTableDefs   = action === 'create' || action === 'alter';
      const showSchemaCard  = action === 'create' || action === 'alter' || action === 'create-schema';
      const showSeqCard     = action === 'create' || action === 'alter' || action === 'sequence' || action === 'grant-sequences';
      const showSeqCreation = action === 'create' || action === 'alter' || action === 'sequence';
      const showGrantTablesObj = action === 'grant-tables';
      const showGrantSeqName   = action === 'grant-sequences';

      if (tablesAreaEl)        tablesAreaEl.style.display        = showTablesArea      ? '' : 'none';
      if (tableDefsOnlyAreaEl) tableDefsOnlyAreaEl.style.display = showTableDefs       ? '' : 'none';
      if (grantTablesObjAreaEl) grantTablesObjAreaEl.style.display = showGrantTablesObj ? '' : 'none';
      if (grantSeqNameAreaEl)  grantSeqNameAreaEl.style.display  = showGrantSeqName    ? '' : 'none';
      if (schemaCardEl)        schemaCardEl.style.display        = showSchemaCard  ? '' : 'none';
      if (seqCardEl)           seqCardEl.style.display           = showSeqCard     ? '' : 'none';
      if (seqCreationAreaEl)   seqCreationAreaEl.style.display   = showSeqCreation ? '' : 'none';

      // Auto-behaviours
      if (sequenceEnabledEl) {
        if (action === 'sequence' || action === 'grant-sequences') {
          sequenceEnabledEl.checked = true;
          sequenceEnabledEl.disabled = true;
        } else {
          sequenceEnabledEl.disabled = false;
          sequenceEnabledEl.checked = false;
        }
      }

      // For grant-tables: auto-check the table grant checkbox
      if (tableGrantEnabledEl && action === 'grant-tables') {
        tableGrantEnabledEl.checked = true;
        tableGrantEnabledEl.dispatchEvent(new Event('change'));
      }

      // For create-schema: auto-check schema enabled
      if (schemaEnabledEl && action === 'create-schema') {
        schemaEnabledEl.checked = true;
        schemaEnabledEl.dispatchEvent(new Event('change'));
      }
    }

    if (tableActionEl) {
      tableActionEl.addEventListener("change", () => {
        clearStatus();
        applyModeUi();
      });
    }

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

    const knownBaseTypes = ${JSON.stringify(commonTypes)};
    let _colRowCounter = 0;

    function makeColTypeDropdown(wrapperId, inputId, valId, items, menuClass) {
      const wrap = document.getElementById(wrapperId);
      const hidden = document.getElementById(inputId);
      const valEl = document.getElementById(valId);
      if (!wrap || !hidden || !valEl) return;
      const trigger = wrap.querySelector('.sd-trigger');
      if (!trigger) return;
      const menu = document.createElement('div');
      menu.className = 'sd-menu' + (menuClass ? ' ' + menuClass : '');
      document.body.appendChild(menu);
      function setVal(v) {
        const opt = items.find(function(o){return o.value===v;});
        hidden.value = v;
        valEl.textContent = opt ? opt.label : v;
        menu.querySelectorAll('.sd-item').forEach(function(el){el.classList.toggle('selected',el.dataset.value===v);});
        hidden.dispatchEvent(new Event('change'));
      }
      items.forEach(function(item){
        const div = document.createElement('div');
        div.className = 'sd-item'; div.dataset.value = item.value; div.textContent = item.label;
        div.addEventListener('click', function(){ setVal(item.value); closeDd(); });
        menu.appendChild(div);
      });
      function positionDd(){
        const r = trigger.getBoundingClientRect();
        const menuH = Math.min(menu.scrollHeight || 260, 260);
        const spaceBelow = window.innerHeight - r.bottom;
        const goUp = spaceBelow < menuH + 8 && r.top > menuH + 8;
        menu.style.top = (goUp ? r.top - menuH - 4 : r.bottom + 4) + 'px';
        menu.style.left = r.left + 'px';
        menu.style.minWidth = r.width + 'px';
      }
      function openDd(){
        document.querySelectorAll('.sd-menu.open').forEach(function(m){m.classList.remove('open');});
        document.querySelectorAll('.sd-trigger.open').forEach(function(t){t.classList.remove('open');});
        trigger.classList.add('open'); menu.classList.add('open');
        positionDd();
        document.addEventListener('scroll', onScrollDd, true);
      }
      function closeDd(){ trigger.classList.remove('open'); menu.classList.remove('open'); document.removeEventListener('scroll', onScrollDd, true); }
      function onScrollDd(){ positionDd(); }
      trigger.addEventListener('click', function(){ if(trigger.classList.contains('open')) closeDd(); else openDd(); });
      document.addEventListener('mousedown', function(e){ if(!trigger.contains(e.target) && !menu.contains(e.target)) closeDd(); });
      setVal(hidden.value || items[0].value);
      return { setValue: setVal, getValue: function(){ return hidden.value; } };
    }

    function makeColumnRow({name = "", type = ""} = {}, onRemove) {
      const rowId = ++_colRowCounter;
      const typeWrapperId = 'acTypeWrap' + rowId;
      const typeInputId   = 'acType' + rowId;
      const typeValId     = 'acTypeVal' + rowId;

      const nameInput = el("input", { placeholder: "column_name", value: name });

      // Build custom sd-* type dropdown
      const typeDropWrap = document.createElement('div');
      typeDropWrap.className = 'sd-wrap'; typeDropWrap.id = typeWrapperId;
      const typeTrigger = document.createElement('button');
      typeTrigger.type = 'button'; typeTrigger.className = 'sd-trigger';
      const typeValSpan = document.createElement('span');
      typeValSpan.className = 'sd-val'; typeValSpan.id = typeValId;
      const typeArrow = document.createElementNS('http://www.w3.org/2000/svg','svg');
      typeArrow.setAttribute('class','sd-arrow'); typeArrow.setAttribute('viewBox','0 0 12 7'); typeArrow.setAttribute('fill','none');
      const typeArrowPath = document.createElementNS('http://www.w3.org/2000/svg','path');
      typeArrowPath.setAttribute('d','M1 1l5 5 5-5'); typeArrowPath.setAttribute('stroke','currentColor');
      typeArrowPath.setAttribute('stroke-width','1.5'); typeArrowPath.setAttribute('stroke-linecap','round'); typeArrowPath.setAttribute('stroke-linejoin','round');
      typeArrow.appendChild(typeArrowPath);
      typeTrigger.appendChild(typeValSpan); typeTrigger.appendChild(typeArrow);
      const typeHidden = document.createElement('input');
      typeHidden.type = 'hidden'; typeHidden.id = typeInputId;
      typeDropWrap.appendChild(typeTrigger); typeDropWrap.appendChild(typeHidden);

      // Always-visible "suffix" box (constraints / extra clauses)
      const suffixInput = el("input", {
        placeholder: "e.g. PRIMARY KEY DEFAULT nextval('seq_name')",
        value: ""
      });

      const typeItems = ${JSON.stringify([
        ...commonTypes.map(t => ({ value: t, label: t })),
        { value: "__custom__", label: "custom\u2026" }
      ])};

      function splitTypeIntoBaseAndSuffix(typeText) {
        const t = String(typeText || "").trim();
        if (!t) return { base: "", suffix: "" };
        const lt = t.toLowerCase();
        for (const base of knownBaseTypes) {
          const lb = String(base).toLowerCase();
          if (lt === lb) return { base, suffix: "" };
          if (lt.startsWith(lb + " ")) {
            return { base, suffix: t.slice(String(base).length).trim() };
          }
        }
        return { base: "__custom__", suffix: t };
      }

      const split = splitTypeIntoBaseAndSuffix(type);
      typeHidden.value = split.base || (typeItems[0] ? typeItems[0].value : "");
      if (split.suffix) suffixInput.value = split.suffix;

      function updateSuffixPlaceholder() {
        if (String(typeHidden.value) === "__custom__") {
          suffixInput.placeholder = "full type + constraints (e.g. BIGINT PRIMARY KEY DEFAULT nextval('seq_name'))";
        } else {
          suffixInput.placeholder = "constraints (optional) e.g. PRIMARY KEY DEFAULT nextval('seq_name')";
        }
      }
      updateSuffixPlaceholder();
      typeHidden.addEventListener("change", updateSuffixPlaceholder);

      const removeBtn = el("button", { class: "danger", type: "button", text: "Remove" });
      removeBtn.addEventListener("click", () => onRemove && onRemove());

      const nameField = el("div", { class: "field" }, [
        el("label", { text: "Column name" }),
        nameInput
      ]);

      const typeField = el("div", { class: "field" }, [
        el("label", { text: "Type" }),
        typeDropWrap
      ]);

      const constraintsField = el("div", { class: "field" }, [
        el("label", { text: "Constraints / suffix" }),
        suffixInput
      ]);

      const row = el("div", { class: "colDefRow" }, [nameField, typeField, constraintsField, removeBtn]);

      // Init dropdown after row is in DOM (deferred)
      setTimeout(() => {
        makeColTypeDropdown(typeWrapperId, typeInputId, typeValId, typeItems, 'col-type-dd');
      }, 0);

      return {
        row,
        getValue: () => {
          const n = (nameInput.value || "").trim();
          const selected = (typeHidden.value || "").trim();
          const suffix = (suffixInput.value || "").trim();

          let t = "";
          if (selected === "__custom__") {
            t = suffix;
          } else {
            t = suffix ? \`\${selected} \${suffix}\` : selected;
          }

          return { name: n, type: String(t || "").trim() };
        }
      };
    }

    function makeTableCard({table = "", columns = []} = {}) {
      const card = el("div", { class: "card" });
      const tableInput = el("input", { placeholder: "schema.table", value: table });

      const tableField = el("div", { class: "field" }, [
        el("label", { text: "Table (schema.table)" }),
        tableInput
      ]);

      const columnsContainer = el("div", {});
      const colRows = [];

      function addColumn(initial) {
        const api = makeColumnRow(initial, () => {
          const i = colRows.indexOf(api);
          if (i >= 0) colRows.splice(i, 1);
          api.row.remove();
        });
        colRows.push(api);
        columnsContainer.appendChild(api.row);
      }

      if (columns.length) columns.forEach(c => addColumn(c));
      else addColumn({});

      const addColBtn = el("button", { class: "secondary", type: "button", text: "? Add column" });
      addColBtn.addEventListener("click", () => addColumn({}));

      const removeTableBtn = el("button", { class: "danger", type: "button", text: "Remove table" });
      removeTableBtn.addEventListener("click", () => { card.remove(); card._removed = true; });

      const spacer = el("div", { class: "spacer" });

      const header = el("div", { class: "tableHeaderRow" }, [
        tableField,
        spacer,
        addColBtn,
        removeTableBtn
      ]);

      card.appendChild(header);
      card.appendChild(columnsContainer);

      function setColumnsDisabled(disabled) {
        const nodes = card.querySelectorAll("input, select, button");
        nodes.forEach(n => {
          if (n && n.textContent && String(n.textContent).toLowerCase().includes("remove table")) return;
          if (n === tableInput) return;
          n.disabled = !!disabled;
        });
        columnsContainer.style.opacity = disabled ? "0.6" : "1";
      }

      return {
        card,
        getValue: () => ({
          table: (tableInput.value || "").trim(),
          // Keep raw values so we can validate "name but missing type"
          columns: colRows.map(r => r.getValue()),
        }),
        isRemoved: () => !!card._removed,
        setColumnsDisabled,
      };
    }

    const tablesRoot = document.getElementById("tables");
    const tableCards = [];

    function addTable(initial) {
      const api = makeTableCard(initial);
      tableCards.push(api);
      tablesRoot.appendChild(api.card);
      applySameColumnsUi();
    }

    const sameColsChk = document.getElementById("sameColsChk");
    function applySameColumnsUi() {
      const active = tableCards.filter(t => !t.isRemoved());
      const enabled = !!(sameColsChk && sameColsChk.checked);
      active.forEach((t, idx) => t.setColumnsDisabled(enabled && idx > 0));
    }
    if (sameColsChk) sameColsChk.addEventListener("change", applySameColumnsUi);

    const addTableBtnEl = document.getElementById("addTableBtn");
    if (addTableBtnEl) addTableBtnEl.addEventListener("click", () => addTable({}));
    const duplicateLastTableBtnEl = document.getElementById("duplicateLastTableBtn");
    if (duplicateLastTableBtnEl) duplicateLastTableBtnEl.addEventListener("click", () => {
      const last = [...tableCards].reverse().find(t => !t.isRemoved());
      if (!last) return addTable({});
      const v = last.getValue();
      addTable({ table: "", columns: v.columns });
    });

    const loadSeqExampleBtnEl = document.getElementById("loadSeqExampleBtn");
    if (loadSeqExampleBtnEl) loadSeqExampleBtnEl.addEventListener("click", () => {
      document.getElementById("sequenceEnabled").checked = true;
      document.getElementById("sequenceName").value = "seq_wfm_ahod_threshold_level";
      document.getElementById("sequenceStartWith").value = "1";
      document.getElementById("sequenceIncrementBy").value = "1";
      document.getElementById("sequenceMinValue").value = "";
      document.getElementById("sequenceMaxValue").value = "";
      document.getElementById("sequenceCache").value = "1";

      document.getElementById("sequenceGrantEnabled").checked = true;
      document.getElementById("sequenceGrantRole").value = "zp_st";
      document.getElementById("qPrivUsage").checked = true;
      document.getElementById("qPrivSelect").checked = true;
      document.getElementById("qPrivUpdate").checked = false;
      setStatus("Loaded sequence example.", "ok");
    });

    const cancelBtnEl = document.getElementById("cancelBtn");
    if (cancelBtnEl) cancelBtnEl.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));

    function collectPrivs(map) {
      const out = [];
      for (const [id, name] of Object.entries(map)) {
        const e = document.getElementById(id);
        if (e && e.checked) out.push(name);
      }
      return out;
    }

    const generateBtnEl = document.getElementById("generateBtn");
    if (generateBtnEl) generateBtnEl.addEventListener("click", () => {
      clearStatus();

      const tableAction = document.getElementById("tableAction").value;
      const defaultSchema = normalizeSchema(document.getElementById("defaultSchema").value);
      const changeNameHint = (document.getElementById("changeNameHint")?.value || "").trim();

      // Grant-tables-only mode: grant on explicitly named tables
      if (tableAction === "grant-tables") {
        const rawNames = (document.getElementById("grantTableNames")?.value || "").trim();
        if (!rawNames) { setStatus("Enter at least one table name to grant on.", "error"); return; }
        const tableNames = rawNames.split(/[\\n,]+/).map(s => s.trim()).filter(Boolean);
        if (!tableNames.length) { setStatus("Enter at least one table name to grant on.", "error"); return; }

        const tableGrantRole = (document.getElementById("tableGrantRole").value || "").trim();
        const tableGrantPrivs = collectPrivs({ "tPrivSelect": "SELECT", "tPrivInsert": "INSERT", "tPrivUpdate": "UPDATE", "tPrivDelete": "DELETE" });
        if (!tableGrantRole) { setStatus("Enter a role name for table GRANTs.", "error"); return; }
        if (!tableGrantPrivs.length) { setStatus("Select at least one privilege for table GRANTs.", "error"); return; }

        const tables = tableNames.map(name => ({
          table: name.includes(".") || !defaultSchema ? name : defaultSchema + "." + name,
          columns: [],
        }));

        const payload = {
          tableAction,
          defaultSchema,
          changeNameHint,
          tables,
          sameColumnsForAllTables: false,
          tableGrantEnabled: true,
          tableGrantRole,
          tableGrantPrivs,
          schemaEnabled: false,
          schemaName: "",
          schemaGrantEnabled: false,
          schemaGrantRole: "",
          schemaGrantPrivs: [],
          sequenceEnabled: false,
          sequenceName: "",
          sequenceStartWith: "",
          sequenceIncrementBy: "",
          sequenceMinValue: "",
          sequenceMaxValue: "",
          sequenceCache: "",
          sequenceGrantEnabled: false,
          sequenceGrantRole: "",
          sequenceGrantPrivs: [],
        };
        setStatus("Submitting request\u2026", "ok");
        vscode.postMessage({ type: "submit", payload });
        return;
      }

      // Grant-sequences-only mode: grant on an explicitly named sequence
      if (tableAction === "grant-sequences") {
        const grantSeqName = (document.getElementById("grantSeqName")?.value || "").trim();
        if (!grantSeqName) { setStatus("Enter the sequence name to grant on.", "error"); return; }

        const seqGrantRole = (document.getElementById("sequenceGrantRole").value || "").trim();
        const seqGrantPrivs = collectPrivs({ "qPrivUsage": "USAGE", "qPrivSelect": "SELECT", "qPrivUpdate": "UPDATE" });
        if (!seqGrantRole) { setStatus("Enter a role name for sequence GRANTs.", "error"); return; }
        if (!seqGrantPrivs.length) { setStatus("Select at least one privilege for sequence GRANTs.", "error"); return; }

        const qualifiedSeqName = grantSeqName.includes(".") || !defaultSchema
          ? grantSeqName
          : defaultSchema + "." + grantSeqName;

        const payload = {
          tableAction,
          defaultSchema,
          changeNameHint,
          tables: [],
          sameColumnsForAllTables: false,
          tableGrantEnabled: false,
          tableGrantRole: "",
          tableGrantPrivs: [],
          schemaEnabled: false,
          schemaName: "",
          schemaGrantEnabled: false,
          schemaGrantRole: "",
          schemaGrantPrivs: [],
          sequenceEnabled: true,
          sequenceName: qualifiedSeqName,
          sequenceStartWith: "",
          sequenceIncrementBy: "",
          sequenceMinValue: "",
          sequenceMaxValue: "",
          sequenceCache: "",
          sequenceGrantEnabled: true,
          sequenceGrantRole: seqGrantRole,
          sequenceGrantPrivs: seqGrantPrivs,
        };
        setStatus("Submitting request\u2026", "ok");
        vscode.postMessage({ type: "submit", payload });
        return;
      }

      // Sequence-only mode: generate only CREATE SEQUENCE (+ optional sequence GRANTs)
      if (tableAction === "sequence") {
        const sequenceName = (document.getElementById("sequenceName").value || "").trim();
        const sequenceStartWith = (document.getElementById("sequenceStartWith").value || "").trim();
        const sequenceIncrementBy = (document.getElementById("sequenceIncrementBy").value || "").trim();
        const sequenceMinValue = (document.getElementById("sequenceMinValue").value || "").trim();
        const sequenceMaxValue = (document.getElementById("sequenceMaxValue").value || "").trim();
        const sequenceCache = (document.getElementById("sequenceCache").value || "").trim();

        if (!sequenceName) {
          setStatus("Enter sequence name.", "error");
          return;
        }

        const sequenceGrantEnabled = !!document.getElementById("sequenceGrantEnabled").checked;
        const sequenceGrantRole = (document.getElementById("sequenceGrantRole").value || "").trim();
        const sequenceGrantPrivs = collectPrivs({
          "qPrivUsage": "USAGE",
          "qPrivSelect": "SELECT",
          "qPrivUpdate": "UPDATE",
        });
        if (sequenceGrantEnabled && (!sequenceGrantRole || !sequenceGrantPrivs.length)) {
          setStatus("Sequence GRANTs enabled: choose privileges and enter role.", "error");
          return;
        }

        const payload = {
          tableAction,
          defaultSchema,
          changeNameHint,

          tables: [],
          sameColumnsForAllTables: false,

          tableGrantEnabled: false,
          tableGrantRole: "",
          tableGrantPrivs: [],

          schemaEnabled: false,
          schemaName: "",
          schemaGrantEnabled: false,
          schemaGrantRole: "",
          schemaGrantPrivs: [],

          sequenceEnabled: true,
          sequenceName,
          sequenceStartWith,
          sequenceIncrementBy,
          sequenceMinValue,
          sequenceMaxValue,
          sequenceCache,

          sequenceGrantEnabled,
          sequenceGrantRole,
          sequenceGrantPrivs,
        };

        setStatus("Submitting request&hellip;", "ok");
        vscode.postMessage({ type: "submit", payload });
        return;
      }

      const activeTables = tableCards
        .filter(t => !t.isRemoved())
        .map(t => t.getValue())
        .filter(t => t.table);

      if (!activeTables.length) { setStatus("Add at least one table.", "error"); return; }

      // Validate: any column with a name must have a type
      for (const t of activeTables) {
        const cols = (t.columns || []);
        if (cols.some(c => (c.name || "").trim() && !(c.type || "").trim())) {
          setStatus("Every column must have a type. If needed, pick 'custom' and enter the full type + constraints.", "error");
          return;
        }
      }

      const sameColumnsForAllTables = !!document.getElementById("sameColsChk").checked;

      let tables = activeTables;
      if (sameColumnsForAllTables) {
        const sharedCols = (activeTables[0].columns || []).filter(c => c.name && c.type);
        if (!sharedCols.length) { setStatus("Add at least one column to the first table.", "error"); return; }
        tables = activeTables.map(t => ({ table: t.table, columns: sharedCols }));
      } else {
        tables = activeTables
          .map(t => ({ table: t.table, columns: (t.columns || []).filter(c => c.name && c.type) }))
          .filter(t => t.columns.length);
        if (!tables.length) { setStatus("Add at least one column.", "error"); return; }
      }

      const tableGrantEnabled = !!document.getElementById("tableGrantEnabled").checked;
      const tableGrantRole = (document.getElementById("tableGrantRole").value || "").trim();
      const tableGrantPrivs = collectPrivs({
        "tPrivSelect": "SELECT",
        "tPrivInsert": "INSERT",
        "tPrivUpdate": "UPDATE",
        "tPrivDelete": "DELETE",
      });

      if (tableGrantEnabled && (!tableGrantRole || !tableGrantPrivs.length)) {
        setStatus("Table GRANTs enabled: choose privileges and enter role.", "error");
        return;
      }

      const schemaEnabled = !!document.getElementById("schemaEnabled").checked;
      const schemaName = (document.getElementById("schemaName").value || "").trim();
      if (schemaEnabled && !schemaName) {
        setStatus("Schema enabled: enter schema name (or fill Default schema to auto-fill).", "error");
        return;
      }

      const schemaGrantEnabled = !!document.getElementById("schemaGrantEnabled").checked;
      const schemaGrantRole = (document.getElementById("schemaGrantRole").value || "").trim();
      const schemaGrantPrivs = collectPrivs({
        "sPrivUsage": "USAGE",
        "sPrivCreate": "CREATE",
      });
      if (schemaEnabled && schemaGrantEnabled && (!schemaGrantRole || !schemaGrantPrivs.length)) {
        setStatus("Schema GRANTs enabled: choose privileges and enter role.", "error");
        return;
      }

      const sequenceEnabled = !!document.getElementById("sequenceEnabled").checked;
      const sequenceName = (document.getElementById("sequenceName").value || "").trim();
      const sequenceStartWith = (document.getElementById("sequenceStartWith").value || "").trim();
      const sequenceIncrementBy = (document.getElementById("sequenceIncrementBy").value || "").trim();
      const sequenceMinValue = (document.getElementById("sequenceMinValue").value || "").trim();
      const sequenceMaxValue = (document.getElementById("sequenceMaxValue").value || "").trim();
      const sequenceCache = (document.getElementById("sequenceCache").value || "").trim();

      if (sequenceEnabled && !sequenceName) {
        setStatus("Sequence enabled: enter sequence name.", "error");
        return;
      }

      const sequenceGrantEnabled = !!document.getElementById("sequenceGrantEnabled").checked;
      const sequenceGrantRole = (document.getElementById("sequenceGrantRole").value || "").trim();
      const sequenceGrantPrivs = collectPrivs({
        "qPrivUsage": "USAGE",
        "qPrivSelect": "SELECT",
        "qPrivUpdate": "UPDATE",
      });
      if (sequenceEnabled && sequenceGrantEnabled && (!sequenceGrantRole || !sequenceGrantPrivs.length)) {
        setStatus("Sequence GRANTs enabled: choose privileges and enter role.", "error");
        return;
      }

      const payload = {
        tableAction,
        defaultSchema,
        changeNameHint,

        tables,
        sameColumnsForAllTables,

        tableGrantEnabled,
        tableGrantRole,
        tableGrantPrivs,

        schemaEnabled,
        schemaName,
        schemaGrantEnabled,
        schemaGrantRole,
        schemaGrantPrivs,

        sequenceEnabled,
        sequenceName,
        sequenceStartWith,
        sequenceIncrementBy,
        sequenceMinValue,
        sequenceMaxValue,
        sequenceCache,

        sequenceGrantEnabled,
        sequenceGrantRole,
        sequenceGrantPrivs,
      };

      setStatus("Submitting request&hellip;", "ok");
      vscode.postMessage({ type: "submit", payload });
    });

    addTable({ table: "", columns: [] });
    addTable({ table: "", columns: [] });
    applySameColumnsUi();
    applyModeUi();
  </script>
  <script nonce="${n}">
  /* -- MiniCalendar pure JS -- */
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
export function getAddColumnsFormHtml(n: string): string { return getHtml(n); }
/** Inline iframe form: compute normalised LLM request from submit payload */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAddColumnsNormalizedRequest(payload: any): string { return buildNormalizedRequest(payload as SubmitMessage['payload']); }