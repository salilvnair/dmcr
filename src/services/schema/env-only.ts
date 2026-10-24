/**
 * Schema Diff and changes kept to some environments (meta.json "environments"): what such a change does to one
 * side of the compare and not the other is expected, not drift. An object it creates (table, view, function,
 * sequence, type) and no change for the other side creates is an "expected difference"; a table it only alters
 * stays drift (another change may have drifted it too) and carries a note naming the change.
 */
import { tablesInSql } from './sql-tables';

export type EnvChange = { id: string; environments?: string[]; deploySql: string };
export type ExpectedNote = { change: string; onlyFor: string[] };

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;
const CREATE = new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE|SEQUENCE|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?` + QNAME, 'gi');

/** The bare, lower-case name: zp_st."Zaps" -> zaps, lookup_card_for(varchar) -> lookup_card_for. */
export function bareName(name: string): string {
  return (name.split('(')[0].split('.').pop() ?? name).replace(/"/g, '').trim().toLowerCase();
}

const strip = (sql: string) => sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Objects a deploy.sql creates (bare names); dmcr.bak_* backups are DMCR's own and left out. */
export function createdInSql(sql: string): string[] {
  const out = new Set<string>();
  const text = strip(sql);
  CREATE.lastIndex = 0;
  for (let m = CREATE.exec(text); m; m = CREATE.exec(text)) {
    const q = m[1].replace(/\s+/g, '').replace(/"/g, '');
    if (/^dmcr\./i.test(q)) continue;
    out.add(bareName(q));
  }
  return [...out];
}

/** Objects a deploy.sql creates or changes (bare names). */
export function touchedInSql(sql: string): string[] {
  return [...new Set([...createdInSql(sql), ...tablesInSql(strip(sql)).filter(t => !/^dmcr\./i.test(t)).map(bareName)])];
}

const listed = (envs: string[] | undefined, env: string) => !!envs?.some(e => e.toLowerCase() === env.toLowerCase());

/**
 * For a compare of `sourceEnv` against `targetEnv`: the objects that are expected only on one side (created by a
 * change kept off the other side, and by no change that goes to both), and the objects such a change only alters.
 */
export function expectedDifferences(changes: EnvChange[], sourceEnv: string, targetEnv: string): { created: Map<string, ExpectedNote>; altered: Map<string, ExpectedNote> } {
  const created = new Map<string, ExpectedNote>();
  const altered = new Map<string, ExpectedNote>();
  if (!sourceEnv || !targetEnv) return { created, altered };
  const oneSided = (c: EnvChange) => !!c.environments?.length && listed(c.environments, sourceEnv) !== listed(c.environments, targetEnv);
  // what changes that go to both sides create: those objects are compared as usual
  const shared = new Set<string>();
  for (const c of changes) if (!oneSided(c) && (!c.environments?.length || (listed(c.environments, sourceEnv) && listed(c.environments, targetEnv)))) createdInSql(c.deploySql).forEach(n => shared.add(n));
  for (const c of changes) {
    if (!oneSided(c)) continue;
    const note = { change: c.id, onlyFor: c.environments! };
    const made = createdInSql(c.deploySql);
    for (const n of made) if (!shared.has(n) && !created.has(n)) created.set(n, note);
    for (const n of touchedInSql(c.deploySql)) if (!made.includes(n) && !altered.has(n)) altered.set(n, note);
  }
  return { created, altered };
}

type DriftObject = { name: string; type?: string; schema?: string; [k: string]: unknown };

/**
 * Moves the expected objects of a compare_schemas result out of only_in_source / only_in_target into `expected`
 * (each with the change and the environments it is for), notes the drifted ones such a change alters, and
 * recounts the summary. Returns the data unchanged when nothing is expected.
 */
export function annotateCompare(data: Record<string, unknown>, notes: ReturnType<typeof expectedDifferences>): Record<string, unknown> {
  if (!notes.created.size && !notes.altered.size) return data;
  const take = (key: string, side: 'source' | 'target') => {
    const keep: DriftObject[] = []; const moved: DriftObject[] = [];
    for (const o of (data[key] as DriftObject[] | undefined) ?? []) {
      const n = notes.created.get(bareName(o.name));
      if (n) moved.push({ ...o, only_on: side, change: n.change, only_for: n.onlyFor }); else keep.push(o);
    }
    return { keep, moved };
  };
  const src = take('only_in_source', 'source');
  const tgt = take('only_in_target', 'target');
  const drifted = ((data.drifted as DriftObject[] | undefined) ?? []).map(o => {
    const n = notes.altered.get(bareName(o.name)) ?? notes.created.get(bareName(o.name));
    return n ? { ...o, env_note: { change: n.change, only_for: n.onlyFor } } : o;
  });
  const expected = [...src.moved, ...tgt.moved];
  const summary = { ...((data.summary as Record<string, unknown> | undefined) ?? {}) };
  if (typeof summary.only_in_source === 'number') summary.only_in_source = src.keep.length;
  if (typeof summary.only_in_target === 'number') summary.only_in_target = tgt.keep.length;
  summary.expected = expected.length;
  return { ...data, only_in_source: src.keep, only_in_target: tgt.keep, drifted, expected, summary };
}
