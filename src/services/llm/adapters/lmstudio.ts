/**
 * LM Studio adapter — OpenAI-compatible, apiKey is optional.
 */
import { createOpenAiClient, fetchOpenAiModels } from './openai';
import type { CustomProviderConfig, ModelInfo, CustomLlmClient } from './types';

export function createLmStudioClient(cfg: CustomProviderConfig): CustomLlmClient {
  return createOpenAiClient(cfg);
}

export async function fetchLmStudioModels(cfg: CustomProviderConfig): Promise<ModelInfo[]> {
  return fetchOpenAiModels(cfg);
}
