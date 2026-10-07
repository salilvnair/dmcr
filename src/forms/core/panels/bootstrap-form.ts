import * as vscode from "vscode";

export type DmcrFormId =
                    | "open_add_columns_form"
                    | "open_insert_rows_form"
                    | "open_freeform_sql_form";

type DmcrFormKind = "DDL" | "DML" | "SQL";

type OpenMessage = { type: "open"; formId: DmcrFormId };
type CancelMessage = { type: "cancel" };

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function openFormsBootstrapForm(opts: {
  extensionUri: vscode.Uri;
  title?: string;
}): Promise<DmcrFormId | null> {
  const panel = vscode.window.createWebviewPanel(
    "dmcrFormsBootstrap",
    opts.title ?? "DMCR: Available forms",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: false }
  );
  panel.iconPath = vscode.Uri.joinPath(opts.extensionUri, "images", "bot_icon.png");
  const n = nonce();
  panel.webview.html = getHtml(n);

  return await new Promise<DmcrFormId | null>(resolve => {
    const disposables: vscode.Disposable[] = [];
    let settled = false;

    const safeResolve = (v: DmcrFormId | null) => {
      if (settled) return;
      settled = true;
      for (const d of disposables) d.dispose();
      resolve(v);
    };

    disposables.push(panel.onDidDispose(() => safeResolve(null)));

    disposables.push(
      panel.webview.onDidReceiveMessage((msg: OpenMessage | CancelMessage) => {
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

        if (msg.type === "open") {
          safeResolve(msg.formId);
          panel.dispose();
        }
      })
    );
  });
}

function getHtml(n: string): string {
  const forms: Array<{
    id: DmcrFormId;
    title: string;
    kind: "DDL" | "DML" | "SQL";
    desc: string;
  }> = [
    {
      id: "open_add_columns_form",
      title: "Schema Builder (PostgreSQL)",
      kind: "DDL",
      desc:
        "Create/alter tables, add columns, create sequences, and optional GRANTs. " +
        "Outputs a normalized request for DMCR deploy/verify/revert generation.",
    },
    {
      id: "open_insert_rows_form",
      title: "Insert rows (PostgreSQL)",
      kind: "DML",
      desc:
        "Define columns + rows and generate an idempotent insert plan (ON CONFLICT). " +
        "Outputs a normalized request for DMCR deploy/verify/revert generation.",
    },
    {
    id: "open_freeform_sql_form",
    title: "SQL → DMCR (paste DDL/DML)",
    kind: "SQL",
    desc:
        "Paste any DDL/DML. DMCR deploy.sql will be exactly what you paste; " +
        "Copilot generates only verify.sql + revert.sql.",
    },
  ];

  const rowsHtml = forms
    .map(
      (f, idx) => `
<tr class="row" data-open="${escapeHtml(f.id)}" role="button" tabindex="0" aria-label="Open ${escapeHtml(f.title)}">
  <td class="num">${idx + 1}</td>
  <td class="main">
    <div class="titleRow">
      <span class="badge ${escapeHtml(f.kind.toLowerCase())}">${escapeHtml(f.kind)}</span>
      <span class="formTitle">${escapeHtml(f.title)}</span>
    </div>
    <div class="formDesc">${escapeHtml(f.desc)}</div>
    <div class="meta">
      <span class="codePill">${escapeHtml(f.id)}</span>
    </div>
  </td>
  <td class="actions">
    <button class="primary" type="button" data-open="${escapeHtml(f.id)}">Open</button>
  </td>
</tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DMCR Forms</title>

  <style nonce="${n}">
    :root {
      --dmcr-bg: var(--vscode-editor-background);
      --dmcr-fg: var(--vscode-editor-foreground, var(--vscode-foreground));
      --dmcr-muted: var(--vscode-descriptionForeground, rgba(127,127,127,0.85));
      --dmcr-border: var(--vscode-panel-border, rgba(127,127,127,0.35));

      --dmcr-card-bg: var(--vscode-editorWidget-background, rgba(127,127,127,0.04));
      --dmcr-card-shadow: rgba(0,0,0,0.18);

      --dmcr-hover: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08));
      --dmcr-alt: rgba(127,127,127,0.035);

      --dmcr-warn-bg: var(--vscode-inputValidation-warningBackground, rgba(255, 204, 0, 0.14));
      --dmcr-warn-border: var(--vscode-inputValidation-warningBorder, rgba(255, 204, 0, 0.45));
      --dmcr-warn-fg: var(--vscode-editorWarning-foreground, var(--dmcr-fg));

      --dmcr-accent: var(--vscode-focusBorder, var(--vscode-button-background));
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px 14px;
      font-family: var(--vscode-font-family);
      color: var(--dmcr-fg);
      background: var(--dmcr-bg);
      font-size: 13px;
      line-height: 1.35;
    }

    .wrap { max-width: 980px; padding-top: 20px; padding-bottom: 20px; margin: auto; padding-left: 14px; padding-right: 14px; }

    .topbar {
      display: block;
      margin-bottom: 10px;
    }

    .footer {
        position: sticky;     /* “float” at bottom while scrolling */
        bottom: 0;
        margin-top: 12px;
        padding-top: 12px;
        display: flex;
        justify-content: flex-end;
        background: linear-gradient(to bottom, transparent, var(--dmcr-bg) 40%);
    }

    .titles { min-width: 0; }
    .h {
      font-weight: 800;
      font-size: 16px;
      letter-spacing: 0.2px;
      margin-top: 2px;
    }
    .hint { margin-top: 4px; color: var(--dmcr-muted); font-size: 12px; }

    .banner {
      border: 1px solid var(--dmcr-warn-border);
      background: var(--dmcr-warn-bg);
      color: var(--dmcr-warn-fg);
      border-radius: 10px;
      padding: 10px 12px;
      margin: 10px 0 12px;
      position: relative;
      overflow: hidden;
    }
    .banner:before {
      content: "";
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 4px;
      background: var(--dmcr-warn-border);
      opacity: 0.9;
    }
    .bannerTitle { font-weight: 750; margin-left: 6px; }
    .bannerText { margin-left: 6px; margin-top: 3px; color: var(--dmcr-muted); }
    .bannerText b { color: var(--dmcr-fg); font-weight: 650; }

    .card {
      border: 1px solid var(--dmcr-border);
      background: var(--dmcr-card-bg);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 28px var(--dmcr-card-shadow);
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead th {
      text-align: left;
      font-weight: 800;
      padding: 10px 12px;
      background: rgba(127,127,127,0.06);
      border-bottom: 1px solid var(--dmcr-border);
      color: var(--dmcr-fg);
      font-size: 12px;
      letter-spacing: 0.2px;
    }

    tbody td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(127,127,127,0.18);
      vertical-align: top;
    }
    tbody tr:last-child td { border-bottom: none; }

    tbody tr:nth-child(even) td { background: var(--dmcr-alt); }

    tr.row:hover td { background: var(--dmcr-hover); }
    tr.row:focus td { outline: 1px solid var(--dmcr-accent); outline-offset: -2px; }

    td.num { width: 48px; color: var(--dmcr-muted); font-variant-numeric: tabular-nums; }
    td.actions { width: 132px; text-align: right; white-space: nowrap; }

    .titleRow {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      margin-bottom: 4px;
    }
    .formTitle {
      font-weight: 800;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .formDesc { color: var(--dmcr-muted); }

    .meta { margin-top: 8px; }
    .codePill {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid rgba(127,127,127,0.25);
      background: rgba(127,127,127,0.06);
      color: var(--vscode-textPreformat-foreground, var(--dmcr-fg));
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
      font-size: 11px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(127,127,127,0.35);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.3px;
    }

    /* Colorful but theme-friendly (uses VS Code chart colors when available) */
    .badge.ddl {
      border-color: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 65%, rgba(127,127,127,0.35));
      background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 18%, transparent);
      color: var(--vscode-charts-blue, #3794ff);
    }
    .badge.dml {
      border-color: color-mix(in srgb, var(--vscode-charts-green, #89d185) 65%, rgba(127,127,127,0.35));
      background: color-mix(in srgb, var(--vscode-charts-green, #89d185) 18%, transparent);
      color: var(--vscode-charts-green, #89d185);
    }
    .badge.sql {
        border-color: color-mix(in srgb, var(--vscode-charts-purple, #c586c0) 65%, rgba(127,127,127,0.35));
        background: color-mix(in srgb, var(--vscode-charts-purple, #c586c0) 18%, transparent);
        color: var(--vscode-charts-purple, #c586c0);
    }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 7px 12px;
      min-height: 32px;
      border-radius: 8px;
      border: 1px solid var(--vscode-button-border, transparent);
      cursor: pointer;
      white-space: nowrap;
      transition: background-color 120ms ease, border-color 120ms ease, transform 40ms ease, filter 120ms ease;
      user-select: none;
    }
    button:hover { filter: brightness(1.06); border-color: var(--dmcr-border); }
    button:active { transform: translateY(1px); }

    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      box-shadow: 0 6px 16px rgba(0,0,0,0.18);
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }

    button.secondary {
      background: transparent;
      color: var(--dmcr-fg);
      border-color: var(--dmcr-border);
    }
    button.secondary:hover { background: rgba(127,127,127,0.08); }

    @media (max-width: 720px) {
      body { padding: 10px 10px; }
      td.actions { width: 110px; }
      .topbar { grid-template-columns: 1fr; }
    }

    @keyframes dmcrSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    button.busy::after {
      content: "";
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid rgba(127,127,127,0.35);
      border-top-color: var(--vscode-button-foreground);
      display: inline-block;
      margin-left: 8px;
      animation: dmcrSpin 0.8s linear infinite;
    }
  </style>
</head>

<body>
  <div class="wrap">
    <div class="topbar">
      <div class="titles">
        <div class="h">Available forms</div>
        <div class="hint">Pick a form to generate a structured DMCR request.</div>
      </div>
    </div>

    <div class="banner" role="note" aria-label="Tip">
      <div class="bannerTitle">Heads up</div>
      <div class="bannerText">
        Forms generate <b>normalized prompts</b> so DMCR deploy/verify/revert output is more consistent.
        You can always reopen this via <b>forms</b>.
      </div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th style="width:48px;">#</th>
            <th>Form</th>
            <th style="width:132px;"></th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
    <div class="footer">
        <button class="secondary" id="cancelBtn" type="button">Cancel</button>
    </div>
  </div>

  <script nonce="${n}">
    const vscode = acquireVsCodeApi();
    window._dmcrVS = vscode;

    function openForm(formId) {
      vscode.postMessage({ type: "open", formId });
    }

    document.getElementById("cancelBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "cancel" });
    });

    // Buttons
    document.querySelectorAll("button[data-open]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const formId = btn.getAttribute("data-open");
        openForm(formId);
      });
    });

    // Row click + keyboard (Enter/Space)
    document.querySelectorAll("tr[data-open]").forEach(row => {
      row.addEventListener("click", () => openForm(row.getAttribute("data-open")));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openForm(row.getAttribute("data-open"));
        }
      });
    });
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