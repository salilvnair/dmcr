import React, { useState } from 'react';
import {
  ChevronDownIcon, ChevronRightIcon, FolderTreeIcon, LightbulbIdeaIcon, SearchIcon, SettingsIcon, UndoIcon, ZapIcon,
} from '@salilvnair/dui';
import './GettingStartedPanel.css';

interface Step {
  num: number;
  title: string;
  code?: string;
  note?: string;
}

interface Section {
  icon: React.ComponentType<{ size?: number }>;
  heading: string;
  steps: Step[];
}

const SECTIONS: Section[] = [
  {
    icon: SettingsIcon,
    heading: 'Initial Setup',
    steps: [
      {
        num: 1,
        title: 'Create your dmcr.cfg file',
        code: `[dmcr]
env=dev
changes_dir=./db/changes
psql_path=auto
lock_timeout=30s
statement_timeout=5min`,
        note: 'Place dmcr.cfg in your project root. Use the DMCR Config tab to fill in connection details.',
      },
      {
        num: 2,
        title: 'Set your database connection',
        note: 'Open Settings → DMCR Config. Enter your dev (and optionally prod) connection URLs. Passwords are stored securely in the OS keychain.',
      },
      {
        num: 3,
        title: 'Initialize the change-log registry',
        code: `dmcr init`,
        note: 'Creates the dmcr_change_log table in your database. Run this once per environment.',
      },
    ],
  },
  {
    icon: FolderTreeIcon,
    heading: 'Your First Change',
    steps: [
      {
        num: 4,
        title: 'Create a change file',
        code: `-- db/changes/001_create_users.sql
-- dmcr:requires:
-- dmcr:repeatable:false

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);`,
        note: 'Change files live in your changes_dir. The filename determines the run order.',
      },
      {
        num: 5,
        title: 'Check what will run',
        code: `dmcr plan`,
        note: 'Shows which changes are pending and in what order, respecting dependencies.',
      },
      {
        num: 6,
        title: 'Deploy changes',
        code: `dmcr deploy`,
        note: 'Runs all pending changes in dependency order, wrapped in transactions. Use --dry-run to preview without applying.',
      },
    ],
  },
  {
    icon: SearchIcon,
    heading: 'Verify & Inspect',
    steps: [
      {
        num: 7,
        title: 'Check current status',
        code: `dmcr status`,
        note: 'Lists all changes with their applied/pending state and checksums.',
      },
      {
        num: 8,
        title: 'View deployment history',
        code: `dmcr history`,
        note: 'Shows a timestamped log of every change ever applied, with commit hashes.',
      },
      {
        num: 9,
        title: 'Verify checksums',
        code: `dmcr verify`,
        note: 'Ensures no change files were modified after being applied. Detects drift.',
      },
    ],
  },
  {
    icon: UndoIcon,
    heading: 'Revert & Repair',
    steps: [
      {
        num: 10,
        title: 'Revert the last change',
        code: `dmcr revertLast`,
        note: 'Rolls back the most recently applied change. Requires a revert block in the SQL file.',
      },
      {
        num: 11,
        title: 'Revert to a specific change',
        code: `dmcr revert to 005_add_index`,
        note: 'Reverts all changes applied after the target, in reverse order.',
      },
      {
        num: 12,
        title: 'Repair a checksum mismatch',
        code: `dmcr repair checksums`,
        note: 'Re-records checksums when a file is intentionally modified (e.g. formatting fixes).',
      },
    ],
  },
];

const QUICK_REF = [
  { cmd: 'dmcr init',            desc: 'Create the change-log registry table' },
  { cmd: 'dmcr status',          desc: 'Show applied / pending changes' },
  { cmd: 'dmcr plan',            desc: 'Preview what will deploy and in what order' },
  { cmd: 'dmcr deploy',          desc: 'Apply all pending changes' },
  { cmd: 'dmcr deploy --dry-run',desc: 'Simulate deploy without touching the DB' },
  { cmd: 'dmcr history',         desc: 'Timestamped history of every applied change' },
  { cmd: 'dmcr verify',          desc: 'Detect drift via checksum comparison' },
  { cmd: 'dmcr check',           desc: 'Validate change file syntax and metadata' },
  { cmd: 'dmcr revertLast',      desc: 'Roll back the most recent change' },
  { cmd: 'dmcr revert list',     desc: 'List revertable changes' },
  { cmd: 'dmcr revert to <id>',  desc: 'Revert everything after <id>' },
  { cmd: 'dmcr tag list',        desc: 'List all named tags' },
  { cmd: 'dmcr tag <name> <id>', desc: 'Tag a change for easy reference' },
  { cmd: 'dmcr info',            desc: 'Show aggregate DB statistics' },
  { cmd: 'dmcr show config',     desc: 'Display resolved configuration' },
  { cmd: 'dmcr repair checksums',desc: 'Re-record checksums after intentional edits' },
  { cmd: 'dmcr baseline <id>',   desc: 'Mark changes up to <id> as applied without running' },
  { cmd: 'dmcr repeatable <id>', desc: 'Re-apply a repeatable change' },
  { cmd: 'dmcr parse <file>',    desc: 'Parse and validate a single SQL file' },
];

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

export function GettingStartedPanel() {
  const [activeSection, setActiveSection] = useState<number | null>(null);

  return (
    <div className="gs-root">
      {/* Hero */}
      <div className="gs-hero">
        <div className="gs-hero-badge">DMCR</div>
        <h1 className="gs-hero-title">Getting Started</h1>
        <p className="gs-hero-sub">
          Database Migration &amp; Change Registry — version-controlled SQL changes for PostgreSQL.
        </p>
        <div className="gs-hero-chips">
          <span className="gs-chip gs-chip--green">Transactional</span>
          <span className="gs-chip gs-chip--indigo">Checksum-verified</span>
          <span className="gs-chip gs-chip--amber">Dependency-aware</span>
          <span className="gs-chip gs-chip--cyan">Git-integrated</span>
        </div>
      </div>

      {/* Step sections */}
      {SECTIONS.map((sec, si) => (
        <div key={si} className="gs-section">
          <button
            className={`gs-section-hd${activeSection === si || activeSection === null ? ' is-open' : ''}`}
            onClick={() => setActiveSection(activeSection === si ? null : si)}
          >
            <span className="gs-section-icon" style={{ display: 'inline-flex', alignItems: 'center' }}><sec.icon size={16} /></span>
            <span className="gs-section-title">{sec.heading}</span>
            <span className="gs-section-chevron" style={{ display: 'inline-flex', alignItems: 'center' }}>{activeSection === si ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
          </button>

          {(activeSection === si || activeSection === null) && (
            <div className="gs-steps">
              {sec.steps.map(step => (
                <div key={step.num} className="gs-step">
                  <div className="gs-step-num">{step.num}</div>
                  <div className="gs-step-body">
                    <div className="gs-step-title">{step.title}</div>
                    {step.code && <CodeBlock code={step.code} />}
                    {step.note && <div className="gs-step-note">{step.note}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Quick reference table */}
      <div className="gs-section">
        <div className="gs-section-hd is-open" style={{ cursor: 'default' }}>
          <span className="gs-section-icon" style={{ display: 'inline-flex', alignItems: 'center' }}><ZapIcon size={16} /></span>
          <span className="gs-section-title">Quick Command Reference</span>
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

      {/* Tip */}
      <div className="gs-tip">
        <span className="gs-tip-icon" style={{ display: 'inline-flex', alignItems: 'center' }}><LightbulbIdeaIcon size={15} /></span>
        <span>Use the <strong>Runner</strong> tab to run any DMCR command directly from the extension — results display as rich React tables, no terminal needed.</span>
      </div>
    </div>
  );
}
