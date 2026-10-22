/**
 * The order to import SQL files that already ran on test by hand (no DMCR, no numbers in their names):
 * what each file needs from another one decides, read from the SQL itself, and test decides between two
 * versions of the same function (the one test has now ran last). Files that do not touch each other keep
 * their git order (the commit that added them), else their name order. Every position says why.
 */

export type ImportFile = {
  name: string;
  path: string;
  sql: string;
  /** position in git history (the commit that added the file): lower ran earlier; equal = unknown order */
  gitOrder: number;
};

export type FileKind = 'DDL' | 'DML' | 'function' | 'mixed' | 'other';

export type OrderedFile = {
  file: ImportFile;
  kind: FileKind;
  /** why it sits where it does */
  reasons: string[];
  /** names of the files it must come after */
  after: string[];
};

export type OrderResult = {
  ordered: OrderedFile[];
  /** some files could not be ordered for sure (no dependency, no git order): the user's order is kept */
  unsure: boolean;
  notes: string[];
};

const NAME = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?`;
const bare = (n: string) => n.split('.').pop()!.replace(/"/g, '').trim().toLowerCase();
const strip = (sql: string) => sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

/** The body of a function / procedure (between its dollar quotes), whitespace-normalised: what PostgreSQL keeps word for word. */
export function routineBody(sql: string): string {
  const m = /\bAS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\1/i.exec(sql);
  return m ? m[2].replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

type Analysis = {
  kind: FileKind;
  creates: Set<string>;          // object names this file creates
  columns: Map<string, string>;  // column -> table it adds the column to
  routines: string[];            // routines it defines (CREATE [OR REPLACE] FUNCTION / PROCEDURE)
  inserts: Map<string, Set<string>>; // table -> string literals it inserts
  words: Set<string>;            // every identifier-like word (to see what a file uses)
  writes: Map<string, string>;   // table -> the UPDATE / DELETE text for it (to match inserted literals)
};

export function analyze(sql: string): Analysis {
  const s = strip(sql);
  const creates = new Set<string>();
  const columns = new Map<string, string>();
  const routines: string[] = [];
  const inserts = new Map<string, Set<string>>();
  const writes = new Map<string, string>();
  let ddl = false; let dml = false; let fn = false;
  const re = (src: string) => new RegExp(src, 'gi');
  for (const m of s.matchAll(re(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(MATERIALIZED\s+VIEW|VIEW|TABLE|TYPE|SEQUENCE|INDEX|FUNCTION|PROCEDURE|TRIGGER)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`))) {
    const kind = m[1].toUpperCase();
    if (kind === 'FUNCTION' || kind === 'PROCEDURE') { fn = true; routines.push(bare(m[2])); } else ddl = true;
    creates.add(bare(m[2]));
  }
  for (const m of s.matchAll(re(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${NAME})([\s\S]*?)(?:;|$)`))) {
    ddl = true;
    for (const c of m[2].matchAll(re(String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)`))) {
      const col = bare(c[1]);
      if (!/^(constraint|primary|unique|check|foreign)$/.test(col)) columns.set(col, bare(m[1]));
    }
    for (const c of m[2].matchAll(re(String.raw`\bRENAME\s+(?:COLUMN\s+)?(?:"[^"]+"|[A-Za-z_][\w$]*)\s+TO\s+("[^"]+"|[A-Za-z_][\w$]*)`))) columns.set(bare(c[1]), bare(m[1]));
  }
  if (/\b(DROP|ALTER)\s+(TABLE|VIEW|TYPE|SEQUENCE|INDEX|MATERIALIZED\s+VIEW)\b/i.test(s)) ddl = true;
  for (const m of s.matchAll(re(String.raw`\bINSERT\s+INTO\s+(${NAME})([\s\S]*?)(?:;|$)`))) {
    dml = true;
    const lits = inserts.get(bare(m[1])) ?? new Set<string>();
    for (const l of m[2].matchAll(/'((?:[^']|'')*)'/g)) if (l[1].length >= 2) lits.add(l[1]);
    inserts.set(bare(m[1]), lits);
  }
  for (const m of s.matchAll(re(String.raw`\b(?:UPDATE\s+(?:ONLY\s+)?|DELETE\s+FROM\s+(?:ONLY\s+)?)(${NAME})([\s\S]*?)(?:;|$)`))) {
    dml = true;
    writes.set(bare(m[1]), (writes.get(bare(m[1])) ?? '') + ' ' + m[2]);
  }
  const words = new Set((s.replace(/'(?:[^']|'')*'/g, ' ').match(/[A-Za-z_][\w$]*/g) ?? []).map(w => w.toLowerCase()));
  const kinds = [ddl && 'DDL', dml && 'DML', fn && 'function'].filter(Boolean) as FileKind[];
  const kind: FileKind = kinds.length === 0 ? 'other' : kinds.length === 1 ? kinds[0] : 'mixed';
  return { kind, creates, columns, routines, inserts, words, writes };
}

/**
 * @param testRoutines routine name -> its definition on test now (pg_get_functiondef), to tell which of two
 *        versions of the same function ran last
 */
export function suggestOrder(files: ImportFile[], testRoutines: Record<string, string> = {}): OrderResult {
  const n = files.length;
  const info = files.map(f => analyze(f.sql));
  const edges: Array<Set<number>> = files.map(() => new Set());     // i -> j: i before j
  const reasons: string[][] = files.map(() => []);
  const after: string[][] = files.map(() => []);
  const notes: string[] = [];
  const addEdge = (a: number, b: number, why: string) => {
    if (a === b || edges[a].has(b)) return;
    edges[a].add(b); reasons[b].push(why); after[b].push(files[a].name);
  };

  // 1. a file uses something another one creates (table, view, type, sequence, function, column)
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      for (const obj of info[a].creates) {
        if (info[b].creates.has(obj)) continue;   // two versions of the same object: decided below
        if (info[b].words.has(obj)) addEdge(a, b, `uses ${obj} (created by ${files[a].name})`);
      }
      for (const [col, table] of info[a].columns) {
        if (info[b].columns.has(col)) continue;
        if (info[b].words.has(col) && info[b].words.has(table)) addEdge(a, b, `uses column ${table}.${col} (added by ${files[a].name})`);
      }
      // 2. it changes rows another one inserted (the same literal key on the same table)
      for (const [table, lits] of info[a].inserts) {
        const w = info[b].writes.get(table);
        if (!w) continue;
        const hit = [...lits].find(l => w.includes(`'${l}'`));
        if (hit) addEdge(a, b, `changes ${hit} (inserted by ${files[a].name})`);
      }
    }
  }

  // 3. several files replace the same function: the one test has now ran last
  const byRoutine = new Map<string, number[]>();
  info.forEach((x, i) => x.routines.forEach(r => byRoutine.set(r, [...(byRoutine.get(r) ?? []), i])));
  for (const [routine, idx] of byRoutine) {
    if (idx.length < 2) continue;
    const onTest = routineBody(testRoutines[routine] ?? '');
    const lastIdx = onTest ? idx.find(i => routineBody(files[i].sql) === onTest) : undefined;
    const rest = idx.filter(i => i !== lastIdx).sort((x, y) => files[x].gitOrder - files[y].gitOrder || files[x].name.localeCompare(files[y].name));
    const chain = lastIdx === undefined ? rest : [...rest, lastIdx];
    for (let k = 1; k < chain.length; k++) {
      addEdge(chain[k - 1], chain[k], lastIdx !== undefined && chain[k] === lastIdx
        ? `matches ${routine} on test now, so it ran last`
        : `a later version of ${routine} than ${files[chain[k - 1]].name}`);
    }
    if (lastIdx !== undefined) for (const i of rest) reasons[i].push(`an older version of ${routine}: test has ${files[lastIdx].name}`);
    else notes.push(`${routine} is defined by ${idx.length} files and none matches test word for word: their git or name order is used`);
  }

  // topological order; ties by git order, then name
  const prio = (i: number) => [files[i].gitOrder, files[i].name] as const;
  const cmp = (x: number, y: number) => prio(x)[0] - prio(y)[0] || prio(x)[1].localeCompare(prio(y)[1]);
  const indeg = files.map(() => 0);
  edges.forEach(s => s.forEach(j => indeg[j]++));
  const ready = files.map((_, i) => i).filter(i => indeg[i] === 0).sort(cmp);
  const order: number[] = [];
  while (ready.length) {
    const i = ready.shift()!;
    order.push(i);
    for (const j of edges[i]) { if (--indeg[j] === 0) { ready.push(j); ready.sort(cmp); } }
  }
  if (order.length < n) {
    const left = files.map((_, i) => i).filter(i => !order.includes(i)).sort(cmp);
    notes.push(`${left.map(i => files[i].name).join(', ')} depend on each other in a circle: kept in git or name order`);
    order.push(...left);
  }

  const gitKnown = new Set(files.map(f => f.gitOrder)).size > 1;
  let unsure = false;
  const ordered: OrderedFile[] = order.map(i => {
    const r = [...reasons[i]];
    if (!r.length) {
      if (gitKnown) r.push('needs no other file: git order');
      else { r.push('needs no other file: name order (git cannot tell)'); if (n > 1) unsure = true; }
    }
    return { file: files[i], kind: info[i].kind, reasons: r, after: [...new Set(after[i])] };
  });
  return { ordered, unsure, notes };
}
