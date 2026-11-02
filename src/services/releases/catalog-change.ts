import type { ReleaseCatalog } from '../../panel/main/handlers/release-handlers';

/** What an edit of releases.json did, for its commit message: "add release 2026-11-20 QuickStart", "project B not going" */
export function describeCatalogChange(before: ReleaseCatalog | null, after: ReleaseCatalog): string {
  const out: string[] = [];
  const named = (x: { id: string; name?: string }) => (x.name ? `${x.id} ${x.name}` : x.id);
  const rel = new Map((before?.releases ?? []).map(r => [r.id, r]));
  for (const r of after.releases) {
    const o = rel.get(r.id);
    if (!o) out.push(`add release ${named(r)}`);
    else if (!!o.archived !== !!r.archived) out.push(`${r.archived ? 'archive' : 'unarchive'} release ${r.id}`);
    else if (JSON.stringify(o) !== JSON.stringify(r)) out.push(`edit release ${r.id}`);
    rel.delete(r.id);
  }
  for (const id of rel.keys()) out.push(`remove release ${id}`);
  const proj = new Map((before?.projects ?? []).map(p => [p.id, p]));
  for (const p of after.projects) {
    const o = proj.get(p.id);
    if (!o) out.push(`add project ${named(p)}${p.release ? ` to ${p.release}` : ''}`);
    else if (o.status !== p.status) out.push(p.status === 'dropped' ? `project ${p.id} not going` : `project ${p.id} going again`);
    else if (o.release !== p.release) out.push(`move project ${p.id} to ${p.release}`);
    else if (JSON.stringify(o) !== JSON.stringify(p)) out.push(`edit project ${p.id}`);
    proj.delete(p.id);
  }
  for (const id of proj.keys()) out.push(`remove project ${id}`);
  if (!out.length) return 'update releases and projects';
  return out.length > 3 ? `${out.slice(0, 3).join(', ')} and ${out.length - 3} more` : out.join(', ');
}
