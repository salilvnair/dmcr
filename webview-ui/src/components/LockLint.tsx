import { LockIcon } from './LockLintIcon';
import './LockLint.css';

/** One finding of the lock / safety lint (src/services/lint/lock-lint.ts). */
export type LintFinding = { rule: string; severity: 'warning' | 'notice'; statement: string; line: number; why: string; fix: string };

/** Findings for one change: what locks or rewrites, why it hurts, and the safer way to write it. */
export function LockLintList({ findings, title }: { findings?: LintFinding[]; title?: string }) {
  if (!findings?.length) return null;
  return (
    <div className="ll">
      <div className="ll-head"><LockIcon size={13} /><b>{title ?? `${findings.length} lock risk${findings.length === 1 ? '' : 's'} on a live table`}</b><span>advisory: fine on a small table or in a maintenance window</span></div>
      {findings.map((f, i) => (
        <div key={i} className={`ll-item ll-item--${f.severity}`}>
          <div className="ll-stmt"><span className="ll-line">line {f.line}</span><code>{f.statement}</code></div>
          <div className="ll-why">{f.why}</div>
          <div className="ll-fix"><b>Safer:</b> {f.fix}</div>
        </div>
      ))}
    </div>
  );
}

/** A small amber chip for a table cell: how many lock risks, the rules on hover. */
export function LockLintChip({ findings }: { findings?: LintFinding[] }) {
  if (!findings?.length) return null;
  const risks = findings.filter(f => f.severity === 'warning').length;
  return (
    <span className={`ll-chip${risks ? '' : ' ll-chip--notice'}`} title={findings.map(f => `line ${f.line}: ${f.why}`).join('\n')}>
      <LockIcon size={11} />{risks ? `${risks} lock risk${risks === 1 ? '' : 's'}` : 'check lock'}
    </span>
  );
}
