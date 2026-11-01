import { ModalView, ButtonView, ShieldAlertIcon } from '@salilvnair/dui';
import { ChangeIdLabel, PersonChip } from '../pages/runner/views/ChangeIdLabel';
import './DeployRefusedModal.css';

export type MissingReleaseFields = { change_id: string; missing: string[]; created_by?: string };
type ConflictSide = { change_id: string; project: string; created_by?: string };
/** A conflict between changes (Releases › Conflicts) not resolved by a merge change: the later one would replace the earlier */
export type UnresolvedConflict = { object: string; label: string; ours: ConflictSide; theirs: ConflictSide };
export type DeployRefusal = { env?: string; missing: MissingReleaseFields[]; conflicts: UnresolvedConflict[] };

/** The refusal in a deploy's JSON result (codes release_fields_missing / conflicts_unresolved), or null */
export function deployRefusalOf(d: unknown, fallbackEnv?: string): DeployRefusal | null {
  const r = d as { code?: string; env?: string; missing?: MissingReleaseFields[]; conflicts?: UnresolvedConflict[] } | null;
  if (r?.code !== 'release_fields_missing' && r?.code !== 'conflicts_unresolved') return null;
  const missing = r.missing ?? [], conflicts = r.conflicts ?? [];
  return missing.length || conflicts.length ? { env: r.env || fallbackEnv, missing, conflicts } : null;
}

/**
 * A deploy refused: pending changes with no project or no requested by, and conflicts between changes it would
 * deploy that no merge change resolves. Each with who wrote it and where to fix it.
 */
export function DeployRefusedModal({ env, missing, conflicts, onClose }: DeployRefusal & { onClose: () => void }) {
  const why = [
    ...(missing.length ? [`${missing.length} pending change${missing.length > 1 ? 's have' : ' has'} no project or no requested by`] : []),
    ...(conflicts.length ? [`${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''} between changes ${conflicts.length > 1 ? 'are' : 'is'} not resolved`] : []),
  ];
  return (
    <ModalView open size="md" onClose={onClose} headerColor="var(--dm-c-f87171)" headerIcon={<ShieldAlertIcon size={16} />}
      title={`Deploy${env ? ` to ${env}` : ''} refused`}
      subtitle={`${why.join('; ')}. Nothing was applied.`}
      footerRight={<ButtonView variant="primary" label="OK" onClick={onClose} />}>
      <div className="drm">
        {missing.map(m => (
          <div key={m.change_id} className="drm-row" data-testid="deploy-refused-row">
            <ChangeIdLabel id={m.change_id} />
            <span className="drm-missing">{m.missing.map(f => <span key={f} className="drm-chip">no {f}</span>)}</span>
            {m.created_by && <PersonChip name={m.created_by} />}
          </div>
        ))}
        {missing.length > 0 && <div className="drm-how">Set them in <b>Releases › Changes</b> (the pencil on the row), commit, then deploy again.</div>}
        {conflicts.map(c => (
          <div key={`${c.object}|${c.ours.change_id}|${c.theirs.change_id}`} className="drm-conflict" data-testid="deploy-refused-conflict">
            <div className="drm-conflict-head"><span className="drm-chip">{c.label}</span><code className="drm-object">{c.object}</code></div>
            <div className="drm-row">
              <ChangeIdLabel id={c.ours.change_id} />
              {c.ours.created_by && <PersonChip name={c.ours.created_by} />}
              <span className="drm-vs">vs</span>
              <ChangeIdLabel id={c.theirs.change_id} />
              {c.theirs.created_by && <PersonChip name={c.theirs.created_by} />}
            </div>
          </div>
        ))}
        {conflicts.length > 0 && <div className="drm-how">Deploying now would let the later change silently replace the earlier one. In <b>Releases › Conflicts</b>, Merge each one (it commits a merge change), then deploy again.</div>}
      </div>
    </ModalView>
  );
}
