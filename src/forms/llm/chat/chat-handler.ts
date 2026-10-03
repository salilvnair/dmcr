import * as vscode from "vscode";
import * as path from "path";
import {
  generateDmcrChangeWithCopilot,
  generateDmcrChangeWithCustomClient,
  loadDmcrContextText,
} from "../generation/generator";
import { getActiveCustomProviderKey, getActiveFamily } from "../../../services/llm/core/llm-settings";
import { getAllCustomProviders, createCustomProviderClient } from "../../../services/llm/core/custom-providers";
import { CHANGE_ID_WIDTH, getChangesDirSetting, resolveChangesDir } from "../../../storage/changes-dir";
import { detectIntentAndRisks } from "../generation/intent-detector";
import { FOLLOW_UPS, FollowUpQuestion } from "../../core/types/followups";
import { planNextStep } from "../generation/request-planner";
import { decideFollowUpAction } from "../generation/followup-decider";
import { DmcrIntentResult } from "../../core/types/intent";
import { openAddColumnsForm } from "../../core/panels/add-columns-form";
import { openInsertRowsForm } from "../../core/panels/insert-rows-form";
import { openFormsBootstrapForm } from "../../core/panels/bootstrap-form";
import { openFreeformSqlForm } from "../../core/panels/freeform-sql-form";

type PendingFollowUpMode = "choose" | "awaiting_clarification";
type PendingFollowUpState = {
  originalText: string;
  followUp: FollowUpQuestion;
  intent: DmcrIntentResult;
  mode: PendingFollowUpMode;
};

let pendingFollowUp: PendingFollowUpState | null = null;

const OPEN_FORMS_FOLLOWUP: vscode.ChatFollowup = { prompt: "forms", label: "Open forms" };

function stripLeadingDmcrMention(s: string): string {
  let t = s.trim();
  if (t.toLowerCase().startsWith("@dmcr")) {
    t = t.slice("@dmcr".length).trim();
  }
  return t;
}

function norm(s: string) {
  return stripLeadingDmcrMention(s).trim().toLowerCase();
}

function mergeClarification(originalText: string, clarification: string): string {
  const o = originalText.trim();
  const c = clarification.trim();
  if (!o) return c;
  if (!c) return o;
  return `${o}\n\nClarification:\n${c}`;
}

function followupsForQuestion(q: FollowUpQuestion): vscode.ChatFollowup[] {
  return q.options.map(o => ({ prompt: o.id, label: o.label }));
}

function followupsForSuggestions(suggestions: string[]): vscode.ChatFollowup[] {
  return (suggestions ?? [])
    .filter(s => typeof s === "string" && s.trim())
    .slice(0, 8)
    .map(s => ({ prompt: s, label: s }));
}

function resultWithFollowups(followups: vscode.ChatFollowup[]): vscode.ChatResult {
  return { metadata: { dmcr_followups: followups } };
}

function buildSafeSplitPrompt(originalText: string, intent: DmcrIntentResult): string {
  const risks = (intent.risks ?? []).join(", ");

  return [
    originalText.trim(),
    "",
    "SAFETY MODE: Generate a safe multi-step plan with minimal locking.",
    `Detected risks: ${risks || "unknown"}.`,
    "",
    "Requirements:",
    "- Prefer steps like: add nullable column(s) WITHOUT DEFAULT, then backfill, then set DEFAULT/NOT NULL if needed.",
    "- Use Postgres-safe techniques: lock_timeout and statement_timeout (SET LOCAL inside a transaction) to avoid blocking traffic.",
    "- Avoid full table rewrites where possible.",
    "- If a constraint/index could block writes, prefer safer sequencing (or concurrent index where applicable).",
    "- Keep output as normal DMCR JSON (deploy/verify/revert).",
  ].join("\n");
}

// export function chatRequestHandler(opts: { extensionUri: vscode.Uri }): vscode.ChatRequestHandler {
//   const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
//     const rawText = (request.prompt ?? "").trim();
//     const text = rawText;

//     try {
//       if (!text || text === "help") {
//         stream.markdown(helpText());
//         return {};
//       }

//       if (norm(text) === "forms") {
//         pendingFollowUp = null;

//         while (true) {
//           const choice = await openFormsBootstrapForm({
//             extensionUri: opts.extensionUri,
//             title: "DMCR: Available forms",
//           });

//           // Cancelled from the bootstrap launcher itself → current behavior
//           if (!choice) {
//             stream.markdown("❌ Cancelled.");
//             return {};
//           }

//           if (choice === "open_freeform_sql_form") {
//             const normalizedRequest = await openFreeformSqlForm({
//               extensionUri: opts.extensionUri,
//               title: "DMCR: SQL → verify/revert (PostgreSQL)",
//             });

//             // Cancelled from the Freeform SQL form → go back to launcher
//             if (!normalizedRequest) continue;

//             return (await handleNewRequest(normalizedRequest, stream, token)) ?? {};
//           }

//           if (choice === "open_add_columns_form") {
//             const normalizedRequest = await openAddColumnsForm({
//               extensionUri: opts.extensionUri,
//               title: "DMCR: Add columns (PostgreSQL)",
//             });

//             // Cancelled from the Add Columns form → go back to launcher
//             if (!normalizedRequest) continue;

//             return (await handleNewRequest(normalizedRequest, stream, token)) ?? {};
//           }

//           if (choice === "open_insert_rows_form") {
//             const normalizedRequest = await openInsertRowsForm({
//               extensionUri: opts.extensionUri,
//               title: "DMCR: Insert rows (PostgreSQL)",
//             });

//             // Cancelled from the Insert Rows form → go back to launcher
//             if (!normalizedRequest) continue;

//             return (await handleNewRequest(normalizedRequest, stream, token)) ?? {};
//           }

//           stream.markdown("Unknown form selection.");
//           return {};
//         }
//       }
      
//       if (norm(text) === "open_freeform_sql_form") {
//         pendingFollowUp = null;

//         const normalizedRequest = await openFreeformSqlForm({
//           extensionUri: opts.extensionUri,
//           title: "DMCR: SQL → verify/revert (PostgreSQL)",
//         });

//         if (!normalizedRequest) {
//           stream.markdown("❌ Cancelled.");
//           return {};
//         }

//         return (await handleNewRequest(normalizedRequest, stream, token)) ?? {};
//       }

//       if (norm(text) === "open_add_columns_form") {
//         pendingFollowUp = null;

//         const normalizedRequest = await openAddColumnsForm({
//           extensionUri: opts.extensionUri,
//           title: "DMCR: Add columns (PostgreSQL)",
//         });

//         if (!normalizedRequest) {
//           stream.markdown("❌ Cancelled.");
//           return {};
//         }

//         return (await handleNewRequest(normalizedRequest, stream, token)) ?? {};
//       }

//       if (norm(text) === "open_insert_rows_form") {
//         pendingFollowUp = null;

//         const normalizedRequest = await openInsertRowsForm({
//           extensionUri: opts.extensionUri,
//           title: "DMCR: Insert rows (PostgreSQL)",
//         });

//         if (!normalizedRequest) {
//           stream.markdown("❌ Cancelled.");
//           return {};
//         }

//         return (await handleNewRequest(normalizedRequest, stream, token)) ?? {};
//       }

//       // -----------------------------
//       // Resume follow-up
//       // -----------------------------
//       if (pendingFollowUp) {
//         const prev = pendingFollowUp;
//         const reply = stripLeadingDmcrMention(text);

//         // After we ask a clarification question, next message is a NEW request
//         if (prev.mode === "awaiting_clarification") {
//           const lower = norm(reply);
//           if (lower === "cancel") {
//             pendingFollowUp = null;
//             stream.markdown("❌ Cancelled.");
//             return {};
//           }

//           pendingFollowUp = null;
//           const merged = mergeClarification(prev.originalText, reply);
//           return (await handleNewRequest(merged, stream, token)) ?? {};
//         }

//         stream.progress("Interpreting your reply…");
//         const decision = await decideFollowUpAction(reply, prev, token);

//         pendingFollowUp = null;

//         if (decision.action === "cancel") {
//           stream.markdown("❌ Cancelled.");
//           return {};
//         }

//         if (decision.action === "unknown") {
//           pendingFollowUp = prev;
//           stream.markdown(`⚠️ ${decision.message}\n\n`);
//           stream.markdown(prev.followUp.question);
//           stream.markdown("\n(Use the follow-up buttons below, or type a reply.)\n");
//           const extra = prev.intent?.risks?.includes("AMBIGUOUS") ? [OPEN_FORMS_FOLLOWUP] : [];
//           return resultWithFollowups([...extra, ...followupsForQuestion(prev.followUp)]);
//         }

//         if (decision.action === "clarify") {
//           pendingFollowUp = { ...prev, mode: "awaiting_clarification" };

//           let msg = `❓ **${decision.question}**\n\n`;
//           for (const s of decision.suggestions) {
//             msg += `- \`${s}\`\n`;
//           }
//           stream.markdown(msg);

//           const extra: vscode.ChatFollowup[] = [
//              OPEN_FORMS_FOLLOWUP,
//              ...(looksLikeAddColumnsRequest(text)
//               ? [{ prompt: "open_add_columns_form", label: "Open add-columns form" }]
//               : []),
//           ];
            
//           return resultWithFollowups([
//             ...extra,
//             ...followupsForSuggestions(decision.suggestions),
//             { prompt: "cancel", label: "Cancel" },
//           ]);
//         }

//         if (decision.action === "safe_split") {

//           stream.progress("Generating safe-split DMCR change…");
//           const safePrompt = buildSafeSplitPrompt(prev.originalText, prev.intent);
//           await continueGeneration(safePrompt, stream, token);
//           return {};
//         }

//         // generate_anyway
//         await continueGeneration(prev.originalText, stream, token);
//         return {};
//       }

//       // -----------------------------
//       // Fresh request
//       // -----------------------------
//       return (await handleNewRequest(text, stream, token)) ?? {};
//     } catch (err: any) {
//       const msg = err?.message ? String(err.message) : String(err);
//       stream.markdown(`**DMCR error:** ${msg}`);
//       return {};
//     }
//   };

//   return handler;
// }

export function chatRequestHandler(opts: { extensionUri: vscode.Uri }): vscode.ChatRequestHandler {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
    const rawText = (request.prompt ?? "").trim();
    const text = rawText;

    try {
      if (!text || text === "help") {
        stream.markdown(helpText());
        return {};
      }

      if (norm(text) === "forms") {
        pendingFollowUp = null;

        while (true) {
          const choice = await openFormsBootstrapForm({
            extensionUri: opts.extensionUri,
            title: "DMCR: Available forms",
          });

          // Cancelled from the bootstrap launcher itself → current behavior
          if (!choice) {
            stream.markdown("❌ Cancelled.");
            return {};
          }

          if (choice === "open_freeform_sql_form") {
            const formResult = await openFreeformSqlForm({
              extensionUri: opts.extensionUri,
              title: "DMCR: SQL → verify/revert (PostgreSQL)",
            });

            // Cancelled from the Freeform SQL form → go back to launcher
            if (!formResult) continue;

            // IMPORTANT: forms already produce normalized prompts; do NOT run planNextStep again
            await continueGeneration(formResult.normalizedRequest, stream, token);
            return {};
          }

          if (choice === "open_add_columns_form") {
            const formResult = await openAddColumnsForm({
              extensionUri: opts.extensionUri,
              title: "DMCR: Add columns (PostgreSQL)",
            });

            // Cancelled from the Add Columns form → go back to launcher
            if (!formResult) continue;

            await continueGeneration(formResult.normalizedRequest, stream, token);
            return {};
          }

          if (choice === "open_insert_rows_form") {
            const formResult = await openInsertRowsForm({
              extensionUri: opts.extensionUri,
              title: "DMCR: Insert rows (PostgreSQL)",
            });

            // Cancelled from the Insert Rows form → go back to launcher
            if (!formResult) continue;

            await continueGeneration(formResult.normalizedRequest, stream, token);
            return {};
          }

          stream.markdown("Unknown form selection.");
          return {};
        }
      }

      if (norm(text) === "open_freeform_sql_form") {
        pendingFollowUp = null;

        const formResult = await openFreeformSqlForm({
          extensionUri: opts.extensionUri,
          title: "DMCR: SQL → verify/revert (PostgreSQL)",
        });

        if (!formResult) {
          stream.markdown("❌ Cancelled.");
          return {};
        }

        await continueGeneration(formResult.normalizedRequest, stream, token);
        return {};
      }

      if (norm(text) === "open_add_columns_form") {
        pendingFollowUp = null;

        const formResult = await openAddColumnsForm({
          extensionUri: opts.extensionUri,
          title: "DMCR: Add columns (PostgreSQL)",
        });

        if (!formResult) {
          stream.markdown("❌ Cancelled.");
          return {};
        }

        await continueGeneration(formResult.normalizedRequest, stream, token);
        return {};
      }

      if (norm(text) === "open_insert_rows_form") {
        pendingFollowUp = null;

        const formResult = await openInsertRowsForm({
          extensionUri: opts.extensionUri,
          title: "DMCR: Insert rows (PostgreSQL)",
        });

        if (!formResult) {
          stream.markdown("❌ Cancelled.");
          return {};
        }

        await continueGeneration(formResult.normalizedRequest, stream, token);
        return {};
      }

      // -----------------------------
      // Resume follow-up
      // -----------------------------
      if (pendingFollowUp) {
        const prev = pendingFollowUp;
        const reply = stripLeadingDmcrMention(text);

        // After we ask a clarification question, next message is a NEW request
        if (prev.mode === "awaiting_clarification") {
          const lower = norm(reply);
          if (lower === "cancel") {
            pendingFollowUp = null;
            stream.markdown("❌ Cancelled.");
            return {};
          }

          pendingFollowUp = null;
          const merged = mergeClarification(prev.originalText, reply);
          return (await handleNewRequest(merged, stream, token)) ?? {};
        }

        stream.progress("Interpreting your reply…");
        const decision = await decideFollowUpAction(reply, prev, token);

        pendingFollowUp = null;

        if (decision.action === "cancel") {
          stream.markdown("❌ Cancelled.");
          return {};
        }

        if (decision.action === "unknown") {
          pendingFollowUp = prev;
          stream.markdown(`⚠️ ${decision.message}\n\n`);
          stream.markdown(prev.followUp.question);
          stream.markdown("\n(Use the follow-up buttons below, or type a reply.)\n");
          const extra = prev.intent?.risks?.includes("AMBIGUOUS") ? [OPEN_FORMS_FOLLOWUP] : [];
          return resultWithFollowups([...extra, ...followupsForQuestion(prev.followUp)]);
        }

        if (decision.action === "clarify") {
          pendingFollowUp = { ...prev, mode: "awaiting_clarification" };

          let msg = `❓ **${decision.question}**\n\n`;
          for (const s of decision.suggestions) {
            msg += `- \`${s}\`\n`;
          }
          stream.markdown(msg);

          const extra: vscode.ChatFollowup[] = [
            OPEN_FORMS_FOLLOWUP,
            ...(looksLikeAddColumnsRequest(text)
              ? [{ prompt: "open_add_columns_form", label: "Open add-columns form" }]
              : []),
          ];

          return resultWithFollowups([
            ...extra,
            ...followupsForSuggestions(decision.suggestions),
            { prompt: "cancel", label: "Cancel" },
          ]);
        }

        if (decision.action === "safe_split") {
          stream.progress("Generating safe-split DMCR change…");
          const safePrompt = buildSafeSplitPrompt(prev.originalText, prev.intent);
          await continueGeneration(safePrompt, stream, token);
          return {};
        }

        // generate_anyway
        await continueGeneration(prev.originalText, stream, token);
        return {};
      }

      // -----------------------------
      // Fresh request
      // -----------------------------
      return (await handleNewRequest(text, stream, token)) ?? {};
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : String(err);
      stream.markdown(`**DMCR error:** ${msg}`);
      return {};
    }
  };

  return handler;
}

// async function handleNewRequest(
//   text: string,
//   stream: vscode.ChatResponseStream,
//   token: vscode.CancellationToken
// ): Promise<vscode.ChatResult | void> {
//   stream.progress("Starting DMCR generation…");

//   stream.progress("Planning next step…");
//   const step = await planNextStep(text, token);

//   if (step.action === "cancel") {
//     stream.markdown("❌ Cancelled.");
//     return;
//   }

//   if (step.action === "clarify") {
//     stream.markdown(`❓ **${step.question}**\n`);

//     pendingFollowUp = {
//       originalText: text,
//       followUp: { question: step.question, options: [{ id: "cancel", label: "Cancel" }] },
//       intent: { intent: "UNKNOWN", risks: ["AMBIGUOUS"], confidence: 0 },
//       mode: "awaiting_clarification",
//     };

//     return resultWithFollowups([
//        OPEN_FORMS_FOLLOWUP,
//        ...(looksLikeAddColumnsRequest(text)
//         ? [{ prompt: "open_add_columns_form", label: "Open add-columns form" }]
//         : []),
//       ...followupsForSuggestions(step.suggestions),
//       { prompt: "cancel", label: "Cancel" },
//     ]);
//   }

//   // step.action === "generate"
//   const normalized = step.normalizedRequest;

//   stream.progress("Analyzing intent and change risks…");
//   const intent = await detectIntentAndRisks(normalized, token);

//   if (intent.risks.length > 0) {
//     const risk = intent.risks[0];
//     const followUp = FOLLOW_UPS[risk] ?? FOLLOW_UPS.AMBIGUOUS;

//     // Keep the follow-up response SMALL so chips aren't far down
//     stream.markdown("⚠️ **Potential change risk detected**\n\n");
//     stream.markdown(followUp.question);
//     stream.markdown("\n(Use the follow-up buttons below, or type a reply.)\n");

//     pendingFollowUp = { originalText: text, followUp, intent, mode: "choose" };
//     const extra = risk === "AMBIGUOUS" ? [OPEN_FORMS_FOLLOWUP] : [];
//     return resultWithFollowups([...extra, ...followupsForQuestion(followUp)]);
//   }

//   // No risk → proceed normally
//   await continueGeneration(text, stream, token);
// }

async function handleNewRequest(
  text: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult | void> {
  stream.progress("Starting DMCR generation…");

  stream.progress("Planning next step…");
  const step = await planNextStep(text, token);

  if (step.action === "cancel") {
    stream.markdown("❌ Cancelled.");
    return;
  }

  if (step.action === "clarify") {
    stream.markdown(`❓ **${step.question}**\n`);

    pendingFollowUp = {
      originalText: text,
      followUp: { question: step.question, options: [{ id: "cancel", label: "Cancel" }] },
      intent: { intent: "UNKNOWN", risks: ["AMBIGUOUS"], confidence: 0 },
      mode: "awaiting_clarification",
    };

    return resultWithFollowups([
      OPEN_FORMS_FOLLOWUP,
      ...(looksLikeAddColumnsRequest(text)
        ? [{ prompt: "open_add_columns_form", label: "Open add-columns form" }]
        : []),
      ...followupsForSuggestions(step.suggestions),
      { prompt: "cancel", label: "Cancel" },
    ]);
  }

  // step.action === "generate"
  const normalized = step.normalizedRequest;

  stream.progress("Analyzing intent and change risks…");
  const intent = await detectIntentAndRisks(normalized, token);

  if (intent.risks.length > 0) {
    const risk = intent.risks[0];
    const followUp = FOLLOW_UPS[risk] ?? FOLLOW_UPS.AMBIGUOUS;

    // Keep the follow-up response SMALL so chips aren't far down
    stream.markdown("⚠️ **Potential change risk detected**\n\n");
    stream.markdown(followUp.question);
    stream.markdown("\n(Use the follow-up buttons below, or type a reply.)\n");

    pendingFollowUp = { originalText: text, followUp, intent, mode: "choose" };
    const extra = risk === "AMBIGUOUS" ? [OPEN_FORMS_FOLLOWUP] : [];
    return resultWithFollowups([...extra, ...followupsForQuestion(followUp)]);
  }

  // No risk → proceed normally
  await continueGeneration(normalized, stream, token);
}

async function continueGeneration(
  text: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
) {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    stream.markdown("No workspace folder open.");
    return;
  }

  stream.progress("Parsing request…");

  const changesDir = getChangesDirSetting();
  const idWidth = CHANGE_ID_WIDTH;

  const changesAbs = resolveChangesDir();

  stream.progress("Loading DMCR context (dmcr.ps1 / dmcr.cfg / ddl)…");
  const dmcrContext = await loadDmcrContextText(ws);

  // Same provider the DMCR panel uses: a custom provider if one is active, otherwise the
  // Copilot model family chosen in Settings → LLM Provider.
  const customKey = getActiveCustomProviderKey();
  let generated;
  if (customKey) {
    const providerCfg = getAllCustomProviders().find(p => p.key === customKey);
    if (!providerCfg) { throw new Error(`Custom provider '${customKey}' not found. Check Settings → LLM Provider.`); }
    stream.progress(`Asking ${providerCfg.name} to generate deploy/verify/revert SQL…`);
    const client = await createCustomProviderClient(customKey);
    generated = await generateDmcrChangeWithCustomClient(client, providerCfg.activeModel ?? '', text, dmcrContext);
  } else {
    stream.progress("Asking Copilot to generate deploy/verify/revert SQL…");
    generated = await generateDmcrChangeWithCopilot(text, dmcrContext, token, undefined, getActiveFamily() || undefined);
  }

  stream.progress("Computing next change id…");
  const nextId = await computeNextChangeId(changesAbs, idWidth, generated.changeName);
  const folderAbs = path.join(changesAbs, nextId);

  const changeId = nextId;
  const deploySql = applyChangeId(generated.deploySql, changeId, generated.changeName);
  const verifySql = applyChangeId(generated.verifySql, changeId, generated.changeName);
  const revertSql = applyChangeId(generated.revertSql, changeId, generated.changeName);

  stream.progress(`Creating folder ${path.join(changesDir, nextId)}…`);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(folderAbs));

  stream.progress("Writing deploy.sql…");
  await writeFile(folderAbs, "deploy.sql", deploySql);

  stream.progress("Writing verify.sql…");
  await writeFile(folderAbs, "verify.sql", verifySql);

  stream.progress("Writing revert.sql…");
  await writeFile(folderAbs, "revert.sql", revertSql);

  // Write meta.json if present
  if (generated.metaJson) {
    stream.progress("Writing meta.json…");
    await writeFile(folderAbs, "meta.json", generated.metaJson);
  }

  const folderRel = path.join(changesDir, nextId);
  const deployUri = vscode.Uri.file(path.join(folderAbs, "deploy.sql"));
  const verifyUri = vscode.Uri.file(path.join(folderAbs, "verify.sql"));
  const revertUri = vscode.Uri.file(path.join(folderAbs, "revert.sql"));
  const changesBaseUri = vscode.Uri.file(changesAbs);

  stream.markdown(`### DMCR change created: \`${folderRel}\``);
  stream.markdown("## **Files**:");
  stream.anchor(deployUri, "Open deploy.sql");
  stream.anchor(verifyUri, "Open verify.sql");
  stream.anchor(revertUri, "Open revert.sql");

  stream.filetree(
    [
      {
        name: nextId,
        children: [
          { name: "deploy.sql" },
          { name: "verify.sql" },
          { name: "revert.sql" },
        ],
      },
    ],
    changesBaseUri
  );

  // Optional action buttons (these are command buttons, not followup chips)
  stream.button({ title: "Open deploy.sql", command: "vscode.open", arguments: [deployUri] });
  stream.button({ title: "Open verify.sql", command: "vscode.open", arguments: [verifyUri] });
  stream.button({ title: "Open revert.sql", command: "vscode.open", arguments: [revertUri] });

  stream.progress("Done.");
  await vscode.window.showTextDocument(deployUri, { preview: false });
}

/* ===================================================================== */
/* ======================  HELPERS ========================= */
/* ===================================================================== */

type VerifyMode = "raise" | "select";

function applyChangeId(sql: string, changeId: string, changeName: string): string {
  let out = sql;

  // Preferred: placeholder replacement
  if (out.includes("__DMCR_CHANGE_ID__")) {
    out = out.replace(/__DMCR_CHANGE_ID__/g, changeId);
    return out;
  }

  // Back-compat: if model used slug directly, rewrite only dmcr.change_log checks
  // Handle: dmcr.change_log.change_id = '...'
  out = out.replace(
    /(dmcr\s*\.\s*change_log\s*\.\s*change_id\s*=\s*)'[^']*'/gi,
    `$1'${changeId}'`
  );

  // Handle: change_id = '...'
  out = out.replace(
    /(\bchange_id\s*=\s*)'[^']*'/gi,
    `$1'${changeId}'`
  );

  // Last resort: replace exact slug if it appears quoted
  out = out.replace(new RegExp(`'${escapeRegExp(changeName)}'`, "g"), `'${changeId}'`);

  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function helpText() {
  return [
    "**@dmcr** generates a DMCR change folder with `deploy.sql`, `verify.sql`, `revert.sql`.",
    "",
    "Examples:",
    "- `@dmcr Add table customer with id bigserial primary key, email text unique not null`",
    "- `@dmcr Add column phone text to public.customer`",
    "- `@dmcr Create sequence order_id_seq and use it as default for public.orders.order_id`",
    "- `@dmcr Backfill customer.full_name from first_name + last_name, then set NOT NULL`",
  ].join("\n");
}

type Parsed =
  | { kind: "ddl.createTable"; table: string; columnsRaw: string; slug: string }
  | { kind: "ddl.addColumn"; table: string; column: string; colType: string; tail: string; slug: string }
  | { kind: "dml.seedCustomer"; email: string; name: string; slug: string };

function stripQuotes(s: string) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

async function computeNextChangeId(
  changesAbs: string,
  width: number,
  slug: string
): Promise<string> {
  let next = 1;

  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(changesAbs));
    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.Directory) continue;
      const m = name.match(/^(\d+)_/);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= next) next = n + 1;
    }
  } catch (err) {
    console.error("Error computing next change ID:", err);
  }

  const prefix = String(next).padStart(width, "0");
  const safeSlug = slugify(slug);
  return `${prefix}_${safeSlug}`;
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function looksLikeAddColumnsRequest(s: string): boolean {
  const t = s.toLowerCase();
  return t.includes("alter table") || t.includes("add column") || t.includes("add columns");
}

async function writeFile(folderAbs: string, fileName: string, content: string) {
  const fileUri = vscode.Uri.file(path.join(folderAbs, fileName));
  await vscode.workspace.fs.writeFile(
    fileUri,
    Buffer.from(content.replace(/\r?\n/g, "\r\n"), "utf8")
  );
}