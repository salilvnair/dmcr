import { useCallback, useEffect, useState } from 'react';
import { ButtonView, CommitIcon, WarningTriangleIcon } from '@salilvnair/dui';
import { postMsg } from '../vscode';
import { ChangeIdLabel } from '../pages/runner/views/ChangeIdLabel';
import './UncommittedBanner.css';

type Uncommitted = { changeId: string; files: { path: string; status: string }[] };

/** Ask the app to show another tab (App listens) */
export const openTab = (tab: string) => window.dispatchEvent(new CustomEvent('dmcr:open-tab', { detail: tab }));

/**
 * Change folders saved but not committed: one Commit button (all of them, default message), or
 * review them first in the Commits tab. Hidden when everything is committed.
 */
export function UncommittedBanner() {
  const [items, setItems] = useState<Uncommitted[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = useCallback(() => postMsg({ type: 'gitOverview', payload: { uncommittedOnly: true } }), []);

  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === 'gitOverview' && m.payload?.uncommittedOnly) setItems(m.payload.repo ? m.payload.uncommitted ?? [] : []);
      if (m?.type === 'gitCommitted' && m.payload?.from === 'banner') {
        setBusy(false);
        setNote(m.payload.ok ? { ok: true, text: `Committed ${m.payload.hash}` } : { ok: false, text: m.payload.error ?? 'Commit failed' });
        refresh();
      }
      if (m?.type === 'gitCommitted' && m.payload?.from !== 'banner') refresh();
      if (m?.type === 'gitUndone' || m?.type === 'gitBranchSwitched' || m?.type === 'releaseDataSaved') refresh();
    };
    window.addEventListener('message', h);
    refresh();
    const t = window.setInterval(refresh, 30_000);
    return () => { window.removeEventListener('message', h); window.clearInterval(t); };
  }, [refresh]);

  if (!items.length) {
    return note?.ok ? <div className="ub-done"><CommitIcon size={13} />{note.text}</div> : null;
  }
  const allNew = items.every(i => i.files.every(f => f.status === 'A'));
  const message = items.length === 1
    ? `feat(dmcr): ${allNew ? 'add' : 'update'} change ${items[0].changeId}`
    : `feat(dmcr): ${allNew ? 'add' : 'update'} changes ${items.map(i => i.changeId).join(', ')}`;

  return (
    <div className="ub-root" data-testid="uncommitted-banner">
      <span className="ub-pulse" />
      <div className="ub-main">
        <div className="ub-title">{items.length} change{items.length === 1 ? '' : 's'} saved but not committed</div>
        <div className="ub-ids">{items.map(i => <span key={i.changeId} className="ub-id"><ChangeIdLabel id={i.changeId} /></span>)}</div>
        {note && !note.ok && <div className="ub-err"><WarningTriangleIcon size={12} />{note.text}</div>}
      </div>
      <ButtonView variant="ghost" label="Review in Commits" onClick={() => openTab('commits')} />
      <ButtonView variant="primary" iconLeft={<CommitIcon size={13} />} disabled={busy} label={busy ? 'Committing…' : items.length === 1 ? 'Commit' : `Commit all ${items.length}`}
        title={message}
        onClick={() => { setBusy(true); setNote(null); postMsg({ type: 'gitCommitChanges', payload: { changeIds: items.map(i => i.changeId), message, from: 'banner' } }); }} />
    </div>
  );
}
