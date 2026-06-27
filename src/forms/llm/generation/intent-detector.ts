import * as vscode from "vscode";
import { DmcrIntentResult } from "../../core/types/intent";
import { getResolvedPrompt } from "../../../storage/prompt-library";
import { callActiveLlm } from "../../../services/llm/core/llm-client";

export async function detectIntentAndRisks(
  userPrompt: string,
  token: vscode.CancellationToken
): Promise<DmcrIntentResult> {

  const systemPrompt = getResolvedPrompt('INTENT_DETECTOR');

  const text = await callActiveLlm(
    systemPrompt,
    userPrompt,
    0,
    token,
    undefined,
    '\n\nNow classify the intent using the tool results above. Return STRICT JSON only.',
  );

  let parsed: DmcrIntentResult | null = null;
  try {
    const obj = JSON.parse(extractJsonObject(text));
    if (isIntentResult(obj)) parsed = obj;
  } catch {}

  if (!parsed) {
    return { intent: "UNKNOWN", risks: ["AMBIGUOUS"], confidence: 0.0 };
  }

  // force follow-up when uncertain
  if (parsed.intent === "UNKNOWN" || parsed.confidence < 0.7) {
    if (!parsed.risks.includes("AMBIGUOUS")) parsed.risks.unshift("AMBIGUOUS");
  }

  return parsed;
}

function extractJsonObject(text: string): string {
  let t = text.trim();
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  t = t.replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return t.slice(start, end + 1);
  return t;
}

function isIntentResult(x: unknown): x is DmcrIntentResult {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.intent === "string" && Array.isArray(o.risks) && typeof o.confidence === "number";
}
