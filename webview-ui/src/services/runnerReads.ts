/**
 * Read-only runner questions (status, release list, approvals) asked from several places at once — the setup check,
 * Releases, each environment — share one runner process: an identical question already on its way gets the same
 * answer, and an answer is reused for a few seconds. Each runner call starts PowerShell (or bash) and reads every
 * change folder, so asking the same thing ten times at startup made the page wait for all ten.
 * Anything that changes something (a deploy, an approval, a command in the Runner tab, Refresh) clears it.
 */
const TTL_MS = 5000;
type Entry<T> = { at: number; promise: Promise<T> };
const cache = new Map<string, Entry<unknown>>();

/** status / release list / approvals: answers that only change when something is run */
export function isRunnerRead(args: string[]): boolean {
  const [cmd, sub] = args;
  return cmd === 'status' || cmd === 'approvals' || (cmd === 'release' && (sub === 'list' || sub === undefined || sub.startsWith('--')));
}

/** Runs `run` once per identical read within TTL_MS; any other command clears the cache first. */
export function sharedRead<T>(args: string[], run: () => Promise<T>): Promise<T> {
  if (!isRunnerRead(args)) { cache.clear(); return run(); }
  const key = args.join('\u0001');
  const hit = cache.get(key) as Entry<T> | undefined;
  // still on its way (at = Infinity), or answered less than TTL_MS ago
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = run();
  const entry: Entry<T> = { at: Infinity, promise };
  cache.set(key, entry);
  // kept TTL_MS from the answer; a failed read is not kept: the next ask tries again
  promise.then(r => { if ((r as { exitCode?: number | null })?.exitCode !== 0) cache.delete(key); else entry.at = Date.now(); }, () => cache.delete(key));
  return promise;
}

/** Something changed (Refresh, a deploy, a Runner command): the next read asks the runner again. */
export function invalidateRunnerReads(): void {
  cache.clear();
}

// a command run in the Runner tab may change what is applied: forget the reads when it ends
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => { if (e.data?.type === 'terminalExit') cache.clear(); });
}
