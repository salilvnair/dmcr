import { ModalView, ButtonView, ShieldAlertIcon } from '@salilvnair/dui';
import { ChangeIdLabel, PersonChip } from '../pages/runner/views/ChangeIdLabel';
import './DeployRefusedModal.css';

export type MissingReleaseFields = { change_id: string; missing: string[]; created_by?: string };

/**
 * A deploy refused because pending changes have no project or no requested by (code release_fields_missing):
 * each change with what it lacks and who wrote it, and where to set them.
 */
export function DeployRefusedModal({ env, missing, onClose }: { env?: string; missing: MissingReleaseFields[]; onClose: () => void }) {
  return (
    <ModalView open size="md" onClose={onClose} headerColor="var(--dm-c-f87171)" headerIcon={<ShieldAlertIcon size={16} />}
      title={`Deploy${env ? ` to ${env}` : ''} refused`}
      subtitle={`${missing.length} pending change${missing.length > 1 ? 's have' : ' has'} no project or no requested by. Nothing was applied.`}
      footerRight={<ButtonView variant="primary" label="OK" onClick={onClose} />}>
      <div className="drm">
        {missing.map(m => (
          <div key={m.change_id} className="drm-row" data-testid="deploy-refused-row">
            <ChangeIdLabel id={m.change_id} />
            <span className="drm-missing">{m.missing.map(f => <span key={f} className="drm-chip">no {f}</span>)}</span>
            {m.created_by && <PersonChip name={m.created_by} />}
          </div>
        ))}
        <div className="drm-how">Set them in <b>Releases › Changes</b> (the pencil on the row), commit, then deploy again.</div>
      </div>
    </ModalView>
  );
}
