/**
 * The deploy gate: conflicts between changes (Releases › Conflicts) that no merge change or "keep order" resolves,
 * where a deploy would apply one side. Deploying then would let the later change silently replace the earlier
 * one, so DMCR Web and both runners (through dmcr_conflicts.cjs) refuse the deploy. No vscode.
 */
import * as fs from 'fs';
import * as path from 'path';
import { analyzeConflicts, type Side } from './analyze';
import { loadChangeInputs, readResolutions } from './inputs';

export type GateSide = { change_id: string; project: string; created_by?: string };
export type UnresolvedConflict = { object: string; label: string; ours: GateSide; theirs: GateSide };

/** Unresolved conflicts with a side the deploy applies (`deploys` says which sides it applies). */
export function unresolvedConflicts(dir: string, deploys: (side: Side) => boolean): UnresolvedConflict[] {
  const report = analyzeConflicts(loadChangeInputs(dir), readResolutions(dir), '');
  const side = (x: Side): GateSide => {
    let by = '';
    try { by = String(JSON.parse(fs.readFileSync(path.join(dir, x.changeId, 'meta.json'), 'utf8').replace(/^﻿/, '')).created_by ?? '').trim(); } catch { /* no meta.json */ }
    return { change_id: x.changeId, project: x.project, ...(by ? { created_by: by } : {}) };
  };
  return report.conflicts
    .filter(c => !c.resolved && (deploys(c.ours) || deploys(c.theirs)))
    .map(c => ({ object: c.object, label: c.label, ours: side(c.ours), theirs: side(c.theirs) }));
}
