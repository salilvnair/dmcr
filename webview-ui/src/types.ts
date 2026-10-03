/** Shared types for DMCR webview â†” extension message protocol */

export type CopilotModel = { id: string; label: string; group: string; family: string };

export type CustomProviderModel = { id: string; label: string; group: string; family: string };

export type CustomProviderConfig = {
  key: string;
  name: string;
  type: 'openai' | 'anthropic' | 'lmstudio' | 'ollama' | 'deepseek' | 'grok' | 'mistral' | 'gemini' | 'qwen';
  chatUrl: string;
  modelsUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  activeModel: string;
  cachedModels?: CustomProviderModel[];
  hasApiKey?: boolean;
};

export type AppTheme = 'dark' | 'light' | 'system';

export type FormSnapshot = {
  /** DDL form */
  ddl?: {
    action?: string;
    defaultSchema?: string;
    tableName?: string;
    columns?: Array<{ name: string; type: string }>;
    changeNameHint?: string;
    metaAuthor?: string;
  };
  /** Insert form */
  insert?: {
    tableName?: string;
    defaultSchema?: string;
    columns?: Array<{ name: string; type: string }>;
    changeNameHint?: string;
    metaAuthor?: string;
  };
  /** Freeform form */
  freeform?: {
    dbSchema?: string;
    changeHint?: string;
    metaAuthor?: string;
    sql?: string;
  };
  /** Conversation page */
  conversation?: {
    schemaCtx?: string;
    changeNameHint?: string;
  };
};

export type UiSnapshot = {
  tab?: string;
  theme?: AppTheme;
  settingsSection?: string;
  devToolActive?: string;
  formState?: FormSnapshot;
};

export type SettingsSnapshot = {
  activeProvider: string;       // 'copilot' | custom key
  activeFamily: string;
  copilot: { models: CopilotModel[] };
  customProviders: CustomProviderConfig[];
  sqliteStatus: 'ok' | 'error';
  sqliteError?: string;
  theme?: AppTheme;
  uiSnapshot?: UiSnapshot;
};

export type DbTableInfo = { name: string; count: number };

export type DbExplorerTableInfo = { name: string; columns: string[]; columnTypes: Record<string, string>; rowCount: number; pkColumn: string | null };

export type DbInfoPayload = {
  dbPath: string;
  dbSizeBytes: number;
  sqliteVersion: string;
  tables: DbTableInfo[];
  extensionPath: string;
  userDataPath: string;
};

export type ProcessEntry = { name: string; pid: number; mem: number; cpu?: number };

export type SystemInfoPayload = {
  heapUsed: number; heapTotal: number; rss: number; external: number; arrayBuffers: number;
  versions: { node: string; v8: string; electron: string; openssl: string; uv: string };
  vscodeVersion: string; appName: string; appHost: string; language: string; remoteName: string; shell: string;
  platform: string; release: string; arch: string; hostname: string;
  totalMemBytes: number; freeMemBytes: number; cpuModel: string; cpuCount: number; cpuSpeed: number; uptime: number;
  extensionPath: string; tmpDir: string; homeDir: string;
  processList?: ProcessEntry[];
};

export type CeAuditEntry = {
  audit_id?: number;
  conversation_id: string;
  stage: string;
  model?: string | null;
  system_prompt?: string | null;
  user_prompt?: string | null;
  request_payload?: string | null;
  response_payload?: string | null;
  headers?: string | null;
  meta?: string | null;
  duration_ms?: number | null;
  error?: string | null;
  created_at?: string;
};

// Messages FROM extension TO webview
export type ExtMsg =
  | { type: 'init'; payload: SettingsSnapshot }
  // Settings save sends the provider; a form save sends the new change folder.
  | { type: 'saved'; payload: { activeProvider?: string; activeFamily?: string; folderId?: string; folderRel?: string; changeName?: string; requestId?: string } }
  | { type: 'providerAdded'; payload: { key: string; name: string; type: string; activeModel: string; models: CustomProviderModel[] } }
  | { type: 'providerDeleted'; payload: { key: string } }
  | { type: 'modelsFetched'; payload: { key: string; models: CustomProviderModel[] } }
  | { type: 'formCancelled'; payload: { form: string; goHome?: boolean; reset?: boolean } }
  | { type: 'generating'; payload: { form: string } }
  // A save sends the folder; a finished form generation sends the change itself plus its form.
  | { type: 'generationDone'; payload: { form?: string; folderId?: string; folderRel?: string; isDanger?: boolean } }
  | { type: 'generationError'; payload: { message: string; form?: string } }
  // Handled by the form pages / ChangeCard / ConversationPage, which listen on window directly
  | { type: 'showProgress' | 'progressUpdate' | 'streamChunk' | 'folderPicked' | 'saveError' | 'lintResult' | 'reply'; payload?: unknown }
  | { type: 'allDbSchemas'; payload: { schemas: string[] } }
  | { type: 'existingChanges'; payload: { changes: string[] } }
  | { type: 'dbMcpStatus'; payload: { hasDbMcp: boolean } }
  | { type: 'terminalData'; payload: string }
  | { type: 'terminalExit'; payload: { code: number | null; expected?: boolean } }
  | { type: 'sqliteRebuildResult'; payload: { ok: boolean; error: string | null; building?: boolean } }
  | { type: 'dbInfo'; payload: DbInfoPayload }
  | { type: 'systemInfo'; payload: SystemInfoPayload }
  | { type: 'aiFootprint'; payload: { entries: CeAuditEntry[]; limit: number } }
  | { type: 'aiFootprintLimitSaved'; payload: { keepLimit?: number; showLimit?: number } }
  | { type: 'dbExplorerTables'; payload: { tables: DbExplorerTableInfo[] } }
  | { type: 'dbExplorerRows'; payload: { table: string; rows: Record<string, unknown>[] } }
  | { type: 'error'; payload: string; msgId?: string };

export type GenState =
  | { status: 'idle' }
  | { status: 'opening' }
  | { status: 'running'; form: string }
  | { status: 'done'; folderId: string; folderRel: string; isDanger: boolean }
  | { status: 'error'; message: string };

