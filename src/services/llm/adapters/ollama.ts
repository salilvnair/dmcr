/**
 * Ollama adapter.
 */
import type { CustomProviderConfig, ModelInfo, CustomLlmClient } from './types';

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\n?/gm, '').replace(/```\s*$/gm, '').trim();
}

type OllamaMsg = { role: string; content: string };

async function ollamaChat(cfg: CustomProviderConfig, messages: OllamaMsg[], model: string, temperature = 0.7): Promise<string> {
  const res = await fetch(cfg.chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.headers ?? {}) },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature } }),
  });
  if (!res.ok) throw new Error(`[ollama-adapter] chat failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? '';
}

export async function fetchOllamaModels(cfg: CustomProviderConfig): Promise<ModelInfo[]> {
  const res = await fetch(cfg.modelsUrl, { headers: { ...(cfg.headers ?? {}) } });
  if (!res.ok) throw new Error(`[ollama-adapter] fetchModels failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => ({ id: m.name, label: m.name, group: cfg.name, family: m.name }));
}

export function createOllamaClient(cfg: CustomProviderConfig): CustomLlmClient {
  return {
    async generateText(hint, context, model, temp) {
      const msgs: OllamaMsg[] = [];
      if (hint) msgs.push({ role: 'system', content: hint });
      msgs.push({ role: 'user', content: context || '' });
      return ollamaChat(cfg, msgs, model, temp);
    },
    async generateJson(hint, jsonSchema, context, model, temp) {
      const msgs: OllamaMsg[] = [
        { role: 'system', content: `You are a JSON extraction engine. Return ONLY valid JSON matching the schema. No markdown. No explanation.\nJSON Schema:\n${jsonSchema}` },
        { role: 'user', content: hint || context },
      ];
      return stripFences(await ollamaChat(cfg, msgs, model, temp));
    },
    async generateJsonStrict(hint, jsonSchema, context, model, temp) {
      const msgs: OllamaMsg[] = [
        { role: 'system', content: `Output ONLY the JSON object matching this schema. No markdown. No explanation.\nJSON Schema:\n${jsonSchema}` },
        { role: 'user', content: hint || context },
      ];
      let output = stripFences(await ollamaChat(cfg, msgs, model, temp));
      try { JSON.parse(output); } catch {
        msgs.push({ role: 'assistant', content: output });
        msgs.push({ role: 'user', content: 'Return ONLY the JSON object. No markdown.' });
        output = stripFences(await ollamaChat(cfg, msgs, model, temp));
      }
      return output;
    },
  };
}
