/**
 * What one deploy.sql touches, at the level git would call "lines": a function / view / trigger
 * definition, a column definition, an enum's values, and data rows (table, key column, keys) per
 * column with the value each row gets. DMCR's own dmcr.* bookkeeping (backups) is ignored.
 */
import { placeholdersToIdent, identToPlaceholdersDeep } from '../schema/placeholders';
import { splitStatements } from '../../forms/llm/generation/live-schema-context';

export type Selector =
  | { kind: 'set'; col: string; values: string[] }
  | { kind: 'range'; col: string; lo: string; hi: string }
  | { kind: 'all' }
  | { kind: 'unknown'; text: string };

/** The value a row gets, as the SQL literal in the change ('slack', 5, NULL); undefined when it cannot be worked out. */
export type ValueFn = (key: string) => string | undefined;

export type Touch =
  /** whole definition: function, procedure, view, trigger */
  | { kind: 'definition'; key: string; object: string; objectType: 'function' | 'view' | 'trigger'; text: string; op: 'create' | 'drop' }
  | { kind: 'column'; key: string; table: string; column: string; op: 'add' | 'drop' | 'alter' | 'rename'; text: string }
  | { kind: 'table'; key: string; table: string; op: 'create' | 'drop'; text: string }
  | { kind: 'type'; key: string; type: string; op: 'create' | 'drop' | 'add-value' | 'rename-value' | 'alter'; values: string[]; text: string }
  | { kind: 'update'; key: string; table: string; column: string; rows: Selector; where: string; expr: string; value: ValueFn; alias: string; text: string }
  | { kind: 'insert'; key: string; table: string; keyColumn: string; keys: string[]; text: string }
  | { kind: 'delete'; key: string; table: string; rows: Selector; text: string };

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').replace(/\s+/g, ' ').trim();
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
const unq = (s: string) => s.replace(/"/g, '').replace(/\s+/g, '').toLowerCase();
/** schema-qualified name, public when not qualified */
export function qualify(name: string, defaultSchema = 'public'): string {
  const n = unq(name);
  return n.includes('.') ? n : `${defaultSchema}.${n}`;
}
const isDmcr = (qname: string) => qname.startsWith('dmcr.');

/** A SQL literal as a plain value ('it''s' -> it's, NULL -> null); undefined when not a literal. */
export function literal(s: string): string | null | undefined {
  const t = s.trim().replace(/::[\w\s".]+$/, '').trim();
  if (/^null$/i.test(t)) return null;
  const m = /^'((?:[^']|'')*)'$/.exec(t);
  if (m) return m[1].replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(t) || /^(true|false)$/i.test(t)) return t.toLowerCase();
  return undefined;
}

/** Split on commas at depth 0 (outside parentheses, strings and CASE ... END). */
export function splitTop(s: string, sep = ','): string[] {
  const out: string[] = []; let cur = ''; let depth = 0; let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") { let j = i + 1; while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; } if (s[j] === "'") break; j++; } cur += s.slice(i, j + 1); i = j + 1; continue; }
    if (/[A-Za-z]/.test(ch) && (i === 0 || !/[\w$]/.test(s[i - 1]))) {
      const w = /^[A-Za-z_]+/.exec(s.slice(i))![0];
      if (/^case$/i.test(w)) depth++;
      else if (/^end$/i.test(w)) depth--;
      cur += w; i += w.length; continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Index of a keyword at depth 0 (outside parentheses / strings / CASE), or -1. */
function findTop(s: string, word: RegExp, from = 0): number {
  let depth = 0; let i = from;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") { let j = i + 1; while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; } if (s[j] === "'") break; j++; } i = j + 1; continue; }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth--; i++; continue; }
    if (/[A-Za-z]/.test(ch) && (i === 0 || !/[\w$.]/.test(s[i - 1]))) {
      const w = /^[A-Za-z_]+/.exec(s.slice(i))![0];
      if (/^case$/i.test(w)) depth++;
      else if (/^end$/i.test(w)) depth--;
      else if (depth === 0 && word.test(w)) return i;
      i += w.length; continue;
    }
    i++;
  }
  return -1;
}

const colRx = (alias: string) => String.raw`(?:(?:${alias ? alias + '|' : ''}${IDENT})\s*\.\s*)?(${IDENT})`;

/** Row selector from a WHERE clause: col IN (...), col = '...', col BETWEEN 'a' AND 'b' (first one found). */
export function parseSelector(where: string | undefined, alias: string): Selector {
  if (!where || !where.trim()) return { kind: 'all' };
  const w = where.trim();
  const c = colRx(alias);
  let m = new RegExp(String.raw`^\(?\s*${c}\s+IN\s*\(([^)]*)\)`, 'i').exec(w) ?? new RegExp(String.raw`(?:^|\bAND\s+)${c}\s+IN\s*\(([^)]*)\)`, 'i').exec(w);
  if (m) {
    const vals = splitTop(m[2]).map(literal);
    if (vals.every(v => typeof v === 'string')) return { kind: 'set', col: unq(m[1]), values: vals as string[] };
  }
  m = new RegExp(String.raw`(?:^|\bAND\s+)${c}\s+BETWEEN\s+('(?:[^']|'')*')\s+AND\s+('(?:[^']|'')*')`, 'i').exec(w);
  if (m) return { kind: 'range', col: unq(m[1]), lo: literal(m[2]) as string, hi: literal(m[3]) as string };
  m = new RegExp(String.raw`(?:^|\bAND\s+)${c}\s*=\s*('(?:[^']|'')*'|-?\d+)`, 'i').exec(w);
  if (m) return { kind: 'set', col: unq(m[1]), values: [literal(m[2]) as string] };
  return { kind: 'unknown', text: w };
}

/** Does `key` satisfy a simple condition on the key column (=, <, <=, >, >=, <>, IN, BETWEEN)? undefined if not understood. */
function condHolds(cond: string, keyCol: string, key: string, alias: string): boolean | undefined {
  const c = colRx(alias);
  const t = cond.trim().replace(/^\((.*)\)$/, '$1').trim();
  let m = new RegExp(String.raw`^${c}\s+IN\s*\(([^)]*)\)$`, 'i').exec(t);
  if (m && unq(m[1]) === keyCol) { const vals = splitTop(m[2]).map(literal); return vals.includes(key); }
  m = new RegExp(String.raw`^${c}\s+BETWEEN\s+('(?:[^']|'')*')\s+AND\s+('(?:[^']|'')*')$`, 'i').exec(t);
  if (m && unq(m[1]) === keyCol) { const lo = literal(m[2]) as string; const hi = literal(m[3]) as string; return key >= lo && key <= hi; }
  m = new RegExp(String.raw`^${c}\s*(<=|>=|<>|!=|=|<|>)\s*('(?:[^']|'')*'|-?\d+)$`, 'i').exec(t);
  if (m && unq(m[1]) === keyCol) {
    const v = literal(m[3]) as string;
    switch (m[2]) { case '=': return key === v; case '<>': case '!=': return key !== v; case '<': return key < v; case '<=': return key <= v; case '>': return key > v; case '>=': return key >= v; }
  }
  return undefined;
}

/** Evaluates a SET expression for one key: a literal, or CASE [WHEN cond THEN literal]... [ELSE literal] END on the key column. */
export function valueFn(expr: string, keyCol: string, alias: string): ValueFn {
  const sqlLit = (tok: string) => (literal(tok) === null ? 'NULL' : tok.trim());
  if (literal(expr) !== undefined) return () => sqlLit(expr);
  const e = expr.trim();
  const caseM = /^CASE\s+([\s\S]*)\s+END$/i.exec(e);
  if (!caseM || !keyCol) return () => undefined;
  const body = caseM[1];
  // simple CASE: CASE code WHEN 'L001' THEN 'x' ...
  const simple = new RegExp(String.raw`^${colRx(alias)}\s+(WHEN[\s\S]*)$`, 'i').exec(body);
  const parts: { cond: string | null; val: string }[] = [];
  const rx = /\bWHEN\s+([\s\S]+?)\s+THEN\s+('(?:[^']|'')*'|-?\d+(?:\.\d+)?|NULL)(?=\s+WHEN\b|\s+ELSE\b|\s*$)/gi;
  const src = simple ? simple[2] : body;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src))) parts.push({ cond: simple ? `${simple[1]} = ${m[1]}` : m[1], val: m[2] });
  const elseM = /\bELSE\s+('(?:[^']|'')*'|-?\d+(?:\.\d+)?|NULL)\s*$/i.exec(src);
  if (!parts.length) return () => undefined;
  return (key: string) => {
    for (const p of parts) {
      const h = condHolds(p.cond!, keyCol, key, alias);
      if (h === undefined) return undefined;
      if (h) return sqlLit(p.val);
    }
    return elseM ? sqlLit(elseM[1]) : 'NULL';
  };
}

/** Parse the touches of one deploy.sql. */
/** ${schema}.zaps is parsed as a name and reported as written. */
export function touchesOf(sql: string, defaultSchema = 'public'): Touch[] {
  return identToPlaceholdersDeep(plainTouchesOf(placeholdersToIdent(sql), defaultSchema));
}

function plainTouchesOf(sql: string, defaultSchema: string): Touch[] {
  const out: Touch[] = [];
  // the statement without the comment lines in front of it (those belong to the file, not the definition)
  for (const raw of splitStatements(sql).map(st => st.replace(/^(?:[ \t]*(?:--[^\n]*)?\r?\n)+/, '').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '').trim())) {
    const s = strip(raw).replace(/;$/, '').trim();
    if (!s) continue;
    let m: RegExpExecArray | null;

    // ── functions / procedures ──
    if ((m = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+(${QNAME})\s*\(([^)]*)\)`, 'i').exec(s))) {
      const name = qualify(m[2], defaultSchema);
      if (isDmcr(name)) continue;
      const object = `${name}(${argTypes(m[3])})`;
      out.push({ kind: 'definition', key: `function:${object}`, object, objectType: 'function', text: raw.trim(), op: 'create' });
      continue;
    }
    if ((m = new RegExp(String.raw`^DROP\s+(FUNCTION|PROCEDURE)\s+(?:IF\s+EXISTS\s+)?(${QNAME})\s*(?:\(([^)]*)\))?`, 'i').exec(s))) {
      const name = qualify(m[2], defaultSchema);
      const object = `${name}(${argTypes(m[3] ?? '')})`;
      out.push({ kind: 'definition', key: `function:${object}`, object, objectType: 'function', text: raw.trim(), op: 'drop' });
      continue;
    }
    // ── views ──
    if ((m = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QNAME})`, 'i').exec(s))) {
      const object = qualify(m[1], defaultSchema);
      if (!isDmcr(object)) out.push({ kind: 'definition', key: `view:${object}`, object, objectType: 'view', text: raw.trim(), op: 'create' });
      continue;
    }
    if ((m = new RegExp(String.raw`^DROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?(${QNAME})`, 'i').exec(s))) {
      const object = qualify(m[1], defaultSchema);
      out.push({ kind: 'definition', key: `view:${object}`, object, objectType: 'view', text: raw.trim(), op: 'drop' });
      continue;
    }
    // ── triggers ──
    if ((m = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(${IDENT})\s[\s\S]*?\bON\s+(${QNAME})`, 'i').exec(s))) {
      const object = `${qualify(m[2], defaultSchema)}.${unq(m[1])}`;
      out.push({ kind: 'definition', key: `trigger:${object}`, object, objectType: 'trigger', text: raw.trim(), op: 'create' });
      continue;
    }
    if ((m = new RegExp(String.raw`^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+(${QNAME})`, 'i').exec(s))) {
      const object = `${qualify(m[2], defaultSchema)}.${unq(m[1])}`;
      out.push({ kind: 'definition', key: `trigger:${object}`, object, objectType: 'trigger', text: raw.trim(), op: 'drop' });
      continue;
    }
    // ── types / enums / domains ──
    if ((m = new RegExp(String.raw`^CREATE\s+(TYPE|DOMAIN)\s+(${QNAME})\s*(?:AS\s+ENUM\s*\(([^)]*)\))?`, 'i').exec(s))) {
      const type = qualify(m[2], defaultSchema);
      if (isDmcr(type)) continue;
      const values = m[3] ? splitTop(m[3]).map(v => String(literal(v) ?? v)) : [];
      out.push({ kind: 'type', key: `type:${type}`, type, op: 'create', values, text: raw.trim() });
      continue;
    }
    if ((m = new RegExp(String.raw`^ALTER\s+TYPE\s+(${QNAME})\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?('(?:[^']|'')*')`, 'i').exec(s))) {
      const type = qualify(m[1], defaultSchema);
      out.push({ kind: 'type', key: `type:${type}`, type, op: 'add-value', values: [literal(m[2]) as string], text: raw.trim() });
      continue;
    }
    if ((m = new RegExp(String.raw`^ALTER\s+TYPE\s+(${QNAME})\s+RENAME\s+VALUE\s+('(?:[^']|'')*')\s+TO\s+('(?:[^']|'')*')`, 'i').exec(s))) {
      const type = qualify(m[1], defaultSchema);
      out.push({ kind: 'type', key: `type:${type}`, type, op: 'rename-value', values: [literal(m[2]) as string, literal(m[3]) as string], text: raw.trim() });
      continue;
    }
    if ((m = new RegExp(String.raw`^(?:DROP|ALTER)\s+(TYPE|DOMAIN)\s+(?:IF\s+EXISTS\s+)?(${QNAME})`, 'i').exec(s))) {
      const type = qualify(m[2], defaultSchema);
      if (isDmcr(type)) continue;
      out.push({ kind: 'type', key: `type:${type}`, type, op: /^DROP/i.test(s) ? 'drop' : 'alter', values: [], text: raw.trim() });
      continue;
    }
    // ── tables and columns ──
    if ((m = new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QNAME})`, 'i').exec(s))) {
      const table = qualify(m[1], defaultSchema);
      if (!isDmcr(table)) out.push({ kind: 'table', key: `table:${table}`, table, op: 'create', text: raw.trim() });
      continue;
    }
    if ((m = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${QNAME})`, 'i').exec(s))) {
      const table = qualify(m[1], defaultSchema);
      if (!isDmcr(table)) out.push({ kind: 'table', key: `table:${table}`, table, op: 'drop', text: raw.trim() });
      continue;
    }
    if ((m = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})\s+([\s\S]+)$`, 'i').exec(s))) {
      const table = qualify(m[1], defaultSchema);
      if (isDmcr(table)) continue;
      for (const clause of splitTop(m[2])) {
        let c: RegExpExecArray | null;
        if ((c = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`, 'i').exec(clause)) && !/^ADD\s+(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(clause)) {
          out.push({ kind: 'column', key: `column:${table}.${unq(c[1])}`, table, column: unq(c[1]), op: 'add', text: clause });
        } else if ((c = new RegExp(String.raw`^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${IDENT})`, 'i').exec(clause)) && !/^DROP\s+CONSTRAINT\b/i.test(clause)) {
          out.push({ kind: 'column', key: `column:${table}.${unq(c[1])}`, table, column: unq(c[1]), op: 'drop', text: clause });
        } else if ((c = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENT})`, 'i').exec(clause))) {
          out.push({ kind: 'column', key: `column:${table}.${unq(c[1])}`, table, column: unq(c[1]), op: 'alter', text: clause });
        } else if ((c = new RegExp(String.raw`^RENAME\s+(?:COLUMN\s+)?(${IDENT})\s+TO\s+(${IDENT})`, 'i').exec(clause))) {
          out.push({ kind: 'column', key: `column:${table}.${unq(c[1])}`, table, column: unq(c[1]), op: 'rename', text: clause });
        }
      }
      continue;
    }
    // ── data ──
    if ((m = new RegExp(String.raw`^UPDATE\s+(?:ONLY\s+)?(${QNAME})(?:\s+(?:AS\s+)?(?!SET\b)(${IDENT}))?\s+SET\s+([\s\S]+)$`, 'i').exec(s))) {
      const table = qualify(m[1], defaultSchema);
      if (isDmcr(table)) continue;
      const alias = m[2] ? unq(m[2]) : '';
      const rest = m[3];
      const end = [findTop(rest, /^from$/i), findTop(rest, /^where$/i), findTop(rest, /^returning$/i)].filter(x => x >= 0);
      const setPart = end.length ? rest.slice(0, Math.min(...end)) : rest;
      const wi = findTop(rest, /^where$/i);
      const ri = findTop(rest, /^returning$/i);
      const where = wi >= 0 ? rest.slice(wi + 5, ri > wi ? ri : undefined) : undefined;
      const rows = parseSelector(where, alias);
      const keyCol = rows.kind === 'set' || rows.kind === 'range' ? rows.col : '';
      for (const a of splitTop(setPart)) {
        const am = new RegExp(String.raw`^(${IDENT})\s*=\s*([\s\S]+)$`, 'i').exec(a);
        if (!am) continue;
        const column = unq(am[1]);
        out.push({ kind: 'update', key: `data:${table}.${column}`, table, column, rows, where: (where ?? '').trim(), expr: am[2].trim(), value: valueFn(am[2], keyCol, alias), alias, text: raw.trim() });
      }
      continue;
    }
    if ((m = new RegExp(String.raw`^INSERT\s+INTO\s+(${QNAME})\s*\(([^)]*)\)\s*([\s\S]+)$`, 'i').exec(s))) {
      const table = qualify(m[1], defaultSchema);
      if (isDmcr(table)) continue;
      const cols = splitTop(m[2]).map(unq);
      const keyIdx = Math.max(0, ['code', 'name', 'key', 'id'].map(k => cols.indexOf(k)).find(i => i >= 0) ?? 0);
      const keys: string[] = [];
      const vi = m[3].search(/\bVALUES\b/i);
      if (vi >= 0) {
        for (const tuple of m[3].slice(vi + 6).match(/\((?:[^()']|'(?:[^']|'')*')*\)/g) ?? []) {
          const v = literal(splitTop(tuple.slice(1, -1))[keyIdx] ?? '');
          if (typeof v === 'string') keys.push(v);
        }
      }
      out.push({ kind: 'insert', key: `rows:${table}`, table, keyColumn: cols[keyIdx] ?? '', keys, text: raw.trim() });
      continue;
    }
    if ((m = new RegExp(String.raw`^DELETE\s+FROM\s+(?:ONLY\s+)?(${QNAME})(?:\s+(?:AS\s+)?(?!WHERE\b|USING\b)(${IDENT}))?(?:\s+USING\s+[\s\S]+?)?(?:\s+WHERE\s+([\s\S]+))?$`, 'i').exec(s))) {
      const table = qualify(m[1], defaultSchema);
      if (isDmcr(table)) continue;
      out.push({ kind: 'delete', key: `rows:${table}`, table, rows: parseSelector(m[3], m[2] ? unq(m[2]) : ''), text: raw.trim() });
      continue;
    }
  }
  return out;
}

/** Parameter types of a function signature: (p_zap_id bigint, b text DEFAULT '') -> bigint,text */
export function argTypes(params: string): string {
  if (!params.trim()) return '';
  const MODES = /^(IN|OUT|INOUT|VARIADIC)\s+/i;
  return splitTop(params).map(p => {
    let t = p.replace(/\s+(DEFAULT\b|=)[\s\S]*$/i, '').replace(MODES, '').trim();
    const words = t.split(/\s+/);
    // "name type" -> type (a lone word is already a type)
    if (words.length > 1 && !/^(double|character|bit|time|timestamp|interval)$/i.test(words[0])) t = words.slice(1).join(' ');
    return t.toLowerCase();
  }).join(',');
}

/** Rows two selectors both hit: a key list when it can be worked out, true when they overlap but the rows are not listed, false when they do not overlap. */
export function overlapRows(a: Selector, b: Selector): string[] | boolean {
  if (a.kind === 'all' || b.kind === 'all') {
    const other = a.kind === 'all' ? b : a;
    return other.kind === 'set' ? other.values : true;
  }
  if (a.kind === 'unknown' || b.kind === 'unknown') return true;
  if (a.col !== b.col) return true;
  const inRange = (v: string, r: { lo: string; hi: string }) => v >= r.lo && v <= r.hi;
  if (a.kind === 'set' && b.kind === 'set') return a.values.filter(v => b.values.includes(v));
  if (a.kind === 'set' && b.kind === 'range') return a.values.filter(v => inRange(v, b));
  if (a.kind === 'range' && b.kind === 'set') return b.values.filter(v => inRange(v, a));
  if (a.kind === 'range' && b.kind === 'range') return a.lo <= b.hi && b.lo <= a.hi;
  return true;
}

export function describeSelector(s: Selector): string {
  switch (s.kind) {
    case 'set': return s.values.length <= 4 ? `${s.col} ${s.values.join(', ')}` : `${s.col} ${s.values[0]} .. ${s.values[s.values.length - 1]} (${s.values.length})`;
    case 'range': return `${s.col} ${s.lo} .. ${s.hi}`;
    case 'all': return 'every row';
    default: return s.text.slice(0, 80);
  }
}
