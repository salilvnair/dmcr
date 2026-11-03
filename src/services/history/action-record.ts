/**
 * The action history kept in git: one small JSON file per action (a deploy, a rollback, a sign-off, a repair ...),
 * in .dmcr-history/<env>/ in the changes folder. Each is a copy of what dmcr.event_log recorded; DMCR never reads
 * them to decide what is applied. One file per action, so two DBAs never conflict, and the same action always gives
 * the same file. No VS Code imports (unit-tested in plain Node).
 */
import { redactText } from '../security/redact';

export const HISTORY_DIR = '.dmcr-history';

/** One row of `dmcr events`: event_at is UTC, 'YYYY-MM-DD HH:MM:SS' */
export type ActionEvent = {
  id: number; event_at: string; action: string; change_id: string; status: string;
  message?: string | null; actor?: string | null; duration_ms?: number | null; deploy_id?: string | null;
};

export type ActionRecord = {
  environment: string; action: string; status: 'success' | 'failure'; at: string; actor: string;
  deploy_id?: string; reason?: string;
  changes: { change_id: string; status: string; duration_ms?: number; message?: string }[];
};

export type ActionFile = { name: string; record: ActionRecord };

/**
 * What of a runner message may go to git: no password, no row values (PostgreSQL puts them in its DETAIL lines),
 * no folders of this machine (a file's name is enough), and not too long.
 */
const cleanMessage = (m?: string | null) => {
  const t = redactText(String(m ?? '').trim())
    .split(/\r?\n/).filter(l => !/^\s*(DETAIL|CONTEXT):/.test(l)).join('\n')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\s"'\\/]+[\\/])+([^\s"'\\/]+)/g, '$1');
  return t.length > 500 ? `${t.slice(0, 500)}...` : t;
};
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'all';

/** A run's events (one deploy_id) are one action; anything else is an action of its own. Oldest first. */
export function actionFiles(environment: string, events: ActionEvent[]): ActionFile[] {
  const groups = new Map<string, ActionEvent[]>();
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    const key = e.deploy_id ? `${e.action}:${e.deploy_id}` : `event:${e.id}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.values()].map(list => {
    const first = list[0];
    const at = `${first.event_at.replace(' ', 'T')}Z`;
    const which = first.deploy_id ? first.deploy_id.slice(0, 8) : `${safe(first.change_id)}-${first.id}`;
    const record: ActionRecord = {
      environment, action: first.action, status: list.some(e => e.status !== 'success') ? 'failure' : 'success',
      at, actor: first.actor ?? '',
      ...(first.deploy_id ? { deploy_id: first.deploy_id } : {}),
      changes: list.map(e => {
        const message = cleanMessage(e.message);
        return { change_id: e.change_id, status: e.status, ...(e.duration_ms != null ? { duration_ms: e.duration_ms } : {}), ...(message ? { message } : {}) };
      }),
    };
    return { name: `${at.replace(/:/g, '-')}_${safe(first.action)}_${which}.json`, record };
  });
}

/** The time of the newest file: what is older than a day before it is already in git */
export function sinceFor(fileNames: string[]): string {
  const newest = fileNames.map(n => /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}Z)_/.exec(n)).filter(Boolean)
    .map(m => `${m![1]}:${m![2]}:${m![3]}`).sort().pop();
  if (!newest) return '';
  return new Date(Date.parse(newest) - 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
}

/** A reason stays one line: it goes in the commit message */
export const cleanReason = (r: unknown) => redactText(String(r ?? '').replace(/\s+/g, ' ').trim()).slice(0, 300);

const ids = (r: ActionRecord) => {
  const list = [...new Set(r.changes.map(c => c.change_id))];
  return list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', ');
};

/** chore(dmcr): revert on prod: 002_b, 001_a (d1973349): the price label is wrong */
export function commitMessage(environment: string, records: ActionRecord[]): string {
  if (records.length !== 1) return `chore(dmcr): record ${records.length} actions on ${environment}`;
  const r = records[0];
  const failed = r.status === 'failure' ? ' failed' : '';
  const run = r.deploy_id ? ` (${r.deploy_id.slice(0, 8)})` : '';
  return `chore(dmcr): ${r.action}${failed} on ${environment}: ${ids(r)}${run}${r.reason ? `: ${r.reason}` : ''}`;
}
