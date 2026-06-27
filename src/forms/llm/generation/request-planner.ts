import * as vscode from "vscode";
import { getResolvedPrompt } from "../../../storage/prompt-library";
import { callActiveLlm } from "../../../services/llm/core/llm-client";

export type DmcrNextStep =
  | { action: "generate"; normalizedRequest: string }
  | { action: "clarify"; question: string; suggestions: string[] }
  | { action: "cancel"; reason?: string };

function extractJsonObject(text: string): string {
  let t = text.trim();
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '');
  t = t.replace(/```$/i, '').trim();

  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return t.slice(start, end + 1);
  return t;
}

function isNextStep(x: unknown): x is DmcrNextStep {
  if (!x || typeof x !== "object" || typeof (x as Record<string,unknown>).action !== "string") return false;
  const o = x as Record<string, unknown>;

  if (o.action === "generate") {
    return typeof o.normalizedRequest === "string" && (o.normalizedRequest as string).trim().length > 0;
  }

  if (o.action === "clarify") {
    if (typeof o.question !== "string" || !(o.question as string).trim()) return false;
    if (!Array.isArray(o.suggestions)) return false;
    return (o.suggestions as unknown[]).every((s) => typeof s === "string" && (s as string).trim().length > 0);
  }

  if (o.action === "cancel") {
    return o.reason === undefined || (typeof o.reason === "string" && (o.reason as string).trim().length > 0);
  }

  return false;
}

export async function planNextStep(
  userRequest: string,
  token: vscode.CancellationToken
): Promise<DmcrNextStep> {
  const systemPrompt = getResolvedPrompt('REQUEST_PLANNER');

  const out = await callActiveLlm(
    systemPrompt,
    JSON.stringify({ userRequest }),
    0,
    token,
    undefined,
    '\n\nNow decide using the tool results above. Return STRICT JSON only.',
  );

  try {
    const parsed = JSON.parse(extractJsonObject(out));
    if (isNextStep(parsed)) return parsed;
  } catch {
    // fall through
  }

  // Safe fallback: ask dialect + missing details
  return {
    action: "clarify",
    question:
      "I can generate the DMCR change, but I need a bit more detail:\n" +
      "- Are we targeting PostgreSQL or Oracle?\n" +
      "- If this is an INSERT/seed: provide the columns + the exact 2 rows, plus the uniqueness key/conflict behavior, and whether deploy should be idempotent.\n" +
      "- If this is a function: provide the signature (params/types) and the return shape (columns/types).",
    suggestions: [
      "PostgreSQL",
      "Oracle",
      "PostgreSQL; idempotent: yes; unique key: (col1, col2); rows: [{\"col1\":\"...\",\"col2\":\"...\"},{\"col1\":\"...\",\"col2\":\"...\"}]",
      "cancel",
    ],
  };
}