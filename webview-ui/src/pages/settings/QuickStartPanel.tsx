import React, { useState } from 'react';
import './GettingStartedPanel.css';

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard?.writeText(code).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="gs-code-wrap">
      <pre className="gs-code">{code}</pre>
      <button className="gs-copy-btn" onClick={handleCopy} title="Copy">
        {copied ? '✓' : '⧉'}
      </button>
    </div>
  );
}

const QUICK_REF = [
  { cmd: 'dmcr init',             desc: 'Create the change-log registry table' },
  { cmd: 'dmcr status',           desc: 'Show applied / pending changes' },
  { cmd: 'dmcr plan',             desc: 'Preview what will deploy and in what order' },
  { cmd: 'dmcr deploy',           desc: 'Apply all pending changes' },
  { cmd: 'dmcr deploy --dry-run', desc: 'Simulate deploy without touching the DB' },
  { cmd: 'dmcr history',          desc: 'Timestamped history of every applied change' },
  { cmd: 'dmcr verify',           desc: 'Detect drift via checksum comparison' },
  { cmd: 'dmcr check',            desc: 'Validate change file syntax and metadata' },
  { cmd: 'dmcr revertLast',       desc: 'Roll back the most recent change' },
  { cmd: 'dmcr revert to <id>',   desc: 'Revert everything after <id>' },
  { cmd: 'dmcr repair checksums', desc: 'Re-record checksums after intentional edits' },
  { cmd: 'dmcr baseline <id>',    desc: 'Mark changes up to <id> as applied' },
  { cmd: 'dmcr tag <name> <id>',  desc: 'Tag a change for easy reference' },
];

export function QuickStartPanel() {
  return (
    <div className="gs-root">
      <div className="gs-hero">
        <div className="gs-hero-badge">DMCR</div>
        <h1 className="gs-hero-title">Quick Start</h1>
        <p className="gs-hero-sub">Up and running in 4 steps. For the full guide see <strong>Settings → DMCR Wiki</strong>.</p>
        <div className="gs-hero-chips">
          <span className="gs-chip gs-chip--green">Transactional</span>
          <span className="gs-chip gs-chip--indigo">Checksum-verified</span>
          <span className="gs-chip gs-chip--amber">Dependency-aware</span>
          <span className="gs-chip gs-chip--cyan">Git-integrated</span>
        </div>
      </div>

      {/* 4-step fast setup */}
      <div className="gs-section" style={{ marginBottom: 0 }}>
        <div className="gs-section-hd is-open" style={{ cursor: 'default' }}>
          <span className="gs-section-icon">⚡</span>
          <span className="gs-section-title">4-Step Setup</span>
        </div>
        <div className="gs-steps">
          <div className="gs-step">
            <div className="gs-step-num">1</div>
            <div className="gs-step-body">
              <div className="gs-step-title">Open Settings → DMCR Config</div>
              <div className="gs-step-note">Set your <strong>Changes directory</strong>, <strong>DEV connection URL</strong>, and optionally PROD. Passwords are stored in OS keychain. Click <em>Save &amp; Write Cfg</em>.</div>
            </div>
          </div>
          <div className="gs-step">
            <div className="gs-step-num">2</div>
            <div className="gs-step-body">
              <div className="gs-step-title">Initialize the change-log registry</div>
              <CodeBlock code="dmcr init" />
              <div className="gs-step-note">Run once per environment. Creates the <code>dmcr_change_log</code> table.</div>
            </div>
          </div>
          <div className="gs-step">
            <div className="gs-step-num">3</div>
            <div className="gs-step-body">
              <div className="gs-step-title">Chat to create your first change</div>
              <div className="gs-step-note">Open the <strong>DMCR Copilot</strong> tab and type what you want — e.g. <em>"Add a nullable email column to public.users"</em>. DMCR generates the SQL and a change folder automatically.</div>
            </div>
          </div>
          <div className="gs-step">
            <div className="gs-step-num">4</div>
            <div className="gs-step-body">
              <div className="gs-step-title">Deploy</div>
              <CodeBlock code="dmcr deploy" />
              <div className="gs-step-note">Or use the <strong>Runner</strong> tab — type <code>deploy</code> and hit Enter.</div>
            </div>
          </div>
        </div>
      </div>

      {/* Quick command reference */}
      <div className="gs-section" style={{ marginTop: 20 }}>
        <div className="gs-section-hd is-open" style={{ cursor: 'default' }}>
          <span className="gs-section-icon">📋</span>
          <span className="gs-section-title">Command Reference</span>
        </div>
        <div className="gs-qref-wrap">
          {QUICK_REF.map((row, i) => (
            <div key={i} className="gs-qref-row">
              <code className="gs-qref-cmd">{row.cmd}</code>
              <span className="gs-qref-desc">{row.desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="gs-tip">
        <span className="gs-tip-icon">📖</span>
        <span>Full documentation, advanced examples, schema diff guide and AI feature details are in <strong>Settings → DMCR Wiki</strong>.</span>
      </div>
    </div>
  );
}
