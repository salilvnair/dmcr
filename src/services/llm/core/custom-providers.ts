/**
 * Custom provider registry — persists user-defined LLM providers in SQLite,
 * stores API keys in OS Keychain via SecretStorage, fetches model lists,
 * and creates LlmClient instances.
 */
import { findAll, upsert, remove } from '../../../storage/db';
import type { CustomProviderConfig, ModelInfo, CustomLlmClient } from '../adapters/types';
import { fetchOpenAiModels, createOpenAiClient } from '../adapters/openai';
import { fetchAnthropicModels, createAnthropicClient } from '../adapters/anthropic';
import { fetchLmStudioModels, createLmStudioClient } from '../adapters/lmstudio';
import { fetchOllamaModels, createOllamaClient } from '../adapters/ollama';
import { storeApiKey, retrieveApiKey, deleteApiKey } from './secret-store';

export type { CustomProviderConfig, ModelInfo };

const COLLECTION = 'custom_providers';

/* ── CRUD ─────────────────────────────────────────────────────────── */

/** DB records never contain apiKey — use getCustomProviderWithKey() when the actual key is needed. */
export function getAllCustomProviders(): CustomProviderConfig[] {
  return findAll<CustomProviderConfig>(COLLECTION);
}

/** Merge the persisted (keyless) config with its OS-keychain-backed API key. */
export async function getCustomProviderWithKey(key: string): Promise<CustomProviderConfig | undefined> {
  const cfg = getAllCustomProviders().find((p) => p.key === key);
  if (!cfg) return undefined;
  const apiKey = await retrieveApiKey(key);
  return { ...cfg, apiKey };
}

/** Persists apiKey to SecretStorage and the rest of the config to SQLite — never both in the same place. */
export async function saveCustomProvider(cfg: CustomProviderConfig): Promise<CustomProviderConfig> {
  const { apiKey, ...rest } = cfg;
  if (apiKey) await storeApiKey(cfg.key, apiKey);
  const saved = upsert(COLLECTION, cfg.key, rest as CustomProviderConfig);
  return { ...saved, apiKey };
}

export async function deleteCustomProvider(key: string): Promise<void> {
  remove(COLLECTION, key);
  await deleteApiKey(key);
}

/* ── Model fetching ───────────────────────────────────────────────── */

export async function fetchAndCacheModels(key: string): Promise<ModelInfo[]> {
  const cfg = await getCustomProviderWithKey(key);
  if (!cfg) throw new Error(`Custom provider not found: ${key}`);
  const models = await fetchModelsFromConfig(cfg);
  // Strip apiKey before writing back to DB
  const { apiKey: _k, ...rest } = cfg;
  upsert(COLLECTION, key, { ...rest, cachedModels: models } as CustomProviderConfig);
  return models;
}

async function fetchModelsFromConfig(cfg: CustomProviderConfig): Promise<ModelInfo[]> {
  switch (cfg.type) {
    case 'openai':
    case 'deepseek':
    case 'grok':
    case 'mistral':
    case 'gemini':
    case 'qwen':
      return fetchOpenAiModels(cfg);
    case 'anthropic': return fetchAnthropicModels(cfg);
    case 'lmstudio':  return fetchLmStudioModels(cfg);
    case 'ollama':    return fetchOllamaModels(cfg);
    default:
      return fetchOpenAiModels(cfg);
  }
}

/* ── Client factory ───────────────────────────────────────────────── */

export async function createCustomProviderClient(key: string): Promise<CustomLlmClient> {
  const cfg = await getCustomProviderWithKey(key);
  if (!cfg) throw new Error(`Custom provider not found: ${key}`);

  switch (cfg.type) {
    case 'openai':
    case 'deepseek':
    case 'grok':
    case 'mistral':
    case 'gemini':
    case 'qwen':
      return createOpenAiClient(cfg);
    case 'anthropic': return createAnthropicClient(cfg);
    case 'lmstudio':  return createLmStudioClient(cfg);
    case 'ollama':    return createOllamaClient(cfg);
    default:
      return createOpenAiClient(cfg);
  }
}

/* ── Helpers ──────────────────────────────────────────────────────── */

export function resolveCustomProviderForModel(modelId: string): CustomProviderConfig | undefined {
  const providers = getAllCustomProviders();
  const byActive = providers.find((p) => p.activeModel === modelId);
  if (byActive) return byActive;
  return providers.find((p) => (p.cachedModels ?? []).some((m) => m.id === modelId));
}

export function buildCustomProviderSection(cfg: CustomProviderConfig): Record<string, unknown> {
  const cachedModels = cfg.cachedModels ?? [];
  const seen = new Set<string>();
  const models = cachedModels.reduce<{ id: string; label: string; group: string; family: string }[]>((acc, m) => {
    if (!m.id || seen.has(m.id)) return acc;
    seen.add(m.id);
    acc.push({ id: m.id, label: m.label, group: cfg.name, family: m.family });
    return acc;
  }, []);
  return {
    name: cfg.name,
    provider: cfg.key,
    type: cfg.type,
    model: cfg.activeModel ?? models[0]?.id ?? '',
    models,
  };
}
