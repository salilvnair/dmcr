import { CalendarIcon, CommitIcon, RocketLaunchIcon, SearchIcon, SettingsIcon, TagIcon, UndoIcon } from '@salilvnair/dui';
import './DmcrHelpRenderer.css';

// ─── Command data ─────────────────────────────────────────────────────────────

interface CmdDef {
  cmd:     string;
  badge:   string;
  desc:    string;
  color:   string;   // badge bg
  group:   string;
}

// Every command and option of the runner, as `dmcr help` lists them (scripts/runner/dmcr.sh)
const C = {
  setup:   'var(--dm-c-6366f1)', deploy: 'var(--dm-c-22c55e)', test: 'var(--dm-c-14b8a6)', info: 'var(--dm-c-06b6d4)',
  check:   'var(--dm-c-a78bfa)', revert: 'var(--dm-c-f59e0b)', danger: 'var(--dm-c-ef4444)', list: 'var(--dm-c-8b5cf6)',
  git:     'var(--dm-c-ec4899)', release: 'var(--dm-c-0ea5e9)', tag: 'var(--dm-c-eab308)', repair: 'var(--dm-c-f97316)', config: 'var(--dm-c-94a3b8)',
};
const COMMANDS: CmdDef[] = [
  // Core
  { cmd: 'init',                       badge: 'SETUP',   desc: 'Create the DMCR registry schema and tables.',                                             color: C.setup,   group: 'Core' },
  { cmd: 'deploy',                     badge: 'DEPLOY',  desc: 'Apply all pending changes in order.',                                                     color: C.deploy,  group: 'Core' },
  { cmd: 'deploy --to <id|@tag>',      badge: 'DEPLOY',  desc: 'Deploy only up to the specified change or tag.',                                          color: C.deploy,  group: 'Core' },
  { cmd: 'deploy --dry-run',           badge: 'PREVIEW', desc: 'Show pending changes without executing.',                                                 color: C.info,    group: 'Core' },
  { cmd: 'test [--to <id|@tag>]',      badge: 'TEST',    desc: 'Round-trip pending changes (deploy, verify, revert, verify; schema and data must match) in one transaction, then roll back.', color: C.test, group: 'Core' },
  { cmd: 'test --only <id,id,...>',    badge: 'TEST',    desc: 'Round-trip only these; the other pending changes up to --to are only applied inside the test (no checks) and rolled back too.', color: C.test, group: 'Core' },
  { cmd: 'status',                     badge: 'INFO',    desc: 'Show APPLIED / PENDING for every change folder.',                                         color: C.info,    group: 'Core' },
  { cmd: 'verify',                     badge: 'CHECK',   desc: 'Run verify.sql for every change of the last deployment.',                                 color: C.check,   group: 'Core' },
  { cmd: 'verify all',                 badge: 'CHECK',   desc: 'Run verify.sql for every applied change.',                                                color: C.check,   group: 'Core' },
  { cmd: 'verify <change_id>',         badge: 'CHECK',   desc: 'Run verify.sql for a specific change.',                                                   color: C.check,   group: 'Core' },
  { cmd: 'parse [sql]',                badge: 'PARSE',   desc: 'Validate SQL inside a rolled-back transaction.',                                          color: C.config,  group: 'Core' },
  { cmd: 'repeatable',                 badge: 'R__',     desc: 'Apply all R__* migrations with changed checksums.',                                       color: C.deploy,  group: 'Core' },
  { cmd: 'manual-script <id>',         badge: 'DBA',     desc: 'One-transaction script a DBA runs by hand for a danger_ change.',                         color: C.danger,  group: 'Core' },
  { cmd: 'approve <id>|--release',     badge: 'SIGN',    desc: 'Sign off pending changes for --env (--by, --note, --revoke); [env] approval = required gates deploy.', color: C.check, group: 'Core' },
  { cmd: 'approvals',                  badge: 'SIGN',    desc: 'Pending changes and their approval on --env.',                                            color: C.check,   group: 'Core' },
  // Revert
  { cmd: 'revert <change_id>',         badge: 'REVERT',  desc: 'Revert a specific change (must be latest).',                                              color: C.revert,  group: 'Revert' },
  { cmd: 'revert to <id|@tag>',        badge: 'REVERT↓', desc: 'Revert all changes down to and including target.',                                        color: C.danger,  group: 'Revert' },
  { cmd: 'revert list',                badge: 'LIST',    desc: 'List all applied changes in reverse order.',                                              color: C.list,    group: 'Revert' },
  { cmd: 'revertLast',                 badge: 'REVERT',  desc: 'Revert the most recently applied change.',                                                color: C.revert,  group: 'Revert' },
  { cmd: 'revert --project <id>',      badge: 'REVERT',  desc: 'Revert every applied change of a project, newest first (any position).',                  color: C.revert,  group: 'Revert' },
  { cmd: 'revert <deploy-id> [<id> ...]', badge: 'REVERT', desc: 'Revert what those deployments applied, newest first (like git revert <commit>); a unique prefix is enough.', color: C.revert, group: 'Revert' },
  { cmd: 'revert --release <id>',      badge: 'REVERT',  desc: 'Revert every applied change of a release, newest first.',                                 color: C.revert,  group: 'Revert' },
  { cmd: 'revert --release a,b | a..b | a^..b | a..', badge: 'REVERT', desc: 'Several releases, like git revert: a list, or a range in release (date) order (a..b = after a up to b; a^..b includes a).', color: C.revert, group: 'Revert' },
  { cmd: '... --kind <kind>',          badge: 'FILTER',  desc: 'Only changes of this kind, e.g. --project B --kind update. Add --dry-run to preview.',    color: C.config,  group: 'Revert' },
  // Like git
  { cmd: 'diff [<env> [<env>]] | diff <change_id>', badge: 'DIFF', desc: "Like git diff: this env vs the change files; two envs; or one change's lines since it was applied.", color: C.git, group: 'Like git' },
  { cmd: 'show <change_id|deploy-id>', badge: 'SHOW',    desc: 'Like git show: a change (who, what, state here, deploy.sql) or a deployment.',            color: C.git,     group: 'Like git' },
  { cmd: 'log [--oneline] [<id>]',     badge: 'LOG',     desc: 'Deploy / revert runs, newest first, like git log (--oneline: one line each); <id>: one run, like git show.', color: C.git, group: 'Like git' },
  { cmd: 'deployments [<id>]',         badge: 'LOG',     desc: 'Deploy / revert runs, newest first, each with its id (like git log); one run change by change (like git show).', color: C.git, group: 'Like git' },
  // Release
  { cmd: 'release [list]',             badge: 'RELEASE', desc: 'Releases in releases.json with applied / pending / dropped counts here.',                 color: C.release, group: 'Release' },
  { cmd: 'release show <id>',          badge: 'RELEASE', desc: 'Every change of a release: project, kind, requested by, created by, status.',             color: C.release, group: 'Release' },
  { cmd: 'deploy --release <id>',      badge: 'DEPLOY',  desc: "Deploy only that release's changes (dropped changes are always skipped).",                 color: C.deploy,  group: 'Release' },
  { cmd: 'deploy --project <id>',      badge: 'DEPLOY',  desc: "Deploy only that project's changes (comma-separate several).",                            color: C.deploy,  group: 'Release' },
  // Inspect
  { cmd: 'history',                    badge: 'INFO',    desc: 'Show applied changes with timestamps, checksums.',                                        color: C.info,    group: 'Inspect' },
  { cmd: 'info',                       badge: 'INFO',    desc: 'Summary of environment, counts, registry health.',                                        color: C.info,    group: 'Inspect' },
  { cmd: 'plan',                       badge: 'PLAN',    desc: 'Show dependency-aware execution order.',                                                  color: C.info,    group: 'Inspect' },
  { cmd: 'check',                      badge: 'CHECK',   desc: 'Run preflight checks without deploying.',                                                 color: C.check,   group: 'Inspect' },
  { cmd: 'show config',                badge: 'CONFIG',  desc: 'Display the active configuration (conn redacted).',                                       color: C.config,  group: 'Inspect' },
  // Tag
  { cmd: 'tag [list]',                 badge: 'TAG',     desc: 'List all release tags.',                                                                  color: C.tag,     group: 'Tag' },
  { cmd: 'tag create <name>',          badge: 'TAG',     desc: 'Tag the current deployment state.',                                                       color: C.tag,     group: 'Tag' },
  { cmd: 'tag delete <name>',          badge: 'TAG',     desc: 'Remove a tag.',                                                                           color: C.tag,     group: 'Tag' },
  // Repair
  { cmd: 'baseline <change_id>',       badge: 'REPAIR',  desc: 'Mark all changes up to <change_id> as applied.',                                          color: C.repair,  group: 'Repair' },
  { cmd: 'repair --mark-applied <id>', badge: 'REPAIR',  desc: 'Mark a change as applied without executing.',                                             color: C.repair,  group: 'Repair' },
  { cmd: 'repair --mark-reverted <id>', badge: 'REPAIR', desc: 'Remove a change without executing revert.',                                               color: C.repair,  group: 'Repair' },
  { cmd: 'repair --checksums',         badge: 'REPAIR',  desc: 'Reconcile stored checksums with files.',                                                  color: C.repair,  group: 'Repair' },
  { cmd: 'repair --unlock',            badge: 'REPAIR',  desc: 'Clear the deploy lock left by a crashed run.',                                            color: C.repair,  group: 'Repair' },
];

const GLOBAL_FLAGS = [
  { flag: '--dry-run',              hint: '(deploy) Print pending SQL without executing.' },
  { flag: '--allow-prod',           hint: "(test) Allow 'test' against an environment named prod." },
  { flag: '--to <id|@tag>',         hint: 'Stop at a specific change_id or release tag.' },
  { flag: '--release <id>',         hint: '(deploy/revert/status) Only changes whose project is in this release.' },
  { flag: '--project <id[,id]>',    hint: '(deploy/revert/status) Only changes of these projects.' },
  { flag: '--kind <kind[,kind]>',   hint: 'insert, update, delete, dml, ddl, function, type, other (dml/ddl match their family).' },
  { flag: '--json',                 hint: 'Machine-readable JSON output.' },
  { flag: '--debug',                hint: 'Enable verbose debug logging (or DMCR_DEBUG=1).' },
  { flag: '--env <name>',           hint: 'Override active environment (e.g. --env prod).' },
  { flag: '-c, --config <path>',    hint: 'Path to config file (default: dmcr.cfg next to script).' },
  { flag: '-h, --help',             hint: 'Show this help.' },
];

const ENV_VARS = [
  { flag: 'DMCR_CONN',              hint: 'Override connection string.' },
  { flag: 'DMCR_PSQL',              hint: 'Override psql executable path.' },
  { flag: 'DMCR_CONFIG',            hint: 'Override config file path.' },
  { flag: 'DMCR_ACTOR',             hint: 'Override deploying principal.' },
  { flag: 'DMCR_DEBUG',             hint: 'Set to 1 for debug output.' },
  { flag: 'DMCR_ANSI_OUTPUT',       hint: 'Set to 0 to disable ANSI colors.' },
  { flag: 'DMCR_PLACEHOLDER_<x>',   hint: 'Override [placeholders] value for <x>.' },
];

const NOTES = [
  'Registry is NOT auto-created — run \`dmcr init\` explicitly first.',
  'Each change deploys in its own transaction with its verify.sql; a change with \`"transaction": false\` in meta.json runs statement by statement.',
  'Verify failure after deploy rolls that change back.',
  '\`revert <change_id>\` only reverts the latest change (stack order); \`revert to\` peels back changes one at a time from the top.',
  '\`test\` and \`parse\` run in BEGIN/ROLLBACK — nothing is persisted.',
  'danger_ changes are never run by deploy: the DBA runs \`manual-script\` by hand.',
  "Write names without a schema (CREATE TABLE zaps): each environment's `schema` in DMCR Config is the session's search_path, like picking the schema in DBeaver.",
  'Passwords in connection strings are redacted in all log output.',
];

const FOLDER_STRUCTURE = `changes_dir/
├── releases.json                    # releases and projects (Releases tab)
├── 001_base_create_users/           # NNN_<project>_<name>
│   ├── deploy.sql                   # DDL/DML to apply, names without a schema
│   ├── verify.sql                   # checks: applied and reverted state
│   ├── revert.sql                   # undoes deploy.sql exactly
│   └── meta.json                    # project, ticket, requires, author,
│                                    # requested_by, "transaction": false
├── 002_a_add_email_index/           # project A
├── 003_danger_drop_legacy_col/      # danger_: the DBA runs it by hand
│                                    # (dmcr manual-script 003_…)
└── R__zap_daily_counts/             # repeatable: re-applied when it changes`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GROUPS = ['Core', 'Revert', 'Like git', 'Release', 'Inspect', 'Tag', 'Repair'];

const GROUP_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  'Core':     RocketLaunchIcon,
  'Revert':   UndoIcon,
  'Like git': CommitIcon,
  'Release':  CalendarIcon,
  'Inspect':  SearchIcon,
  'Tag':      TagIcon,
  'Repair':   SettingsIcon,
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
        <code className="dhr-usage-code">dmcr &lt;command&gt; [args] [--env &lt;name&gt;] [--dry-run] [--json] [--debug] [-c|--config &lt;path&gt;]</code>
      </div>

      {/* ── Command groups ──────────────────────────────────────────────── */}
      <div className="dhr-section-label">COMMANDS</div>
      {GROUPS.map(group => {
        const cmds = COMMANDS.filter(c => c.group === group);
        const GroupIcon = GROUP_ICON[group];
        return (
          <div key={group} className="dhr-group">
            <div className="dhr-group-title">
              <span className="dhr-group-icon" style={{ display: 'inline-flex', alignItems: 'center' }}>{GroupIcon && <GroupIcon size={13} />}</span>
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

      <div className="dhr-section-label">ENVIRONMENT VARIABLES</div>
      <div className="dhr-flags">
        {ENV_VARS.map(f => (
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
  // its own card: no grey library bubble around it
  hideBubble: true,
  match: ({ effectiveType, payload }: { effectiveType: string; payload: unknown }) => {
    if (effectiveType === 'dmcrHelp') return true;
    const p = payload as any;
    return p?.type === 'dmcrHelp';
  },
  Component: DmcrHelpRendererComponent,
};
