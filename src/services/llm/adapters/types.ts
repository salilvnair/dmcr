/** Shared types for all custom LLM provider adapters. */

export interface CustomProviderConfig {
  key: string;
  name: string;
  type: 'openai' | 'anthropic' | 'lmstudio' | 'ollama' | 'deepseek' | 'grok' | 'mistral' | 'gemini' | 'qwen';
  chatUrl: string;
  modelsUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** The currently active/selected model id for this provider. */
  activeModel?: string;
  /** Cached model list from last successful fetchModels call. */
  cachedModels?: ModelInfo[];
}

export interface ModelInfo {
  id: string;
  label: string;
  group: string;
  family: string;
}

export interface CustomLlmClient {
  generateText(hint: string, context: string, model: string, temperature?: number): Promise<string>;
  generateJson(hint: string, jsonSchema: string, context: string, model: string, temperature?: number): Promise<string>;
  generateJsonStrict(hint: string, jsonSchema: string, context: string, model: string, temperature?: number): Promise<string>;
  /** Stream output tokens one by one via onToken; resolves with the full text when done. */
  stream?(hint: string, context: string, model: string, onToken: (delta: string) => void, temperature?: number): Promise<string>;
}
