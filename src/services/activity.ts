/**
 * What a generation is doing right now, step by step: MCP tool calls, AI requests, the definition lookup
 * and the self-check test run. The form handler sets a sink for the length of one generation; the code
 * that calls MCP / the AI reports into it, so the progress screen can list each step with its time.
 */
export type ActivityKind = 'mcp' | 'ai' | 'repo' | 'check' | 'step';
export type ActivityEvent = { id: number; kind: ActivityKind; label: string; detail?: string; state: 'run' | 'ok' | 'error'; startedAt: number; ms?: number };

let sink: ((e: ActivityEvent) => void) | null = null;
let aiLabel = 'AI';
let nextId = 1;

/** Runs `fn` with `onEvent` receiving every step; `ai` names the provider / model shown on AI steps. */
export async function withActivity<T>(onEvent: (e: ActivityEvent) => void, ai: string, fn: () => Promise<T>): Promise<T> {
  const prevSink = sink, prevAi = aiLabel;
  sink = onEvent; aiLabel = ai || 'AI';
  try { return await fn(); } finally { sink = prevSink; aiLabel = prevAi; }
}

/** Like withActivity, for code that can't be wrapped in one function: returns the restore. */
export function setActivitySink(onEvent: (e: ActivityEvent) => void, ai: string): () => void {
  const prevSink = sink, prevAi = aiLabel;
  sink = onEvent; aiLabel = ai || 'AI';
  return () => { sink = prevSink; aiLabel = prevAi; };
}

export type ActivityHandle ={ update: (detail: string) => void; end: (ok?: boolean, detail?: string) => void };

export function activityStart(kind: ActivityKind, label: string, detail?: string): ActivityHandle {
  const s = sink;
  if (!s) return { update: () => {}, end: () => {} };
  const ev: ActivityEvent = { id: nextId++, kind, label, detail, state: 'run', startedAt: Date.now() };
  s({ ...ev });
  let done = false;
  return {
    update: d => { if (!done) { ev.detail = d; s({ ...ev }); } },
    end: (ok = true, d) => { if (done) return; done = true; s({ ...ev, state: ok ? 'ok' : 'error', detail: d ?? ev.detail, ms: Date.now() - ev.startedAt }); },
  };
}

/** A step around a promise: started now, ended when it settles. */
export async function track<T>(kind: ActivityKind, label: string, detail: string | undefined, run: () => Promise<T>, doneDetail?: (v: T) => string | undefined): Promise<T> {
  const h = activityStart(kind, label, detail);
  try { const v = await run(); h.end(true, doneDetail?.(v)); return v; }
  catch (e) { h.end(false, e instanceof Error ? e.message.split('\n')[0].slice(0, 160) : String(e).slice(0, 160)); throw e; }
}

/**
 * An AI request: "<provider/model> · <purpose>", with the streamed size while it answers.
 * `run` gets a tick for each streamed piece of text (call it from the stream callback, if there is one).
 */
export async function trackAi<T>(purpose: string, run: (tick: (delta: string) => void) => Promise<T>): Promise<T> {
  const h = activityStart('ai', aiLabel, purpose);
  let chars = 0, last = 0;
  const tick = (d: string) => {
    chars += d.length;
    const now = Date.now();
    if (now - last > 300) { last = now; h.update(`${purpose} · ${chars.toLocaleString()} chars received`); }
  };
  try {
    const v = await run(tick);
    const n = chars || (typeof v === 'string' ? v.length : 0);
    h.end(true, `${purpose}${n ? ` · ${n.toLocaleString()} chars` : ''}`);
    return v;
  } catch (e) { h.end(false, `${purpose} · ${e instanceof Error ? e.message.split('\n')[0].slice(0, 140) : String(e).slice(0, 140)}`); throw e; }
}
