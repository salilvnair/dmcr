/**
 * What the conflict analysis reads from a changes folder: every change (project, release, requires, deploy.sql,
 * merges) and the recorded decisions (conflicts.json). No vscode: the runners' conflict check (dmcr_conflicts.cjs)
 * uses it too.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ChangeInput, Resolution } from './analyze';
import { compareChangeIds } from '../../storage/change-order';

const RESOLUTIONS_FILE = 'conflicts.json';

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');


export function readResolutions(dir: string): Resolution[] {
  const f = path.join(dir, RESOLUTIONS_FILE);
  if (!fs.existsSync(f)) return [];
  try { const j = readJson(f) as { resolutions?: Resolution[] }; return Array.isArray(j.resolutions) ? j.resolutions : []; } catch { return []; }
}

export function writeResolutions(dir: string, list: Resolution[]): void {
  fs.writeFileSync(path.join(dir, RESOLUTIONS_FILE), JSON.stringify({ resolutions: list }, null, 2) + '\n', 'utf8');
}

/** Every change folder with its project, release, requires and deploy.sql. */
export function loadChangeInputs(dir: string): ChangeInput[] {
  let projects: { id: string; release?: string; status?: string }[] = [];
  let releases: { id: string; date?: string }[] = [];
  const cat = path.join(dir, 'releases.json');
  if (fs.existsSync(cat)) {
    try { const j = readJson(cat) as { projects?: typeof projects; releases?: typeof releases }; projects = j.projects ?? []; releases = j.releases ?? []; } catch { /* reported by the Releases page */ }
  }
  const proj = new Map(projects.map(p => [str(p.id).toLowerCase(), p]));
  const rel = new Map(releases.map(r => [str(r.id).toLowerCase(), r]));
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d+_/.test(d.name))
    .map(d => d.name).sort(compareChangeIds)
    .map(id => {
      let meta: Record<string, unknown> = {};
      const mf = path.join(dir, id, 'meta.json');
      if (fs.existsSync(mf)) { try { meta = readJson(mf) as Record<string, unknown>; } catch { /* ignored */ } }
      const df = path.join(dir, id, 'deploy.sql');
      const project = str(meta.project);
      const p = proj.get(project.toLowerCase());
      const release = str(p?.release);
      const merges = Array.isArray(meta.merges) ? (meta.merges as { key?: string; changes?: string[] }[]).filter(m => m.key && Array.isArray(m.changes)).map(m => ({ key: m.key!, changes: m.changes! })) : undefined;
      return {
        id, project, release, releaseDate: str(rel.get(release.toLowerCase())?.date) || release,
        dropped: str(meta.status).toLowerCase() === 'dropped' || str(p?.status).toLowerCase() === 'dropped',
        requires: Array.isArray(meta.requires) ? (meta.requires as unknown[]).map(str).filter(Boolean) : [],
        // no schema: older changes' ${schema}.zaps and newer ones' zaps are the same table
        deploySql: fs.existsSync(df) ? fs.readFileSync(df, 'utf8').replace(/\$\{schema\}\./g, '') : '',
        merges,
        author: str(meta.created_by) || undefined,
      };
    });
}
