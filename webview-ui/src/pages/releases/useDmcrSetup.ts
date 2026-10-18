import { useCallback, useEffect, useRef, useState } from 'react';
import { postMsg } from '../../vscode';

export type CaptureResult = { captureId: string; exitCode: number | null; data: Record<string, unknown> | unknown[] };

/** Runs a runner command for the caller only (dmcrCaptureResult), never in the Runner terminal. */
export function useRunnerCapture() {
  const waiting = useRef(new Map<string, (r: CaptureResult) => void>());
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.data?.type !== 'dmcrCaptureResult') return;
      const r = e.data.payload as CaptureResult;
      const done = waiting.current.get(r.captureId);
      if (done) { waiting.current.delete(r.captureId); done(r); }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  return useCallback((args: string[]) => new Promise<CaptureResult>(resolve => {
    const captureId = `setup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    waiting.current.set(captureId, resolve);
    postMsg({ type: 'runDmcr', payload: { args: [...args, '--json'], captureId } });
  }), []);
}

const message = (r: CaptureResult) => { const d = r.data as Record<string, unknown>; return String(d?.message ?? ''); };

/**
 * Can DMCR work yet? It needs the DBA name and every environment set up (dmcr registry + schema).
 * 'checking' until known; 'needed' shows the setup wizard instead of the tabs; 'ok' lets them through.
 */
export function useDmcrSetup() {
  const capture = useRunnerCapture();
  const [state, setState] = useState<'checking' | 'needed' | 'ok'>('checking');
  const [envs, setEnvs] = useState<string[]>([]);
  const [dbaName, setDbaName] = useState('');
  const seq = useRef(0);

  const check = useCallback(async (envList: string[], dba: string) => {
    const my = ++seq.current;
    if (!dba.trim()) { setState('needed'); return; }
    if (!envList.length) { setState('ok'); return; }
    const rs = await Promise.all(envList.map(e => capture(['status', '--env', e])));
    if (my !== seq.current) return;
    setState(rs.some(r => r.exitCode !== 0 && /registry not found/i.test(message(r))) ? 'needed' : 'ok');
  }, [capture]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.data?.type !== 'releaseData') return;
      const p = e.data.payload as { envs?: string[]; dbaName?: string; changesDir?: string; error?: string } | undefined;
      // no changes folder (or no workspace config yet): the wizard's Changes folder step fixes it
      if (!p || p.error || !p.changesDir) { setState(prev => (prev === 'ok' ? prev : 'needed')); return; }
      const list = Array.isArray(p.envs) ? p.envs : [];
      const dba = String(p.dbaName ?? '');
      setEnvs(list); setDbaName(dba);
      setState(prev => {
        // once set up, a later release data refresh does not send anyone back to the wizard
        if (prev === 'ok' && dba.trim()) return prev;
        void check(list, dba);
        return prev === 'ok' ? 'checking' : prev;
      });
    };
    window.addEventListener('message', on);
    postMsg({ type: 'getReleaseData' });
    return () => window.removeEventListener('message', on);
  }, [check]);

  const recheck = useCallback(() => { setState('checking'); postMsg({ type: 'getReleaseData' }); void check(envs, dbaName); }, [check, envs, dbaName]);
  return { state, envs, dbaName, capture, recheck, done: () => setState('ok') };
}
