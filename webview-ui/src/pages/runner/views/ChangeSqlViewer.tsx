import { useEffect, useMemo, useState } from 'react';
import { ModalView, SegmentedControlView, EditorView, LoaderView, EyeIcon, WarningTriangleIcon } from '@salilvnair/dui';
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

/** Read-only view of a change's files (deploy / verify / revert / meta.json), opened from the eye next to a change name. */
export function ChangeSqlViewer({ changeId, onClose }: { changeId: string; onClose: () => void }) {
  const requestId = useMemo(() => `cf-${changeId}-${Date.now()}`, [changeId]);
  const [state, setState] = useState<{ files?: Files; folder?: string; error?: string } | null>(null);
  const [tab, setTab] = useState<'deploy' | 'verify' | 'revert' | 'meta'>('deploy');

  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: { requestId?: string; files?: Files; folder?: string; error?: string } };
      if (m?.type === 'changeFiles' && m.payload?.requestId === requestId) setState({ files: m.payload.files, folder: m.payload.folder, error: m.payload.error });
    };
    window.addEventListener('message', h);
    postMsg({ type: 'readChangeFiles', payload: { changeId, requestId } });
    return () => window.removeEventListener('message', h);
  }, [changeId, requestId]);

  const tabs = TABS.filter(t => state?.files?.[t.value] != null);
  const current = TABS.find(t => t.value === tab)!;
  const text = state?.files?.[tab] ?? '';

  return (
    <ModalView open size="xxl" height="88vh" onClose={onClose} headerColor="#6366f1" headerIcon={<EyeIcon size={16} />}
      title={<span className="csv-title"><ChangeIdLabel id={changeId} noView /></span>}
      subtitle={state?.folder}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'hidden' }}>
      {!state ? <LoaderView variant="dots" label="Reading the change" center />
        : state.error ? <div className="csv-error"><WarningTriangleIcon size={15} /><span>{state.error}</span></div>
        : (
          <>
            <div className="csv-tabs">
              <SegmentedControlView size="sm" accentColor="#6366f1" value={tab} onChange={v => setTab(v as typeof tab)} options={tabs.map(t => ({ value: t.value, label: t.label }))} />
              <span className="csv-lines">{text.split('\n').length} lines</span>
            </div>
            <div className="csv-editor">
              <EditorView key={tab} value={text} language={current.lang} readOnly height="100%" fontSize={13} editorOptions={MONACO_OPTS} />
            </div>
          </>
        )}
    </ModalView>
  );
}
