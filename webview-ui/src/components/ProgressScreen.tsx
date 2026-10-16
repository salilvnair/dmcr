import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircleIcon, FolderIcon, LayersIcon, ServerIcon, SparkleIcon, TestTubeIcon, XCircleIcon } from '@salilvnair/dui';
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
  const current = [...steps].reverse().find(s => s.state === 'run');
  const total = steps.length ? (running ? now : Math.max(...steps.map(s => s.startedAt + (s.ms ?? 0)))) - steps[0].startedAt : 0;

  return (
    <div className="progress-screen">
      <div className="prog-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
        </svg>
      </div>
      <div className="prog-bar" />
      <div className="prog-label">{current ? <>{current.label}{current.detail ? <span className="prog-label-detail"> · {current.detail}</span> : null}</> : message}</div>
      {steps.length > 0 && (
        <div className="prog-steps">
          <div className="prog-steps-head"><span>What is happening</span><span className="prog-steps-total">{secs(total)}</span></div>
          {steps.map(s => {
            const ms = s.state === 'run' ? now - s.startedAt : s.ms ?? 0;
            return (
              <div key={s.id} className={`prog-step prog-step--${s.state} prog-step--${s.kind}`}>
                <span className="prog-step-state">{s.state === 'run' ? <span className="prog-spin" /> : s.state === 'ok' ? <CheckCircleIcon size={13} /> : <XCircleIcon size={13} />}</span>
                <span className="prog-step-kind">{KIND[s.kind].icon}{KIND[s.kind].tag}</span>
                <span className="prog-step-text"><b>{s.label}</b>{s.detail ? <span className="prog-step-detail">{s.detail}</span> : null}</span>
                <span className={`prog-step-ms${ms > 15000 && s.state === 'run' ? ' prog-step-ms--slow' : ''}`}>{secs(ms)}</span>
              </div>
            );
          })}
        </div>
      )}
      {streamChunk && !steps.length && (
        <div className="prog-stream">{streamChunk.slice(-400)}</div>
      )}
    </div>
  );
}
