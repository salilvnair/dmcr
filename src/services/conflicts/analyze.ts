/**
 * Conflicts between projects, git style. Two changes from different projects conflict when they
 * touch the same "lines" of the database: the same function / view / trigger definition, the same
 * column on overlapping rows with different values, the same column or type definition, the same
 * row keys. Whichever deploys last silently wins, so each conflict needs a decision.
 *
 *  - A change that requires the other (directly or through others) built on it: like a fast-forward
 *    in git, that pair is not a conflict.
 *  - Definitions are merged three-way (diff3) against the definition in place before both changes,
 *    the merge base. A clean merge still needs a merge change: deploying both would keep only one.
 *  - Touching the same table but different columns or rows merges by itself ("auto-merged").
 *  - A merge change (meta.json "merges") or a recorded decision (conflicts.json) resolves a conflict.
 */
import { createHash } from 'crypto';
import { diff3Merge, withMarkers, type MergeResult } from './diff3';
import { touchesOf, overlapRows, describeSelector, type Touch } from './sql-touches';

export interface ChangeInput {
  id: string;
  project: string;
  /** release of the project (releases.json) */
  release: string;
  releaseDate?: string;
  dropped: boolean;
  requires: string[];
  deploySql: string;
  /** meta.json "merges" of a merge change */
  merges?: { key: string; changes: string[] }[];
}

export interface Resolution { id: string; resolution: 'keep-order' | 'merge'; changeId?: string; note?: string; by?: string; at?: string }

export interface Side { changeId: string; project: string; release: string; text: string }

/** per row: the SQL literal each side sets (undefined: could not be worked out) */
export interface RowDiff { key: string; ours: string | undefined; theirs: string | undefined }

export interface Conflict {
  id: string;
  key: string;
  kind: 'definition' | 'data' | 'column' | 'type' | 'rows' | 'table';
  /** display name: public.zap_score(bigint), public.zp_lookup_data.custom1 */
  object: string;
  /** git-style label: both modified, both added, deleted by A, ... */
  label: string;
  summary: string;
  /** auto: merges cleanly, but a merge change is still needed (last deploy wins) */
  status: 'conflict' | 'auto';
  /** deploys first */
  ours: Side;
  /** deploys later */
  theirs: Side;
  base?: { changeId: string; text: string } | null;
  merge?: MergeResult;
  markers?: string;
  table?: string; column?: string; keyColumn?: string;
  rows?: RowDiff[];
  rowsText?: string;
  oursExpr?: string; theirsExpr?: string; alias?: { ours: string; theirs: string }; where?: { ours: string; theirs: string };
  resolved?: Resolution;
}

export interface AutoMerge { object: string; changes: [string, string]; projects: [string, string]; why: string }

export interface ConflictReport { conflicts: Conflict[]; autoMerged: AutoMerge[]; analyzed: number }

const num = (id: string) => parseInt(/^(\d+)/.exec(id)?.[1] ?? '0', 10);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const cid = (key: string, a: string, b: string) => createHash('sha1').update(`${key}|${[a, b].sort().join('|')}`).digest('hex').slice(0, 12);

/** Changes `id` requires, directly or through others. */
function ancestry(changes: ChangeInput[]): Map<string, Set<string>> {
  const byId = new Map(changes.map(c => [c.id, c]));
  const memo = new Map<string, Set<string>>();
  const walk = (id: string, seen: Set<string>): Set<string> => {
    if (memo.has(id)) return memo.get(id)!;
    const out = new Set<string>();
    for (const r of byId.get(id)?.requires ?? []) {
      if (seen.has(r)) continue;
      out.add(r);
      seen.add(r);
      for (const x of walk(r, seen)) out.add(x);
    }
    memo.set(id, out);
    return out;
  };
  for (const c of changes) walk(c.id, new Set([c.id]));
  return memo;
}

export function analyzeConflicts(changes: ChangeInput[], resolutions: Resolution[] = [], defaultSchema = 'public'): ConflictReport {
  const live = changes.filter(c => !c.dropped).sort((a, b) => num(a.id) - num(b.id));
  const anc = ancestry(changes);
  const touches = new Map<string, Touch[]>();
  for (const c of changes) touches.set(c.id, touchesOf(c.deploySql, defaultSchema));
  const resolvedBy = new Map(resolutions.map(r => [r.id, r]));
  // merge changes: key|x|y -> merge change id
  for (const c of changes) for (const m of c.merges ?? []) {
    if (m.changes.length === 2) resolvedBy.set(cid(m.key, m.changes[0], m.changes[1]), { id: cid(m.key, m.changes[0], m.changes[1]), resolution: 'merge', changeId: c.id });
  }

  // deploy order: earlier release first, then folder number
  const order = (a: ChangeInput, b: ChangeInput) => {
    const da = a.releaseDate || a.release || '9999'; const db = b.releaseDate || b.release || '9999';
    return da === db ? num(a.id) - num(b.id) : da < db ? -1 : 1;
  };
  const side = (c: ChangeInput, text: string): Side => ({ changeId: c.id, project: c.project || '(no project)', release: c.release, text });

  const conflicts: Conflict[] = [];
  const auto = new Map<string, AutoMerge>();
  const addAuto = (object: string, x: ChangeInput, y: ChangeInput, why: string) => {
    const k = `${object}|${x.id}|${y.id}`;
    if (!auto.has(k)) auto.set(k, { object, changes: [x.id, y.id], projects: [x.project, y.project], why });
  };

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      let [x, y] = [live[i], live[j]];
      if ((x.project || x.id) === (y.project || y.id)) continue; // same project: one branch
      if (anc.get(y.id)?.has(x.id) || anc.get(x.id)?.has(y.id)) continue; // built on the other
      // Concurrent only when neither comes first everywhere: same release, or the folder order and the
      // release order disagree. A change numbered and released before the other is its history, like
      // main before a branch (a change with no release deploys in folder order: history too).
      const rx = x.releaseDate || ''; const ry = y.releaseDate || '';
      if (!rx || !ry) continue;
      if (rx !== ry && (rx < ry) === (num(x.id) < num(y.id))) continue;
      if (order(x, y) > 0) [x, y] = [y, x];
      const tx = touches.get(x.id)!; const ty = touches.get(y.id)!;
      const push = (c: Omit<Conflict, 'id' | 'resolved'>) => {
        const id = cid(c.key, x.id, y.id);
        if (conflicts.some(k => k.id === id)) return;
        conflicts.push({ ...c, id, resolved: resolvedBy.get(id) });
      };

      // ── definitions: three-way merge ──
      const lastDef = (ts: Touch[], key: string) => [...ts].reverse().find(t => t.kind === 'definition' && t.key === key) as Extract<Touch, { kind: 'definition' }> | undefined;
      const defKeys = new Set(tx.filter(t => t.kind === 'definition').map(t => t.key));
      // a project's own later change that redefines the object replaces this one (like a later commit on the branch);
      // a merge change does not: it resolves the pair, which stays listed as resolved
      const superseded = (c: ChangeInput, key: string) => live.some(o => o !== c && !o.merges?.length && (o.project || o.id) === (c.project || c.id) && num(o.id) > num(c.id) && lastDef(touches.get(o.id)!, key));
      for (const key of defKeys) {
        const a = lastDef(tx, key); const b = lastDef(ty, key);
        if (!a || !b) continue;
        if (superseded(x, key) || superseded(y, key)) continue;
        if (a.op === 'drop' && b.op === 'drop') continue;
        if (a.op !== b.op) {
          const dropper = a.op === 'drop' ? x : y;
          push({ key, kind: 'definition', object: a.object, label: `deleted by ${dropper.project}`, status: 'conflict',
            summary: `${dropper.project} drops ${a.object} while ${dropper === x ? y.project : x.project} changes it`, ours: side(x, a.text), theirs: side(y, b.text) });
          continue;
        }
        if (norm(a.text) === norm(b.text)) continue; // same definition on both sides
        // merge base: the definition in place before both changes
        const before = Math.min(num(x.id), num(y.id));
        let base: { changeId: string; text: string } | null = null;
        for (const c of live) {
          if (num(c.id) >= before) break;
          const d = lastDef(touches.get(c.id)!, key);
          if (d) base = d.op === 'drop' ? null : { changeId: c.id, text: d.text };
        }
        const merge = diff3Merge(a.text, base?.text ?? null, b.text);
        const both = base ? 'both modified' : 'both added';
        push({ key, kind: 'definition', object: a.object, label: both, status: merge.conflicts ? 'conflict' : 'auto',
          summary: merge.conflicts
            ? `${merge.conflicts} conflicting hunk${merge.conflicts === 1 ? '' : 's'}: ${x.project} and ${y.project} changed the same lines of ${a.object}`
            : `${x.project} and ${y.project} changed different lines of ${a.object}: merges cleanly, but whichever deploys last would drop the other's lines`,
          ours: side(x, a.text), theirs: side(y, b.text), base, merge,
          markers: withMarkers(merge, `${x.id} (${x.project})`, `${y.id} (${y.project})`) });
      }

      // ── data: same column on overlapping rows ──
      for (const a of tx) {
        if (a.kind !== 'update') continue;
        for (const b of ty) {
          if (b.kind === 'update' && b.key === a.key) {
            const ov = overlapRows(a.rows, b.rows);
            if (ov === false || (Array.isArray(ov) && ov.length === 0)) { addAuto(a.table, x, y, `both set ${a.column}, on different rows`); continue; }
            const object = `${a.table}.${a.column}`;
            if (Array.isArray(ov)) {
              const rows: RowDiff[] = ov.map(k => ({ key: k, ours: a.value(k), theirs: b.value(k) }))
                .filter(r => !(r.ours !== undefined && r.theirs !== undefined && r.ours === r.theirs));
              if (!rows.length) { addAuto(a.table, x, y, `both set ${a.column} to the same values`); continue; }
              const keyColumn = a.rows.kind === 'set' || a.rows.kind === 'range' ? a.rows.col : '';
              push({ key: a.key, kind: 'data', object, label: 'both modified', status: 'conflict',
                summary: `${rows.length} row${rows.length === 1 ? '' : 's'} get a different ${a.column} from ${x.project} and ${y.project}`,
                ours: side(x, a.text), theirs: side(y, b.text), table: a.table, column: a.column, keyColumn, rows,
                oursExpr: a.expr, theirsExpr: b.expr, alias: { ours: a.alias, theirs: b.alias }, where: { ours: a.where, theirs: b.where } });
            } else {
              if (norm(a.expr) === norm(b.expr)) { addAuto(a.table, x, y, `both set ${a.column} the same way`); continue; }
              push({ key: a.key, kind: 'data', object, label: 'both modified', status: 'conflict',
                summary: `${x.project} and ${y.project} both set ${a.column} on overlapping rows (${describeSelector(a.rows)} / ${describeSelector(b.rows)})`,
                ours: side(x, a.text), theirs: side(y, b.text), table: a.table, column: a.column,
                rowsText: `${describeSelector(a.rows)} / ${describeSelector(b.rows)}`, oursExpr: a.expr, theirsExpr: b.expr, alias: { ours: a.alias, theirs: b.alias }, where: { ours: a.where, theirs: b.where } });
            }
          } else if (b.kind === 'update' && b.table === a.table && b.column !== a.column) {
            const ov = overlapRows(a.rows, b.rows);
            addAuto(a.table, x, y, ov === false || (Array.isArray(ov) && !ov.length) ? 'different columns, different rows' : `different columns (${a.column} / ${b.column}) on the same rows`);
          }
        }
      }

      // ── rows: inserts with the same keys, deletes of rows the other writes ──
      const rowsOf = (ts: Touch[]) => ts.filter(t => t.kind === 'insert' || t.kind === 'delete' || t.kind === 'update');
      for (const a of rowsOf(tx)) for (const b of rowsOf(ty)) {
        if (a.table !== b.table) continue;
        if (a.kind === 'insert' && b.kind === 'insert') {
          const same = a.keys.filter(k => b.keys.includes(k));
          if (same.length) push({ key: `rows:${a.table}:insert`, kind: 'rows', object: a.table, label: 'both added', status: 'conflict',
            summary: `${same.length} row key${same.length === 1 ? '' : 's'} inserted by both (${same.slice(0, 4).join(', ')}${same.length > 4 ? ', ...' : ''}): the second insert fails or is skipped`,
            ours: side(x, a.text), theirs: side(y, b.text), table: a.table, keyColumn: a.keyColumn, rows: same.map(k => ({ key: k, ours: 'insert', theirs: 'insert' })) });
          else if (a.keys.length && b.keys.length) addAuto(a.table, x, y, 'inserts with different keys');
        } else if ((a.kind === 'delete') !== (b.kind === 'delete') && (a.kind === 'delete' || b.kind === 'delete')) {
          const del = (a.kind === 'delete' ? a : b) as Extract<Touch, { kind: 'delete' }>;
          const other = a.kind === 'delete' ? b : a;
          const otherRows = other.kind === 'update' ? other.rows : other.kind === 'insert' ? { kind: 'set' as const, col: other.keyColumn, values: other.keys } : { kind: 'all' as const };
          const ov = overlapRows(del.rows, otherRows);
          if (ov === false || (Array.isArray(ov) && !ov.length)) continue;
          const dropper = del === a ? x : y;
          push({ key: `rows:${a.table}:delete`, kind: 'rows', object: a.table, label: `deleted by ${dropper.project}`, status: 'conflict',
            summary: `${dropper.project} deletes rows of ${a.table} that ${dropper === x ? y.project : x.project} writes (${describeSelector(del.rows)})`,
            ours: side(x, a.text), theirs: side(y, b.text), table: a.table });
        }
      }

      // ── columns, tables, types ──
      for (const a of tx) for (const b of ty) {
        if (a.kind === 'column' && b.kind === 'column' && a.key === b.key) {
          if (a.op === 'add' && b.op === 'add' && norm(a.text) === norm(b.text)) continue;
          push({ key: a.key, kind: 'column', object: `${a.table}.${a.column}`, label: a.op === b.op ? `both ${a.op === 'add' ? 'added' : a.op === 'drop' ? 'dropped' : 'changed'}` : `${a.op} / ${b.op}`, status: 'conflict',
            summary: `${x.project}: ${a.text} | ${y.project}: ${b.text}`, ours: side(x, a.text), theirs: side(y, b.text), table: a.table, column: a.column });
        } else if (a.kind === 'column' && b.kind === 'update' && a.op !== 'add' && a.table === b.table && a.column === b.column
          || b.kind === 'column' && a.kind === 'update' && b.op !== 'add' && a.table === b.table && a.column === b.column) {
          const col = (a.kind === 'column' ? a : b) as Extract<Touch, { kind: 'column' }>;
          const changer = col === a ? x : y;
          push({ key: `column:${col.table}.${col.column}:data`, kind: 'column', object: `${col.table}.${col.column}`, label: `${col.op === 'drop' ? 'deleted' : 'changed'} by ${changer.project}`, status: 'conflict',
            summary: `${changer.project} ${col.op === 'drop' ? 'drops' : col.op === 'rename' ? 'renames' : 'changes the type of'} ${col.column} while ${changer === x ? y.project : x.project} writes data into it`,
            ours: side(x, a.text), theirs: side(y, b.text), table: col.table, column: col.column });
        } else if (a.kind === 'table' && b.kind === 'table' && a.key === b.key) {
          push({ key: a.key, kind: 'table', object: a.table, label: a.op === b.op ? `both ${a.op === 'create' ? 'added' : 'dropped'}` : 'created / dropped', status: 'conflict',
            summary: `${x.project} and ${y.project} both ${a.op} ${a.table}`, ours: side(x, a.text), theirs: side(y, b.text), table: a.table });
        } else if (a.kind === 'type' && b.kind === 'type' && a.key === b.key) {
          if (a.op === 'add-value' && b.op === 'add-value') {
            if (a.values[0] === b.values[0]) push({ key: `${a.key}:${a.values[0]}`, kind: 'type', object: a.type, label: 'both added', status: 'conflict',
              summary: `both add the value '${a.values[0]}' to ${a.type}: the second ADD VALUE fails unless it says IF NOT EXISTS`, ours: side(x, a.text), theirs: side(y, b.text) });
            else addAuto(a.type, x, y, `different enum values ('${a.values[0]}' / '${b.values[0]}')`);
            continue;
          }
          push({ key: a.key, kind: 'type', object: a.type, label: a.op === b.op ? 'both modified' : `${a.op} / ${b.op}`, status: 'conflict',
            summary: `${x.project}: ${a.op} · ${y.project}: ${b.op} on ${a.type}`, ours: side(x, a.text), theirs: side(y, b.text) });
        }
      }
    }
  }
  // open conflicts first, then clean merges that still need a merge change, then resolved ones
  return { conflicts: conflicts.sort((a, b) => Number(!!a.resolved) - Number(!!b.resolved) || (a.status === b.status ? 0 : a.status === 'conflict' ? -1 : 1)), autoMerged: [...auto.values()], analyzed: live.length };
}

export const conflictId = cid;
export type { MergeResult };
