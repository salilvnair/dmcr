/**
 * dmcr_conflicts.cjs: the runners' conflict check (dmcr.ps1 / dmcr.sh call it before a deploy). Prints the
 * conflicts between changes (Releases › Conflicts) that no merge change resolves and that the deploy would apply
 * one side of, as JSON: {"conflicts":[{object,label,ours:{change_id,project,created_by?},theirs:{...}}]}.
 * Exit 0 (an empty list when there are none); exit 2 with the reason on stderr when it cannot check.
 *
 *   node dmcr_conflicts.cjs --changes <changes folder> --ids 003_b_price_label,004_b_price_label_currency_first
 *   node dmcr_conflicts.cjs --changes <changes folder> --ids -      (the ids on stdin: a long list does not fit a
 *                                                                    Windows command line)
 */
import * as fs from 'fs';
import { unresolvedConflicts } from '../services/conflicts/deploy-gate';

function main(argv: string[]): number {
  const get = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? '' : ''; };
  const dir = get('changes');
  if (!dir || !fs.existsSync(dir)) { process.stderr.write(`changes folder not found: ${dir || '(none)'}\n`); return 2; }
  const raw = get('ids') === '-' ? fs.readFileSync(0, 'utf8') : get('ids');
  const ids = new Set(raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean));
  const conflicts = ids.size ? unresolvedConflicts(dir, s => ids.has(s.changeId)) : [];
  process.stdout.write(JSON.stringify({ conflicts }) + '\n');
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 2; }
