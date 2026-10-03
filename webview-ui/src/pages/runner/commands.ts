// ─── Valid bare (non-slash) first arguments recognized by dmcr.ps1 ────────────
export const VALID_BARE = new Set([
  'status', 'deploy', 'verify', 'revertlast', 'revert', 'init', 'parse',
  'show', 'config', 'help', 'clear', 'ls', 'it', 'sync', 'history',
  'info', 'plan', 'check', 'baseline', 'repair', 'tag', 'repeatable',
]);

// ─── Slash commands for autocomplete ──────────────────────────────────────────
export interface SlashCmd {
  cmd:     string;
  label:   string;
  hint:    string;
  group:   string;
  args:    string[] | null;
  color:   string;
  aliases: string[];
  special?: string;
}

export const SLASH_CMDS: SlashCmd[] = [
  { cmd: '/status',           label: '/status',              hint: 'Show applied / pending changes',              group: 'Deploy',  args: ['status'],              color: '#6366f1', aliases: ['pending', 'applied'] },
  { cmd: '/deploy',           label: '/deploy',              hint: 'Apply all pending changes',                   group: 'Deploy',  args: ['deploy'],              color: '#22c55e', aliases: ['run', 'apply', 'execute'] },
  { cmd: '/deploy --dry-run', label: '/deploy --dry-run',   hint: 'Preview pending SQL (no DB writes)',           group: 'Deploy',  args: ['deploy', '--dry-run'], color: '#34d399', aliases: ['preview', 'dryrun'] },
  { cmd: '/deploy --to',      label: '/deploy --to <id|@tag>', hint: 'Deploy up to a specific change or @tag',   group: 'Deploy',  args: null,                    color: '#10b981', aliases: ['deploy to', 'partial'] },
  { cmd: '/verify',           label: '/verify',              hint: 'Run verify.sql for last change',              group: 'Deploy',  args: ['verify'],              color: '#06b6d4', aliases: ['validate'] },
  { cmd: '/history',          label: '/history',             hint: 'Show change_log history',                     group: 'Deploy',  args: ['history'],             color: '#8b5cf6', aliases: ['log', 'changelog'] },
  { cmd: '/info',             label: '/info',                hint: 'Summary stats and registry health',           group: 'Deploy',  args: ['info'],                color: '#6366f1', aliases: ['summary', 'health'] },
  { cmd: '/plan',             label: '/plan',                hint: 'Dependency-aware execution plan',             group: 'Deploy',  args: ['plan'],                color: '#a78bfa', aliases: ['graph', 'deps'] },
  { cmd: '/check',            label: '/check',               hint: 'Preflight validation (no DB writes)',         group: 'Deploy',  args: ['check'],               color: '#f59e0b', aliases: ['preflight', 'lint all'] },
  { cmd: '/repeatable',       label: '/repeatable',          hint: 'Apply R__ migrations with changed checksums', group: 'Deploy',  args: ['repeatable'],          color: '#14b8a6', aliases: ['R__', 'idempotent'] },
  { cmd: '/tag list',         label: '/tag list',            hint: 'List release tags',                           group: 'Deploy',  args: ['tag', 'list'],         color: '#f472b6', aliases: ['tags', 'releases'] },
  { cmd: '/tag create',       label: '/tag create <name>',   hint: 'Create a release tag at current state',       group: 'Deploy',  args: null,                    color: '#ec4899', aliases: ['bookmark', 'snapshot'] },
  { cmd: '/tag delete',       label: '/tag delete <name>',   hint: 'Delete a release tag',                        group: 'Deploy',  args: null,                    color: '#e11d48', aliases: ['untag'] },
  { cmd: '/parse',            label: '/parse <sql>',         hint: 'Validate SQL in a rolled-back transaction',   group: 'Core',    args: null,                    color: '#a78bfa', aliases: ['lint', 'syntax', 'sql'] },
  { cmd: '/revertLast',       label: '/revertLast',          hint: 'Revert the last applied change',              group: 'Revert',  args: ['revertLast'],          color: '#f59e0b', aliases: ['rollback', 'undo last'] },
  { cmd: '/revert list',      label: '/revert list',         hint: 'List all applied changes',                    group: 'Revert',  args: ['revert', 'list'],      color: '#8b5cf6', aliases: ['list', 'stack'] },
  { cmd: '/revert to',        label: '/revert to <id|@tag>', hint: 'Revert down to target (supports @tag)',       group: 'Revert',  args: null,                    color: '#f87171', aliases: ['rollback to', 'undo to'] },
  { cmd: '/revert',           label: '/revert <id>',         hint: 'Revert a specific change (must be latest)',   group: 'Revert',  args: null,                    color: '#f59e0b', aliases: ['rollback one', 'undo'] },
  { cmd: '/baseline',         label: '/baseline <id>',       hint: 'Mark change as applied without running SQL',  group: 'Core',    args: null,                    color: '#94a3b8', aliases: ['mark applied', 'seed'] },
  { cmd: '/repair',           label: '/repair --checksums',  hint: 'Recalculate all stored checksums',            group: 'Core',    args: ['repair', '--checksums'], color: '#64748b', aliases: ['fix', 'reconcile'] },
  { cmd: '/repair --unlock',  label: '/repair --unlock',     hint: 'Clear the deploy lock left by a crashed run',  group: 'Core',    args: ['repair', '--unlock'],    color: '#64748b', aliases: ['unlock', 'lock'] },
  { cmd: '/init',             label: '/init',                hint: 'Initialize DMCR registry (once)',             group: 'Core',    args: ['init'],                color: '#94a3b8', aliases: ['setup', 'bootstrap'] },
  { cmd: '/config',           label: '/config',              hint: 'Show active configuration',                   group: 'Core',    args: ['show', 'config'],      color: '#64748b', aliases: ['settings', 'show config'] },
  { cmd: '/ls',               label: '/ls [pattern]',        hint: 'Tree view of changes directory',              group: 'Explore', args: null, special: 'ls',     color: '#34d399', aliases: ['browse', 'list files', 'tree'] },
  { cmd: '/it',               label: '/it',                  hint: 'Interactive revert mode',                     group: 'Explore', args: null, special: 'it',     color: '#a78bfa', aliases: ['interactive', 'picker'] },
  { cmd: '/help',             label: '/help',                hint: 'Show available commands',                     group: 'Help',    args: null, special: 'help',   color: '#818cf8', aliases: ['docs', 'commands'] },
  { cmd: '/sync',             label: '/sync',                hint: 'Git pull, stage changes, AI commit, push',    group: 'Core',    args: null, special: 'sync',   color: '#22d3ee', aliases: ['git', 'commit', 'push', 'git sync'] },
];

export function computeSuggestions(buf: string): SlashCmd[] {
  if (!buf.startsWith('/')) return [];
  const query = buf.slice(1).trim().toLowerCase();
  if (!query) return SLASH_CMDS;

  const tokens = query.split(/\s+/).filter(Boolean);
  return [...SLASH_CMDS]
    .map((cmd) => {
      let score = 0;
      for (const token of tokens) {
        if (cmd.cmd.toLowerCase().startsWith('/' + token)) score += 14;
        if (cmd.label.toLowerCase().includes(token)) score += 10;
        if (cmd.hint.toLowerCase().includes(token)) score += 4;
        if ((cmd.aliases ?? []).some(a => a.toLowerCase().includes(token))) score += 6;
        if (cmd.group.toLowerCase().includes(token)) score += 3;
      }
      return { cmd, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.cmd.label.localeCompare(b.cmd.label))
    .map((entry) => entry.cmd);
}

// ─── Toolbar preset commands ──────────────────────────────────────────────────
export const PRESETS = [
  { label: 'status',             args: ['status'],                desc: 'Show applied / pending changes',  color: '#4f46e5' },
  { label: 'deploy',             args: ['deploy'],                desc: 'Apply all pending changes',       color: '#16a34a' },
  { label: 'deploy --dry-run',   args: ['deploy', '--dry-run'],   desc: 'Preview pending SQL (no writes)', color: '#059669' },
  { label: 'verify',             args: ['verify'],                desc: 'Run verify.sql for last change',  color: '#0891b2' },
  { label: 'history',            args: ['history'],               desc: 'Show change_log history',         color: '#7c3aed' },
  { label: 'check',              args: ['check'],                 desc: 'Preflight validation',            color: '#d97706' },
  { label: 'repeatable',         args: ['repeatable'],            desc: 'Apply R__ changed checksums',     color: '#0d9488' },
  { label: 'tag list',           args: ['tag', 'list'],           desc: 'Show release tags',               color: '#be185d' },
  { label: 'revertLast',         args: ['revertLast'],            desc: 'Revert the last applied change',  color: '#c2410c' },
  { label: 'revert list',        args: ['revert', 'list'],        desc: 'List all applied changes',        color: '#6d28d9' },
  { label: 'init',               args: ['init'],                  desc: 'Create DMCR registry (once)',     color: '#475569' },
  { label: 'show config',        args: ['show', 'config'],        desc: 'Display active configuration',    color: '#334155' },
];
