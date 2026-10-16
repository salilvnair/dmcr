import { useEffect, useState, type ReactNode } from 'react';
import { ChangeSqlViewer } from '../pages/runner/views/ChangeSqlViewer';

/**
 * Any change label opens its files (deploy / verify / revert / meta.json) the way the Releases tab does:
 * openChanges() from anywhere, one viewer mounted once at the app root.
 */
type Req = { ids: string[]; title?: ReactNode };
const listeners = new Set<(r: Req) => void>();

export function openChanges(ids: string[], title?: ReactNode) {
  const list = ids.filter(Boolean);
  if (list.length) listeners.forEach(l => l({ ids: list, title }));
}

export function ChangeViewerHost() {
  const [req, setReq] = useState<Req | null>(null);
  useEffect(() => { const l = (r: Req) => setReq(r); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return req ? <ChangeSqlViewer changeIds={req.ids} title={req.title} onClose={() => setReq(null)} /> : null;
}
