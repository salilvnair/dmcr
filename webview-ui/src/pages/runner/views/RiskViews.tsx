import { ButtonView, ChevronDownIcon, ChevronRightIcon, SparkleIcon } from '@salilvnair/dui';
import './RiskViews.css';

/** AI Migration Risk Scorer on a deploy --dry-run: one score per change, shown in the change's own row. */
export interface RiskScore { change_id: string; risk: string; justification: string }
export interface RiskState { scores?: RiskScore[]; analyzing?: boolean; onAnalyze?: () => void }

export const RISK_COLOR: Record<string, string> = {
  LOW: 'var(--dm-c-4ade80)', MEDIUM: 'var(--dm-c-fbbf24)', HIGH: 'var(--dm-c-f97316)', CRITICAL: 'var(--dm-c-f87171)',
};
const ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const riskColor = (risk?: string) => RISK_COLOR[(risk ?? '').toUpperCase()] ?? 'var(--dm-c-94a3b8)';

export function RiskChip({ risk }: { risk: string }) {
  const c = riskColor(risk);
  return <span className="rk-chip" style={{ color: c, borderColor: `color-mix(in srgb, ${c} 40%, transparent)`, background: `color-mix(in srgb, ${c} 12%, transparent)` }}>
    <span className="rk-dot" style={{ background: c }} />{risk.toUpperCase()}</span>;
}

/** Header of the dry-run: the Analyze button, a spinner, or "2 low · 3 medium". */
export function RiskSummary({ risk, expandedAll, onToggleAll }: { risk: RiskState; expandedAll: boolean; onToggleAll: () => void }) {
  if (!risk.scores) {
    if (!risk.onAnalyze) return null;
    return <ButtonView variant="secondary" color="var(--dm-c-a78bfa)" iconLeft={<SparkleIcon size={12} />}
      loading={risk.analyzing} disabled={risk.analyzing} label={risk.analyzing ? 'Scoring each change…' : 'Analyze risk'} onClick={risk.onAnalyze} />;
  }
  const counts = ORDER.map(r => [r, risk.scores!.filter(s => s.risk.toUpperCase() === r).length] as const).filter(([, n]) => n);
  return (
    <span className="rk-summary">
      <SparkleIcon size={12} />
      <span className="rk-summary-label">AI risk</span>
      {counts.map(([r, n]) => <span key={r} className="rk-count" style={{ color: riskColor(r) }}><b>{n}</b> {r.toLowerCase()}</span>)}
      <button type="button" className="rk-toggle-all" onClick={onToggleAll}>{expandedAll ? 'Collapse all' : 'Expand all'}</button>
    </span>
  );
}

/** The cell in the Risk column: the chip and a chevron when there is something to read. */
export function RiskCell({ score, analyzing, open }: { score?: RiskScore; analyzing?: boolean; open: boolean }) {
  if (!score) return analyzing ? <span className="rk-pending" /> : null;
  return <span className="rk-cell"><RiskChip risk={score.risk} />{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>;
}

/** The explanation under a row. */
export function RiskDetail({ score }: { score: RiskScore }) {
  const c = riskColor(score.risk);
  return (
    <div className="rk-detail" style={{ background: `color-mix(in srgb, ${c} 14%, transparent)` }}>
      <div className="rk-detail-head" style={{ color: c }}><SparkleIcon size={12} /><span>Why {score.risk.toLowerCase()} risk</span></div>
      <p className="rk-detail-text">{score.justification}</p>
    </div>
  );
}
