import { useState } from 'react';
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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
          <button
            type="button"
            className="gen-err-toggle"
            onClick={() => setStackOpen(o => !o)}
          >
            {stackOpen ? '\u25B2 Hide stack' : '\u25BC Stack trace'}
          </button>
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
