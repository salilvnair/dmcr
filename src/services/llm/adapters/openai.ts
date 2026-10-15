/**
 * OpenAI-compatible adapter.
 * Works with any API that speaks the OpenAI REST protocol.
 */
import type { CustomProviderConfig, ModelInfo, CustomLlmClient } from './types';

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\n?/gm, '').replace(/```\s*$/gm, '').trim();
}

function buildHeaders(cfg: CustomProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    ...(cfg.headers ?? {}),
  };
}

type OAMessage = { role: string; content: string };

/**
 * A provider can accept a request and then send nothing (only SSE keep-alive comments) for minutes, as DeepSeek
 * does when overloaded. Without a limit every AI feature waits forever ("Ordering…", "Gate…"), so give up after
 * this long without an answer, or without any streamed data (keep-alives do not count), and say so.
 */
const NO_ANSWER_MS = 90_000;
const host = (cfg: CustomProviderConfig) => { try { return new URL(cfg.chatUrl).host; } catch { return cfg.name || 'the AI provider'; } };
const noAnswer = (cfg: CustomProviderConfig, model: string) => new Error(`${cfg.name || host(cfg)} (${model}) sent no answer for ${NO_ANSWER_MS / 1000} s; the provider may be overloaded or down. Try again later, or pick another model in Settings > LLM Provider.`);

async function oaChat(cfg: CustomProviderConfig, messages: OAMessage[], model: string, temperature = 0.7): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), NO_ANSWER_MS * 2);
  try {
    const res = await fetch(cfg.chatUrl, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({ model, messages, temperature }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`[openai-adapter] chat failed ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    if (ac.signal.aborted) throw noAnswer(cfg, model);
    throw e;
  } finally { clearTimeout(timer); }
}

async function oaChatStream(
  cfg: CustomProviderConfig,
  messages: OAMessage[],
  model: string,
  onToken: (delta: string) => void,
  temperature = 0.7
): Promise<string> {
  // aborted when no data line (an answer or the model's reasoning) arrives for NO_ANSWER_MS
  const ac = new AbortController();
  let idle = setTimeout(() => ac.abort(), NO_ANSWER_MS);
  const alive = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), NO_ANSWER_MS); };
  try {
    const res = await fetch(cfg.chatUrl, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({ model, messages, temperature, stream: true }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`[openai-adapter] stream failed ${res.status}: ${await res.text()}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('[openai-adapter] no response body for streaming');
    const decoder = new TextDecoder();
    let full = '';
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        // ": keep-alive" comments are not an answer
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        alive();
        try {
          const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[] };
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) { full += token; onToken(token); }
        } catch { /* skip malformed SSE line */ }
      }
    }
    return full;
  } catch (e) {
    if (ac.signal.aborted) throw noAnswer(cfg, model);
    throw e;
  } finally { clearTimeout(idle); }
}

export async function fetchOpenAiModels(cfg: CustomProviderConfig): Promise<ModelInfo[]> {
  const res = await fetch(cfg.modelsUrl, { headers: buildHeaders(cfg) });
  if (!res.ok) throw new Error(`[openai-adapter] fetchModels failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  const seen = new Set<string>();
  return (data.data ?? []).reduce<ModelInfo[]>((acc, m) => {
    if (!m.id || seen.has(m.id)) return acc;
    seen.add(m.id);
    acc.push({ id: m.id, label: m.id, group: cfg.name, family: m.id });
    return acc;
  }, []);
}

export function createOpenAiClient(cfg: CustomProviderConfig): CustomLlmClient {
  return {
    async generateText(hint, context, model, temp) {
      const msgs: OAMessage[] = [];
      if (hint) msgs.push({ role: 'system', content: hint });
      msgs.push({ role: 'user', content: context || '' });
      return oaChat(cfg, msgs, model, temp);
    },
    async stream(hint, context, model, onToken, temp) {
      const msgs: OAMessage[] = [];
      if (hint) msgs.push({ role: 'system', content: hint });
      msgs.push({ role: 'user', content: context || '' });
      return oaChatStream(cfg, msgs, model, onToken, temp);
    },
    async generateJson(hint, jsonSchema, context, model, temp) {
      const msgs: OAMessage[] = [
        { role: 'system', content: 'You are a JSON extraction engine. Return ONLY valid JSON matching the provided schema. No markdown fences. No explanation.' },
        { role: 'system', content: `JSON Schema:\n${jsonSchema}` },
        { role: 'user', content: hint || context },
      ];
      return stripFences(await oaChat(cfg, msgs, model, temp));
    },
    async generateJsonStrict(hint, jsonSchema, context, model, temp) {
      const msgs: OAMessage[] = [
        { role: 'system', content: 'You are a JSON extraction engine. Return ONLY valid JSON matching the schema. Output ONLY the JSON object. No markdown. No explanation.' },
        { role: 'system', content: `JSON Schema:\n${jsonSchema}` },
        { role: 'user', content: hint || context },
      ];
      let output = stripFences(await oaChat(cfg, msgs, model, temp));
      try { JSON.parse(output); } catch {
        msgs.push({ role: 'assistant', content: output });
        msgs.push({ role: 'user', content: 'The response was not valid JSON. Return ONLY the JSON object.' });
        output = stripFences(await oaChat(cfg, msgs, model, temp));
      }
      return output;
    },
  };
}
