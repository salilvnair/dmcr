/**
 * Minimal 'vscode' module for DMCR Web (local-server/).
 *
 * Lets the server import the REAL extension-host code — src/panel/main/handlers/*,
 * src/storage/*, src/services/* — unchanged, outside VS Code. local-server/build.js
 * aliases `from 'vscode'` to this file at bundle time. It covers only the API surface
 * DMCR's handlers call (found with: grep -rhoE "vscode\.[A-Za-z.]+" src). Not a general
 * vscode mock — grow it only when a handler needs more.
 *
 * Where VS Code would show UI (dialogs, editors, notifications) this logs, and where it
 * would persist something (settings, secrets, state) it uses files under DMCR_WEB_HOME
 * (default ~/.dmcr-web).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const WEB_HOME = process.env.DMCR_WEB_HOME || path.join(os.homedir(), '.dmcr-web');
fs.mkdirSync(WEB_HOME, { recursive: true });

/** The workspace folder DMCR works in (change folders live under it). */
export const WORKSPACE_DIR = process.env.DMCR_WEB_WORKSPACE || path.join(WEB_HOME, 'workspace');
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

// ─── events / disposables ──────────────────────────────────────────────────────
export class Disposable {
  constructor(private readonly fn: () => void = () => {}) {}
  static from(...items: { dispose(): unknown }[]) { return new Disposable(() => items.forEach(i => i.dispose())); }
  dispose() { this.fn(); }
}

export class EventEmitter<T> {
  private listeners: ((e: T) => unknown)[] = [];
  readonly event = (listener: (e: T) => unknown) => {
    this.listeners.push(listener);
    return new Disposable(() => { this.listeners = this.listeners.filter(l => l !== listener); });
  };
  fire(e: T) { for (const l of [...this.listeners]) l(e); }
  dispose() { this.listeners = []; }
}

export class CancellationTokenSource {
  private cancelled = false;
  private emitter = new EventEmitter<void>();
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose() { this.emitter.dispose(); }
}

// ─── Uri ───────────────────────────────────────────────────────────────────────
export interface WebUri { fsPath: string; path: string; scheme: string; toString(): string }
function makeUri(fsPath: string, scheme = 'file'): WebUri {
  return { fsPath, path: fsPath.replace(/\\/g, '/'), scheme, toString: () => (scheme === 'file' ? `file://${fsPath.replace(/\\/g, '/')}` : fsPath) };
}
export const Uri = {
  file: (p: string) => makeUri(path.resolve(p)),
  joinPath: (base: WebUri, ...parts: string[]) => makeUri(path.join(base.fsPath, ...parts)),
  parse: (v: string) => (/^file:\/\//.test(v) ? makeUri(decodeURIComponent(v.replace(/^file:\/\/\/?/, process.platform === 'win32' ? '' : '/'))) : makeUri(v, v.split(':')[0] || 'file')),
};

export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2 }
export enum StatusBarAlignment { Left = 1, Right = 2 }

// ─── workspace ─────────────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(WEB_HOME, 'settings.json');
function readSettings(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
const configChanged = new EventEmitter<{ affectsConfiguration(s: string): boolean }>();

export const workspace = {
  workspaceFolders: [{ uri: makeUri(WORKSPACE_DIR), name: path.basename(WORKSPACE_DIR), index: 0 }],
  /** Settings like VS Code's settings.json, from DMCR_WEB_HOME/settings.json ("dmcr.dbPath": …). */
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const v = readSettings()[section ? `${section}.${key}` : key];
        return (v === undefined ? defaultValue : v) as T | undefined;
      },
      async update(key: string, value: unknown) {
        const all = readSettings();
        all[section ? `${section}.${key}` : key] = value;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2));
        configChanged.fire({ affectsConfiguration: (s: string) => `${section}.${key}`.startsWith(s) });
      },
      has(key: string) { return readSettings()[section ? `${section}.${key}` : key] !== undefined; },
    };
  },
  onDidChangeConfiguration: configChanged.event,
  asRelativePath(p: string | WebUri) {
    const abs = typeof p === 'string' ? p : p.fsPath;
    const rel = path.relative(WORKSPACE_DIR, abs);
    return rel.startsWith('..') ? abs : rel;
  },
  fs: {
    async readDirectory(uri: WebUri): Promise<[string, FileType][]> {
      return fs.readdirSync(uri.fsPath, { withFileTypes: true })
        .map(d => [d.name, d.isDirectory() ? FileType.Directory : d.isSymbolicLink() ? FileType.SymbolicLink : FileType.File] as [string, FileType]);
    },
    async createDirectory(uri: WebUri) { fs.mkdirSync(uri.fsPath, { recursive: true }); },
    async writeFile(uri: WebUri, content: Uint8Array) { fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true }); fs.writeFileSync(uri.fsPath, content); },
    async readFile(uri: WebUri): Promise<Uint8Array> { return fs.readFileSync(uri.fsPath); },
    async stat(uri: WebUri) {
      const s = fs.statSync(uri.fsPath);
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs };
    },
    async delete(uri: WebUri) { fs.rmSync(uri.fsPath, { recursive: true, force: true }); },
  },
};

// ─── window ────────────────────────────────────────────────────────────────────
/** The server sets this so notifications reach the open browser tabs as toasts. */
export const webHooks: { notify?: (level: 'info' | 'warn' | 'error', message: string) => void } = {};

async function note(level: 'info' | 'warn' | 'error', message: string) {
  (level === 'error' ? console.error : console.log)(`[dmcr-web] ${level}: ${message}`);
  webHooks.notify?.(level, message);
  return undefined;
}

export const window = {
  showInformationMessage: (m: string, ..._items: unknown[]) => note('info', m),
  showWarningMessage: (m: string, ..._items: unknown[]) => note('warn', m),
  showErrorMessage: (m: string, ..._items: unknown[]) => note('error', m),
  /** No native dialog in a browser build: folder picks cancel; the UI lets you type a path. */
  showOpenDialog: async (_o?: unknown) => undefined,
  showSaveDialog: async (o?: { defaultUri?: WebUri }) => {
    const dir = path.join(WEB_HOME, 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    return makeUri(path.join(dir, o?.defaultUri ? path.basename(o.defaultUri.fsPath) : `download-${Date.now()}`));
  },
  showInputBox: async (_o?: unknown) => undefined,
  /** VS Code would open the file in an editor; here the browser UI already shows it. */
  showTextDocument: async (doc: unknown) => { console.log(`[dmcr-web] (editor) ${(doc as WebUri)?.fsPath ?? ''}`); return undefined; },
  activeTextEditor: undefined,
  tabGroups: { all: [] as { tabs: { label: string }[] }[] },
  createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
  registerWebviewViewProvider: () => new Disposable(),
  createWebviewPanel: () => { throw new Error('Separate VS Code panels are not available in DMCR Web — use the tabs in the main page.'); },
};

export const commands = {
  async executeCommand(id: string, ..._args: unknown[]) { if (id !== 'setContext') console.log(`[dmcr-web] command ${id} (no VS Code here)`); return undefined; },
  registerCommand: () => new Disposable(),
  async getCommands() { return [] as string[]; },
};

// ─── language models: no Copilot outside VS Code ───────────────────────────────
// DMCR Web uses a custom provider (DeepSeek from .env). An empty model list is what
// DMCR already treats as "Copilot not available".
export const lm = { async selectChatModels(_f?: unknown) { return [] as unknown[]; } };
export class LanguageModelChatMessage {
  constructor(public role: 'user' | 'assistant', public content: string) {}
  static User(c: string) { return new LanguageModelChatMessage('user', c); }
  static Assistant(c: string) { return new LanguageModelChatMessage('assistant', c); }
}
export class LanguageModelError extends Error { constructor(message: string, public code = 'Unknown') { super(message); } }

export const env = {
  appName: 'DMCR Web', appHost: 'web', language: 'en', remoteName: undefined as string | undefined,
  shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
  clipboard: { async readText() { return ''; }, async writeText(_t: string) {} },
  async openExternal(_u: unknown) { return false; },
};
export const extensions = { all: [] as unknown[], getExtension: (_id: string) => undefined };
export const version = 'dmcr-web';
export const chat = { createChatParticipant: () => ({ dispose() {} }) };

// ─── ExtensionContext pieces (secrets, state) backed by files ──────────────────
/**
 * SecretStorage for the local web build: a JSON file in DMCR_WEB_HOME (user-only).
 * The VS Code extension uses the OS keychain; this is a local test harness.
 */
export function fileSecretStorage(file = path.join(WEB_HOME, 'secrets.json')) {
  const read = (): Record<string, string> => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (d: Record<string, string>) => { fs.writeFileSync(file, JSON.stringify(d, null, 2), { mode: 0o600 }); };
  const changed = new EventEmitter<{ key: string }>();
  return {
    async get(key: string) { return read()[key]; },
    async store(key: string, value: string) { const d = read(); d[key] = value; write(d); changed.fire({ key }); },
    async delete(key: string) { const d = read(); delete d[key]; write(d); changed.fire({ key }); },
    async keys() { return Object.keys(read()); },
    onDidChange: changed.event,
  };
}

export function fileMemento(file: string) {
  const read = (): Record<string, unknown> => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    get<T>(key: string, d?: T): T | undefined { const v = read()[key]; return (v === undefined ? d : v) as T | undefined; },
    async update(key: string, value: unknown) { const all = read(); all[key] = value; fs.writeFileSync(file, JSON.stringify(all, null, 2)); },
    keys() { return Object.keys(read()); },
    setKeysForSync() {},
  };
}

export default { Uri, FileType, ViewColumn, StatusBarAlignment, workspace, window, commands, lm, LanguageModelChatMessage, LanguageModelError, env, extensions, version, chat, EventEmitter, Disposable, CancellationTokenSource };
