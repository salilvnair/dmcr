import { useEffect, useState, type ReactNode } from 'react';
import { postMsg } from '../../../vscode';

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

const PROJECT_HUES = ['#2dd4bf', '#f472b6', '#a78bfa', '#38bdf8', '#fb923c', '#a3e635', '#facc15', '#f87171'];
// By position in releases.json, so neighbouring projects never share a color
function projectColor(id: string, projects: string[]): string {
  return PROJECT_HUES[Math.max(0, projects.indexOf(id)) % PROJECT_HUES.length];
}

/** A change id in color: number, project tag (when the slug is a known project), name; danger_ in red. */
export function ChangeIdLabel({ id }: { id: string }) {
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
  return (
    <span className="cv-cid">
      <span className="cv-cid-num">{num}</span>
      {danger && <span className="cv-cid-danger">danger</span>}
      {project && <span className="cv-cid-proj" style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{project}</span>}
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
