import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, FolderIcon, LayersIcon, ServerIcon, SparkleIcon, TestTubeIcon, XCircleIcon } from '@salilvnair/dui';
import './ProgressScreen.css';

/** One step of a generation (src/services/activity.ts): MCP tool call, AI request, lookup, self-check */
type Activity = { id: number; kind: 'mcp' | 'ai' | 'repo' | 'check' | 'step'; label: string; detail?: string; state: 'run' | 'ok' | 'error'; startedAt: number; ms?: number };

type Props = {
  message: string;
  streamChunk?: string;
  /** the form this screen belongs to: its generation steps are listed live */
  form?: string;
  /** inside a chat bubble (the Assistant): no big icon, no full-height centring */
  compact?: boolean;
};

const KIND: Record<Activity['kind'], { icon: ReactNode; tag: string }> = {
  mcp: { icon: <ServerIcon size={13} />, tag: 'MCP' },
  ai: { icon: <SparkleIcon size={13} />, tag: 'AI' },
  repo: { icon: <FolderIcon size={13} />, tag: 'LOOKUP' },
  check: { icon: <TestTubeIcon size={13} />, tag: 'TEST' },
  step: { icon: <LayersIcon size={13} />, tag: 'READ' },
};

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/*
 * The steps live here, not in the screen: the Assistant re-creates its in-progress bubble whenever the status
 * text changes ("… refining your change"), and a screen that kept them itself started empty and lost the step
 * already running. A form's screen starts its own list when it mounts; the Assistant's list starts over when
 * the server says a new message began ({ reset: true }).
 */
const stepStore = new Map<string, Activity[]>();
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { type?: string; payload?: { form?: string; event?: Activity; reset?: boolean } };
    if (m?.type !== 'genActivity' || !m.payload) return;
    const key = m.payload.form ?? '';
    if (m.payload.reset) stepStore.set(key, []);
    const ev = m.payload.event;
    if (ev) {
      const prev = stepStore.get(key) ?? [];
      const i = prev.findIndex(x => x.id === ev.id);
      stepStore.set(key, i < 0 ? [...prev, ev] : prev.map((x, k) => (k === i ? ev : x)));
    }
    listeners.forEach(l => l());
  });
}

export default function ProgressScreen({ message, streamChunk, form, compact }: Props) {
  const key = form ?? '';
  const [steps, setSteps] = useState<Activity[]>(() => {
    if (!compact) stepStore.set(key, []);   // a form's generation starts with this screen
    return stepStore.get(key) ?? [];
  });
  const [now, setNow] = useState(Date.now());
  // the finished steps fold into one row above the running one; open on demand
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    const on = () => { setNow(Date.now()); setSteps(stepStore.get(key) ?? []); };
    listeners.add(on);
    on();
    return () => { listeners.delete(on); };
  }, [key]);
  // running steps count up
  const running = steps.some(s => s.state === 'run');
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, [running]);
  const total = steps.length ? (running ? now : Math.max(...steps.map(s => s.startedAt + (s.ms ?? 0)))) - steps[0].startedAt : 0;

  return (
    <div className={`progress-screen${compact ? ' progress-screen--compact' : ''}`}>
      {compact && !steps.length && <div className="prog-compact-wait"><span className="prog-spin" /><span>{message}</span></div>}
      {!compact && <div className="prog-icon">
        <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
        </svg>
      </div>}
      {/* the icon, then the steps; the message only until the first step arrives */}
      {!compact && !steps.length && <div className="prog-label">{message}</div>}
      {steps.length > 0 && (() => {
        const done = steps.filter(x => x.state !== 'run');
        const live = steps.filter(x => x.state === 'run');
        const failed = done.filter(x => x.state === 'error').length;
        const row = (x: Activity) => {
          const ms = x.state === 'run' ? Math.max(0, now - x.startedAt) : x.ms ?? 0;  // a step that just came in starts at 0, never below
          return (
            <div key={x.id} className={`prog-step prog-step--${x.state} prog-step--${x.kind}`}>
              <span className="prog-step-state">{x.state === 'run' ? <span className="prog-spin" /> : x.state === 'ok' ? <CheckCircleIcon size={13} /> : <XCircleIcon size={13} />}</span>
              <span className="prog-step-kind">{KIND[x.kind].icon}{KIND[x.kind].tag}</span>
              <span className="prog-step-text"><b>{x.label}</b>{x.detail ? <span className="prog-step-detail">{x.detail}</span> : null}</span>
              <span className={`prog-step-ms${ms > 15000 && x.state === 'run' ? ' prog-step-ms--slow' : ''}`}>{secs(ms)}</span>
            </div>
          );
        };
        return (
          <div className="prog-steps">
            {done.length > 0 && (
              <>
                <button type="button" className="prog-done-toggle" onClick={() => setShowDone(v => !v)} aria-expanded={showDone}>
                  {showDone ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                  <span>{done.length} step{done.length !== 1 ? 's' : ''} done</span>
                  <span className="prog-done-kinds">
                    {(['mcp', 'step', 'repo', 'ai', 'check'] as const).map(k => { const n = done.filter(x => x.kind === k).length; return n ? <span key={k} className={`prog-done-kind prog-step--${k}`}>{n} {KIND[k].tag}</span> : null; })}
                    {failed > 0 && <span className="prog-done-failed">{failed} failed</span>}
                  </span>
                  <span className="prog-steps-total">{secs(total)}</span>
                </button>
                {showDone && <div className="prog-done-list">{done.map(row)}</div>}
              </>
            )}
            {live.map(row)}
          </div>
        );
      })()}
      {streamChunk && !steps.length && (
        <div className="prog-stream">{streamChunk.slice(-400)}</div>
      )}
    </div>
  );
}
