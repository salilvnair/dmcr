/**
 * Real definitions of the objects a request talks about, for the generation prompt.
 *
 * Without this the model only saw the request text and guessed column names and types.
 * Two sources, because a database often lags the repository:
 *   1. the live database, through the DB MCP server (discover_objects + get_ddl);
 *   2. the repository's change folders: the statements that create or alter the object, in deploy
 *      order - the schema as it will be once pending changes are applied (on a fresh test database
 *      that is the only place the object exists yet).
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolvePlaceholders } from '../../../services/schema/placeholders';
import { compareChangeIds } from '../../../storage/change-order';

const MAX_CHARS = 9000;

type Obj = { schema: string; name: string };

/** schema.name and bare snake_case names mentioned in the request (bare ones get the default schema). */
export function mentionedObjects(text: string, defaultSchema: string): Obj[] {
  const out = new Map<string, Obj>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
    if (m[1] === 'dmcr') continue;
    out.set(`${m[1]}.${m[2]}`, { schema: m[1], name: m[2] });
  }
  const qualifiedNames = new Set([...out.values()].map(o => o.name));
  for (const m of lower.matchAll(/(?<![.\w])([a-z][a-z0-9]*_[a-z0-9_]+)\b/g)) {
    if (qualifiedNames.has(m[1])) continue;
    const key = `${defaultSchema}.${m[1]}`;
    if (!out.has(key)) out.set(key, { schema: defaultSchema, name: m[1] });
  }
  return [...out.values()];
}

/** Split SQL into statements, keeping $tag$ bodies, quoted strings and comments intact. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []; let cur = ''; let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); const end = j < 0 ? sql.length : j; cur += sql.slice(i, end); i = end; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const j = sql.indexOf('*/', i + 2); const end = j < 0 ? sql.length : j + 2; cur += sql.slice(i, end); i = end; continue; }
    if (ch === "'") { let j = i + 1; while (j < sql.length) { if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; } if (sql[j] === "'") break; j++; } cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (ch === '$') { const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i)); if (m) { const j = sql.indexOf(m[0], i + m[0].length); const end = j < 0 ? sql.length : j + m[0].length; cur += sql.slice(i, end); i = end; continue; } }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim() + ';'); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').trim();

/** Structure statements in one deploy.sql that define or change `o` (not DMCR's own dmcr.* bookkeeping). */
export function statementsFor(sql: string, o: Obj, home = 'public'): string[] {
  const nameRx = new RegExp(`(^|[^\\w.])("?${o.schema}"?\\.)?"?${o.name}"?(?![\\w])`, 'i');
  const qualifiedRx = new RegExp(`"?${o.schema}"?\\."?${o.name}"?(?![\\w])`, 'i');
  return splitStatements(sql).filter(st => {
    const t = stripComments(st);
    if (!/^(CREATE|ALTER|COMMENT|GRANT|REVOKE|DROP)\b/i.test(t)) return false;
    if (/^(CREATE\s+(UNLOGGED\s+)?TABLE|ALTER\s+TABLE|DROP\s+TABLE)\s+(IF\s+(NOT\s+)?EXISTS\s+)?"?dmcr"?\./i.test(t)) return false;
    // the object itself must be named: schema-qualified, or without a schema when it is in the home schema
    // (the environment's schema, which is every session's search_path; public before that)
    return qualifiedRx.test(t) || ((o.schema === home || o.schema === 'public') && nameRx.test(t));
  }).map(stripComments);
}

/** Pending/applied structure of the mentioned objects from the change folders, in deploy order. */
export function repoDefinitions(changesDir: string, objs: Obj[], placeholders: Record<string, string | undefined> = {}, home = 'public'): string {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(changesDir).filter(d => /^\d+_/.test(d)).sort(compareChangeIds); } catch { return ''; }
  const parts: string[] = [];
  for (const d of dirs) {
    let sql = '';
    try { sql = resolvePlaceholders(fs.readFileSync(path.join(changesDir, d, 'deploy.sql'), 'utf8'), placeholders); } catch { continue; }
    const hits = new Set<string>();
    for (const o of objs) for (const st of statementsFor(sql, o, home)) hits.add(st);
    if (hits.size) parts.push(`-- ${d}\n${[...hits].join('\n\n')}`);
  }
  return parts.join('\n\n');
}

export interface LiveDb {
  /** objects of one schema: name -> type ('table' | 'view' | 'function' | 'sequence' ...) */
  objects(schema: string): Promise<Map<string, string> | null>;
  ddl(schema: string, name: string, type: string): Promise<string>;
  label: string;
}

/** The context block for the generation prompt ('' when nothing mentioned is known). */
export async function buildLiveSchemaContext(request: string, defaultSchema: string, changesDir: string | null, live: LiveDb | null, placeholders: Record<string, string | undefined> = {}): Promise<string> {
  const objs = mentionedObjects(request, defaultSchema || 'public');
  if (!objs.length) return '';
  const sections: string[] = [];

  if (live) {
    const bySchema = new Map<string, Map<string, string> | null>();
    const ddls: string[] = [];
    for (const o of objs) {
      if (!bySchema.has(o.schema)) bySchema.set(o.schema, await live.objects(o.schema).catch(() => null));
      const type = bySchema.get(o.schema)?.get(o.name);
      if (!type) continue;
      const ddl = (await live.ddl(o.schema, o.name, type).catch(() => '')).trim();
      if (ddl) ddls.push(`-- ${o.schema}.${o.name} (${type})\n${ddl}`);
    }
    if (ddls.length) sections.push(`LIVE DATABASE OBJECTS (read now through MCP from ${live.label}; this is the exact current definition):\n${ddls.join('\n\n')}`);
  }

  if (changesDir) {
    const repo = repoDefinitions(changesDir, objs, placeholders, defaultSchema || 'public');
    if (repo) sections.push(`CHANGES IN THIS REPOSITORY THAT CREATE OR ALTER THESE OBJECTS (in deploy order; together they are the schema as it will be once all pending changes are applied, and the live database may not have them yet):\n${repo}`);
  }

  if (!sections.length) return '';
  let text = `\n\nOBJECT DEFINITIONS - use these exact names, columns and types; do not guess:\n${sections.join('\n\n')}`;
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n-- ...[truncated]';
  return text;
}
