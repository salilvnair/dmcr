import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ProgressBarView } from '@salilvnair/dui';
import './PageLoader.css';

/**
 * The Releases tab's loader for any page: a ring round the page's icon, what is being read, and a bar that
 * eases on while it waits. Shown until the page's data has arrived, so nothing renders empty and then jumps.
 */
export function PageLoader({ icon, title, sub }: { icon: ReactNode; title: string; sub?: string }) {
  const [started] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 120); return () => clearInterval(t); }, []);
  const elapsed = Date.now() - started;
  // no real steps to count: approach 95% (half way after ~0.6s)
  const pct = 95 * (1 - Math.exp(-elapsed / 900));
  return (
    <div className="pl-page" data-testid="page-loading">
      <div className="pl-loader">
        <span className="pl-ring"><span className="pl-glow" /><span className="pl-spin" />{icon}</span>
        <span className="pl-title">{title}</span>
        {sub && <span className="pl-sub">{sub}</span>}
        <span className="pl-bar"><ProgressBarView value={pct} size="xs" color="var(--bs-accent)" /></span>
        <span className="pl-pct">{(elapsed / 1000).toFixed(1)}s</span>
      </div>
    </div>
  );
}

/**
 * Waits for the page's first data messages (`wait`, by message type), showing PageLoader meanwhile.
 * The page is mounted (hidden) from the start, so its own requests go out as usual; after `timeoutMs`
 * it is shown anyway, so a missing answer can never leave a page stuck.
 */
export function LoadGate({ wait, icon, title, sub, timeoutMs = 8000, children }: {
  wait: string[]; icon: ReactNode; title: string; sub?: string; timeoutMs?: number; children: ReactNode;
}) {
  const seen = useRef(new Set<string>());
  const [ready, setReady] = useState(wait.length === 0);
  useEffect(() => {
    if (ready) return;
    const on = (e: MessageEvent) => {
      const t = (e.data as { type?: string })?.type;
      if (!t || !wait.includes(t)) return;
      seen.current.add(t);
      // one more frame so the page has applied the data before it shows
      if (wait.every(w => seen.current.has(w))) requestAnimationFrame(() => setReady(true));
    };
    window.addEventListener('message', on);
    const timer = setTimeout(() => setReady(true), timeoutMs);
    return () => { window.removeEventListener('message', on); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  return (
    <>
      {!ready && <PageLoader icon={icon} title={title} sub={sub} />}
      <div className="pl-content" hidden={!ready}>{children}</div>
    </>
  );
}
