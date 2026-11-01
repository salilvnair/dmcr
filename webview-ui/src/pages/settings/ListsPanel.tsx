import { useEffect, useState } from 'react';
import { ButtonView, SelectInputView, CheckCircleIcon, ModalView, TextInputView, RefreshIcon, WarningTriangleIcon } from '@salilvnair/dui';
import { ListsIcon } from './icons';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, setPageSize, usePageSize } from '../../services/listPrefs';
import { postMsg } from '../../vscode';
import './DmcrConfigPanel.css';
import { FieldHint } from '../../components/FieldHint';

/** Settings > General: app-wide preferences (how DMCR Web itself behaves, not your databases). */
export function ListsPanel() {
  const saved = usePageSize();
  const [size, setSize] = useState(saved);
  useEffect(() => { setSize(saved); }, [saved]);
  const dirty = size !== saved;
  return (
    <div className="bs-settings-pane dc-pane">
      <div className="dc-title">
        <ListsIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3" style={{ margin: 0 }}>General</h3>
        <span className="dc-title-sub">How DMCR itself looks and behaves</span>
      </div>

      <section className="dc-card">
        <div className="dc-card-head">
          <span className="dc-card-icon"><ListsIcon width={15} height={15} /></span>
          <div className="dc-card-titles"><b>Long lists</b><span>Rows per page in Releases, Runner results and previews</span></div>
        </div>
        <div className="dc-card-body">
          <div className="dc-row">
            <label className="dc-row-label">Rows per page<FieldHint title="Rows per page" text="Lists longer than this get search, filters and page numbers; each list's footer can still show more" /></label>
            <div className="dc-row-ctl dc-inline">
              <span style={{ width: 170 }}>
                <SelectInputView size="md" width="100%" value={String(size)} onChange={v => setSize(Number(v))}
                  options={PAGE_SIZES.map(n => ({ value: String(n), label: `${n} rows${n === DEFAULT_PAGE_SIZE ? ' (default)' : ''}` }))} />
              </span>
              <ButtonView label={dirty ? 'Save' : 'Saved'} variant={dirty ? 'primary' : 'ghost'} accentColor="var(--dm-c-6366f1)" disabled={!dirty}
                iconLeft={dirty ? undefined : <CheckCircleIcon size={13} />} onClick={() => setPageSize(size)} />
            </div>
          </div>
        </div>
      </section>

      <DangerZone />
    </div>
  );
}

/**
 * Danger zone › Erase local data: DMCR as if it were uninstalled and installed again. Everything DMCR keeps on this
 * machine goes (see services/factory-reset.ts); the databases it deploys to and the change files are not touched.
 * Typing ERASE confirms it.
 */
function DangerZone() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.data?.type !== 'factoryResetDone') return;
      setBusy(false);
      if (!e.data.payload?.ok) { setError(String(e.data.payload?.error ?? 'The reset failed')); return; }
      // this browser's own memory of DMCR (last project, open tabs …) goes too, then DMCR starts again
      try { Object.keys(localStorage).filter(k => k.startsWith('dmcr')).forEach(k => localStorage.removeItem(k)); } catch { /* storage unavailable */ }
      window.location.reload();
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  const close = () => { if (!busy) { setOpen(false); setTyped(''); setError(''); } };
  return (
    <section className="dc-danger-zone">
      <div className="dc-danger-title"><WarningTriangleIcon size={13} /> Danger zone</div>
      <div className="dc-card dc-reset">
        <div className="dc-card-head">
          <span className="dc-card-icon"><RefreshIcon size={15} /></span>
          <div className="dc-card-titles"><b>Erase local data</b><span>DMCR as if uninstalled and installed again: everything it keeps on this machine goes, your databases stay</span></div>
          <ButtonView variant="danger" label="Erase local data" iconLeft={<RefreshIcon size={13} />} style={{ marginLeft: 'auto' }} onClick={() => setOpen(true)} />
        </div>
      </div>
      {open && (
        <ModalView open size="md" onClose={close} title="Erase DMCR's local data" headerIcon={<WarningTriangleIcon size={16} />}
          subtitle="DMCR starts again as on a fresh install, with the setup wizard. This cannot be undone."
          footerRight={<>
            <ButtonView variant="ghost" label="Cancel" disabled={busy} onClick={close} />
            <ButtonView variant="danger" label="Erase local data" iconLeft={<RefreshIcon size={13} />} loading={busy} disabled={typed.trim().toUpperCase() !== 'ERASE' || busy}
              onClick={() => { setBusy(true); setError(''); postMsg({ type: 'factoryReset' }); }} />
          </>}>
          <div className="dc-reset-cols">
            <div>
              <b className="dc-reset-h dc-reset-h--go">Goes (this machine)</b>
              <ul>
                <li>Your environments, their passwords and release rules (dmcr.cfg goes; the setup wizard makes it again)</li>
                <li>AI providers and their keys, MCP servers</li>
                <li>DMCR's local database file: your DBA name, chats, the AI footprint, Runner history and drafts (a new, empty one is made)</li>
                <li>DMCR's storage folder, danger rules back to the default, saved UI state and open tabs</li>
                <li>DMCR's settings, except where its database file lives</li>
              </ul>
            </div>
            <div>
              <b className="dc-reset-h dc-reset-h--stay">Stays</b>
              <ul>
                <li>The databases DMCR connects to and what is in them, the dmcr registry included</li>
                <li>Your change folders, releases.json and git history</li>
                <li>The extension itself: no reinstall needed</li>
              </ul>
            </div>
          </div>
          <label className="dc-row-label" style={{ marginTop: 12 }}>Type ERASE to confirm</label>
          <TextInputView size="md" width="fullWidth" value={typed} autoFocus placeholder="ERASE" spellCheck={false} onChange={e => setTyped(e.target.value)} />
          {error && <div className="dc-reset-err"><WarningTriangleIcon size={12} /> {error}</div>}
        </ModalView>
      )}
    </section>
  );
}
