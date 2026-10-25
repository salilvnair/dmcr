import { useCallback, useEffect, useRef, useState } from 'react';
import { ButtonView, CommitIcon, WarningTriangleIcon } from '@salilvnair/dui';
import { postMsg } from '../vscode';
import { ChangeIdLabel } from '../pages/runner/views/ChangeIdLabel';
import './UncommittedBanner.css';

type Uncommitted = { changeId: string; files: { path: string; status: string }[] };

/** Ids shown in the banner; the rest are counted (hundreds of ids filled the screen and hid the page under it) */
const SHOWN = 8;

/** Ask the app to show another tab (App listens) */
export const openTab = (tab: string) => window.dispatchEvent(new CustomEvent('dmcr:open-tab', { detail: tab }));

/**
 * Change folders saved but not committed: one Commit button (all of them, default message), or
 * review them first in the Commits tab. Hidden when everything is committed.
 */
/** onLoaded: the first answer from git is in (a page keeps its loader until then, so the banner never pops in late) */
export function UncommittedBanner({ onLoaded }: { onLoaded?: () => void } = {}) {
  const loaded = useRef(false);
  const [items, setItems] = useState<Uncommitted[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = useCallback(() => postMsg({ type: 'gitOverview', payload: { uncommittedOnly: true } }), []);

  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === 'gitOverview' && m.payload?.uncommittedOnly) {
        setItems(m.payload.repo ? m.payload.uncommitted ?? [] : []);
        if (!loaded.current) { loaded.current = true; onLoaded?.(); }
      }
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
    : items.length <= SHOWN
      ? `feat(dmcr): ${allNew ? 'add' : 'update'} changes ${items.map(i => i.changeId).join(', ')}`
      : `feat(dmcr): ${allNew ? 'add' : 'update'} ${items.length} changes (${items[0].changeId} … ${items[items.length - 1].changeId})`;
  const more = items.length - SHOWN;

  return (
    <div className="ub-root" data-testid="uncommitted-banner">
      <span className="ub-pulse" />
      <div className="ub-main">
        <div className="ub-title">{items.length} change{items.length === 1 ? '' : 's'} saved but not committed</div>
        <div className="ub-ids">
          {items.slice(0, SHOWN).map(i => <span key={i.changeId} className="ub-id"><ChangeIdLabel id={i.changeId} /></span>)}
          {more > 0 && <button type="button" className="ub-more" title="See them all in the Commits tab" onClick={() => openTab('commits')}>+{more} more</button>}
        </div>
        {note && !note.ok && <div className="ub-err"><WarningTriangleIcon size={12} />{note.text}</div>}
      </div>
      <ButtonView variant="ghost" label="Review in Commits" onClick={() => openTab('commits')} />
      <ButtonView variant="primary" iconLeft={<CommitIcon size={13} />} disabled={busy} label={busy ? 'Committing…' : items.length === 1 ? 'Commit' : `Commit all ${items.length}`}
        title={message}
        onClick={() => { setBusy(true); setNote(null); postMsg({ type: 'gitCommitChanges', payload: { changeIds: items.map(i => i.changeId), message, from: 'banner' } }); }} />
    </div>
  );
}
