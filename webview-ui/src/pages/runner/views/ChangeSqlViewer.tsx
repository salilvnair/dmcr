import { useEffect, useState, type ReactNode } from 'react';
import { ModalView, EditorView, LoaderView, WarningTriangleIcon, FolderIcon, FolderOpenIcon, ChevronRightIcon, ChevronDownIcon, FileIconView, CopyIcon, IconButtonView } from '@salilvnair/dui';
import { postMsg } from '../../../vscode';
import { ChangeIdLabel } from './ChangeIdLabel';
import './ChangeSqlViewer.css';

type FileKey = 'deploy' | 'verify' | 'revert' | 'meta';
type Files = Record<FileKey, string | null>;
type Loaded = { files?: Files; folder?: string; error?: string };
const FILES: { key: FileKey; name: string; lang: 'sql' | 'json' }[] = [
  { key: 'deploy', name: 'deploy.sql', lang: 'sql' },
  { key: 'verify', name: 'verify.sql', lang: 'sql' },
  { key: 'revert', name: 'revert.sql', lang: 'sql' },
  { key: 'meta', name: 'meta.json', lang: 'json' },
];
const MONACO_OPTS = { scrollbar: { vertical: 'hidden' as const, horizontal: 'hidden' as const, verticalScrollbarSize: 0, horizontalScrollbarSize: 0 }, wordWrap: 'on' as const, minimap: false, scrollBeyondLastLine: false };

/**
 * Read-only view of change files, laid out like VS Code: an explorer on the left (each change a folder with its
 * deploy / verify / revert / meta.json), the open file on the right in Monaco. Opened by clicking a change row
 * (one change) or a project row (all its changes).
 */
export function ChangeSqlViewer({ changeIds, title, onClose }: { changeIds: string[]; title?: ReactNode; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([changeIds[0]]));
  const [open, setOpen] = useState<{ id: string; file: FileKey }>({ id: changeIds[0], file: 'deploy' });

  // read each change's files once, when its folder is first expanded or opened
  const want = [...new Set([...expanded, open.id])].filter(id => !loaded[id]);
  useEffect(() => {
    if (!want.length) return;
    const stamp = Date.now();
    const pending = new Map(want.map(id => [`cf-${id}-${stamp}`, id]));
    const h = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: { requestId?: string; files?: Files; folder?: string; error?: string } };
      const id = m?.type === 'changeFiles' ? pending.get(m.payload?.requestId ?? '') : undefined;
      if (id) setLoaded(prev => ({ ...prev, [id]: { files: m.payload!.files, folder: m.payload!.folder, error: m.payload!.error } }));
    };
    window.addEventListener('message', h);
    pending.forEach((id, requestId) => postMsg({ type: 'readChangeFiles', payload: { changeId: id, requestId } }));
    return () => window.removeEventListener('message', h);
  }, [want.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => setExpanded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const cur = loaded[open.id];
  const meta = FILES.find(f => f.key === open.file)!;
  const text = cur?.files?.[open.file] ?? '';

  return (
    <ModalView open size="xxl" height="95vh" maxHeight="95vh" className="csv-modal" onClose={onClose} headerColor="var(--bs-accent)"
      title={<span className="csv-title">{title ?? <ChangeIdLabel id={changeIds[0]} static />}</span>}
      subtitle={cur?.folder}
      bodyStyle={{ display: 'flex', minHeight: 0, overflow: 'hidden', padding: 0 }}>
      <div className="csv-layout">
        <aside className="csv-explorer">
          <div className="csv-explorer-head">Explorer</div>
          <div className="csv-tree">
            {changeIds.map(id => {
              const isOpen = expanded.has(id);
              const l = loaded[id];
              return (
                <div key={id}>
                  <div className={`csv-node csv-node--folder${open.id === id ? ' is-current' : ''}`} onClick={() => toggle(id)} title={id}>
                    {isOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                    {isOpen ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />}
                    <ChangeIdLabel id={id} static />
                  </div>
                  {isOpen && (
                    !l ? <div className="csv-node csv-node--file csv-node--muted">reading…</div>
                      : l.error ? <div className="csv-node csv-node--file csv-node--bad">{l.error}</div>
                      : FILES.filter(f => l.files?.[f.key] != null).map(f => (
                        <div key={f.key} className={`csv-node csv-node--file${open.id === id && open.file === f.key ? ' is-active' : ''}`} onClick={() => setOpen({ id, file: f.key })}>
                          <FileIconView name={f.name} size="sm" />
                        </div>
                      ))
                  )}
                </div>
              );
            })}
          </div>
        </aside>
        <section className="csv-main">
          <div className="csv-tabbar">
            <span className="csv-tab"><FileIconView name={meta.name} size="sm" /></span>
            <span className="csv-crumbs">{open.id}<span>›</span>{meta.name}</span>
            <span className="csv-lines">{text ? `${text.split('\n').length} lines` : ''}</span>
            {text && <IconButtonView size="sm" variant="ghost" icon={<CopyIcon size={13} />} title="Copy" onClick={() => void navigator.clipboard?.writeText(text)} />}
          </div>
          <div className="csv-editor">
            {!cur ? <LoaderView variant="dots" label="Reading the change" center />
              : cur.error ? <div className="csv-error"><WarningTriangleIcon size={15} /><span>{cur.error}</span></div>
              : <EditorView key={`${open.id}-${open.file}`} value={text} language={meta.lang} readOnly height="100%" fontSize={13} editorOptions={MONACO_OPTS} />}
          </div>
        </section>
      </div>
    </ModalView>
  );
}
