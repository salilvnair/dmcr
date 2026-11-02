/**
 * What a deploy preview would be refused for, sorted out for the page. The runners report one message per
 * check: dmcr.ps1 with a line per problem, dmcr.sh all on one line ("BLOCKED by ...: >> a >> b").
 */

export type ProblemItem = { id: string; why?: string };
export type ProblemGroup = { key: string; title: string; items: ProblemItem[] };
export type PlanProblems = {
  groups: ProblemGroup[];
  /** per change, why it is refused: the red rows of the plan */
  reasons: Record<string, string>;
  /** the environment changes have to run on first, when that is what is wrong */
  runFirstOn: string;
};

const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;
const are = (n: number) => (n === 1 ? 'is' : 'are');
const have = (n: number) => (n === 1 ? 'has' : 'have');

export function parsePlanProblems(blocked: string[]): PlanProblems {
  const lines = blocked.flatMap(b => b.replace(/^[^\n]*?BLOCKED(?: by [^:]+)?:\s*/, '').split(/\s*>>\s*|\r?\n/)).map(s => s.trim()).filter(Boolean);
  const groups = new Map<string, { title: (n: number) => string; items: Map<string, string[]> }>();
  const reasons: Record<string, string[]> = {};
  let runFirstOn = '';
  const add = (key: string, title: (n: number) => string, id: string, why?: string, reason?: string) => {
    const g = groups.get(key) ?? { title, items: new Map<string, string[]>() };
    groups.set(key, g);
    const whys = g.items.get(id) ?? [];
    if (why) whys.push(why);
    g.items.set(id, whys);
    if (reason) (reasons[id] ??= []).push(reason);
  };
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = /^(\S+) is not applied in (\S+)$/.exec(line))) {
      const [, id, env] = m;
      runFirstOn ||= env;
      add(`missing:${env}`, n => `${changes(n)} ${are(n)} not applied in ${env}`, id, undefined, `not applied in ${env}`);
    } else if ((m = /^([^\s/]+)\/(\S+\.sql) differs from the one applied in (\S+)$/.exec(line))) {
      const [, id, file, env] = m;
      add(`differs:${env}`, n => `${changes(n)} ${have(n)} files that differ from ${env}`, id, file, `${file} differs from ${env}`);
    } else if ((m = /^(\S+) is out of order: (\S+) is already applied/.exec(line))) {
      add('order', n => `${changes(n)} ${are(n)} out of order`, m[1], `${m[2]} is already applied`, `out of order: ${m[2]} is already applied`);
    } else if ((m = /^(\S+) (requires \S+, which .*)$/.exec(line))) {
      add('requires', n => `${changes(n)} need${n === 1 ? 's' : ''} a change that is not in this deploy`, m[1], m[2], m[2]);
    } else if ((m = /^(\S+) is not approved for (\S+)/.exec(line))) {
      const [, id, env] = m;
      add(`signoff:${env}`, n => `${changes(n)} ${are(n)} not signed off for ${env}`, id, undefined, `not signed off for ${env}`);
    } else if ((m = /^(\S+) changed since (.+?) approved it/.exec(line))) {
      add('resign', n => `${changes(n)} changed after the sign-off`, m[1], `signed off by ${m[2]}`, `changed after ${m[2]} signed it off`);
    } else if ((m = /^applied change files edited since they were deployed: (.+?) \(checksum_policy=\w+\)$/.exec(line))) {
      for (const id of m[1].split(/[,\s]+/).filter(Boolean)) add('edited', n => `${changes(n)} already applied ${have(n)} been edited since`, id);
    } else {
      groups.set(`other:${line}`, { title: () => line, items: new Map() });
    }
  }
  return {
    groups: [...groups.entries()].map(([key, g]) => ({
      key, title: g.title(g.items.size),
      items: [...g.items.entries()].map(([id, whys]) => ({ id, why: whys.join(', ') || undefined })),
    })),
    reasons: Object.fromEntries(Object.entries(reasons).map(([id, r]) => [id, r.join('; ')])),
    runFirstOn,
  };
}
