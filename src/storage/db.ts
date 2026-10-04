/**
 * Storage layer — sql.js (WASM-based SQLite).
 * Zero native compilation required. Portable across all platforms.
 * Graceful degradation if init fails (_sqliteOk = false).
 */
import { redactText } from '../services/security/redact';
import * as path from 'path';
import * as os   from 'os';
import * as fs   from 'fs';

type SqlJsDatabase = import('sql.js').Database;

// ─── State ───────────────────────────────────────────────────────────────────

let _db:           SqlJsDatabase | null = null;
let _sqliteOk      = false;
let _sqliteError   = '';
let _dbPath        = '';
let _extensionPath = '';
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _SQL: import('sql.js').SqlJsStatic | null = null;

// Several VS Code windows share one database file, and sql.js keeps the whole database in
// memory. Every write is recorded here until it reaches disk; if another window saved the
// file in the meantime, we load its version and re-apply our writes instead of overwriting it.
let _journal: Array<{ sql: string; params?: unknown[] }> = [];
// Token from <db>.version for the copy this window last read or wrote. Every save writes a
// new token, so a different token means another window saved. (File mtime and size are not
// enough: on Windows two saves can share a timestamp, and the size moves in whole pages.)
let _knownVersion = '';
let _watching = '';
let _watchListener: ((curr: fs.Stats, prev: fs.Stats) => void) | null = null;

// ─── Public: status ──────────────────────────────────────────────────────────

export function getSqliteStatus(): { ok: boolean; error?: string } {
  return _sqliteOk ? { ok: true } : { ok: false, error: _sqliteError };
}

export function getDbPath(): string { return _dbPath; }

export function getSqliteVersion(): string {
  if (!_sqliteOk || !_db) return 'unknown';
  try {
    const stmt = _db.prepare('SELECT sqlite_version() AS v');
    let ver = 'unknown';
    if (stmt.step()) { ver = (stmt.getAsObject() as { v: string }).v ?? 'unknown'; }
    stmt.free();
    return ver;
  } catch { return 'unknown'; }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function _scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => _saveToDisk(), 500);
}

/** Run a write and remember it until it is saved (see _journal). */
function _write(sql: string, params?: unknown[]): void {
  _db!.run(sql, params as any[]);
  _journal.push({ sql, params });
  _scheduleSave();
}

const _versionPath = (dbPath: string) => `${dbPath}.version`;

function _readVersion(dbPath: string): string {
  try { return fs.readFileSync(_versionPath(dbPath), 'utf8').trim(); } catch { return ''; }
}

function _sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding <db>.lock, so only one window at a time reads-then-writes the file.
 * The lock is held for milliseconds; one left behind by a crashed window is taken over
 * after 10 s.
 */
function _withFileLock<T>(dbPath: string, fn: () => T): T {
  const lock = `${dbPath}.lock`;
  let held = false;
  const deadline = Date.now() + 10_000;
  while (!held) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      held = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { break; } // e.g. read-only folder: run unlocked
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }  // just released
      if (age > 10_000 || Date.now() > deadline) {
        try { fs.unlinkSync(lock); } catch { /* another window took it over first */ }
        continue;
      }
      _sleepSync(15);
    }
  }
  try { return fn(); }
  finally { if (held) { try { fs.unlinkSync(lock); } catch { /* ignore */ } } }
}

/** Replace the in-memory database with the file on disk, re-applying unsaved writes.
 *  Caller holds the file lock. */
function _reloadFromDisk(): void {
  if (!_db || !_SQL || !fs.existsSync(_dbPath)) return;
  const fresh = new _SQL.Database(fs.readFileSync(_dbPath));
  for (const op of _journal) {
    try { fresh.run(op.sql, op.params as any[]); }
    catch (e) { console.warn('[dmcr] Could not re-apply a write after another window saved the DB:', e); }
  }
  _db.close();
  _db = fresh;
  _knownVersion = _readVersion(_dbPath);
}

function _saveToDisk(): void {
  if (!_db) return;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    _withFileLock(_dbPath, () => {
      // Another window saved since we last read or wrote → start from its file.
      if (_readVersion(_dbPath) !== _knownVersion) { _reloadFromDisk(); }
      const buffer = Buffer.from(_db!.export());
      // Write a temp file and rename it, so a reader never sees a half-written database.
      const tmp = `${_dbPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buffer);
      try { fs.renameSync(tmp, _dbPath); }
      catch { fs.writeFileSync(_dbPath, buffer); try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
      const version = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(_versionPath(_dbPath), version);
      _knownVersion = version;
      _journal = [];
    });
  } catch (e) {
    console.error('[dmcr] Failed to save DB:', e);
  }
}

/** Pick up saves made by other windows while this one is idle. */
function _watchDbFile(p: string): void {
  _unwatchDbFile();
  _watching = _versionPath(p);
  _watchListener = () => {
    if (!_db || _readVersion(p) === _knownVersion) return;
    if (_journal.length) { _saveToDisk(); }       // merge our pending writes, then save
    else {
      try { _withFileLock(p, () => { if (_readVersion(p) !== _knownVersion) { _reloadFromDisk(); } }); }
      catch (e) { console.warn('[dmcr] DB reload failed:', e); }
    }
  };
  fs.watchFile(_watching, { interval: 1000 }, _watchListener);
}

function _unwatchDbFile(): void {
  // Remove only our listener: unwatchFile(path) alone would drop every watcher on the file.
  if (_watching && _watchListener) { fs.unwatchFile(_watching, _watchListener); }
  _watching = '';
  _watchListener = null;
}

// ─── Resolve configured or default DB path ───────────────────────────────────

function resolveDbPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode') as typeof import('vscode');
    const custom = vscode.workspace.getConfiguration('dmcr').get<string>('dbPath', '').trim();
    if (custom) return custom;
  } catch { /* no-op */ }
  return path.join(os.homedir(), '.dmcr', 'db', 'dmcr.db');
}

// ─── Open (or reopen) the database at the given path ─────────────────────────

async function openDb(dbPath: string): Promise<void> {
  try {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    const wasmPath = path.join(_extensionPath, 'dist', 'sql-wasm.wasm');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const initSqlJs = require('sql.js') as typeof import('sql.js').default;

    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });
    _SQL = SQL;
    _journal = [];

    // Load existing DB or create new
    if (fs.existsSync(dbPath)) {
      // Read the file and its version together, so a save from another window can't slip between
      const loaded = _withFileLock(dbPath, () => ({ buffer: fs.readFileSync(dbPath), version: _readVersion(dbPath) }));
      _db = new SQL.Database(loaded.buffer);
      _knownVersion = loaded.version;
    } else {
      _knownVersion = _readVersion(dbPath);
      _db = new SQL.Database();
    }

    _db.run('PRAGMA journal_mode = WAL');

    // Create tables
    _db.run(`
      CREATE TABLE IF NOT EXISTS kv (
        collection TEXT NOT NULL,
        id         TEXT NOT NULL,
        data       TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      )
    `);
    _db.run(`
      CREATE TABLE IF NOT EXISTS ce_audit (
        audit_id         INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id  TEXT    NOT NULL,
        stage            TEXT    NOT NULL,
        model            TEXT,
        system_prompt    TEXT,
        user_prompt      TEXT,
        request_payload  TEXT,
        response_payload TEXT,
        headers          TEXT,
        meta             TEXT,
        duration_ms      INTEGER,
        error            TEXT,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);

    _db.run(`
      CREATE TABLE IF NOT EXISTS runner_event_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        event_ts    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        action      TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        message     TEXT,
        command     TEXT,
        exit_code   INTEGER,
        duration_ms INTEGER
      )
    `);

    _db.run(`
      CREATE TABLE IF NOT EXISTS conversation_sql (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id  TEXT    NOT NULL,
        change_name      TEXT    NOT NULL,
        deploy_sql       TEXT    NOT NULL,
        verify_sql       TEXT    NOT NULL,
        revert_sql       TEXT    NOT NULL,
        meta_json        TEXT,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    _db.run(`CREATE INDEX IF NOT EXISTS idx_conversation_sql_conv ON conversation_sql(conversation_id)`);

    _dbPath      = dbPath;
    _sqliteOk    = true;
    _sqliteError = '';

    _saveToDisk();
    _watchDbFile(dbPath);
  } catch (e: unknown) {
    _sqliteOk    = false;
    _sqliteError = e instanceof Error ? e.message : String(e);
  }
}

// ─── Public: relocate ─────────────────────────────────────────────────────────

/** Re-open the database at a new path at runtime (no restart required). */
export async function relocateDb(newDbPath: string): Promise<void> {
  if (_db) { _saveToDisk(); _db.close(); _db = null; }
  await openDb(newDbPath);
}

// ─── Init ────────────────────────────────────────────────────────────────────

export async function initDb(extensionPath: string): Promise<void> {
  _extensionPath = extensionPath;
  await openDb(resolveDbPath());
}

/** Expose a better-sqlite3-compatible wrapper for modules that expect .prepare().get()/.run()/.all() and .exec() */
export function getRawDb(): BetterSqlite3Compat | null {
  if (!_sqliteOk || !_db) return null;
  return createCompat();
}

// ─── Compat adapter ──────────────────────────────────────────────────────────

type BetterSqlite3Compat = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => void;
    get: (...args: unknown[]) => Record<string, unknown> | undefined;
    all: (...args: unknown[]) => Array<Record<string, unknown>>;
  };
  exec: (sql: string) => void;
};

/** Always uses the current _db: it is replaced when another window's save is loaded. */
function createCompat(): BetterSqlite3Compat {
  return {
    exec(sql: string) {
      _write(sql);
    },
    prepare(sql: string) {
      return {
        run(...args: unknown[]) {
          _write(sql, args);
        },
        get(...args: unknown[]): Record<string, unknown> | undefined {
          const stmt = _db!.prepare(sql);
          if (args.length) stmt.bind(args as any[]);
          let result: Record<string, unknown> | undefined;
          if (stmt.step()) {
            result = stmt.getAsObject() as Record<string, unknown>;
          }
          stmt.free();
          return result;
        },
        all(...args: unknown[]): Array<Record<string, unknown>> {
          const stmt = _db!.prepare(sql);
          if (args.length) stmt.bind(args as any[]);
          const results: Array<Record<string, unknown>> = [];
          while (stmt.step()) {
            results.push(stmt.getAsObject() as Record<string, unknown>);
          }
          stmt.free();
          return results;
        },
      };
    },
  };
}

/** Close DB and flush to disk. */
export function closeDb(): void {
  _unwatchDbFile();
  if (_db) {
    _saveToDisk();
    _db.close();
    _db = null;
    _sqliteOk = false;
  }
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
}

// ─── SQLite helpers ───────────────────────────────────────────────────────────

function sqliteReadCollection<T>(name: string): Record<string, T> {
  const stmt = _db!.prepare('SELECT id, data FROM kv WHERE collection = ?');
  stmt.bind([name]);
  const out: Record<string, T> = {};
  while (stmt.step()) {
    const row = stmt.getAsObject() as { id: string; data: string };
    try { out[row.id] = JSON.parse(row.data) as T; } catch { /* skip corrupt */ }
  }
  stmt.free();
  return out;
}

function sqliteUpsert<T>(name: string, id: string, record: T): void {
  _write(
    'INSERT OR REPLACE INTO kv (collection, id, data) VALUES (?, ?, ?)',
    [name, id, JSON.stringify(record)]
  );
  _scheduleSave();
}

function sqliteRemove(name: string, id: string): void {
  _write('DELETE FROM kv WHERE collection = ? AND id = ?', [name, id]);
  _scheduleSave();
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function readCollection<T>(name: string): Record<string, T> {
  if (!_sqliteOk) { return {}; }
  return sqliteReadCollection<T>(name);
}

export function writeCollection<T>(name: string, data: Record<string, T>): void {
  if (!_sqliteOk) { return; }
  _write('DELETE FROM kv WHERE collection = ?', [name]);
  for (const [id, record] of Object.entries(data)) { sqliteUpsert(name, id, record); }
}

export function upsert<T>(name: string, id: string, record: T): T {
  if (_sqliteOk) { sqliteUpsert(name, id, record); }
  return record;
}

export function remove(name: string, id: string): void {
  if (_sqliteOk) { sqliteRemove(name, id); }
}

export function findAll<T>(name: string): T[] {
  return Object.values(readCollection<T>(name));
}

export function findById<T>(name: string, id: string): T | undefined {
  return readCollection<T>(name)[id];
}

// ─── ce_audit API ─────────────────────────────────────────────────────────────

export type CeAuditEntry = {
  audit_id?:         number;
  conversation_id:   string;
  stage:             string;
  model?:            string | null;
  system_prompt?:    string | null;
  user_prompt?:      string | null;
  request_payload?:  string | null;
  response_payload?: string | null;
  headers?:          string | null;
  meta?:             string | null;
  duration_ms?:      number | null;
  error?:            string | null;
  created_at?:       string;
};

export function insertAudit(entry: CeAuditEntry): void {
  if (!_sqliteOk || !_db) return;
  // Never persist credentials: connection-string passwords, API keys, auth headers.
  const r = (v: string | null | undefined) => (v == null ? v : redactText(v));
  entry = {
    ...entry,
    system_prompt: r(entry.system_prompt), user_prompt: r(entry.user_prompt),
    request_payload: r(entry.request_payload), response_payload: r(entry.response_payload),
    headers: r(entry.headers), meta: r(entry.meta), error: r(entry.error),
  };
  try {
    _write(`
      INSERT INTO ce_audit
        (conversation_id, stage, model, system_prompt, user_prompt,
         request_payload, response_payload, headers, meta, duration_ms, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `, [
      entry.conversation_id,
      entry.stage,
      entry.model ?? null,
      entry.system_prompt ?? null,
      entry.user_prompt ?? null,
      entry.request_payload ?? null,
      entry.response_payload ?? null,
      entry.headers ?? null,
      entry.meta ?? null,
      entry.duration_ms ?? null,
      entry.error ?? null,
    ]);

    // Trim to configured storage limit (default 10000)
    const limit = getAiFootprintLimit();
    _write(`
      DELETE FROM ce_audit WHERE audit_id NOT IN (
        SELECT audit_id FROM ce_audit ORDER BY audit_id DESC LIMIT ?
      )
    `, [limit]);
    _scheduleSave();
  } catch { /* non-fatal */ }
}

export function getAuditEntries(limit?: number): CeAuditEntry[] {
  if (!_sqliteOk || !_db) return [];
  try {
    const stmt = _db.prepare('SELECT * FROM ce_audit ORDER BY audit_id DESC LIMIT ?');
    stmt.bind([limit ?? getAiFootprintDisplayLimit()]);
    const results: CeAuditEntry[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as CeAuditEntry);
    }
    stmt.free();
    return results;
  } catch { return []; }
}

export function getAuditEntriesSince(sinceAuditId: number): CeAuditEntry[] {
  if (!_sqliteOk || !_db) return [];
  try {
    const stmt = _db.prepare(
      `SELECT * FROM ce_audit WHERE audit_id > ? AND conversation_id NOT LIKE 'form-%' AND conversation_id NOT LIKE 'mcp-%' AND conversation_id NOT LIKE 'dmcr-gen-%' ORDER BY audit_id ASC`
    );
    stmt.bind([sinceAuditId]);
    const results: CeAuditEntry[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as CeAuditEntry);
    }
    stmt.free();
    return results;
  } catch { return []; }
}

export function getMaxAuditId(): number {
  if (!_sqliteOk || !_db) return 0;
  try {
    const stmt = _db.prepare('SELECT MAX(audit_id) AS m FROM ce_audit');
    let result = 0;
    if (stmt.step()) {
      const row = stmt.getAsObject() as { m: number | null };
      result = row?.m ?? 0;
    }
    stmt.free();
    return result;
  } catch { return 0; }
}

export function getAuditEntriesByConversation(conversationId: string, limit?: number): CeAuditEntry[] {
  if (!_sqliteOk || !_db) return [];
  try {
    const stmt = _db.prepare(
      'SELECT * FROM ce_audit WHERE conversation_id = ? ORDER BY audit_id ASC LIMIT ?'
    );
    stmt.bind([conversationId, limit ?? 200]);
    const results: CeAuditEntry[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as CeAuditEntry);
    }
    stmt.free();
    return results;
  } catch { return []; }
}

export function deleteAuditEntry(auditId: number): void {
  if (!_sqliteOk || !_db) return;
  try { _write('DELETE FROM ce_audit WHERE audit_id = ?', [auditId]); _scheduleSave(); } catch { /* non-fatal */ }
}

export function deleteAuditEntries(auditIds: number[]): void {
  if (!_sqliteOk || !_db || !auditIds.length) return;
  try {
    const placeholders = auditIds.map(() => '?').join(',');
    _write(`DELETE FROM ce_audit WHERE audit_id IN (${placeholders})`, auditIds);
    _scheduleSave();
  } catch { /* non-fatal */ }
}

/** AI Footprint storage limit (how many rows to keep in DB, default 10000) */
export function getAiFootprintLimit(): number {
  if (!_sqliteOk || !_db) return 10000;
  try {
    const stmt = _db.prepare("SELECT data FROM kv WHERE collection='settings' AND id='aiFootprintLimit'");
    let v = NaN;
    if (stmt.step()) {
      const row = stmt.getAsObject() as { data: string };
      v = parseInt(row.data, 10);
    }
    stmt.free();
    return isNaN(v) || v < 1 ? 10000 : v;
  } catch { return 10000; }
}

export function setAiFootprintLimit(limit: number): void {
  if (!_sqliteOk) return;
  sqliteUpsert('settings', 'aiFootprintLimit', limit);
}

/** AI Footprint display limit (how many rows to show in UI, default 500) */
export function getAiFootprintDisplayLimit(): number {
  if (!_sqliteOk || !_db) return 500;
  try {
    const stmt = _db.prepare("SELECT data FROM kv WHERE collection='settings' AND id='aiFootprintDisplayLimit'");
    let v = NaN;
    if (stmt.step()) {
      const row = stmt.getAsObject() as { data: string };
      v = parseInt(row.data, 10);
    }
    stmt.free();
    return isNaN(v) || v < 1 ? 500 : v;
  } catch { return 500; }
}

export function setAiFootprintDisplayLimit(limit: number): void {
  if (!_sqliteOk) return;
  sqliteUpsert('settings', 'aiFootprintDisplayLimit', limit);
}

// ─── Runner event log API ─────────────────────────────────────────────────────

export type RunnerEvent = {
  id?:          number;
  event_ts?:    string;
  action:       string;
  status:       string;
  message?:     string | null;
  command?:     string | null;
  exit_code?:   number | null;
  duration_ms?: number | null;
};

export function insertRunnerEvent(entry: RunnerEvent): void {
  if (!_sqliteOk || !_db) return;
  try {
    _write(`
      INSERT INTO runner_event_log (action, status, message, command, exit_code, duration_ms)
      VALUES (?,?,?,?,?,?)
    `, [
      entry.action,
      entry.status,
      entry.message ?? null,
      entry.command ?? null,
      entry.exit_code ?? null,
      entry.duration_ms ?? null,
    ]);
    // Keep last 200 entries
    _write(`
      DELETE FROM runner_event_log WHERE id NOT IN (
        SELECT id FROM runner_event_log ORDER BY id DESC LIMIT 200
      )
    `);
    _scheduleSave();
  } catch { /* non-fatal */ }
}

export function deleteAllRunnerEvents(): void {
  if (!_sqliteOk || !_db) return;
  try {
    _write('DELETE FROM runner_event_log');
    _scheduleSave();
  } catch { /* non-fatal */ }
}

export function getRunnerEvents(limit?: number): RunnerEvent[] {
  if (!_sqliteOk || !_db) return [];
  try {
    const stmt = _db.prepare('SELECT * FROM runner_event_log ORDER BY id DESC LIMIT ?');
    stmt.bind([limit ?? 50]);
    const results: RunnerEvent[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as RunnerEvent);
    }
    stmt.free();
    return results;
  } catch { return []; }
}

// ─── DB Explorer: generic table query ─────────────────────────────────────────

export type DbExplorerTableInfo = { name: string; columns: string[]; columnTypes: Record<string, string>; rowCount: number; pkColumn: string | null };

export function getDbExplorerTables(): DbExplorerTableInfo[] {
  if (!_sqliteOk || !_db) return [];
  try {
    const tStmt = _db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tables: string[] = [];
    while (tStmt.step()) {
      const row = tStmt.getAsObject() as { name: string };
      tables.push(row.name);
    }
    tStmt.free();

    return tables.map(name => {
      const cStmt = _db!.prepare(`PRAGMA table_info("${name}")`);
      const cols: { name: string; type: string; pk: number }[] = [];
      while (cStmt.step()) {
        cols.push(cStmt.getAsObject() as { name: string; type: string; pk: number });
      }
      cStmt.free();
      const colNames = cols.map(c => c.name);
      const colTypes: Record<string, string> = {};
      cols.forEach(c => { colTypes[c.name] = c.type || 'text'; });
      const pkCol = cols.find(c => c.pk === 1);

      const countStmt = _db!.prepare(`SELECT COUNT(*) as c FROM "${name}"`);
      countStmt.step();
      const cnt = countStmt.getAsObject() as { c: number };
      countStmt.free();

      return { name, columns: colNames, columnTypes: colTypes, rowCount: cnt?.c ?? 0, pkColumn: pkCol?.name ?? null };
    });
  } catch { return []; }
}

export function getDbExplorerRows(table: string, limit = 100, offset = 0): Record<string, unknown>[] {
  if (!_sqliteOk || !_db) return [];
  // Whitelist check
  const tStmt = _db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames: string[] = [];
  while (tStmt.step()) { tableNames.push((tStmt.getAsObject() as { name: string }).name); }
  tStmt.free();
  if (!tableNames.includes(table)) return [];

  try {
    const cStmt = _db.prepare(`PRAGMA table_info("${table}")`);
    const cols: { name: string; pk: number }[] = [];
    while (cStmt.step()) { cols.push(cStmt.getAsObject() as { name: string; pk: number }); }
    cStmt.free();
    const pkCol = cols.find(c => c.pk === 1);
    const orderCol = pkCol ? `"${pkCol.name}"` : 'rowid';

    const stmt = _db.prepare(`SELECT * FROM "${table}" ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`);
    stmt.bind([limit, offset]);
    const results: Record<string, unknown>[] = [];
    while (stmt.step()) { results.push(stmt.getAsObject()); }
    stmt.free();
    return results;
  } catch { return []; }
}

export function deleteDbExplorerRows(table: string, pkValues: (number | string)[], pkColumn?: string): void {
  if (!_sqliteOk || !_db || pkValues.length === 0) return;
  const tStmt = _db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames: string[] = [];
  while (tStmt.step()) { tableNames.push((tStmt.getAsObject() as { name: string }).name); }
  tStmt.free();
  if (!tableNames.includes(table)) return;

  let pk = pkColumn;
  if (!pk) {
    const cStmt = _db.prepare(`PRAGMA table_info("${table}")`);
    const cols: { name: string; pk: number }[] = [];
    while (cStmt.step()) { cols.push(cStmt.getAsObject() as { name: string; pk: number }); }
    cStmt.free();
    const pkCol = cols.find(c => c.pk === 1);
    pk = pkCol?.name ?? 'rowid';
  }
  const placeholders = pkValues.map(() => '?').join(',');
  _write(`DELETE FROM "${table}" WHERE "${pk}" IN (${placeholders})`, pkValues as any[]);
  _scheduleSave();
}

// ─── Conversation SQL API (for SQL_REFINE agent) ──────────────────────────────

export type ConversationSqlEntry = {
  id?:              number;
  conversation_id:  string;
  change_name:      string;
  deploy_sql:       string;
  verify_sql:       string;
  revert_sql:       string;
  meta_json?:       string | null;
  created_at?:      string;
};

export function saveConversationSql(entry: ConversationSqlEntry): void {
  if (!_sqliteOk || !_db) return;
  try {
    _write(`
      INSERT INTO conversation_sql
        (conversation_id, change_name, deploy_sql, verify_sql, revert_sql, meta_json)
      VALUES (?,?,?,?,?,?)
    `, [
      entry.conversation_id,
      entry.change_name,
      entry.deploy_sql,
      entry.verify_sql,
      entry.revert_sql,
      entry.meta_json ?? null,
    ]);
    // Keep generated SQL for 30 days so earlier conversations can still be reopened.
    _write("DELETE FROM conversation_sql WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')");
    _scheduleSave();
  } catch { /* non-fatal */ }
}

export function getConversationSql(conversationId: string): ConversationSqlEntry | undefined {
  if (!_sqliteOk || !_db) return undefined;
  try {
    const stmt = _db.prepare(
      'SELECT * FROM conversation_sql WHERE conversation_id = ? ORDER BY id DESC LIMIT 1'
    );
    stmt.bind([conversationId]);
    let result: ConversationSqlEntry | undefined;
    if (stmt.step()) {
      result = stmt.getAsObject() as unknown as ConversationSqlEntry;
    }
    stmt.free();
    return result;
  } catch { return undefined; }
}

export function getConversationSqlHistory(conversationId: string): ConversationSqlEntry[] {
  if (!_sqliteOk || !_db) return [];
  try {
    const stmt = _db.prepare(
      'SELECT * FROM conversation_sql WHERE conversation_id = ? ORDER BY id ASC'
    );
    stmt.bind([conversationId]);
    const results: ConversationSqlEntry[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as ConversationSqlEntry);
    }
    stmt.free();
    return results;
  } catch { return []; }
}

export type ConversationSession = {
  conversation_id: string;
  first_change: string;
  change_count: number;
  first_at: string;
  last_at: string;
};

/** List distinct conversation sessions from conversation_sql, newest first. */
export function listConversationSessions(limit = 50): ConversationSession[] {
  if (!_sqliteOk || !_db) return [];
  try {
    const stmt = _db.prepare(
      `SELECT conversation_id,
              MIN(change_name) AS first_change,
              COUNT(*)         AS change_count,
              MIN(created_at)  AS first_at,
              MAX(created_at)  AS last_at
       FROM conversation_sql
       GROUP BY conversation_id
       ORDER BY last_at DESC
       LIMIT ?`
    );
    stmt.bind([limit]);
    const results: ConversationSession[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as ConversationSession);
    }
    stmt.free();
    return results;
  } catch { return []; }
}

/** Delete all conversation_sql rows for a given conversation_id. */
export function deleteConversationSession(conversationId: string): void {
  if (!_sqliteOk || !_db) return;
  try {
    _write('DELETE FROM conversation_sql WHERE conversation_id = ?', [conversationId]);
    _scheduleSave();
  } catch { /* non-fatal */ }
}
