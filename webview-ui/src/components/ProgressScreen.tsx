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
};

const KIND: Record<Activity['kind'], { icon: ReactNode; tag: string }> = {
  mcp: { icon: <ServerIcon size={13} />, tag: 'MCP' },
  ai: { icon: <SparkleIcon size={13} />, tag: 'AI' },
  repo: { icon: <FolderIcon size={13} />, tag: 'LOOKUP' },
  check: { icon: <TestTubeIcon size={13} />, tag: 'TEST' },
  step: { icon: <LayersIcon size={13} />, tag: 'READ' },
};

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export default function ProgressScreen({ message, streamChunk, form }: Props) {
  const [steps, setSteps] = useState<Activity[]>([]);
  const [now, setNow] = useState(Date.now());
  // the finished steps fold into one row above the running one; open on demand
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: { form?: string; event?: Activity } };
      if (m?.type !== 'genActivity' || !m.payload?.event || (form && m.payload.form && m.payload.form !== form)) return;
      const ev = m.payload.event;
      setSteps(prev => { const i = prev.findIndex(x => x.id === ev.id); if (i < 0) return [...prev, ev]; const n = prev.slice(); n[i] = ev; return n; });
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [form]);
  // running steps count up
  const running = steps.some(s => s.state === 'run');
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, [running]);
  const total = steps.length ? (running ? now : Math.max(...steps.map(s => s.startedAt + (s.ms ?? 0)))) - steps[0].startedAt : 0;

  return (
    <div className="progress-screen">
      <div className="prog-icon">
        <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
        </svg>
      </div>
      {/* the icon, then the steps; the message only until the first step arrives */}
      {!steps.length && <div className="prog-label">{message}</div>}
      {steps.length > 0 && (() => {
        const done = steps.filter(x => x.state !== 'run');
        const live = steps.filter(x => x.state === 'run');
        const failed = done.filter(x => x.state === 'error').length;
        const row = (x: Activity) => {
          const ms = x.state === 'run' ? now - x.startedAt : x.ms ?? 0;
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
