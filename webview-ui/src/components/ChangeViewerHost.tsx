import { useEffect, useState, type ReactNode } from 'react';
import { ChangeSqlViewer } from '../pages/runner/views/ChangeSqlViewer';

/**
 * Any change label opens its files (deploy / verify / revert / meta.json) the way the Releases tab does:
 * openChanges() from anywhere, one viewer mounted once at the app root.
 */
type Req = { ids: string[]; title?: ReactNode; file?: 'deploy' | 'verify' | 'revert' | 'meta' };
const listeners = new Set<(r: Req) => void>();

/** file: the one to show first (deploy.sql unless given), e.g. 'revert' from a revert DMCR will not run */
export function openChanges(ids: string[], title?: ReactNode, file?: Req['file']) {
  const list = ids.filter(Boolean);
  if (list.length) listeners.forEach(l => l({ ids: list, title, file }));
}

export function ChangeViewerHost() {
  const [req, setReq] = useState<Req | null>(null);
  useEffect(() => { const l = (r: Req) => setReq(r); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return req ? <ChangeSqlViewer changeIds={req.ids} title={req.title} file={req.file} onClose={() => setReq(null)} /> : null;
}
