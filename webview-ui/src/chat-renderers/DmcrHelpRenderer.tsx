import './DmcrHelpRenderer.css';

// ─── Command data ─────────────────────────────────────────────────────────────

interface CmdDef {
  cmd:     string;
  badge:   string;
  desc:    string;
  color:   string;   // badge bg
  group:   string;
}

const COMMANDS: CmdDef[] = [
  // Deploy group
  { cmd: 'init',             badge: 'SETUP',   desc: 'Create the DMCR registry schema and tables (run once per database).',    color: '#6366f1', group: 'Setup' },
  { cmd: 'deploy',           badge: 'DEPLOY',  desc: 'Apply all pending changes in order (001_*, 002_*, …).',                  color: '#22c55e', group: 'Deploy' },
  { cmd: 'status',           badge: 'INFO',    desc: 'Show APPLIED / PENDING status for every change folder.',                 color: '#06b6d4', group: 'Deploy' },
  { cmd: 'verify',           badge: 'CHECK',   desc: 'Run verify.sql for the last applied change.',                            color: '#a78bfa', group: 'Deploy' },
  { cmd: 'parse [sql]',      badge: 'PARSE',   desc: 'Validate SQL inside a rolled-back transaction — nothing is persisted.',  color: '#64748b', group: 'Deploy' },
  // Revert group
  { cmd: 'revertLast',       badge: 'REVERT',  desc: 'Revert the single most-recently applied change.',                        color: '#f59e0b', group: 'Revert' },
  { cmd: 'revert <id>',      badge: 'REVERT',  desc: 'Revert a specific change (must be the latest applied).',                 color: '#f59e0b', group: 'Revert' },
  { cmd: 'revert to <id>',   badge: 'REVERT↓', desc: 'Revert all changes down to and including the target.',                  color: '#ef4444', group: 'Revert' },
  { cmd: 'revert list',      badge: 'LIST',    desc: 'List all applied changes in reverse chronological order.',               color: '#8b5cf6', group: 'Revert' },
  // Config group
  { cmd: 'show config',      badge: 'CONFIG',  desc: 'Display the active configuration (connection string is redacted).',      color: '#94a3b8', group: 'Config' },
];

const GLOBAL_FLAGS = [
  { flag: '--debug',             hint: 'Enable verbose debug logging (or set DMCR_DEBUG=1).' },
  { flag: '-c, --config <path>', hint: 'Path to config file (default: dmcr.cfg next to script).' },
  { flag: '-h, --help, /?',      hint: 'Show documentation.' },
];

const NOTES = [
  'Registry is NOT auto-created — run \`dmcr init\` explicitly first.',
  'Deploy and revert are fully transactional (single psql call).',
  'Verify failure after deploy triggers automatic rollback.',
  '\`revert\` only allows reverting the latest change (stack order).',
  '\`revert to\` peels back changes one-at-a-time from the top.',
  '\`parse\` runs SQL in BEGIN/ROLLBACK — nothing is persisted.',
  'Passwords in connection strings are redacted in all log output.',
];

const FOLDER_STRUCTURE = `changes_dir/
├── 001_create_users/
│   ├── deploy.sql   # DDL/DML to apply
│   ├── verify.sql   # Assertions after deploy
│   └── revert.sql   # SQL to undo the change
└── 002_add_email_index/
    ├── deploy.sql
    ├── verify.sql
    └── revert.sql`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GROUPS = ['Setup', 'Deploy', 'Revert', 'Config'];

const GROUP_ICON: Record<string, string> = {
  Setup:  '⚡',
  Deploy: '🚀',
  Revert: '↩️',
  Config: '⚙️',
};

// ─── Component ────────────────────────────────────────────────────────────────

export function DmcrHelpRendererComponent() {
  return (
    <div className="dhr-root">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="dhr-header">
        <span className="dhr-logo">DMCR</span>
        <div className="dhr-header-meta">
          <span className="dhr-title">Database Management Change Request Tracker</span>
          <span className="dhr-sub">PostgreSQL · Versioned · Transactional</span>
        </div>
      </div>

      {/* ── Usage line ──────────────────────────────────────────────────── */}
      <div className="dhr-usage">
        <span className="dhr-usage-label">USAGE</span>
        <code className="dhr-usage-code">dmcr &lt;command&gt; [args] [--debug] [-c|--config &lt;path&gt;]</code>
      </div>

      {/* ── Command groups ──────────────────────────────────────────────── */}
      <div className="dhr-section-label">COMMANDS</div>
      {GROUPS.map(group => {
        const cmds = COMMANDS.filter(c => c.group === group);
        return (
          <div key={group} className="dhr-group">
            <div className="dhr-group-title">
              <span className="dhr-group-icon">{GROUP_ICON[group]}</span>
              {group}
            </div>
            <div className="dhr-cmd-list">
              {cmds.map(c => (
                <div key={c.cmd} className="dhr-cmd-row">
                  <span className="dhr-badge" style={{ background: c.color }}>
                    {c.badge}
                  </span>
                  <code className="dhr-cmd-name">dmcr {c.cmd}</code>
                  <span className="dhr-cmd-desc">{c.desc}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* ── Global flags ────────────────────────────────────────────────── */}
      <div className="dhr-section-label">GLOBAL OPTIONS</div>
      <div className="dhr-flags">
        {GLOBAL_FLAGS.map(f => (
          <div key={f.flag} className="dhr-flag-row">
            <code className="dhr-flag-name">{f.flag}</code>
            <span className="dhr-flag-hint">{f.hint}</span>
          </div>
        ))}
      </div>

      {/* ── Folder structure ────────────────────────────────────────────── */}
      <div className="dhr-section-label">CHANGE FOLDER STRUCTURE</div>
      <pre className="dhr-tree">{FOLDER_STRUCTURE}</pre>

      {/* ── Safety notes ────────────────────────────────────────────────── */}
      <div className="dhr-section-label">SAFETY &amp; DESIGN NOTES</div>
      <div className="dhr-notes">
        {NOTES.map((n, i) => (
          <div key={i} className="dhr-note-row">
            <span className="dhr-note-dot">•</span>
            <span className="dhr-note-text" dangerouslySetInnerHTML={{ __html: n.replace(/`([^`]+)`/g, '<code>$1</code>') }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Renderer definition ──────────────────────────────────────────────────────

export const dmcrHelpRendererProvider = {
  key: 'DmcrHelp',
  priority: 400,   // highest priority — matches before everything else
  match: ({ effectiveType, payload }: { effectiveType: string; payload: unknown }) => {
    if (effectiveType === 'dmcrHelp') return true;
    const p = payload as any;
    return p?.type === 'dmcrHelp';
  },
  Component: DmcrHelpRendererComponent,
};
