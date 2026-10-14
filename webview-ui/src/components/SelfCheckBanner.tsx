import { CheckCircleIcon, DatabaseTableIcon, HistoryClockIcon, InfoCircleIcon, WarningTriangleIcon, WrenchToolIcon } from '@salilvnair/dui';
import './SelfCheckBanner.css';
import { LockLintList, type LintFinding } from './LockLint';

export type SelfCheck = {
  status: 'passed' | 'failed' | 'skipped';
  message: string;
  error?: string;
  env?: string;
  ms: number;
  rounds: number;
  fixed?: string[];
  repairNote?: string;
  lint?: LintFinding[];
  /** how the revert of each replaced function / procedure / view was made */
  previous?: { object: string; from: string; how: 'exact' | 'pinned' | 'new' }[];
};

/** What happened when DMCR ran the generated change for real (rolled back) before showing it. */
export default function SelfCheckBanner({ check }: { check?: SelfCheck }) {
  if (!check) return null;
  const Icon = check.status === 'passed' ? CheckCircleIcon : check.status === 'failed' ? WarningTriangleIcon : InfoCircleIcon;
  const secs = (check.ms / 1000).toFixed(1);
  return (
    <div className={`scb scb--${check.status}`}>
      <div className="scb-head">
        <Icon size={14} />
        <span className="scb-title">
          {check.status === 'passed' ? 'Self-check passed' : check.status === 'failed' ? 'Self-check failed' : 'Not test-run'}
        </span>
        <span className="scb-msg">{check.message}</span>
        <span className="scb-time">{secs}s</span>
      </div>
      {!!check.fixed?.length && (
        <div className="scb-fixed">
          {check.fixed.map((f, i) => (
            <div key={i}><WrenchToolIcon size={12} /><span>Fixed before you saw it: <code>{f}</code></span></div>
          ))}
        </div>
      )}
      {!!check.previous?.length && (
        <div className="scb-prev">
          {check.previous.map((p, i) => (
            <div key={i}>
              {p.how === 'new' ? <InfoCircleIcon size={12} /> : /^live /.test(p.from) ? <DatabaseTableIcon size={12} /> : <HistoryClockIcon size={12} />}
              <span>{p.how === 'new'
                ? <>New: <code>{p.object}</code> was not defined before, so revert drops it</>
                : p.how === 'exact'
                  ? <>Revert restores <code>{p.object}</code> word for word, from <b>{p.from}</b></>
                  : <>Revert puts back <code>{p.object}</code> word for word, from <b>{p.from}</b></>}</span>
            </div>
          ))}
        </div>
      )}
      {check.error && check.status !== 'passed' && <pre className="scb-error">{check.error}</pre>}
      {check.repairNote && <div className="scb-note">{check.repairNote}</div>}
      <LockLintList findings={check.lint} />
    </div>
  );
}
