import { CheckCircleIcon, InfoCircleIcon, WarningTriangleIcon, WrenchToolIcon } from '@salilvnair/dui';
import './SelfCheckBanner.css';

export type SelfCheck = {
  status: 'passed' | 'failed' | 'skipped';
  message: string;
  error?: string;
  env?: string;
  ms: number;
  rounds: number;
  fixed?: string[];
  repairNote?: string;
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
      {check.error && check.status !== 'passed' && <pre className="scb-error">{check.error}</pre>}
      {check.repairNote && <div className="scb-note">{check.repairNote}</div>}
    </div>
  );
}
