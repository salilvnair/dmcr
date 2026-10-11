/**
 * Releases page: releases.json (releases and the projects in them) in the changes folder, the
 * project / kind / people / dropped fields of each change's meta.json, and the DBA profile.
 * The runner reads the same files: dmcr release list, deploy --release, revert --project.
 */
import * as fs from "fs";
import * as path from "path";
import type { HandlerContext, Message } from "./types";
import { lintDeploySql } from "../../../services/lint/lock-lint";
import { parseDmcrIni } from "./types";
import { getUserCfgPath } from "../../../storage/runner-paths";

export const PROJECT_TYPES = ['new', 'bugfix', 'cr', 'hotfix', 'other'] as const;
export const CHANGE_KINDS = ['insert', 'update', 'delete', 'dml', 'ddl', 'function', 'type', 'other'] as const;

export interface ReleaseEntry { id: string; name?: string; date?: string; status?: string; notes?: string }
export interface ProjectEntry { id: string; name?: string; type?: string; release?: string; status?: string; dropped_reason?: string; owner?: string }
export interface ReleaseCatalog { releases: ReleaseEntry[]; projects: ProjectEntry[] }

/** Fields of meta.json the Releases page edits; everything else in the file is kept as is. */
const META_FIELDS = ['project', 'kind', 'requested_by', 'ticket', 'created_by', 'created_at', 'status', 'dropped_reason'] as const;

const DBA_REQUIRED = 'Set your DBA name first (Settings > DMCR Config > DBA name). Every change records who created it.';

/** The DBA's name, recorded as created_by on every change DMCR saves. Required before anything is saved. */
export async function getDbaName(): Promise<string> {
  const { findById } = await import('../../../storage/db.js');
  return (findById<{ dbaName?: string }>('dmcr_profile', 'main')?.dbaName ?? '').trim();
}

/** Same rules as the runners (dmcr.ps1 Get-InferredKind / dmcr.sh kind_of). */
export function inferChangeKind(sql: string): string {
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ');
  s = s.replace(/'(?:[^']|'')*'/g, "''");
  s = s.replace(/\$((?:[A-Za-z_]\w*)?)\$[\s\S]*?\$\1\$/g, ' ');
  const ddl = new Set<string>(); const dml = new Set<string>();
  for (const raw of s.split(';')) {
    const t = raw.trim();
    if (!t) continue;
    // DMCR's own bookkeeping (dmcr.bak_* backups a data change keeps for its revert) is not the change's kind
    if (/^(?:CREATE\s+(?:UNLOGGED\s+)?TABLE|INSERT\s+INTO|DROP\s+TABLE|ALTER\s+TABLE|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?"?dmcr"?\./i.test(t)) continue;
    if (/^(CREATE|ALTER|DROP)\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|AGGREGATE)\b/i.test(t)) ddl.add('function');
    else if (/^(CREATE|ALTER|DROP)\s+(TYPE|DOMAIN)\b/i.test(t)) ddl.add('type');
    else if (/^(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|REFRESH)\b/i.test(t)) ddl.add('ddl');
    else if (/^INSERT\b/i.test(t)) dml.add('insert');
    else if (/^UPDATE\b/i.test(t)) dml.add('update');
    else if (/^(DELETE|TRUNCATE)\b/i.test(t)) dml.add('delete');
    else if (/^MERGE\b/i.test(t)) dml.add('dml');
    else if (/^WITH\b/i.test(t)) { for (const k of ['insert', 'update', 'delete']) if (new RegExp(`\\b${k}\\b`, 'i').test(t)) dml.add(k); }
  }
  if (ddl.size === 1) return [...ddl][0];
  if (ddl.size > 1) return 'ddl';
  if (dml.size === 1) return [...dml][0];
  if (dml.size > 1) return 'dml';
  return 'other';
}

async function changesDirAbs(): Promise<string> {
  const { requireChangesDir } = await import('../../../storage/changes-dir.js');
  return requireChangesDir();
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function str(v: unknown): string { return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''; }

function readCatalog(dir: string): { catalog: ReleaseCatalog | null; error?: string } {
  const file = path.join(dir, 'releases.json');
  if (!fs.existsSync(file)) return { catalog: null };
  try {
    const raw = readJson(file) as { releases?: unknown; projects?: unknown };
    const releases = (Array.isArray(raw.releases) ? raw.releases : []) as ReleaseEntry[];
    const projects = (Array.isArray(raw.projects) ? raw.projects : []) as ProjectEntry[];
    return { catalog: { releases, projects } };
  } catch (e) {
    return { catalog: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Problems that would make the runner refuse a deploy (same messages as dmcr check). */
function validateCatalog(c: ReleaseCatalog): string[] {
  const problems: string[] = [];
  const rel = new Set<string>(); const prj = new Set<string>();
  for (const r of c.releases) {
    const id = str(r.id);
    if (!id) { problems.push('Every release needs an id'); continue; }
    if (rel.has(id.toLowerCase())) problems.push(`release '${id}' is listed more than once`);
    rel.add(id.toLowerCase());
    if (r.date && !/^\d{4}-\d{2}-\d{2}$/.test(str(r.date))) problems.push(`release '${id}': date must be YYYY-MM-DD`);
  }
  for (const p of c.projects) {
    const id = str(p.id);
    if (!id) { problems.push('Every project needs an id'); continue; }
    if (prj.has(id.toLowerCase())) problems.push(`project '${id}' is listed more than once`);
    prj.add(id.toLowerCase());
    if (p.release && !rel.has(str(p.release).toLowerCase())) problems.push(`project '${id}': release '${p.release}' is not in the list`);
    if (p.type && !(PROJECT_TYPES as readonly string[]).includes(str(p.type).toLowerCase())) problems.push(`project '${id}': type '${p.type}' (use ${PROJECT_TYPES.join(', ')})`);
  }
  return problems;
}

/** Environments from the runner's dmcr.cfg (every section except [dmcr] and [placeholders]). */
function cfgEnvs(): { envs: string[]; active: string } {
  const cfgPath = getUserCfgPath();
  if (!cfgPath || !fs.existsSync(cfgPath)) return { envs: [], active: '' };
  const parsed = parseDmcrIni(fs.readFileSync(cfgPath, 'utf8'));
  const envs = Object.keys(parsed).filter(s => s !== 'dmcr' && s !== 'placeholders' && parsed[s]?.['conn']);
  return { envs, active: parsed['dmcr']?.['env'] ?? '' };
}

export async function buildReleaseData() {
  const dir = await changesDirAbs();
  const { catalog, error } = readCatalog(dir);
  const changes = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{3}_/.test(d.name))
      .map(d => d.name).sort()
      .map(id => {
        let meta: Record<string, unknown> = {};
        const metaFile = path.join(dir, id, 'meta.json');
        let metaError: string | undefined;
        if (fs.existsSync(metaFile)) {
          try { meta = readJson(metaFile) as Record<string, unknown>; } catch (e) { metaError = e instanceof Error ? e.message : String(e); }
        }
        const deployFile = path.join(dir, id, 'deploy.sql');
        const deploySql = fs.existsSync(deployFile) ? fs.readFileSync(deployFile, 'utf8') : '';
        const inferred = deploySql ? inferChangeKind(deploySql) : 'other';
        return {
          id,
          project: str(meta.project), kind: str(meta.kind).toLowerCase(), inferredKind: inferred,
          requested_by: str(meta.requested_by), created_by: str(meta.created_by), created_at: str(meta.created_at),
          ticket: str(meta.ticket), status: str(meta.status).toLowerCase() === 'dropped' ? 'dropped' : 'active',
          dropped_reason: str(meta.dropped_reason), danger: /(^|_)danger_/i.test(id), metaError,
          // lock / safety lint of deploy.sql (advisory)
          lint: lintDeploySql(deploySql),
        };
      })
    : [];
  return { changesDir: dir, catalog, catalogError: error, changes, ...cfgEnvs(), dbaName: await getDbaName(), projectTypes: PROJECT_TYPES, changeKinds: CHANGE_KINDS };
}

export async function handleReleaseMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;
  const reply = async (extra?: Record<string, unknown>) => {
    try {
      webview.postMessage({ type: 'releaseData', payload: { ...(await buildReleaseData()), ...extra } });
    } catch (e) {
      webview.postMessage({ type: 'releaseData', payload: { error: e instanceof Error ? e.message : String(e), ...extra } });
    }
  };

  // Conflicts between projects (git-style detection and merge changes)
  {
    const { handleConflictMessage } = await import('./conflict-handlers.js');
    if (await handleConflictMessage(ctx, msg)) return true;
  }

  switch (msg.type) {
    case 'getReleaseData': {
      await reply();
      return true;
    }

    /* releases.json written whole: { catalog: { releases, projects } } */
    case 'saveReleaseCatalog': {
      const { catalog, requestId } = (msg.payload ?? {}) as { catalog?: ReleaseCatalog; requestId?: string };
      try {
        if (!(await getDbaName())) throw new Error(DBA_REQUIRED);
        if (!catalog || !Array.isArray(catalog.releases) || !Array.isArray(catalog.projects)) throw new Error('No releases / projects given');
        const clean: ReleaseCatalog = {
          releases: catalog.releases.map(r => {
            const o: ReleaseEntry = { id: str(r.id) };
            if (str(r.name)) o.name = str(r.name);
            if (str(r.date)) o.date = str(r.date);
            o.status = str(r.status) || 'planned';
            if (str(r.notes)) o.notes = str(r.notes);
            return o;
          }),
          projects: catalog.projects.map(p => {
            const o: ProjectEntry = { id: str(p.id) };
            if (str(p.name)) o.name = str(p.name);
            o.type = (str(p.type) || 'new').toLowerCase();
            o.release = str(p.release);
            o.status = str(p.status).toLowerCase() === 'dropped' ? 'dropped' : 'active';
            if (o.status === 'dropped' && str(p.dropped_reason)) o.dropped_reason = str(p.dropped_reason);
            if (str(p.owner)) o.owner = str(p.owner);
            return o;
          }),
        };
        const problems = validateCatalog(clean);
        if (problems.length) throw new Error(problems.join('; '));
        const dir = await changesDirAbs();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify(clean, null, 2) + '\n', 'utf8');
        await reply({ requestId, saved: 'catalog' });
      } catch (e) {
        await reply({ requestId, saveError: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    /* One change's meta.json: { changeId, patch: { project?, kind?, requested_by?, status?, dropped_reason? } }.
       An empty value removes the field. */
    /* Releases > Set up CI: preview ({ write: false }) or write the GitHub Actions check into the repository */
    case 'setupCi': {
      const { write } = (msg.payload ?? {}) as { write?: boolean };
      try {
        const { planCi, writeCi } = await import('../../../ci/setup-ci.js');
        const { getUserDangerRulesPath } = await import('../../../storage/runner-paths.js');
        const plan = planCi({ extensionPath: ctx.extensionPath, changesDir: await changesDirAbs(), dangerRules: getUserDangerRulesPath() ?? undefined });
        const written = write ? writeCi(plan) : [];
        webview.postMessage({ type: 'ciSetup', payload: { root: plan.root, changesRel: plan.changesRel, workflow: plan.workflow, files: plan.files.map(f => ({ path: f.path, exists: f.exists })), written } });
      } catch (e) {
        webview.postMessage({ type: 'ciSetup', payload: { error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    /* The files of one change, for the eye viewer next to every change name */
    case 'readChangeFiles': {
      const { changeId, requestId } = (msg.payload ?? {}) as { changeId?: string; requestId?: string };
      try {
        if (!changeId || !/^(\d{3}_|R__)[\w-]+$/.test(changeId)) throw new Error(`Not a change folder: ${changeId}`);
        const dir = await changesDirAbs();
        const folder = path.join(dir, changeId);
        if (!fs.existsSync(folder)) throw new Error(`${changeId} is not in ${dir}`);
        const read = (n: string) => { const f = path.join(folder, n); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
        const files = { deploy: read('deploy.sql'), verify: read('verify.sql'), revert: read('revert.sql'), meta: read('meta.json') };
        webview.postMessage({ type: 'changeFiles', payload: { requestId, changeId, folder, files } });
      } catch (e) {
        webview.postMessage({ type: 'changeFiles', payload: { requestId, changeId, error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    case 'updateChangeMeta': {
      const { changeId, patch, requestId } = (msg.payload ?? {}) as { changeId?: string; patch?: Record<string, string | null>; requestId?: string };
      try {
        if (!(await getDbaName())) throw new Error(DBA_REQUIRED);
        if (!changeId || !/^\d{3}_[\w-]+$/.test(changeId)) throw new Error(`Not a change folder: ${changeId}`);
        const dir = await changesDirAbs();
        const folder = path.join(dir, changeId);
        if (!fs.existsSync(folder)) throw new Error(`${changeId} does not exist in ${dir}`);
        const metaFile = path.join(folder, 'meta.json');
        const meta = (fs.existsSync(metaFile) ? readJson(metaFile) : {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch ?? {})) {
          if (!(META_FIELDS as readonly string[]).includes(k)) throw new Error(`meta.json field '${k}' is not edited here`);
          const val = str(v);
          if (k === 'kind' && val && !(CHANGE_KINDS as readonly string[]).includes(val)) throw new Error(`kind '${val}' (use ${CHANGE_KINDS.join(', ')})`);
          if (val) meta[k] = val; else delete meta[k];
        }
        if (meta.status !== 'dropped') { delete meta.status; delete meta.dropped_reason; }
        if (meta.status === 'dropped' && !meta.dropped_at) {
          const dba = await getDbaName();
          if (dba) meta.dropped_by = dba;
          meta.dropped_at = new Date().toISOString().slice(0, 10);
        }
        if (meta.status !== 'dropped') { delete meta.dropped_by; delete meta.dropped_at; }
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
        await reply({ requestId, saved: changeId });
      } catch (e) {
        await reply({ requestId, saveError: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    case 'saveDbaProfile': {
      const { dbaName } = (msg.payload ?? {}) as { dbaName?: string };
      const { upsert } = await import('../../../storage/db.js');
      upsert('dmcr_profile', 'main', { dbaName: str(dbaName) });
      webview.postMessage({ type: 'dbaProfile', payload: { dbaName: str(dbaName) } });
      return true;
    }

    case 'getDbaProfile': {
      webview.postMessage({ type: 'dbaProfile', payload: { dbaName: await getDbaName() } });
      return true;
    }
  }
  return false;
}
