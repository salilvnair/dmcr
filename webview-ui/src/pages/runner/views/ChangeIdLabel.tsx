import { useEffect, useState, type ReactNode } from 'react';
import { postMsg } from '../../../vscode';
import { UserSingleIcon } from '@salilvnair/dui';

// Project ids from releases.json, loaded once and shared by every label on the page
let knownProjects: string[] | null = null;
const listeners = new Set<(p: string[]) => void>();
let requested = false;
function useProjects(): string[] {
  const [projects, setProjects] = useState<string[]>(knownProjects ?? []);
  useEffect(() => {
    listeners.add(setProjects);
    if (!requested) {
      requested = true;
      const handler = (e: MessageEvent) => {
        if (e.data?.type !== 'releaseData' || !e.data.payload) return;
        knownProjects = (e.data.payload.catalog?.projects ?? []).map((p: { id: string }) => String(p.id));
        listeners.forEach(l => l(knownProjects!));
      };
      window.addEventListener('message', handler);
      postMsg({ type: 'getReleaseData' });
    }
    return () => { listeners.delete(setProjects); };
  }, []);
  return projects;
}

const PROJECT_HUES = ['var(--dm-c-2dd4bf)', 'var(--dm-c-f472b6)', 'var(--dm-c-a78bfa)', 'var(--dm-c-38bdf8)', 'var(--dm-c-fb923c)', 'var(--dm-c-a3e635)', 'var(--dm-c-facc15)', 'var(--dm-c-f87171)'];
// By position in releases.json, so neighbouring projects never share a color
function projectColor(id: string, projects: string[]): string {
  return PROJECT_HUES[Math.max(0, projects.indexOf(id)) % PROJECT_HUES.length];
}

/** A change id in color: number, project tag (when the slug is a known project), name; danger_ in red.
 *  With projectType the tag shows the project's type (NEW, CR, BUGFIX...) instead, for tables that list the project in its own column. */
export function ChangeIdLabel({ id, projectType }: { id: string; projectType?: string }) {
  const projects = useProjects();
  const m = /^(\d+)_(danger_)?(.*)$/.exec(id);
  if (!m) {
    const rep = id.startsWith('R__');
    return <span className="cv-cid">{rep ? <><span className="cv-cid-rep">R__</span><span className="cv-cid-name">{id.slice(3)}</span></> : <span className="cv-cid-name">{id}</span>}</span>;
  }
  const [, num, danger, rest] = m;
  const slug = rest.split('_')[0];
  const project = projects.find(p => p.toLowerCase().replace(/[^a-z0-9]+/g, '_') === slug.toLowerCase());
  const name = project ? rest.slice(slug.length + 1) : rest;
  const color = project ? projectColor(project, projects) : '';
  const typeColor = projectType ? TYPE_COLORS[projectType.toLowerCase()] ?? 'var(--dm-c-94a3b8)' : '';
  return (
    <span className="cv-cid">
      <span className="cv-cid-num">{num}</span>
      {danger && <span className="cv-cid-danger">danger</span>}
      {projectType
        ? <span className="cv-cid-proj" style={{ color: typeColor, borderColor: `color-mix(in srgb, ${typeColor} 45%, transparent)`, background: `color-mix(in srgb, ${typeColor} 14%, transparent)` }}>{projectType}</span>
        : project && <span className="cv-cid-proj" style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{project}</span>}
      <span className="cv-cid-name">{name}</span>
    </span>
  );
}

/** Runner detail text with the round-trip steps, counts and outcomes picked out in color. */
export function DetailText({ text }: { text: string }): ReactNode {
  const parts = text.split(/(\bdeploy\b|\bverify\b|\brevert\b|\bpassed\b|\brestored exactly\b|\bfailed\b|\berror\b|\b\d+\b)/gi);
  return parts.map((p, i) => {
    if (i % 2 === 0) return p;
    const k = p.toLowerCase();
    const cls = k === 'deploy' ? 'cv-dt-deploy' : k === 'verify' ? 'cv-dt-verify' : k === 'revert' ? 'cv-dt-revert'
      : k === 'passed' || k === 'restored exactly' ? 'cv-dt-ok' : k === 'failed' || k === 'error' ? 'cv-dt-bad' : 'cv-dt-num';
    return <span key={i} className={cls}>{p}</span>;
  });
}

const TYPE_COLORS: Record<string, string> = { new: 'var(--dm-c-22c55e)', bugfix: 'var(--dm-c-f97316)', cr: 'var(--dm-c-818cf8)', hotfix: 'var(--dm-c-ef4444)', other: 'var(--dm-c-94a3b8)' };
const KIND_COLORS: Record<string, string> = {
  insert: 'var(--dm-c-4ade80)', update: 'var(--dm-c-38bdf8)', delete: 'var(--dm-c-f87171)', dml: 'var(--dm-c-2dd4bf)',
  ddl: 'var(--dm-c-fbbf24)', function: 'var(--dm-c-c084fc)', type: 'var(--dm-c-f472b6)', other: 'var(--dm-c-94a3b8)',
};
const tint = (c: string) => ({ color: c, borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, background: `color-mix(in srgb, ${c} 13%, transparent)` });

/** Project tag (same color as in change ids) with its type (NEW, CR, BUGFIX...). */
export function ProjectChip({ id, type, dropped }: { id?: string; type?: string; dropped?: boolean }) {
  const projects = useProjects();
  if (!id) return <span className="cv-dim">—</span>;
  const c = projects.includes(id) ? projectColor(id, projects) : 'var(--dm-c-94a3b8)';
  return (
    <span className="cv-chips">
      <span className="cv-chip cv-chip--strong" style={tint(c)}>{id}</span>
      {type && <span className="cv-chip cv-chip--small" style={tint(TYPE_COLORS[type.toLowerCase()] ?? 'var(--dm-c-94a3b8)')}>{type.toUpperCase()}</span>}
      {dropped && <span className="cv-chip cv-chip--small" style={tint('var(--dm-c-f87171)')}>DROPPED</span>}
    </span>
  );
}

/** Change kind in its family color: data kinds green/sky/red, structure kinds amber/violet/pink. */
export function KindChip({ kind }: { kind?: string }) {
  if (!kind) return <span className="cv-dim">—</span>;
  return <span className="cv-chip" style={tint(KIND_COLORS[kind.toLowerCase()] ?? 'var(--dm-c-94a3b8)')}>{kind}</span>;
}

/** A person: the developer who asked, or (dba) the DBA who built the change. */
export function PersonChip({ name, dba }: { name?: string; dba?: boolean }) {
  if (!name) return <span className="cv-dim">—</span>;
  const c = dba ? 'var(--dm-c-fbbf24)' : 'var(--dm-c-7dd3fc)';
  return (
    <span className="cv-chip cv-chip--person" style={tint(c)}>
      <UserSingleIcon size={11} />{name}{dba && <span className="cv-chip-tag">DBA</span>}
    </span>
  );
}

/** A release id (a date) as a chip. */
export function ReleaseChip({ id }: { id?: string }) {
  if (!id) return <span className="cv-dim">—</span>;
  return <span className="cv-chip cv-chip--mono" style={tint('var(--dm-c-a78bfa)')}>{id}</span>;
}

/** Runner warning / problem text with change ids (amber) and schema.table names (sky) picked out. */
export function WarnText({ text }: { text: string }) {
  return <>{text.split(/(\b\d{3}_[a-z0-9_]+\b|\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b)/g).map((part, j) =>
    j % 2 === 0 ? part : /^\d{3}_/.test(part) ? <code key={j} className="cv-warn-id">{part}</code> : <code key={j} className="cv-warn-obj">{part}</code>)}</>;
}
