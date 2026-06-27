/**
 * Anthropic adapter.
 */
import type { CustomProviderConfig, ModelInfo, CustomLlmClient } from './types';

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\n?/gm, '').replace(/```\s*$/gm, '').trim();
}

function buildHeaders(cfg: CustomProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {}),
    ...(cfg.headers ?? {}),
  };
}

type AnthMsg = { role: 'user' | 'assistant'; content: string };

async function anthropicChat(cfg: CustomProviderConfig, system: string | undefined, messages: AnthMsg[], model: string, temperature = 0.7): Promise<string> {
  const body: Record<string, unknown> = { model, max_tokens: 4096, temperature, messages };
  if (system) body.system = system;
  const res = await fetch(cfg.chatUrl, { method: 'POST', headers: buildHeaders(cfg), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`[anthropic-adapter] chat failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return data.content?.find((c) => c.type === 'text')?.text ?? '';
}

export async function fetchAnthropicModels(cfg: CustomProviderConfig): Promise<ModelInfo[]> {
  const res = await fetch(cfg.modelsUrl, { headers: buildHeaders(cfg) });
  if (!res.ok) throw new Error(`[anthropic-adapter] fetchModels failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data?: { id: string; display_name?: string }[] };
  return (data.data ?? []).map((m) => ({ id: m.id, label: m.display_name || m.id, group: cfg.name, family: m.id }));
}

export function createAnthropicClient(cfg: CustomProviderConfig): CustomLlmClient {
  return {
    async generateText(hint, context, model, temp) {
      return anthropicChat(cfg, hint || undefined, [{ role: 'user', content: context || '' }], model, temp);
    },
    async generateJson(hint, jsonSchema, context, model, temp) {
      const system = `You are a JSON extraction engine. Return ONLY valid JSON matching the schema. No markdown. No explanation.\nJSON Schema:\n${jsonSchema}`;
      return stripFences(await anthropicChat(cfg, system, [{ role: 'user', content: hint || context }], model, temp));
    },
    async generateJsonStrict(hint, jsonSchema, context, model, temp) {
      const system = `You are a JSON extraction engine. Output ONLY the JSON object matching the schema. No markdown. No explanation.\nJSON Schema:\n${jsonSchema}`;
      let output = stripFences(await anthropicChat(cfg, system, [{ role: 'user', content: hint || context }], model, temp));
      try { JSON.parse(output); } catch {
        output = stripFences(await anthropicChat(cfg, system, [
          { role: 'user', content: hint || context },
          { role: 'assistant', content: output },
          { role: 'user', content: 'The response was not valid JSON. Return ONLY the JSON object.' },
        ], model, temp));
      }
      return output;
    },
  };
}
