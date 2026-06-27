import * as vscode from "vscode";
import { FollowUpQuestion } from "../../core/types/followups";
import { DmcrIntentResult } from "../../core/types/intent";
import { getResolvedPrompt } from "../../../storage/prompt-library";
import { callActiveLlm } from "../../../services/llm/core/llm-client";

export type FollowUpDecision =
  | { action: "cancel" }
  | { action: "generate_anyway" }
  | { action: "safe_split" }
  | { action: "clarify"; question: string; suggestions: string[] }
  | { action: "unknown"; message: string };

function norm(s: string) {
  return s.trim().toLowerCase();
}

function extractJsonObject(text: string): string {
  let t = text.trim();

  // Strip common fenced-code wrappers
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  t = t.replace(/```$/i, "").trim();

  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return t.slice(start, end + 1);
  }
  return t;
}

function isValidDecisionShape(x: unknown): x is FollowUpDecision {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.action !== "string") return false;

  if (o.action === "cancel") return true;
  if (o.action === "generate_anyway") return true;
  if (o.action === "safe_split") return true;

  if (o.action === "unknown") {
    return typeof o.message === "string" && (o.message as string).trim().length > 0;
  }

  if (o.action === "clarify") {
    if (typeof o.question !== "string" || !(o.question as string).trim()) return false;
    if (!Array.isArray(o.suggestions)) return false;
    return (o.suggestions as unknown[]).every((s) => typeof s === "string" && (s as string).trim());
  }

  return false;
}

export async function decideFollowUpAction(
  userReply: string,
  pending: {
    originalText: string;
    followUp: FollowUpQuestion;
    intent: DmcrIntentResult;
  },
  token: vscode.CancellationToken
): Promise<FollowUpDecision> {
  const reply = norm(userReply.replace(/^@dmcr\b/i, "").trim());

  // Fast-path: if user typed an option id, don't call the model
  if (reply === "cancel") return { action: "cancel" };
  if (reply === "safe_split") return { action: "safe_split" };
  if (reply === "generate_anyway") return { action: "generate_anyway" };

  const systemPrompt = getResolvedPrompt('FOLLOWUP_DECIDER');

  const payload = {
    originalRequest: pending.originalText,
    intent: pending.intent,
    followUpQuestion: pending.followUp.question,
    options: pending.followUp.options,
    userReply,
  };

  const out = await callActiveLlm(
    systemPrompt,
    JSON.stringify(payload),
    0,
    token,
    undefined,
    '\n\nNow decide using the tool results above. Return STRICT JSON only.',
  );

  try {
    const parsed = JSON.parse(extractJsonObject(out));
    if (isValidDecisionShape(parsed)) return parsed;
  } catch {}

  return { action: "unknown", message: "Could not parse decision." };
}