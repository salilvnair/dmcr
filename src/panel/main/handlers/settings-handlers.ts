/**
 * LLM settings message handlers: ready, saveTheme, saveCopilot, activateProvider,
 * addProvider, deleteProvider, fetchModels.
 */
import {
  getSettingsSnapshot,
  saveActiveFamilyToDb,
  saveActiveCustomProviderToDb,
  getActiveProviderKey,
} from "../../../services/llm/core/llm-settings";
import {
  saveCustomProvider,
  deleteCustomProvider,
  fetchAndCacheModels,
  getAllCustomProviders,
} from "../../../services/llm/core/custom-providers";
import type { CustomProviderConfig } from "../../../services/llm/core/custom-providers";
import { getSqliteStatus, upsert, findById } from "../../../storage/db";
import type { HandlerContext, Message } from "./types";

const UI_STATE_COLLECTION = 'ui_state';
const WORKSPACE_SNAPSHOT_ID = 'workspace_snapshot';

interface WorkspaceSnapshot {
  tab: string;
  theme?: string;
  settingsSection?: string;
  devToolActive?: string;
  formState?: Record<string, unknown>;
}

function loadWorkspaceSnapshot(): WorkspaceSnapshot | null {
  return findById<WorkspaceSnapshot>(UI_STATE_COLLECTION, WORKSPACE_SNAPSHOT_ID) ?? null;
}

function saveWorkspaceSnapshot(data: WorkspaceSnapshot): void {
  upsert(UI_STATE_COLLECTION, WORKSPACE_SNAPSHOT_ID, data);
}

export async function handleSettingsMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;

  switch (msg.type) {

    /* ── Settings: init ── */
    case "ready": {
      const snapshot = await getSettingsSnapshot();
      const sqlite = getSqliteStatus();
      const savedTheme = ctx.extensionContext?.globalState.get<string>('dmcr.theme') ?? 'dark';
      const uiSnapshot = loadWorkspaceSnapshot();
      webview.postMessage({
        type: "init",
        payload: { ...snapshot, sqliteStatus: sqlite.ok ? 'ok' : 'error', sqliteError: sqlite.error, theme: savedTheme, uiSnapshot },
      });
      return true;
    }

    /* ── Settings: save theme preference ── */
    case "saveTheme": {
      const { theme: newTheme } = msg.payload as { theme: string };
      await ctx.extensionContext?.globalState.update('dmcr.theme', newTheme);
      // Also keep snapshot in sync with the new theme
      const prev = loadWorkspaceSnapshot();
      saveWorkspaceSnapshot({ ...(prev ?? { tab: 'home' }), theme: newTheme });
      return true;
    }

    /* ── UI Snapshot: save active tab + other layout prefs ── */
    case "saveUiSnapshot": {
      const data = msg.payload as WorkspaceSnapshot;
      saveWorkspaceSnapshot(data);
      return true;
    }

    /* ── Settings: save Copilot model ── */
    case "saveSettings":
    case "saveCopilot": {
      const p2 = msg.payload as { activeProvider?: string; copilotModel?: string; family?: string };
      const family = p2.copilotModel ?? p2.family ?? '';
      saveActiveFamilyToDb(family);
      saveActiveCustomProviderToDb(null);
      webview.postMessage({ type: "saved", payload: { activeProvider: 'copilot', activeFamily: family } });
      return true;
    }

    /* ── Settings: activate custom provider ── */
    case "activateProvider":
    case "activateCustom": {
      const p3 = msg.payload as { key: string; model?: string };
      const { key: cpKey } = p3;
      const allProviders = getAllCustomProviders();
      const cpCfg = allProviders.find((p) => p.key === cpKey);
      const newModel = p3.model ?? cpCfg?.activeModel ?? '';
      if (cpCfg) await saveCustomProvider({ ...cpCfg, activeModel: newModel });
      saveActiveCustomProviderToDb(cpKey);
      webview.postMessage({ type: "saved", payload: { activeProvider: cpKey, activeFamily: newModel } });
      return true;
    }

    /* ── Settings: add provider ── */
    case "addProvider": {
      const body = msg.payload as Partial<CustomProviderConfig> & { apiKey?: string };
      const name = (body.name ?? "").trim();
      if (!name) { webview.postMessage({ type: "error", payload: "name is required" }); return true; }
      if (!body.type) { webview.postMessage({ type: "error", payload: "type is required" }); return true; }
      if (!body.chatUrl) { webview.postMessage({ type: "error", payload: "chatUrl is required" }); return true; }
      if (!body.modelsUrl) { webview.postMessage({ type: "error", payload: "modelsUrl is required" }); return true; }

      const key = body.key || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const cfg: CustomProviderConfig = {
        key, name,
        type: body.type as CustomProviderConfig["type"],
        chatUrl: body.chatUrl,
        modelsUrl: body.modelsUrl,
        apiKey: body.apiKey || undefined,
        headers: body.headers || {},
        activeModel: body.activeModel || "",
      };
      await saveCustomProvider(cfg);
      let fetchedModels: { id: string; label: string; group: string; family: string }[] = [];
      try { fetchedModels = await fetchAndCacheModels(key); } catch { /* non-fatal */ }
      webview.postMessage({
        type: "providerAdded",
        payload: { key, name: cfg.name, type: cfg.type, activeModel: cfg.activeModel, models: fetchedModels },
      });
      return true;
    }

    /* ── Settings: delete provider ── */
    case "deleteProvider": {
      const { key } = msg.payload as { key: string };
      await deleteCustomProvider(key);
      if (getActiveProviderKey() === key) saveActiveCustomProviderToDb(null);
      webview.postMessage({ type: "providerDeleted", payload: { key } });
      return true;
    }

    /* ── Settings: fetch models ── */
    case "fetchModels": {
      const { key } = msg.payload as { key: string };
      try {
        const models = await fetchAndCacheModels(key);
        webview.postMessage({ type: "modelsFetched", payload: { key, models } });
      } catch (err: unknown) {
        webview.postMessage({ type: "error", payload: `fetchModels failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      return true;
    }

    default:
      return false;
  }
}
