import { useEffect, useState, type ReactNode } from 'react';
import { ModalView, SegmentedControlView, EditorView, LoaderView, WarningTriangleIcon } from '@salilvnair/dui';
import { postMsg } from '../../../vscode';
import { ChangeIdLabel } from './ChangeIdLabel';
import './ChangeSqlViewer.css';

type Files = { deploy: string | null; verify: string | null; revert: string | null; meta: string | null };
const TABS = [
  { value: 'deploy', label: 'deploy.sql', lang: 'sql' },
  { value: 'verify', label: 'verify.sql', lang: 'sql' },
  { value: 'revert', label: 'revert.sql', lang: 'sql' },
  { value: 'meta', label: 'meta.json', lang: 'json' },
] as const;
const MONACO_OPTS = { scrollbar: { vertical: 'hidden' as const, horizontal: 'hidden' as const, verticalScrollbarSize: 0, horizontalScrollbarSize: 0 }, wordWrap: 'on' as const, minimap: false, scrollBeyondLastLine: false };

/**
 * Read-only view of a change's files (deploy / verify / revert / meta.json). Opened by clicking a change row,
 * or a project row (then `changeIds` holds the project's changes and a picker switches between them).
 */
export function ChangeSqlViewer({ changeIds, title, onClose }: { changeIds: string[]; title?: ReactNode; onClose: () => void }) {
  const [current, setCurrent] = useState(changeIds[0]);
  const [state, setState] = useState<{ id: string; files?: Files; folder?: string; error?: string } | null>(null);
  const [tab, setTab] = useState<'deploy' | 'verify' | 'revert' | 'meta'>('deploy');

  useEffect(() => {
    if (!current) return;
    const requestId = `cf-${current}-${Date.now()}`;
    const h = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: { requestId?: string; files?: Files; folder?: string; error?: string } };
      if (m?.type === 'changeFiles' && m.payload?.requestId === requestId) setState({ id: current, files: m.payload.files, folder: m.payload.folder, error: m.payload.error });
    };
    window.addEventListener('message', h);
    postMsg({ type: 'readChangeFiles', payload: { changeId: current, requestId } });
    return () => window.removeEventListener('message', h);
  }, [current]);

  const ready = state?.id === current ? state : null;
  const tabs = TABS.filter(t => ready?.files?.[t.value] != null);
  const lang = TABS.find(t => t.value === tab)!.lang;
  const text = ready?.files?.[tab] ?? '';

  return (
    <ModalView open size="xxl" height="88vh" onClose={onClose} headerColor="#6366f1"
      title={<span className="csv-title">{title ?? <ChangeIdLabel id={current} />}</span>}
      subtitle={ready?.folder}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'hidden' }}>
      {changeIds.length > 1 && (
        <div className="csv-picker">
          <SegmentedControlView size="sm" accentColor="#22c55e" value={current} onChange={v => setCurrent(String(v))} options={changeIds.map(id => ({ value: id, label: id }))} />
        </div>
      )}
      {!ready ? <LoaderView variant="dots" label="Reading the change" center />
        : ready.error ? <div className="csv-error"><WarningTriangleIcon size={15} /><span>{ready.error}</span></div>
        : (
          <>
            <div className="csv-tabs">
              <SegmentedControlView size="sm" accentColor="#6366f1" value={tab} onChange={v => setTab(v as typeof tab)} options={tabs.map(t => ({ value: t.value, label: t.label }))} />
              <span className="csv-lines">{text.split('\n').length} lines</span>
            </div>
            <div className="csv-editor">
              <EditorView key={`${current}-${tab}`} value={text} language={lang} readOnly height="100%" fontSize={13} editorOptions={MONACO_OPTS} />
            </div>
          </>
        )}
    </ModalView>
  );
}
