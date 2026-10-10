import { useState } from 'react';
import { ButtonView, ChevronDownIcon, ChevronUpIcon } from '@salilvnair/dui';
import './GenErrorBox.css';

export type GenError = {
  message: string;
  stack?: string;
  code?: string | number;
  timestamp?: string;
  source?: string;
};

type Props = {
  error: GenError;
};

export default function GenErrorBox({ error }: Props) {
  const [stackOpen, setStackOpen] = useState(false);
  const hasStack = !!error.stack && error.stack !== error.message;

  return (
    <div className="gen-err-box">
      <div className="gen-err-hd">
        <div className="gen-err-ico">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--dm-c-f87171)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div className="gen-err-body">
          <div className="gen-err-title">Generation Failed</div>
          <div className="gen-err-msg">{error.message}{error.code ? ` [${error.code}]` : ''}</div>
          {(error.timestamp || error.source) && (
            <div className="gen-err-meta">
              {error.timestamp}{error.source ? `  \u00b7  ${error.source}` : ''}
            </div>
          )}
        </div>
        {hasStack && (
          <ButtonView
            type="button"
            variant="ghost"
            color="var(--dm-c-f87171)"
            iconLeft={stackOpen ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
            label={stackOpen ? 'Hide stack' : 'Stack trace'}
            onClick={() => setStackOpen(o => !o)}
          />
        )}
      </div>
      {hasStack && stackOpen && (
        <div className="gen-err-stack">
          <pre>{error.stack}</pre>
        </div>
      )}
    </div>
  );
}
