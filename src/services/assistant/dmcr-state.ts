/**
 * What DMCR itself knows, for the Assistant: the change folders (project, release, what each one
 * creates or changes), the releases, and on each environment which changes are applied
 * (dmcr.change_log, read through that environment's database server). With it an answer can say
 * "zp_lookup_data comes from 002_a_create_zp_lookup_data (release 2026-10-25), applied on test,
 * not deployed to prod yet" instead of guessing from an empty lookup.
 */
import * as fs from 'fs';
import * as path from 'path';

export type ChangeInfo = { id: string; project?: string; release?: string; requires: string[]; description?: string; objects: string[] };
type Release = { id: string; name?: string; date?: string; status?: string };
type Project = { id: string; name?: string; release?: string; status?: string };

const KIND = '(MATERIALIZED\\s+VIEW|VIEW|TABLE|FUNCTION|PROCEDURE|TYPE|SEQUENCE|INDEX|TRIGGER)';
const NAME = '((?:"[^"]+"|[A-Za-z_][\\w$]*)(?:\\s*\\.\\s*(?:"[^"]+"|[A-Za-z_][\\w$]*))?)';

const bare = (n: string) => n.split('.').pop()!.replace(/"/g, '').trim().toLowerCase();

/** "creates table zp_lookup_data", "alters table zp_lookup_data", "inserts into zp_lookup_data", … from a deploy.sql */
export function objectsTouched(sql: string): string[] {
  const s = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = new Set<string>();
  const add = (verb: string, kind: string, name: string) => {
    const n = bare(name);
    if (!n || n === 'dmcr' || /^(if|only|not|exists)$/.test(n)) return;
    out.add(`${verb} ${kind.toLowerCase().replace(/\s+/g, ' ')} ${n}`);
  };
  const re = (src: string) => new RegExp(src, 'gi');
  for (const m of s.matchAll(re(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:UNIQUE\\s+)?${KIND}\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}`))) add('creates', m[1], m[2]);
  for (const m of s.matchAll(re(`\\bALTER\\s+${KIND}\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${NAME}`))) add('alters', m[1], m[2]);
  for (const m of s.matchAll(re(`\\bDROP\\s+${KIND}\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${NAME}`))) add('drops', m[1], m[2]);
  for (const m of s.matchAll(re(`\\bREFRESH\\s+MATERIALIZED\\s+VIEW\\s+(?:CONCURRENTLY\\s+)?${NAME}`))) add('refreshes', 'materialized view', m[1]);
  for (const m of s.matchAll(re(`\\bINSERT\\s+INTO\\s+${NAME}`))) add('inserts into', 'table', m[1]);
  for (const m of s.matchAll(re(`\\bUPDATE\\s+(?:ONLY\\s+)?${NAME}\\s+(?:AS\\s+\\w+\\s+|\\w+\\s+)?SET\\b`))) add('updates', 'table', m[1]);
  for (const m of s.matchAll(re(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?${NAME}`))) add('deletes from', 'table', m[1]);
  return [...out].map(o => o.replace(/^(inserts into|updates|deletes from) table /, '$1 '));
}

/** The change folders, oldest first, with their project, release and what they touch. */
export function readChanges(dir: string): { changes: ChangeInfo[]; releases: Release[]; projects: Project[] } {
  if (!dir || !fs.existsSync(dir)) return { changes: [], releases: [], projects: [] };
  let releases: Release[] = [], projects: Project[] = [];
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'releases.json'), 'utf8'));
    releases = Array.isArray(r.releases) ? r.releases : [];
    projects = Array.isArray(r.projects) ? r.projects : [];
  } catch { /* no releases.json yet */ }
  const releaseOf = new Map(projects.map(p => [p.id, p.release]));
  const changes: ChangeInfo[] = [];
  for (const id of fs.readdirSync(dir).sort()) {
    const folder = path.join(dir, id);
    const deploy = path.join(folder, 'deploy.sql');
    if (!fs.existsSync(deploy)) continue;
    let meta: { project?: string; release?: string; requires?: string[]; description?: string } = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8')); } catch { /* no meta */ }
    changes.push({
      id, project: meta.project, release: meta.release ?? (meta.project ? releaseOf.get(meta.project) : undefined),
      requires: Array.isArray(meta.requires) ? meta.requires : [], description: meta.description,
      objects: objectsTouched(fs.readFileSync(deploy, 'utf8')),
    });
  }
  return { changes, releases, projects };
}

export type EnvApplied = { env: string; schema?: string; active: boolean; applied?: Map<string, string>; problem?: string };

/** The context block: releases, each change with where it is applied, and how to use it. */
export function formatDmcrState(changes: ChangeInfo[], releases: Release[], envs: EnvApplied[]): string {
  const lines: string[] = [];
  lines.push('━━━ DMCR STATE (what DMCR itself knows; answer from it first) ━━━');
  lines.push('DMCR deploys versioned change folders (db/changes/NNN_name with deploy.sql, verify.sql, revert.sql, meta.json) environment by environment. '
    + 'Each environment\'s dmcr.change_log lists the changes applied there. An object exists on an environment only once a change that creates it is applied there; '
    + 'a release goes out from Releases (Deploy) one environment at a time.');
  lines.push('Rules: when asked about an object on an environment where the change that creates it is not applied, say that plainly (name the change, its release and project, '
    + 'and where it IS applied) instead of guessing why a lookup came back empty. When asked what is deployed, pending or in a release, answer from this block.');
  if (envs.length) {
    lines.push('Environments:');
    for (const e of envs) {
      const total = changes.length;
      const st = e.problem ? e.problem
        : `${e.applied!.size} of ${total} change${total === 1 ? '' : 's'} applied${e.applied!.size === 0 ? ' (nothing deployed yet)' : ''}`;
      lines.push(`  ${e.env}${e.active ? ' (active)' : ''}${e.schema ? ` · schema ${e.schema}` : ''}: ${st}`);
    }
  }
  if (releases.length) {
    lines.push('Releases:');
    for (const r of releases) lines.push(`  ${r.id}${r.name ? ` · ${r.name}` : ''}${r.status ? ` · ${r.status}` : ''}`);
  }
  if (changes.length) {
    lines.push('Changes (oldest first):');
    for (const c of changes) {
      const where = envs.filter(e => e.applied).map(e => `${e.env}: ${e.applied!.has(c.id) ? `applied ${e.applied!.get(c.id)}` : 'not applied'}`).join(' · ');
      const bits = [c.project && `project ${c.project}`, c.release && `release ${c.release}`, c.objects.length && c.objects.join(', '),
        c.requires.length && `requires ${c.requires.join(', ')}`, where].filter(Boolean);
      lines.push(`  ${c.id} · ${bits.join(' · ')}`);
    }
  } else {
    lines.push('Changes: none yet (the changes folder is empty).');
  }
  return '\n\n' + lines.join('\n');
}

/**
 * Reads what is applied on each environment (dmcr.change_log, through the environment's own database
 * server) and puts it next to the change folders. Never throws: a database that can't be read says so.
 */
export async function buildDmcrStateContext(conversationId?: string): Promise<string> {
  const { cfgEnvSchemas, managedId } = await import('../mcp/server/env-servers.js');
  const { callMcpTool } = await import('../mcp/agent/mcp-agent.js');
  const { resolveChangesDir } = await import('../../storage/changes-dir.js');
  const { changes, releases } = readChanges(resolveChangesDir());
  const schemas = cfgEnvSchemas();          // the active environment first
  const names = Object.keys(schemas);
  const envs: EnvApplied[] = [];
  for (const [i, env] of names.entries()) {
    const e: EnvApplied = { env, schema: schemas[env], active: i === 0 };
    try {
      const r = await callMcpTool('run_readonly_query', { sql: 'SELECT change_id, applied_at::date::text AS applied_on FROM dmcr.change_log ORDER BY change_id', limit: 1000 }, managedId(env), conversationId);
      const data = (r as { success?: boolean; data?: unknown; error?: string });
      const d = data.data as { rows?: unknown[]; columns?: string[]; error?: string } | undefined;
      if (!data.success || d?.error) {
        const why = String(data.error ?? d?.error ?? '');
        e.problem = /change_log.*does not exist|relation .*dmcr/i.test(why) ? 'DMCR is not set up here yet (no dmcr registry)' : `could not read what is applied (${why.split('\n')[0].slice(0, 120)})`;
      } else {
        const cols = d?.columns ?? ['change_id', 'applied_on'];
        e.applied = new Map((d?.rows ?? []).map(row => {
          const o = Array.isArray(row) ? Object.fromEntries(cols.map((c, k) => [c, row[k]])) : row as Record<string, unknown>;
          return [String(o.change_id), String(o.applied_on ?? '')];
        }));
      }
    } catch (err) {
      e.problem = `could not read what is applied (${err instanceof Error ? err.message.split('\n')[0].slice(0, 120) : String(err)})`;
    }
    envs.push(e);
  }
  return formatDmcrState(changes, releases, envs);
}
