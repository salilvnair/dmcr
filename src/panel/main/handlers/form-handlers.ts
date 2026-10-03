/**
 * Form-related message handlers: openForm, submit, cancel, browseFolder, saveChange, lint.
 */
import * as vscode from "vscode";
import * as path from "path";
import { openAddColumnsForm, buildAddColumnsNormalizedRequest } from "../../../forms/core/panels/add-columns-form";
import { openInsertRowsForm, buildInsertRowsNormalizedRequest } from "../../../forms/core/panels/insert-rows-form";
import { openFreeformSqlForm, buildFreeformNormalizedRequest } from "../../../forms/core/panels/freeform-sql-form";
import { buildSchemaDiffNormalizedRequest } from "../../../forms/core/panels/schema-diff-form";
import { lintPostgresSql } from "../../../forms/utils/sql-utils";
import {
  generateDmcrChangeWithCopilot,
  generateDmcrChangeWithCustomClient,
  loadDmcrContextText,
  type DmcrGeneratedChange,
} from "../../../forms/llm/generation/generator";
import { hasDangerPatterns } from "../../../forms/llm/prompts/prompt-template";
import { getAgentName, getResolvedPrompt } from "../../../storage/prompt-library";
import {
  getActiveFamily,
  getActiveCustomProviderKey,
} from "../../../services/llm/core/llm-settings";
import {
  getAllCustomProviders,
  createCustomProviderClient,
} from "../../../services/llm/core/custom-providers";
import { insertAudit } from "../../../storage/db";
import type { HandlerContext, Message } from "./types";
import { computeNextChangeId, writeFileToDisk, saveChangeToDisk, gitAutoCommitIfEnabled } from "./types";

export async function handleFormMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;

  switch (msg.type) {

    /* ── Home: open a form ── */
    case "openForm": {
      const formName: string = msg.payload?.form ?? "";
      type FormResult = { normalizedRequest: string; panel: vscode.WebviewPanel };
      let formResult: FormResult | null = null;

      try {
        if (formName === "ddl") {
          formResult = await openAddColumnsForm({
            extensionUri: ctx.extensionUri,
            title: "DMCR: Schema Builder (PostgreSQL)",
          });
        } else if (formName === "insert") {
          formResult = await openInsertRowsForm({
            extensionUri: ctx.extensionUri,
            title: "DMCR: Insert Rows (PostgreSQL)",
          });
        } else if (formName === "freeform") {
          formResult = await openFreeformSqlForm({
            extensionUri: ctx.extensionUri,
            title: "DMCR: Freeform SQL",
          });
        }

        if (!formResult) {
          webview.postMessage({ type: "formCancelled", payload: { form: formName } });
          return true;
        }

        const { normalizedRequest, panel: formPanel } = formResult;

        const formDisposables: vscode.Disposable[] = [];
        let savedOk = false;
        formDisposables.push(formPanel.onDidDispose(() => {
          for (const d of formDisposables) d.dispose();
          if (!savedOk) webview.postMessage({ type: "formCancelled", payload: { form: formName } });
        }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formDisposables.push(formPanel.webview.onDidReceiveMessage(async (m: any) => {
          if (m.type === "saveChange") {
            try {
              const change = m.payload as DmcrGeneratedChange & { location?: string };
              const { nextId, folderRel, deployUri, isDanger } = await saveChangeToDisk(change);
              savedOk = true;
              formPanel.webview.postMessage({ type: "saved", payload: { folderId: nextId, folderRel } });
              webview.postMessage({ type: "generationDone", payload: { folderId: nextId, folderRel, isDanger } });
              await vscode.window.showTextDocument(deployUri, { preview: false });
              // Auto-commit if enabled
              gitAutoCommitIfEnabled(folderRel, change.deploySql, nextId).then(r => {
                if (r?.ok && r.committed) {
                  webview.postMessage({ type: 'gitCommitDone', payload: { folderRel, commitHash: r.commitHash, commitMessage: r.commitMessage } });
                } else if (r && !r.ok) {
                  webview.postMessage({ type: 'gitCommitError', payload: { folderRel, error: r.error } });
                }
              }).catch(() => {});
            } catch (saveErr: unknown) {
              const saveErrMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
              formPanel.webview.postMessage({ type: "saveError", payload: { msg: saveErrMsg } });
            }
          } else if (m.type === "revealFolder") {
            const ws3 = vscode.workspace.workspaceFolders?.[0];
            if (ws3) {
              const folderUri3 = vscode.Uri.file(path.join(ws3.uri.fsPath, m.payload.folderRel));
              vscode.commands.executeCommand("revealInExplorer", folderUri3);
            }
          } else if (m.type === "browseFolder") {
            const picked = await vscode.window.showOpenDialog({
              canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
              openLabel: 'Select save folder',
            });
            if (picked?.[0]) {
              const relPath = vscode.workspace.asRelativePath(picked[0]);
              formPanel.webview.postMessage({ type: 'folderPicked', path: relPath });
            }
          } else if (m.type === "cancel") {
            formPanel.dispose();
          }
        }));

        webview.postMessage({ type: "generating", payload: { form: formName } });

        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) throw new Error("No workspace folder open. Open a workspace first.");

        const cts = new vscode.CancellationTokenSource();
        formDisposables.push({ dispose: () => cts.dispose() });

        const postProgress = (text: string) =>
          formPanel.webview.postMessage({ type: 'progressUpdate', payload: { text } });
        const postChunk = (chunk: string) =>
          formPanel.webview.postMessage({ type: 'streamChunk', payload: { text: chunk } });
        postProgress('Loading DMCR context…');
        const dmcrContext = await loadDmcrContextText(ws);
        postProgress('Agent is preparing DMCR change…');
        const change = await generateDmcrChangeWithCopilot(normalizedRequest, dmcrContext, cts.token, postChunk);
        postProgress('Generating your DMCR change…');
        formPanel.webview.postMessage({ type: "generationDone", payload: change });

      } catch (err: unknown) {
        const errMsg   = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? (err.stack ?? errMsg) : errMsg;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errCode  = (err as any)?.statusCode ?? (err as any)?.code ?? undefined;
        const errPayload = { message: errMsg, stack: errStack, code: errCode, timestamp: new Date().toISOString(), source: 'submit/inline' };
        if (formResult?.panel) {
          formResult.panel.webview.postMessage({ type: "generationError", payload: errPayload });
        }
        webview.postMessage({ type: "generationError", payload: errPayload });
      }
      return true;
    }

    /* ── Inline iframe forms: form submitted ── */
    case "submit": {
      // The page sends its own form id; activeFormType is only a fallback (it is cleared by
      // save/cancel and never set when a tab is restored or opened by shortcut).
      const form = ((msg.payload as { form?: string })?.form) || ctx.state.activeFormType;
      if (!form) {
        webview.postMessage({ type: 'generationError', payload: { message: 'Could not tell which form was submitted. Reopen the form tab and try again.', timestamp: new Date().toISOString(), source: 'submit' } });
        return true;
      }
      ctx.state.activeFormType = form;
      const t0Form = Date.now();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload = msg.payload as any;
        let normalized = '';
        if (form === 'ddl') normalized = buildAddColumnsNormalizedRequest(payload);
        else if (form === 'insert') normalized = buildInsertRowsNormalizedRequest(payload);
        else if (form === 'freeform') normalized = buildFreeformNormalizedRequest(payload);
        else if (form === 'schema_diff') normalized = buildSchemaDiffNormalizedRequest(payload);
        if (!normalized) return true;

        webview.postMessage({ type: 'showProgress', payload: { form, message: `${getAgentName(form === 'ddl' ? 'ADD_COLUMNS' : form === 'insert' ? 'INSERT_ROWS' : 'FREEFORM_SQL')} is thinking\u2026` } });
        webview.postMessage({ type: 'generating', payload: { form } });

        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) throw new Error('No workspace folder open. Open a workspace first.');
        const cts = new vscode.CancellationTokenSource();
        ctx.disposables.push({ dispose: () => cts.dispose() });

        const agentLabel = getAgentName(form === 'ddl' ? 'ADD_COLUMNS' : form === 'insert' ? 'INSERT_ROWS' : 'FREEFORM_SQL');
        const postProgress = (text: string) => webview.postMessage({ type: 'progressUpdate', payload: { form, text } });
        const postChunk = (chunk: string) => webview.postMessage({ type: 'streamChunk', payload: { form, text: chunk } });
        postProgress(`${agentLabel} is loading DMCR context\u2026`);
        const dmcrContext = await loadDmcrContextText(ws);
        postProgress(`${agentLabel} is preparing DMCR change\u2026`);

        const activeCustomKeyF = getActiveCustomProviderKey();
        const activeFamilyF    = getActiveFamily();
        let change: DmcrGeneratedChange;
        let usedModelF = 'copilot';

        if (activeCustomKeyF) {
          const allProvidersF = getAllCustomProviders();
          const pCfgF = allProvidersF.find(p => p.key === activeCustomKeyF);
          if (!pCfgF) throw new Error(`Custom provider '${activeCustomKeyF}' not found.`);
          const clientF = await createCustomProviderClient(activeCustomKeyF);
          const modelIdF = pCfgF.activeModel ?? '';
          usedModelF = `${pCfgF.name}/${modelIdF || 'default'}`;
          change = await generateDmcrChangeWithCustomClient(clientF, modelIdF, normalized, dmcrContext, postChunk, () => {});
        } else {
          usedModelF = activeFamilyF || 'copilot';
          change = await generateDmcrChangeWithCopilot(normalized, dmcrContext, cts.token, postChunk, activeFamilyF || undefined);
        }

        // Merge user-provided metadata into metaJson
        const metaTags = (payload.metaTags ?? '').trim();
        const metaRequires = (payload.metaRequires ?? '').trim();
        const metaAuthor = (payload.metaAuthor ?? '').trim();
        if (metaTags || metaRequires || metaAuthor) {
          let meta: Record<string, unknown> = {};
          if (change.metaJson) { try { meta = JSON.parse(change.metaJson); } catch {} }
          if (metaTags) meta.tags = metaTags.split(/,\s*/).filter(Boolean);
          if (metaRequires) meta.requires = metaRequires.split(/,\s*/).filter(Boolean);
          if (metaAuthor) meta.author = metaAuthor;
          change.metaJson = JSON.stringify(meta, null, 2);
        }

        const formStage = form === 'ddl' ? 'DDL_AGENT_OUTPUT' : form === 'insert' ? 'DML_AGENT_OUTPUT' : form === 'schema_diff' ? 'SCHEMA_DIFF_AGENT_OUTPUT' : 'SQL_AGENT_OUTPUT';
        const formSystemPrompt = getResolvedPrompt(form === 'ddl' ? 'ADD_COLUMNS' : form === 'insert' ? 'INSERT_ROWS' : 'FREEFORM_SQL');
        insertAudit({ conversation_id: `form-${form}`, stage: formStage, model: usedModelF, system_prompt: formSystemPrompt.slice(0, 2000), user_prompt: normalized.slice(0, 2000), request_payload: JSON.stringify({ messages: [{ role: 'system', content: formSystemPrompt.slice(0, 2000) }, { role: 'user', content: normalized.slice(0, 2000) }] }), response_payload: JSON.stringify({ changeName: change.changeName }), duration_ms: Date.now() - t0Form });
        webview.postMessage({ type: 'generationDone', payload: { ...change, form } });
      } catch (err: unknown) {
        const errMsg   = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? (err.stack ?? errMsg) : errMsg;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errCode  = (err as any)?.statusCode ?? (err as any)?.code ?? undefined;
        const formStage = form === 'ddl' ? 'DDL_AGENT_OUTPUT' : form === 'insert' ? 'DML_AGENT_OUTPUT' : form === 'schema_diff' ? 'SCHEMA_DIFF_AGENT_OUTPUT' : 'SQL_AGENT_OUTPUT';
        insertAudit({ conversation_id: `form-${form}`, stage: `${formStage}_ERROR`, model: getActiveCustomProviderKey() ? (getAllCustomProviders().find(p => p.key === getActiveCustomProviderKey())?.name ?? 'custom') : (getActiveFamily() || 'copilot'), user_prompt: '', request_payload: JSON.stringify({ error: true }), response_payload: JSON.stringify({ error: errMsg, code: errCode }), duration_ms: Date.now() - t0Form });
        webview.postMessage({ type: 'generationError', payload: { message: errMsg, stack: errStack, code: errCode, timestamp: new Date().toISOString(), source: `submit/${form}`, form } });
      }
      return true;
    }

    /* ── Inline iframe forms: cancel / close ── */
    case "cancel": {
      const cancelledForm = msg.payload?.form || ctx.state.activeFormType || 'unknown';
      const goHome = !!msg.payload?.goHome;
      const reset = !!msg.payload?.reset;
      ctx.state.activeFormType = null;
      webview.postMessage({ type: 'formCancelled', payload: { form: cancelledForm, goHome, reset } });
      return true;
    }

    /* ── Inline iframe forms: browse for folder ── */
    case "browseFolder": {
      const requestId = (msg.payload as { requestId?: string })?.requestId;
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select save folder',
      });
      if (picked?.[0]) {
        const relPath = vscode.workspace.asRelativePath(picked[0]);
        webview.postMessage({ type: 'folderPicked', path: relPath, payload: { path: relPath, requestId } });
      }
      return true;
    }

    /* ── Inline iframe forms: save generated change ── */
    case "saveChange": {
      try {
        const change = msg.payload as DmcrGeneratedChange & { location?: string; requestId?: string };
        const { nextId, folderRel, deployUri, isDanger } = await saveChangeToDisk(change);
        webview.postMessage({ type: 'saved', payload: { folderId: nextId, folderRel, changeName: change.changeName, requestId: change.requestId } });
        webview.postMessage({ type: 'generationDone', payload: { folderId: nextId, folderRel, isDanger } });
        await vscode.window.showTextDocument(deployUri, { preview: false });
        // Auto-commit if enabled
        gitAutoCommitIfEnabled(folderRel, change.deploySql, nextId).then(r => {
          if (r?.ok && r.committed) {
            webview.postMessage({ type: 'gitCommitDone', payload: { folderRel, commitHash: r.commitHash, commitMessage: r.commitMessage } });
          } else if (r && !r.ok) {
            webview.postMessage({ type: 'gitCommitError', payload: { folderRel, error: r.error } });
          }
        }).catch(() => {});
      } catch (saveErr: unknown) {
        const saveErrMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
        const failed = (msg.payload ?? {}) as { changeName?: string; requestId?: string };
        webview.postMessage({ type: 'saveError', payload: { changeName: failed.changeName ?? '', requestId: failed.requestId, msg: saveErrMsg } });
      }
      return true;
    }

    /* ── SQL lint for DmcrChangeRenderer (conversation change card) ── */
    case "lintSql": {
      const { id, sql: lintSqlText, which: lintWhich, requestId } = (msg.payload ?? {}) as { id?: string; sql?: string; which?: string; requestId?: string };
      const which = lintWhich ?? 'deploy';
      try {
        const res = await lintPostgresSql(lintSqlText ?? '');
        webview.postMessage({ type: 'lintResult', payload: { id, which, requestId, ok: res.ok, msg: res.msg } });
      } catch {
        webview.postMessage({ type: 'lintResult', payload: { id, which, requestId, ok: false, msg: 'Lint engine error' } });
      }
      return true;
    }

    /* ── Inline iframe forms: SQL lint ── */
    case "lint": {
      const { id, which, sql } = (msg.payload ?? {}) as { id?: number; which?: string; sql?: string };
      try {
        const res = await lintPostgresSql(sql ?? '');
        webview.postMessage({ type: 'lintResult', payload: { id, which, ok: res.ok, msg: res.msg } });
      } catch {
        webview.postMessage({ type: 'lintResult', payload: { id, which, ok: false, msg: 'Lint engine error' } });
      }
      return true;
    }

    /* ── Conversation session scope for audit ── */
    case "conversationSessionStart": {
      const { getMaxAuditId } = await import("../../../storage/db.js");
      ctx.state.inlineConvSessionStartId = getMaxAuditId();
      ctx.state.pendingGenerations = {};  // new chat: forget unconfirmed metadata forms
      return true;
    }

    /* ── Update active form type for cached form re-activation ── */
    case "setActiveForm": {
      const formName = (msg.payload as { form?: string })?.form ?? '';
      if (['ddl', 'insert', 'freeform', 'schema_diff'].includes(formName)) {
        ctx.state.activeFormType = formName;
      }
      return true;
    }

    /* ── Manual commit & push (from ChangeCard Commit button) ── */
    case 'manualCommitAndPush': {
      const { folderRel, requestId } = msg.payload as { folderRel: string; requestId?: string };
      const postCommit = (r: Record<string, unknown>) =>
        webview.postMessage({ type: 'commitResult', payload: { ...r, folderRel, requestId } });
      if (!folderRel) {
        postCommit({ ok: false, error: 'No folder path provided.' });
        return true;
      }
      try {
        const { isGitAvailable, isGitRepo, commitAndPush, getCurrentBranch } = await import('../../../services/git/git-service.js');
        if (!(await isGitAvailable()) || !(await isGitRepo())) {
          postCommit({ ok: false, error: 'Git not available or not a git repository.' });
          return true;
        }
        // Stage + commit with simple message
        const folderName = folderRel.split(/[\\/]/).pop() || folderRel;
        const commitMsg = `feat(dmcr): add change ${folderName}`;
        const result = await commitAndPush(folderRel, commitMsg);
        postCommit({ ...result });
      } catch (e: unknown) {
        postCommit({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    default:
      return false;
  }
}
