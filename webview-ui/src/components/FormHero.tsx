import type { ReactNode } from 'react';
import { CheckCircleIcon } from '@salilvnair/dui';
import './FormHero.css';

export type HeroPill = { label: string; tone?: 'green' | 'indigo' | 'violet' | 'amber' | 'teal' };

type Props = {
  icon: ReactNode;
  title: string;
  pills?: HeroPill[];
  description?: ReactNode;
  /** the form's steps, left to right; `step` (1-based) is the one you are on, the ones before it are done */
  steps?: string[];
  step?: number;
  /** the form's color: the icon tile and the band's tint (DDL indigo, DML amber, Freeform violet, Diff teal, Manual green) */
  tone?: 'indigo' | 'amber' | 'violet' | 'teal' | 'green';
};

/** The header band every form page opens with: what the page is, how it works, and where you are. */
export default function FormHero({ icon, title, pills = [], description, steps, step = 1, tone = 'indigo' }: Props) {
  return (
    <div className={`fh fh--${tone}`}>
      <span className="fh-icon">{icon}</span>
      <div className="fh-text">
        <div className="fh-title">
          <h1>{title}</h1>
          {pills.map(p => <span key={p.label} className={`fh-pill${p.tone ? ` fh-pill--${p.tone}` : ''}`}>{p.label}</span>)}
        </div>
        {description && <p>{description}</p>}
      </div>
      {!!steps?.length && (
        <ol className="fh-steps">
          {steps.map((s, i) => (
            <li key={s} className={i + 1 < step ? 'is-done' : i + 1 === step ? 'is-now' : ''}>
              <span>{i + 1 < step ? <CheckCircleIcon size={13} /> : i + 1}</span>{s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
