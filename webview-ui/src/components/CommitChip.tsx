import { CheckCircleIcon } from '@salilvnair/dui';
import './CommitChip.css';

/** What a change card shows once its folder is committed: the hash, and whether it was pushed */
export type CommitChipInfo = { hash: string; where: string };

/** From a commitResult payload: pushed, local only (no git remote) or nothing new */
export function commitChipOf(p: { committed?: boolean; pushed?: boolean; commitHash?: string; note?: string } | undefined): CommitChipInfo {
  if (!p?.committed && !p?.pushed) return { hash: '', where: 'nothing new' };
  return { hash: String(p.commitHash ?? ''), where: p.pushed ? 'pushed' : p.note ? 'local only' : '' };
}

/** "Committed 475f704 | local only", in the Saved bar in place of the Commit button */
export function CommitChip({ info, title }: { info: CommitChipInfo | null; title?: string }) {
  return (
    <span className="commit-chip" title={title}>
      <CheckCircleIcon size={12} />{info?.hash ? <>Committed <code>{info.hash}</code></> : 'Committed'}
      {info?.where && <span className="commit-chip-where">{info.where}</span>}
    </span>
  );
}
