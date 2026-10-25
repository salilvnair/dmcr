import { useState, useEffect, useCallback } from 'react';
import { SelectInputView, TextInputView, UserSingleIcon } from '@salilvnair/dui';
import { postMsg } from '../vscode';
import './ReleaseFields.css';

type ReleaseProject = { id: string; name?: string; type?: string; release?: string; status?: string };

export const PROJECT_TYPE_COLORS: Record<string, string> = {
  new: 'var(--dm-c-22c55e)', bugfix: 'var(--dm-c-f97316)', cr: 'var(--dm-c-6366f1)', hotfix: 'var(--dm-c-ef4444)', other: 'var(--dm-c-64748b)',
};

// Last project chosen on a card, and the developer last named for each project (per browser, best effort)
const memo = {
  get(key: string): string { try { return localStorage.getItem(`dmcr.card.${key}`) ?? ''; } catch { return ''; } },
  set(key: string, v: string) { try { localStorage.setItem(`dmcr.card.${key}`, v); } catch { /* storage unavailable */ } },
};

/**
 * Release fields of a change card: project (from releases.json), the developer who asked, and an
 * optional kind. Shared by the form pages' card and the Assistant's card so both save the same metadata.
 * `fields` renders them; `releaseMeta` goes into the saveChange payload; call `remember()` on save.
 */
export function useReleaseFields() {
  const [projects, setProjects] = useState<ReleaseProject[]>([]);
  const [changeKinds, setChangeKinds] = useState<string[]>([]);
  const [project, setProject] = useState(() => memo.get('lastProject'));
  const [requestedBy, setRequestedBy] = useState(() => memo.get(`requestedBy.${memo.get('lastProject')}`));
  const [kind, setKind] = useState('');
  const [dbaName, setDbaName] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'releaseData' || !e.data.payload) return;
      const all: ReleaseProject[] = e.data.payload.catalog?.projects ?? [];
      setProjects(all.filter(p => p.status !== 'dropped'));
      setChangeKinds(e.data.payload.changeKinds ?? []);
      setDbaName(String(e.data.payload.dbaName ?? ''));
      setProject(prev => (prev && !all.some(p => p.id === prev && p.status !== 'dropped') ? '' : prev));
    };
    window.addEventListener('message', handler);
    postMsg({ type: 'getReleaseData' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const remember = useCallback(() => {
    memo.set('lastProject', project);
    if (project) memo.set(`requestedBy.${project}`, requestedBy.trim());
  }, [project, requestedBy]);

  const fields = (
    <div className="cc-release">
      <div className="cc-release-field">
        <label>Project</label>
        <SelectInputView size="md"
          value={project}
          onChange={v => { setProject(v); const r = memo.get(`requestedBy.${v}`); if (r) setRequestedBy(r); }}
          options={[
            { value: '', label: projects.length ? '(no project)' : '(no releases.json yet: add projects in Releases)' },
            ...projects.map(p => ({ value: p.id, label: `${p.id}${p.name ? ' · ' + p.name : ''}${p.release ? ' — ' + p.release : ''}`, badge: p.type ? { label: p.type.toUpperCase(), color: PROJECT_TYPE_COLORS[p.type] ?? 'var(--dm-c-64748b)' } : undefined })),
          ]}
        />
      </div>
      <div className="cc-release-field">
        <label>Requested by (developer)</label>
        <TextInputView value={requestedBy} onChange={e => setRequestedBy(e.target.value)} placeholder="Developer who asked" iconLeft={<UserSingleIcon size={12} />} />
      </div>
      <div className="cc-release-field cc-release-kind">
        <label>Kind</label>
        <SelectInputView size="md"
          value={kind}
          onChange={setKind}
          options={[{ value: '', label: 'auto (from deploy.sql)' }, ...changeKinds.map(k => ({ value: k, label: k }))]}
        />
      </div>
    </div>
  );

  return { fields, releaseMeta: { project, requestedBy: requestedBy.trim(), kind }, dbaName, remember };
}
