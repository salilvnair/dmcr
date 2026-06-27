import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { chatRequestHandler } from "./forms/llm/chat/chat-handler";
import { initDb, relocateDb, getDbPath, getRawDb, closeDb } from "./storage/db";
import { initDangerRulesDir } from "./storage/danger-rules";
import { initPromptLibraryDb } from "./storage/prompt-library";
import { loadActiveFamilyFromDb } from "./services/llm/core/llm-settings";
import { initSecretStore, migrateLegacyApiKeys } from "./services/llm/core/secret-store";
import { initMcpService, disposeMcpService, listDatabaseServers } from "./services/mcp/server/mcp";
import { DmcrPanel } from "./panel/main/DmcrPanel";
import { DmcrWikiViewProvider } from "./panel";
import { QuickAccessViewProvider } from "./panel/sidepanel/QuickAccessViewProvider";
import { SchemaExplorerProvider } from "./panel/sidepanel/SchemaExplorerProvider";
import { killActiveRunnerChild } from "./panel/main/handlers/runner-handlers";

export async function activate(context: vscode.ExtensionContext) {
  /* ── 1. Init SQLite storage (sql.js WASM) ── */
  await initDb(context.extensionPath);
  initPromptLibraryDb(getRawDb());
  initDangerRulesDir(context.extensionPath);
  initSecretStore(context.secrets);
  await migrateLegacyApiKeys();
  loadActiveFamilyFromDb();
  initMcpService(context.extensionPath);

  /* ── 2. Register DMCR chat participant (@dmcr) ── */
  const handler = chatRequestHandler({ extensionUri: context.extensionUri });

  const participant = vscode.chat.createChatParticipant(
    "salilvnair.copilot.dmcr",
    handler
  );

  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "images",
    "bot_icon.png"
  );

  participant.followupProvider = {
    provideFollowups(result: vscode.ChatResult) {
      const meta = result.metadata as Record<string, unknown>;
      const followups = meta?.dmcr_followups;
      return Array.isArray(followups) ? followups : [];
    },
  };

  context.subscriptions.push(participant);

  /* ── 3. Activity-bar icon → opens DmcrPanel (same pattern as ck8t) ── */
  const quickAccessProvider = new QuickAccessViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      QuickAccessViewProvider.viewId,
      quickAccessProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  /* ── Wiki quick-reference sidebar panel ── */
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DmcrWikiViewProvider.viewId,
      new DmcrWikiViewProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  /* ── Schema Explorer tree view (shown only when database MCP is configured) ── */
  const schemaExplorer = new SchemaExplorerProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SchemaExplorerProvider.viewId, schemaExplorer),
  );

  // Set context key so the view is visible only when DB MCP servers exist
  function updateDbMcpContext() {
    const hasDb = listDatabaseServers().length > 0;
    vscode.commands.executeCommand('setContext', 'dmcr.hasDbMcp', hasDb);
  }
  updateDbMcpContext();

  context.subscriptions.push(
    vscode.commands.registerCommand('dmcr.schemaExplorer.refresh', () => {
      updateDbMcpContext();
      schemaExplorer.refresh();
    }),
  );

  // Auto-open DmcrPanel when Quick Access becomes visible is no longer needed
  // since the Quick Access webview now has direct action buttons.

  /* ── 4. Explicit command to open the panel ── */
  context.subscriptions.push(
    vscode.commands.registerCommand("dmcr.open", () => {
      DmcrPanel.createOrShow(context.extensionUri, context);
    })
  );

  /* ── 4b. Open conversation tab ── */
  context.subscriptions.push(
    vscode.commands.registerCommand("dmcr.conversation", () => {
      DmcrPanel.createOrShow(context.extensionUri, context);
      setTimeout(() => {
        DmcrPanel.currentPanel?.postMessage({ type: 'navigateToTab', payload: { tab: 'conversation' } });
      }, 300);
    })
  );

  /* ── 4c. Open Copilot Chat with @dmcr mention ── */
  context.subscriptions.push(
    vscode.commands.registerCommand("dmcr.openCopilotChat", async () => {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@dmcr ' });
    })
  );

  /* ── 5. Status bar shortcut ── */
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusItem.text = "$(database) DMCR";
  statusItem.tooltip = "Open DMCR Change Builder";
  statusItem.command = "dmcr.open";
  statusItem.show();
  context.subscriptions.push(statusItem);

  /* ── 5b. Open Schema Explorer (opens in sidebar panel) ── */
  context.subscriptions.push(
    vscode.commands.registerCommand("dmcr.openSchemaExplorer", () => {
      vscode.commands.executeCommand('dmcr.schemaExplorer.focus');
    })
  );

  /* ── 6. Change DB location command ── */
  context.subscriptions.push(
    vscode.commands.registerCommand("dmcr.changeDbLocation", async () => {
      const defaultPath = path.join(os.homedir(), '.dmcr', 'db', 'dmcr.db');
      const current = getDbPath() || defaultPath;

      const picked = await vscode.window.showOpenDialog({
        title: 'Select DMCR Database File',
        openLabel: 'Use as DB',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(current),
        filters: { 'SQLite Database': ['db', 'sqlite', 'sqlite3'], 'All Files': ['*'] },
      });

      if (picked && picked[0]) {
        const newPath = picked[0].fsPath;
        await vscode.workspace.getConfiguration('dmcr').update('dbPath', newPath, vscode.ConfigurationTarget.Global);
        relocateDb(newPath);
        vscode.window.showInformationMessage(`DMCR database switched to: ${newPath}`);
      }
    })
  );

  /* ── 7. Live-reload DB when setting changes externally (settings.json edit) ── */
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('dmcr.dbPath')) {
        const newPath = vscode.workspace.getConfiguration('dmcr').get<string>('dbPath', '').trim()
          || path.join(os.homedir(), '.dmcr', 'db', 'dmcr.db');
        relocateDb(newPath);
      }
    })
  );

  /* ── 8. Auto-open the main panel on launch ── */
  DmcrPanel.createOrShow(context.extensionUri, context);
}

export function deactivate() {
  killActiveRunnerChild(); // kill any running dmcr.ps1 child process
  disposeMcpService();     // kill any running stdio MCP processes
  closeDb();               // flush and close sql.js database
}

