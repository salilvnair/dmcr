import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getUserCfgPath } from '../../../storage/runner-paths';
import { parseDmcrIni } from '../../../panel/main/handlers/dmcr-cfg';
import { findById, upsert } from '../../../storage/db';
import { listServers, upsertServer, deleteServer, type McpServerConfig } from './mcp';

/**
 * One database MCP server per DMCR Config environment, made and kept by DMCR: the user enters an
 * environment once (Settings > DMCR Config) and its MCP server follows — created, updated when the
 * program changes, removed with the environment. Users only add servers of their own.
 */
export const MANAGED = 'dmcr-env';
export const managedId = (env: string) => `dmcr-env-${env}`;

export type DbProgram = { command: string; args: string[]; cwd?: string };

/** The database MCP program: what was saved, else pgsql_mcp from the local venv (python -m app_mcp.server). */
export function dbProgram(): DbProgram | null {
  const saved = findById<DbProgram>('dmcr_settings', 'db_mcp_program');
  if (saved?.command) return { command: saved.command, args: saved.args ?? [], cwd: saved.cwd || undefined };
  const venv = path.join(os.homedir(), '.dmcr-local', 'mcp-venv');
  const py = [path.join(venv, 'Scripts', 'python.exe'), path.join(venv, 'bin', 'python')].find(p => fs.existsSync(p));
  return py ? { command: py, args: ['-m', 'app_mcp.server'] } : null;
}

export function saveDbProgram(p: DbProgram): void {
  upsert<DbProgram>('dmcr_settings', 'db_mcp_program', { command: p.command.trim(), args: p.args.map(a => a.trim()).filter(Boolean), cwd: p.cwd?.trim() || undefined });
}

/** host:port/db of a postgres URL (no user / password), for "same database" checks */
export function dbKey(url: string | undefined): string {
  if (!url) return '';
  try { const u = new URL(url.trim()); return `${u.hostname}:${u.port || '5432'}/${u.pathname.replace(/^\//, '')}`.toLowerCase(); } catch { return ''; }
}

export function cfgEnvConns(): Record<string, string> {
  const cfgPath = getUserCfgPath();
  if (!cfgPath || !fs.existsSync(cfgPath)) return {};
  const ini = parseDmcrIni(fs.readFileSync(cfgPath, 'utf8'));
  const names = (ini['envs']?.['names'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const list = names.length ? names : Object.keys(ini).filter(k => !['dmcr', 'envs', 'compare', 'placeholders'].includes(k) && ini[k]?.['conn']);
  return Object.fromEntries(list.filter(n => ini[n]?.['conn']).map(n => [n, ini[n]['conn']]));
}

/** Environments whose auto server the user deleted: it stays deleted until Restore defaults */
const dismissed = (): string[] => findById<{ envs: string[] }>('dmcr_settings', 'db_mcp_dismissed')?.envs ?? [];
export function dismissEnvServer(env: string): void {
  upsert('dmcr_settings', 'db_mcp_dismissed', { envs: [...new Set([...dismissed(), env])] });
}

/**
 * Create / update / remove the managed servers so they match DMCR Config. A deleted one stays
 * deleted and an edited one keeps its edits, unless `restore` (Restore defaults): then every
 * environment gets DMCR's own server back.
 */
export async function syncEnvMcpServers(opts: { restore?: boolean } = {}): Promise<{ created: string[]; updated: string[]; removed: string[] }> {
  const out = { created: [] as string[], updated: [] as string[], removed: [] as string[] };
  if (opts.restore) upsert('dmcr_settings', 'db_mcp_dismissed', { envs: [] });
  const skip = new Set(dismissed());
  const prog = dbProgram();
  const envs = cfgEnvConns();
  const servers = listServers();
  for (const s of servers.filter(x => x.managed === MANAGED)) {
    if (!s.envName || !envs[s.envName] || !prog) { deleteServer(s.id); out.removed.push(s.envName ?? s.id); }
  }
  if (!prog) return out;
  for (const [name, conn] of Object.entries(envs)) {
    if (skip.has(name)) continue;
    const id = managedId(name);
    const desired: Partial<McpServerConfig> & Record<string, unknown> = {
      id, name, type: 'stdio', category: 'database', managed: MANAGED, envName: name,
      description: `${name.toUpperCase()} database from DMCR Config (${dbKey(conn) || 'see DMCR Config'})`,
      command: prog.command, args: prog.args, cwd: prog.cwd ?? '', env: { APP_PG_CONN: `@env:${name}` },
    };
    const cur = servers.find(s => s.id === id);
    if (cur?.customized && !opts.restore) continue;
    desired.customized = false;
    const same = cur && cur.command === prog.command && JSON.stringify(cur.args ?? []) === JSON.stringify(prog.args)
      && (cur.cwd ?? '') === (prog.cwd ?? '') && cur.env?.APP_PG_CONN === `@env:${name}` && cur.description === desired.description && cur.managed === MANAGED && !cur.customized;
    if (same) continue;
    await upsertServer(desired);
    (cur ? out.updated : out.created).push(name);
  }
  return out;
}
