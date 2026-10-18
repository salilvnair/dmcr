/**
 * The previous definition of a function, procedure or view a change replaces, found by DMCR itself so
 * nobody has to paste it (Freeform's Previous version) and the revert restores it word for word.
 *
 * Where it comes from, in this order:
 *   1. the repository: the newest change folder whose deploy.sql creates or replaces the same object (same
 *      name and argument types). That is exactly what the runner deployed before this change, already
 *      written with ${schema}.
 *   2. the live database of the generation environment, through the DB MCP server (get_ddl). PostgreSQL
 *      rebuilds that text from its catalog (header layout, $function$ quoting), so it restores the same
 *      object but does not read like the file; the schema is written back as ${schema}.
 * Neither has it: the object is new, and the revert drops it (written by the AI).
 */
import * as fs from 'fs';
import * as path from 'path';
import { splitStatements } from './live-schema-context';
import { compareChangeIds } from '../../../storage/change-order';

export type ReplaceableKind = 'function' | 'procedure' | 'view';

/** A function / procedure / view named by a CREATE (OR REPLACE) or DROP statement. */
export type DefinedObject = {
  kind: ReplaceableKind;
  /** schema as written (${schema}, zp_st, …) or null when unqualified */
  schema: string | null;
  name: string;
  /** identity argument types, normalised (routines); null for a view or a DROP without an argument list */
  args: string[] | null;
  /** ${schema}.zap_score(bigint) */
  display: string;
};

export type PreviousSource = { kind: 'repo'; change: string } | { kind: 'live'; server: string };

export type PreviousDefinition = {
  object: DefinedObject;
  /** the statement that restores the previous definition, word for word; null when the object is new */
  sql: string | null;
  source: PreviousSource | null;
};

const IDENT = String.raw`(?:"[^"]+"|\$\{[A-Za-z_]\w*\}|[A-Za-z_][\w$]*)`;
const HEAD_RX = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:temp|temporary)\s+)?(?:recursive\s+)?(function|procedure|view)\s+(?:(${IDENT})\s*\.\s*)?(${IDENT})`, 'i');
const DROP_RX = new RegExp(String.raw`^drop\s+(function|procedure|view)\s+(?:if\s+exists\s+)?(?:(${IDENT})\s*\.\s*)?(${IDENT})`, 'i');
const REPLACE_RX = /^create\s+or\s+replace\s+(?:(?:temp|temporary)\s+)?(?:recursive\s+)?(?:function|procedure|view)\b/i;

/** The statement without the comment lines / blocks in front of it. */
export function stripLeadingComments(stmt: string): string {
  let s = stmt.trimStart();
  for (;;) {
    if (s.startsWith('--')) { const j = s.indexOf('\n'); s = j < 0 ? '' : s.slice(j + 1).trimStart(); continue; }
    if (s.startsWith('/*')) { const j = s.indexOf('*/'); s = j < 0 ? '' : s.slice(j + 2).trimStart(); continue; }
    return s;
  }
}

const unquote = (x: string) => x.replace(/^"(.*)"$/, '$1');

/** Text of the balanced (...) starting at `open`, or null. */
function parenGroup(s: string, open: number): string | null {
  let depth = 0, quote = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return s.slice(open + 1, i); }
  }
  return null;
}

const TYPE_WORDS = new Set(('bigint int int2 int4 int8 integer smallint numeric decimal real double float float4 float8 money text varchar ' +
  'character char bpchar name citext boolean bool date time timetz timestamp timestamptz interval json jsonb uuid bytea inet cidr ' +
  'macaddr xml point record anyelement anyarray anycompatible anynonarray anyenum anyrange oid regclass regproc regtype tsvector tsquery bit varbit void trigger setof').split(' '));
const ALIASES: Record<string, string> = {
  int: 'integer', int4: 'integer', int2: 'smallint', int8: 'bigint', bool: 'boolean', float8: 'double precision', float4: 'real',
  'character varying': 'varchar', decimal: 'numeric', 'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp',
  'time with time zone': 'timetz', 'time without time zone': 'time', char: 'bpchar', character: 'bpchar',
};

/** Identity argument types of a routine's argument list: modes, names, defaults and typmods left out; OUT arguments do not count. */
export function identityArgs(argList: string, normSchema: (s: string) => string = s => s): string[] {
  const parts: string[] = []; let depth = 0, cur = '';
  for (const ch of argList) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out: string[] = [];
  for (const raw of parts) {
    let a = raw.replace(/\s+(default\b|=)[\s\S]*$/i, '').trim();
    const mode = /^(in|out|inout|variadic)\s+/i.exec(a);
    if (mode) { if (/^out$/i.test(mode[1])) continue; a = a.slice(mode[0].length); }
    const tokens = a.split(/\s+/);
    // "p_zap_id bigint": the first word is the argument's name unless it already starts the type ("double precision")
    if (tokens.length > 1 && !TYPE_WORDS.has(tokens[0].toLowerCase().replace(/\(.*$/, '')) && !/[.[]/.test(tokens[0])) tokens.shift();
    let t = tokens.join(' ').toLowerCase().replace(/"/g, '').replace(/\s*\([^)]*\)/g, '').replace(/\s*\.\s*/g, '.').trim();
    t = ALIASES[t] ?? t;
    const dot = t.lastIndexOf('.');
    if (dot > 0 && !t.endsWith(']')) t = `${normSchema(t.slice(0, dot))}.${t.slice(dot + 1)}`;
    out.push(t);
  }
  return out;
}

function describe(kind: ReplaceableKind, schema: string | null, name: string, args: string[] | null): string {
  return `${schema ? schema + '.' : ''}${name}${args ? `(${args.join(', ')})` : ''}`;
}

/** The function / procedure / view a CREATE or DROP statement names (comments in front are fine). */
export function definedObject(stmt: string, normSchema: (s: string) => string = s => s): DefinedObject | null {
  const s = stripLeadingComments(stmt);
  const create = HEAD_RX.exec(s);
  const m = create ?? DROP_RX.exec(s);
  if (!m) return null;
  const kind = m[1].toLowerCase() as ReplaceableKind;
  const schema = m[2] ? normSchema(unquote(m[2])) : null;
  const name = unquote(m[3]).toLowerCase();
  let args: string[] | null = null;
  if (kind !== 'view') {
    const rest = s.slice(m[0].length);
    const open = /^\s*\(/.exec(rest);
    if (open) { const g = parenGroup(rest, open[0].length - 1); if (g !== null) args = identityArgs(g, normSchema); }
    else if (create) args = [];
  }
  return { kind, schema, name, args, display: describe(kind, schema, name, args) };
}

const isDrop = (stmt: string) => /^drop\b/i.test(stripLeadingComments(stmt));

/** Same object: kind (routines are one namespace), name, schema (unqualified matches any) and argument types. */
export function sameObject(a: DefinedObject, b: DefinedObject): boolean {
  const routine = (k: ReplaceableKind) => k === 'function' || k === 'procedure';
  if (a.kind !== b.kind && !(routine(a.kind) && routine(b.kind))) return false;
  if (a.name !== b.name) return false;
  if (a.schema && b.schema && a.schema.toLowerCase() !== b.schema.toLowerCase()) return false;
  if (a.args && b.args) return a.args.join(',') === b.args.join(',');
  return true;
}

/** The functions / procedures / views a deploy.sql replaces (CREATE OR REPLACE), in order. */
export function replacedObjects(deploySql: string, normSchema?: (s: string) => string): DefinedObject[] {
  const out: DefinedObject[] = [];
  for (const st of splitStatements(deploySql)) {
    if (!REPLACE_RX.test(stripLeadingComments(st))) continue;
    const o = definedObject(st, normSchema);
    if (o && !out.some(x => sameObject(x, o))) out.push(o);
  }
  return out;
}

/**
 * The functions / procedures / views replaced by CREATE OR REPLACE statements anywhere in a text: a request
 * that has SQL inside prose (the Assistant chat, Freeform's request with DEPLOY_SQL_START … END).
 */
export function replacedObjectsInText(text: string, normSchema?: (s: string) => string): DefinedObject[] {
  const out: DefinedObject[] = [];
  for (const m of text.matchAll(/create\s+or\s+replace\s+(?:(?:temp|temporary)\s+)?(?:recursive\s+)?(?:function|procedure|view)\b/gi)) {
    const first = splitStatements(text.slice(m.index ?? 0))[0] ?? '';
    const o = definedObject(first, normSchema);
    if (o && !out.some(x => sameObject(x, o))) out.push(o);
  }
  return out;
}

/** The newest definition of `obj` in the numbered change folders (a later DROP of it forgets it). */
export function repoPreviousDefinition(changesDir: string, obj: DefinedObject, normSchema?: (s: string) => string): { sql: string; change: string } | null {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(changesDir).filter(d => /^\d+_/.test(d)).sort(compareChangeIds); } catch { return null; }
  let found: { sql: string; change: string } | null = null;
  for (const d of dirs) {
    let sql = '';
    try { sql = fs.readFileSync(path.join(changesDir, d, 'deploy.sql'), 'utf8'); } catch { continue; }
    for (const st of splitStatements(sql)) {
      const o = definedObject(st, normSchema);
      if (!o || !sameObject(o, obj)) continue;
      found = isDrop(st) ? null : { sql: stripLeadingComments(st).replace(/;?\s*$/, ';'), change: d };
    }
  }
  return found;
}

/** Reads one object's definition from the live database (the DB MCP server's get_ddl). */
export type LiveDdl = { label: string; ddl(schema: string, name: string, type: 'function' | 'view'): Promise<string> };

/**
 * The previous definition of every object `deploySql` replaces: repository first, then the live database.
 * `envSchema` is the generation environment's schema (zp_st): it is what ${schema} means while looking
 * objects up, and live text is written back with ${schema}.
 */
export async function previousDefinitionsFor(deploySql: string, opts: { changesDir?: string | null; live?: LiveDdl | null; envSchema?: string; toPlaceholder?: (sql: string) => string; inText?: boolean }): Promise<PreviousDefinition[]> {
  const env = opts.envSchema?.toLowerCase();
  const normSchema = (s: string) => (env && s.toLowerCase() === env ? '${schema}' : s);
  const out: PreviousDefinition[] = [];
  const objects = opts.inText ? replacedObjectsInText(deploySql, normSchema) : replacedObjects(deploySql, normSchema);
  for (const object of objects) {
    const repo = opts.changesDir ? repoPreviousDefinition(opts.changesDir, object, normSchema) : null;
    if (repo) { out.push({ object, sql: repo.sql, source: { kind: 'repo', change: repo.change } }); continue; }
    let liveSql: string | null = null;
    if (opts.live) {
      const schema = !object.schema || object.schema === '${schema}' ? (opts.envSchema || 'public') : object.schema;
      try {
        let ddl = (await opts.live.ddl(schema, object.name, object.kind === 'view' ? 'view' : 'function')).trim();
        if (ddl && opts.toPlaceholder) ddl = opts.toPlaceholder(ddl);
        // get_ddl gives one overload of a name: use it only when it is this signature
        const got = ddl ? definedObject(ddl, normSchema) : null;
        if (got && sameObject(got, object)) liveSql = ddl.replace(/;?\s*$/, ';');
      } catch { /* live database not reachable: treated as unknown */ }
    }
    out.push({ object, sql: liveSql, source: liveSql ? { kind: 'live', server: opts.live!.label } : null });
  }
  return out;
}

export function sourceLabel(src: PreviousSource | null): string {
  if (!src) return 'nowhere (new object)';
  return src.kind === 'repo' ? `${src.change}/deploy.sql` : `live ${src.server} (rebuilt by PostgreSQL)`;
}

/**
 * revert.sql for a change that only replaces functions / procedures / views whose previous definitions are
 * all known: those definitions, word for word, newest replacement first. null when the change does
 * anything else, or replaces an object that is new.
 */
export function exactRevertFromPrevious(deploySql: string, prev: PreviousDefinition[]): string | null {
  const stmts = splitStatements(deploySql).map(stripLeadingComments).filter(Boolean);
  if (!stmts.length || !prev.length || prev.some(p => !p.sql)) return null;
  if (!stmts.every(st => REPLACE_RX.test(st))) return null;
  const header = prev.map(p => `-- Revert: put back the previous definition of ${p.object.display}, word for word (from ${sourceLabel(p.source)}).`);
  return [...header, ...[...prev].reverse().map(p => p.sql!), ''].join('\n');
}

/**
 * For a change that does more than replace objects (the AI writes its revert): every statement of the
 * revert that re-creates a replaced object is swapped for the exact previous definition.
 */
export function pinPreviousDefinitions(revertSql: string, prev: PreviousDefinition[], normSchema?: (s: string) => string): string {
  const known = prev.filter(p => p.sql);
  if (!known.length) return revertSql;
  let out = revertSql;
  for (const st of splitStatements(revertSql)) {
    if (!REPLACE_RX.test(stripLeadingComments(st))) continue;
    const o = definedObject(st, normSchema);
    const p = o && known.find(k => sameObject(k.object, o));
    // a function as the replacement: a string would turn the body's $$ into $ ("$$" means "$" in a replacement string)
    if (p) { const exact = p.sql!.replace(/;$/, ''); out = out.replace(stripLeadingComments(st).replace(/;$/, ''), () => exact); }
  }
  return out;
}
