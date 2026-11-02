import { useEffect, useRef, useState } from 'react';
import { ButtonView, ModalView, LoaderView, UndoIcon, WarningTriangleIcon, ShieldAlertIcon, FileTextIcon } from '@salilvnair/dui';
import { postMsg } from '../../../vscode';
import { ChangeIdLabel } from './ChangeIdLabel';
import { CopyButton } from '../../../components/CopyButton';
import { openChanges } from '../../../components/ChangeViewerHost';
import './RevertLastConfirm.css';

type Plan = { status: 'nothing' } | { status: 'error'; message: string } | { status: 'ok'; changeId: string; manual: boolean };

/**
 * `revertLast` never runs straight away: first what it would revert (revertLast --dry-run) and that change's
 * revert.sql, then the DBA confirms. A manual-only (danger_) change DMCR does not revert: its revert.sql, to run by hand.
 */
export function RevertLastConfirm({ extra, onRun, onClose }: { extra: string[]; onRun: (args: string[]) => void; onClose: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [revertSql, setRevertSql] = useState<string | null>(null);
  const reqId = useRef(`revert-last-${Date.now()}`);
  const envIdx = extra.indexOf('--env');
  const env = envIdx >= 0 ? extra[envIdx + 1] : '';

  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: Record<string, unknown> };
      if (m?.type === 'dmcrCaptureResult' && m.payload?.captureId === reqId.current) {
        const d = (m.payload.data ?? {}) as { status?: string; change_id?: string | null; manual?: boolean; message?: string };
        if (d.status === 'nothing_to_revert') setPlan({ status: 'nothing' });
        else if (d.status === 'dry_run' && d.change_id) {
          setPlan({ status: 'ok', changeId: d.change_id, manual: !!d.manual });
          postMsg({ type: 'readChangeFiles', payload: { changeId: d.change_id, requestId: reqId.current } });
        } else setPlan({ status: 'error', message: String(d.message ?? 'Could not work out what revertLast would revert') });
      }
      if (m?.type === 'changeFiles' && m.payload?.requestId === reqId.current) {
        setRevertSql(String((m.payload.files as Record<string, string> | undefined)?.revert ?? ''));
      }
    };
    window.addEventListener('message', h);
    postMsg({ type: 'runDmcr', payload: { args: ['revertLast', ...extra, '--dry-run', '--json'], captureId: reqId.current } });
    return () => window.removeEventListener('message', h);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const where = env ? ` on ${env}` : '';
  const ok = plan?.status === 'ok' ? plan : null;
  return (
    <ModalView open size="lg" onClose={onClose} title={`Revert the last change${where}`}
      headerIcon={ok?.manual ? <ShieldAlertIcon size={16} style={{ color: 'var(--bs-status-error)' }} /> : <UndoIcon size={16} style={{ color: 'var(--dm-c-f87171)' }} />}
      subtitle={ok?.manual ? 'A manual-only (danger_) change: DMCR never reverts it, the DBA runs its revert.sql by hand.' : 'Nothing is reverted until you confirm.'}
      footerRight={<>
        <ButtonView variant="ghost" label={ok && !ok.manual ? 'Cancel' : 'Close'} onClick={onClose} />
        {ok && !ok.manual && (
          <ButtonView variant="danger" iconLeft={<UndoIcon size={13} />} label="Revert it" disabled={revertSql === null}
            onClick={() => { onClose(); onRun(['revertLast', ...extra]); }} />
        )}
      </>}>
      <div className="rlc">
        {!plan && <LoaderView variant="dots" label="Finding the last applied change" />}
        {plan?.status === 'nothing' && <div className="rlc-note">Nothing to revert{where}: no change is applied.</div>}
        {plan?.status === 'error' && <div className="rlc-error"><WarningTriangleIcon size={14} />{plan.message}</div>}
        {ok && (
          <>
            <div className="rlc-change">
              <ChangeIdLabel id={ok.changeId} />
              <span className="rlc-what">{ok.manual ? 'manual-only: run its revert.sql yourself' : `its revert.sql runs${where}, then verify.sql`}</span>
            </div>
            <div className="rlc-sql-head">
              <span><FileTextIcon size={13} />revert.sql</span>
              <span className="rlc-sql-actions">
                {revertSql && <CopyButton text={revertSql} title="Copy revert.sql" />}
                <ButtonView variant="ghost" iconLeft={<FileTextIcon size={12} />} label="Open revert.sql" onClick={() => { onClose(); openChanges([ok.changeId], undefined, 'revert'); }} />
              </span>
            </div>
            {revertSql === null ? <LoaderView variant="dots" label="Reading revert.sql" /> : <pre className="rlc-sql">{revertSql || '-- revert.sql is empty'}</pre>}
          </>
        )}
      </div>
    </ModalView>
  );
}
