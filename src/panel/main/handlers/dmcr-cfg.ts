/**
 * dmcr.cfg: parse it, list its environments, write it. No VS Code imports (unit-tested in plain Node).
 */

/** Minimal INI parser — returns { section: { key: value } }. Strips inline # comments. */
export function parseDmcrIni(text: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      result[section] = result[section] ?? {};
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0 || !section) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).split('#')[0].trim();
    result[section][key] = val;
  }
  return result;
}

/** Per-environment release rules (dmcr.cfg [<env>] promote_from / out_of_order / approval / approvers). */
export interface EnvRules { promoteFrom?: string; outOfOrder?: 'allow' | 'block' | ''; approval?: 'required' | ''; approvers?: string }

/** One database environment: its name and connection URL (the password lives in the OS keychain as dmcr.<name>Password). */
export interface EnvConn { name: string; connUrl: string; /** Schema the changes target here: the ${schema} placeholder (e.g. zp_st on test, zp on prod) */ schema?: string }

/** Section names that are never environments. */
export const NON_ENV_SECTIONS = new Set(['dmcr', 'envs', 'compare', 'placeholders']);

/** Environment names: letters, digits, _ and -, starting with a letter (they become [section] names and keychain keys). */
export const ENV_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Schema names: a plain lowercase identifier (it is substituted into SQL unquoted). */
export const SCHEMA_NAME_RE = /^[a-z_][a-z0-9_$]*$/;

/**
 * The environments a parsed dmcr.cfg defines, in order: [envs] names, else every section with a conn.
 * Each one's URL comes from its own [name] section.
 */
export function cfgEnvList(parsed: Record<string, Record<string, string>>): EnvConn[] {
  const listed = (parsed['envs']?.['names'] ?? '').split(',').map(n => n.trim()).filter(Boolean);
  const names = listed.length ? listed : Object.keys(parsed).filter(n => !NON_ENV_SECTIONS.has(n) && 'conn' in (parsed[n] ?? {}));
  return names.filter(n => !NON_ENV_SECTIONS.has(n)).map(n => ({ name: n, connUrl: parsed[n]?.['conn'] ?? '', schema: parsed[n]?.['schema'] ?? '' }));
}

/** The active environment of a parsed dmcr.cfg: [dmcr] env, else the first environment, else 'dev'. */
export function cfgActiveEnv(parsed: Record<string, Record<string, string>>): string {
  return parsed['dmcr']?.['env']?.trim() || cfgEnvList(parsed)[0]?.name || 'dev';
}

/**
 * Build the content of dmcr.cfg from form values.
 * `envs` is the whole list of environments, any names, any number: each becomes a [name] section and
 * [envs] names lists them. An environment that is in the existing file but not in `envs` is removed.
 * (Older callers may still pass devConnUrl / prodConnUrl / extraEnvs; they are turned into `envs`.)
 * `existing` is the current file, parsed: keys and sections the form does not manage
 * ([placeholders], run_history_limit, hand-added settings …) are carried over unchanged.
 */
export function buildDmcrCfg(p: {
  env: string; changesDir: string; psqlPath: string;
  lockTimeout: string; statementTimeout: string;
  checksumPolicy?: string;
  envs?: EnvConn[];
  devConnUrl?: string; prodConnUrl?: string; compareConnUrl?: string;
  extraEnvs?: { name: string; connUrl: string; schema?: string }[];
  envRules?: Record<string, EnvRules>;
  existing?: Record<string, Record<string, string>>;
}): string {
  const envs: EnvConn[] = (p.envs ?? [
    { name: 'dev', connUrl: p.devConnUrl ?? '' }, { name: 'prod', connUrl: p.prodConnUrl ?? '' }, ...(p.extraEnvs ?? []),
  ]).map(e => ({ name: e.name.trim(), connUrl: (e.connUrl ?? '').trim(), schema: (e.schema ?? '').trim() })).filter(e => e.name);
  for (const e of envs) {
    if (!ENV_NAME_RE.test(e.name) || NON_ENV_SECTIONS.has(e.name)) throw new Error(`Not a valid environment name: ${e.name}`);
    if (e.schema && !SCHEMA_NAME_RE.test(e.schema)) throw new Error(`Not a valid schema name for ${e.name}: ${e.schema}`);
  }
  const allEnvNames = envs.map(e => e.name);
  if (new Set(allEnvNames).size !== allEnvNames.length) throw new Error(`Two environments have the same name`);
  if (!allEnvNames.length) throw new Error('Add at least one environment');
  const existing = p.existing ?? {};
  // environments the file had that the form no longer lists: their sections go
  const removedEnvs = new Set(cfgEnvList(existing).map(e => e.name).filter(n => !allEnvNames.includes(n)));
  const managed: Record<string, Set<string>> = {
    dmcr: new Set(['env', 'changes_dir', 'psql_path', 'lock_timeout', 'statement_timeout', 'checksum_policy']),
    envs: new Set(['names']),
    compare: new Set(['conn']),
  };
  for (const n of allEnvNames) { managed[n] = new Set(['conn', 'schema', 'promote_from', 'out_of_order', 'approval', 'approvers']); }
  /** Lines for the keys of `section` in the existing file that the form does not manage. */
  const kept = (section: string): string[] =>
    Object.entries(existing[section] ?? {})
      .filter(([k]) => !managed[section]?.has(k))
      .map(([k, v]) => `${k} = ${v}`);
  const rules = (envName: string): string[] => {
    const r = p.envRules?.[envName] ?? {};
    const out: string[] = [];
    const from = (r.promoteFrom ?? '').trim();
    if (from && from !== envName && allEnvNames.includes(from)) {
      out.push(`# Promotion gate: deploy only changes already applied in [${from}] with identical files`, `promote_from = ${from}`);
    }
    if (r.outOfOrder === 'block' || r.outOfOrder === 'allow') {
      out.push(`# A pending change that sorts before an applied one: allow | block`, `out_of_order = ${r.outOfOrder}`);
    }
    if (r.approval === 'required') {
      out.push(`# Approval gate: deploy (and a danger_ change's manual script) needs a sign-off per change: dmcr approve`, `approval = required`);
      const who = (r.approvers ?? '').split(',').map(x => x.trim()).filter(Boolean).join(', ');
      if (who) out.push(`# Who may approve (DBA names); the DBA who created or requested a change never approves it`, `approvers = ${who}`);
    }
    return out;
  };
  const activeEnv = allEnvNames.includes((p.env ?? '').trim()) ? p.env.trim() : allEnvNames[0];

  const lines: string[] = [
    '[dmcr]',
    `# Active environment: ${allEnvNames.join(' | ')}`,
    `env = ${activeEnv}`,
    '',
    `# Relative (from workspace root) or absolute path to your DMCR changes directory`,
    `changes_dir = ${p.changesDir}`,
    '',
    `# Absolute path to psql (leave blank to use PATH)`,
    `psql_path = ${p.psqlPath}`,
    '',
    `# Fail fast if DDL/DML waits on a lock longer than this (e.g. 5s, 30s)`,
    `lock_timeout = ${p.lockTimeout || '30s'}`,
    '',
    `# Abort any single statement that runs longer than this (e.g. 5min, 30s)`,
    `statement_timeout = ${p.statementTimeout || '5min'}`,
    '',
  ];
  const policy = (p.checksumPolicy ?? existing['dmcr']?.['checksum_policy'] ?? '').trim();
  if (policy) {
    lines.push(`# Applied change files edited afterwards: warn | block | repair`, `checksum_policy = ${policy}`, '');
  }
  lines.push(...kept('dmcr'),
    '',
    '[envs]',
    `# All configured environments — add names here and create a matching [envname] section below`,
    `names = ${allEnvNames.join(', ')}`,
    ...kept('envs'),
    '',
  );

  for (const env of envs) {
    lines.push(
      '',
      `[${env.name}]`,
      `# Connection URL (no password). Password stored separately in OS Keychain as dmcr.${env.name}Password.`,
      `conn = ${env.connUrl}`,
      ...(env.schema ? [`# Schema every session runs in here (search_path), like picking it in DBeaver: SQL without a schema lands in ${env.schema}`, `schema = ${env.schema}`] : []),
      ...rules(env.name),
      ...kept(env.name),
      '',
    );
  }

  lines.push(
    '',
    '[compare]',
    `# Optional second DB for Schema Diff (compare target). Full connection URL including password.`,
    `conn = ${p.compareConnUrl ?? ''}`,
    ...kept('compare'),
    '',
  );

  // Sections the form does not know ([placeholders], …) — kept as they were
  for (const section of Object.keys(existing)) {
    if (managed[section] || removedEnvs.has(section)) continue;
    const entries = Object.entries(existing[section]);
    lines.push('', `[${section}]`, ...entries.map(([k, v]) => `${k} = ${v}`), '');
  }

  return lines.join('\n');
}
