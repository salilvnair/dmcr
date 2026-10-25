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

      <ResetToDefaults />
    </div>
  );
}

/**
 * Reset to defaults: DMCR back to its first run, like a phone's factory reset. Everything DMCR keeps for itself goes
 * (see services/factory-reset.ts); the databases and the change files are not touched. Typing RESET confirms it.
 */
function ResetToDefaults() {
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
    <section className="dc-card dc-reset">
      <div className="dc-card-head">
        <span className="dc-card-icon"><RefreshIcon size={15} /></span>
        <div className="dc-card-titles"><b>Reset to defaults</b><span>DMCR as on its first run, like a factory reset: you set it up again from the start</span></div>
        <ButtonView variant="danger" label="Reset to defaults" iconLeft={<RefreshIcon size={13} />} style={{ marginLeft: 'auto' }} onClick={() => setOpen(true)} />
      </div>
      {open && (
        <ModalView open size="md" onClose={close} title="Reset DMCR to defaults" headerIcon={<WarningTriangleIcon size={16} />}
          subtitle="DMCR starts again as on its first run, with the setup wizard. This cannot be undone."
          footerRight={<>
            <ButtonView variant="ghost" label="Cancel" disabled={busy} onClick={close} />
            <ButtonView variant="danger" label="Reset to defaults" iconLeft={<RefreshIcon size={13} />} loading={busy} disabled={typed.trim().toUpperCase() !== 'RESET' || busy}
              onClick={() => { setBusy(true); setError(''); postMsg({ type: 'factoryReset' }); }} />
          </>}>
          <div className="dc-reset-cols">
            <div>
              <b className="dc-reset-h dc-reset-h--go">Goes</b>
              <ul>
                <li>Your environments, their passwords and release rules (dmcr.cfg goes; the setup wizard makes it again)</li>
                <li>AI providers and their keys, MCP servers</li>
                <li>Your DBA name and every other setting, danger rules back to the default</li>
                <li>Assistant chats, the AI footprint, Runner history, drafts and open tabs</li>
              </ul>
            </div>
            <div>
              <b className="dc-reset-h dc-reset-h--stay">Stays</b>
              <ul>
                <li>Your databases and what is in them, the dmcr registry included</li>
                <li>Your change folders, releases.json and git history</li>
              </ul>
            </div>
          </div>
          <label className="dc-row-label" style={{ marginTop: 12 }}>Type RESET to confirm</label>
          <TextInputView size="md" width="fullWidth" value={typed} autoFocus placeholder="RESET" spellCheck={false} onChange={e => setTyped(e.target.value)} />
          {error && <div className="dc-reset-err"><WarningTriangleIcon size={12} /> {error}</div>}
        </ModalView>
      )}
    </section>
  );
}
