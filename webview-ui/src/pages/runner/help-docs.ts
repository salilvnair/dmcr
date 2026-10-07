export interface CmdHelpDoc {
  name: string;
  /** Legacy icon slot printed by the terminal help; kept empty (no emoji). */
  emoji: string;
  summary: string;
  usage: string[];
  flags?: [string, string][];
  examples: [string, string][];
  notes?: string[];
}

export const CMD_HELP_DOCS: Record<string, CmdHelpDoc> = {
  deploy: {
    name: 'deploy',
    emoji: '',
    summary: 'Apply all pending change folders to the target database in sequential order.',
    usage: ['/deploy', '/deploy --dry-run', '/deploy --to <id|@tag>'],
    flags: [
      ['--dry-run', 'Print the SQL that would be executed without writing to the database'],
      ['--to <id|@tag>', 'Deploy up to and including a specific change ID or @tag (skip later ones)'],
    ],
    examples: [
      ['/deploy', 'Apply all pending changes to the current environment (dev/prod)'],
      ['/deploy --dry-run', 'Preview all pending SQL scripts — nothing is written to the DB'],
      ['/deploy --to 005_add_users', 'Deploy only up to change 005 (skip anything after)'],
      ['/deploy --to @v1.2', 'Deploy up to the release tag @v1.2'],
    ],
    notes: [
      'Each change runs inside a transaction — if any step fails, that change is rolled back',
      'The deploy order is determined by the numeric prefix (001_, 002_, etc.)',
      'After deploy, the git commit hash is recorded in the audit trail',
      'Use /check before deploy to validate without touching the database',
    ],
  },
  status: {
    name: 'status',
    emoji: '',
    summary: 'Show which changes have been applied and which are still pending.',
    usage: ['/status'],
    examples: [
      ['/status', 'Display a table of all changes with their applied/pending status'],
      ['/deploy --dry-run', 'Alternative: preview what /deploy would do'],
      ['/history', 'View the full deployment history with timestamps'],
    ],
    notes: [
      'Applied changes show ✓ with timestamp and git commit hash',
      'Pending changes show ○ and are listed in deployment order',
      'If checksums differ from what was deployed, a warning is shown',
    ],
  },
  verify: {
    name: 'verify',
    emoji: '',
    summary: 'Run the verify.sql script for the last applied change to confirm it was applied correctly.',
    usage: ['/verify'],
    examples: [
      ['/verify', 'Execute verify.sql for the most recently deployed change'],
      ['/deploy && /verify', 'Deploy then verify in sequence'],
      ['/status', 'Check which change is "last applied" before verifying'],
    ],
    notes: [
      'verify.sql should contain SELECT/assertion queries that confirm the change exists',
      'If verify.sql returns a non-zero exit code, the verification failed',
      'Tip: write verify scripts that check for columns, constraints, or row counts',
    ],
  },
  history: {
    name: 'history',
    emoji: '',
    summary: 'Show the full change_log history — every deployed change with timestamps and metadata.',
    usage: ['/history'],
    examples: [
      ['/history', 'Display all entries from dmcr.change_log in chronological order'],
      ['/status', 'Quicker overview: just applied vs pending'],
      ['/info', 'High-level summary stats instead of full log'],
    ],
    notes: [
      'Shows: change_id, applied_at, git_commit, checksum, and status',
      'Reverted changes appear with status "reverted" and their revert timestamp',
      'The log is stored in the dmcr.change_log table on the target database',
    ],
  },
  info: {
    name: 'info',
    emoji: '',
    summary: 'Display summary statistics and health information about the DMCR registry.',
    usage: ['/info'],
    examples: [
      ['/info', 'Show total changes, applied count, pending count, last deploy time'],
      ['/check', 'More detailed validation — preflight checks before deploy'],
      ['/config', 'View the active configuration (env, paths, timeouts)'],
    ],
    notes: [
      'Includes: total changes on disk, applied count, pending count, registry version',
      'Flags any orphaned entries (deployed but no longer on disk) with a warning',
      'Shows the configured environment (dev/prod) and target connection',
    ],
  },
  plan: {
    name: 'plan',
    emoji: '',
    summary: 'Show the dependency-aware execution plan for pending changes.',
    usage: ['/plan'],
    examples: [
      ['/plan', 'Display the ordered list of changes that will run on next /deploy'],
      ['/deploy --dry-run', 'See the actual SQL that would execute (more detail than /plan)'],
      ['/check', 'Validate the plan passes all preflight checks'],
    ],
    notes: [
      'Changes are ordered by their numeric prefix (001_, 002_, …)',
      'If a change has already been applied, it is skipped',
      'Repeatable (R__) changes show only if their checksum differs from last run',
    ],
  },
  check: {
    name: 'check',
    emoji: '',
    summary: 'Preflight validation — checks everything without writing to the database.',
    usage: ['/check'],
    examples: [
      ['/check', 'Validate all pending changes: SQL syntax, connectivity, permissions'],
      ['/deploy', 'If /check passes, proceed with deployment'],
      ['/parse <sql>', 'Validate a single SQL statement instead of all pending'],
    ],
    notes: [
      'Verifies: database connectivity, schema existence, SQL parse validity',
      'Does NOT execute any statements — completely read-only',
      'Returns a pass/fail report for each pending change folder',
    ],
  },
  repeatable: {
    name: 'repeatable',
    emoji: '',
    summary: 'Apply all R__ (repeatable) migrations whose checksums have changed since last run.',
    usage: ['/repeatable'],
    examples: [
      ['/repeatable', 'Re-run any R__*.sql files that have been modified since last execution'],
      ['/status', 'Check which repeatables have changed checksums'],
      ['/deploy', 'Regular deploy — only runs versioned (numbered) changes'],
    ],
    notes: [
      'Repeatable files start with R__ prefix (e.g. R__create_views.sql)',
      'They run every time their content checksum changes — idempotent by design',
      'Typically used for views, functions, and stored procedures',
    ],
  },
  init: {
    name: 'init',
    emoji: '',
    summary: 'Initialize the DMCR registry tables (dmcr.change_log, etc.) on the target database.',
    usage: ['/init'],
    examples: [
      ['/init', 'Create the dmcr schema and change_log table (safe to re-run)'],
      ['/config', 'Verify your connection settings before running init'],
      ['/status', 'After init, check that the registry is empty and ready'],
    ],
    notes: [
      'Creates the dmcr schema if it does not exist',
      'Uses ADD COLUMN IF NOT EXISTS — safe to run on existing v0.x databases',
      'Only needs to be run once per database (or after major version upgrades)',
    ],
  },
  config: {
    name: 'config',
    emoji: '',
    summary: 'Display the active DMCR configuration — environment, paths, timeouts, and connection info.',
    usage: ['/config'],
    examples: [
      ['/config', 'Show current env (dev/prod), changes_dir, psql path, timeouts'],
      ['/init', 'After checking config, initialize the registry'],
      ['/deploy', 'Confirm the target env before deploying'],
    ],
    notes: [
      'Reads from scripts/runner/dmcr.cfg and .vscode/settings.json',
      'Connection strings are masked (only host:port/dbname shown)',
      'Change settings in the DMCR Config panel (Settings → DMCR Config)',
    ],
  },
  sync: {
    name: 'sync',
    emoji: '',
    summary: 'Full git sync: pull from remote → stage changes → AI commit message → push to remote.',
    usage: ['/sync'],
    examples: [
      ['/sync', 'Pull latest, stage all change folders, AI-commit, and push'],
      ['/deploy && /sync', 'Deploy then sync your changes to GitHub'],
      ['/ls', 'Check what change folders exist before syncing'],
    ],
    flags: [
      ['(none)', 'No flags — /sync always does a full pull → stage → commit → push cycle'],
    ],
    notes: [
      'Uses the configured branch (dmcr.gitBranch) or current HEAD if not set',
      'AI generates a conventional-commit message from the staged diff',
      'If nothing to commit, returns immediately without an empty commit',
      'If push fails, the commit is preserved locally — retry with /sync',
    ],
  },
  revertlast: {
    name: 'revertLast',
    emoji: '',
    summary: 'Revert the most recently applied change by executing its revert.sql script.',
    usage: ['/revertLast'],
    examples: [
      ['/revertLast', 'Undo the last deployed change and mark it as reverted'],
      ['/status', 'Check which change is "last" before reverting'],
      ['/revert list', 'See all applied changes (to pick a specific one)'],
    ],
    notes: [
      'Executes revert.sql inside a transaction — rolls back on failure',
      'The change is marked "reverted" in dmcr.change_log (not deleted)',
      'After revert, the change becomes "pending" again for future deploys',
    ],
  },
  revert: {
    name: 'revert',
    emoji: '',
    summary: 'Revert specific changes or revert down to a target change/tag.',
    usage: ['/revert <id>', '/revert to <id|@tag>', '/revert list'],
    flags: [
      ['<id>', 'Revert a single specific change (must be the latest applied)'],
      ['to <id|@tag>', 'Revert ALL changes applied after the target (keeps target applied)'],
      ['list', 'Show all applied changes that can be reverted'],
    ],
    examples: [
      ['/revert 005_add_email', 'Revert change 005 (must be the last applied)'],
      ['/revert to 003_base_tables', 'Revert everything after change 003'],
      ['/revert to @v1.0', 'Revert to the state at release tag v1.0'],
      ['/revert list', 'List all applied changes with IDs for reference'],
    ],
    notes: [
      'Reverts execute in reverse order (newest first)',
      'Each revert runs inside its own transaction',
      'Use /revertLast for a quick undo of just the latest change',
    ],
  },
  parse: {
    name: 'parse',
    emoji: '',
    summary: 'Validate SQL syntax by executing it inside a rolled-back transaction (no data modified).',
    usage: ['/parse <sql statement>'],
    examples: [
      ['/parse ALTER TABLE users ADD COLUMN email TEXT', 'Check if ALTER is valid SQL'],
      ['/parse SELECT * FROM nonexistent', 'Detect invalid table references'],
      ['/parse CREATE INDEX idx_users_email ON users(email)', 'Validate DDL before saving'],
    ],
    notes: [
      'Runs the SQL in a BEGIN → EXECUTE → ROLLBACK cycle',
      'Catches syntax errors, missing tables/columns, type mismatches',
      'Does NOT validate that the SQL is idempotent or safe — only that it parses',
      'For validating entire change folders, use /check instead',
    ],
  },
  tag: {
    name: 'tag',
    emoji: '',
    summary: 'Manage release tags — named bookmarks on the deployment timeline.',
    usage: ['/tag list', '/tag create <name>', '/tag delete <name>'],
    flags: [
      ['list', 'Show all existing release tags with their associated change IDs'],
      ['create <name>', 'Create a new tag at the current deployment state'],
      ['delete <name>', 'Remove an existing tag'],
    ],
    examples: [
      ['/tag list', 'Show all tags: v1.0, sprint-42, pre-migration, etc.'],
      ['/tag create v2.0', 'Bookmark the current state as "v2.0"'],
      ['/tag delete old-snapshot', 'Remove the tag "old-snapshot"'],
    ],
    notes: [
      'Tag names: alphanumeric, dots, dashes, underscores (e.g. v1.0, sprint-42)',
      'Tags can be used with /deploy --to @tagname and /revert to @tagname',
      'Creating a tag on an empty registry (no deploys) is not allowed',
    ],
  },
  baseline: {
    name: 'baseline',
    emoji: '',
    summary: 'Mark a change as "applied" without actually running its SQL. Used for existing databases.',
    usage: ['/baseline <change_id>'],
    examples: [
      ['/baseline 001_initial_schema', 'Mark change 001 as applied (DB already has it)'],
      ['/baseline 003_add_indexes', 'Skip a change that was applied manually via psql'],
      ['/status', 'After baseline, the change shows as ✓ applied'],
    ],
    notes: [
      'Use when adopting DMCR on an existing database that already has some changes applied',
      'Does NOT execute any SQL — only inserts a record into dmcr.change_log',
      'The checksum is still recorded, so /repair --checksums will detect drift',
    ],
  },
  repair: {
    name: 'repair',
    emoji: '',
    summary: 'Recalculate and fix stored checksums in the change_log when they drift from disk.',
    usage: ['/repair --checksums'],
    flags: [
      ['--checksums', 'Recompute checksums for all applied changes from their current deploy.sql on disk'],
    ],
    examples: [
      ['/repair --checksums', 'Fix all checksum mismatches (e.g. after reformatting SQL)'],
      ['/status', 'Check for checksum warnings before repairing'],
      ['/check', 'Verify everything is clean after repair'],
    ],
    notes: [
      'Only modifies the checksum column in dmcr.change_log — no SQL is executed',
      'Use after reformatting, whitespace cleanup, or comment changes in deploy.sql',
      'Does NOT re-run any scripts — safe to use anytime',
    ],
  },
  ls: {
    name: 'ls',
    emoji: '',
    summary: 'Tree view of the changes directory — shows all change folders and their files.',
    usage: ['/ls', '/ls [pattern]'],
    examples: [
      ['/ls', 'Show all change folders in a tree structure'],
      ['/ls 005*', 'Filter: only show folders matching the glob pattern'],
      ['/ls add_users', 'Filter: folders containing "add_users" in their name'],
    ],
    notes: [
      'Reads from the configured changes_dir in dmcr.cfg',
      'Displays: folder name, contained files (deploy.sql, verify.sql, revert.sql)',
      'Folders are sorted by their numeric prefix',
    ],
  },
  it: {
    name: 'it',
    emoji: '',
    summary: 'Interactive mode — arrow-key driven folder browser for quick revert actions.',
    usage: ['/it'],
    examples: [
      ['/it', 'Enter interactive mode — use ↑↓ to browse, Enter to select'],
      ['/revert list', 'Alternative: non-interactive list of revertable changes'],
      ['/revertLast', 'Quick revert without entering interactive mode'],
    ],
    notes: [
      'Navigate with arrow keys, Enter to select a change for revert',
      'Press Esc or q to exit without action',
      'Only shows applied changes that can be reverted',
    ],
  },
  clear: {
    name: 'clear',
    emoji: '',
    summary: 'Clear the terminal output and reset to the DMCR logo.',
    usage: ['/clear'],
    examples: [
      ['/clear', 'Wipe the terminal and show a fresh prompt'],
    ],
    notes: [
      'Does not affect command history — use ↑↓ to recall previous commands',
      'Scrollback buffer is also cleared',
    ],
  },
  help: {
    name: 'help',
    emoji: '',
    summary: 'Show the list of all available commands.',
    usage: ['/help', '/<command> --help'],
    examples: [
      ['/help', 'Show the full command reference table'],
      ['/deploy --help', 'Detailed docs for a specific command'],
      ['/sync -h', 'Short flag works too'],
    ],
    notes: [
      'Every command supports --help or -h for detailed documentation',
      'The autocomplete palette (type /) also shows hints for each command',
    ],
  },
};
