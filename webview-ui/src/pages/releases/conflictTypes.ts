/* Shapes of the extension's conflict report (src/services/conflicts/analyze.ts) */
export type MergeChunk =
  | { kind: 'stable'; lines: string[] }
  | { kind: 'ours' | 'theirs' | 'both'; lines: string[]; base: string[] }
  | { kind: 'conflict'; ours: string[]; base: string[]; theirs: string[] };

export interface Side { changeId: string; project: string; release: string; text: string }
export interface RowDiff { key: string; ours?: string; theirs?: string }
export interface Resolution { id: string; resolution: 'keep-order' | 'merge'; changeId?: string; note?: string; by?: string; at?: string }

export interface Conflict {
  id: string; key: string;
  kind: 'definition' | 'data' | 'column' | 'type' | 'rows' | 'table';
  object: string; label: string; summary: string;
  status: 'conflict' | 'auto';
  ours: Side; theirs: Side;
  base?: { changeId: string; text: string } | null;
  merge?: { chunks: MergeChunk[]; conflicts: number; clean: string | null };
  markers?: string;
  table?: string; column?: string; keyColumn?: string;
  rows?: RowDiff[]; rowsText?: string;
  oursExpr?: string; theirsExpr?: string;
  resolved?: Resolution;
}

export interface AutoMerge { object: string; changes: [string, string]; projects: [string, string]; why: string }

export interface ConflictReport {
  conflicts: Conflict[]; autoMerged: AutoMerge[]; analyzed: number; changesDir?: string;
  error?: string; saveError?: string; saved?: string;
}

export interface MergeSql { changeName: string; deploySql: string; verifySql: string; revertSql: string; description: string }

/** 'slack' -> slack, NULL -> null (for display) */
export const shown = (v?: string) => (v === undefined ? '?' : /^null$/i.test(v) ? 'NULL' : v.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'"));
