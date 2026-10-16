import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownIcon, ArrowUpIcon, BranchIcon, ButtonView, CheckIcon, CheckboxView, ChevronDownIcon, CloudUploadIcon, CommitIcon,
  CopyIcon, DiffEditorView, FileTextIcon, FolderIcon, LoaderView, RefreshIcon, SearchInputView, SegmentedControlView,
  TextInputView, UndoIcon, WarningTriangleIcon,
} from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import { ChangeIdLabel } from '../runner/views/ChangeIdLabel';
import { openChanges } from '../../components/ChangeViewerHost';
import './CommitsPage.css';

type StatusFile = { path: string; status: string };
type Uncommitted = { changeId: string; files: StatusFile[] };
type Commit = {
  sha: string; short: string; author: string; email: string; date: string; subject: string; body: string;
  refs: string[]; parents: string[]; files: { path: string; status: string; adds: number; dels: number }[]; changeIds: string[];
};
type Overview = {
  repo: boolean; root?: string; changesRel?: string; branch?: string; branches?: string[]; upstream?: string;
  ahead?: number; behind?: number; remotes?: string[]; uncommitted?: Uncommitted[]; otherUncommitted?: StatusFile[];
  commits?: Commit[]; totalCommits?: number; canUndo?: boolean;
};
type DiffFile = { path: string; status: string; changeId?: string; before: string; after: string; binary?: boolean };
type Selection = { kind: 'commit'; sha: string } | { kind: 'work'; changeIds: string[] } | null;

const STATUS: Record<string, { label: string; cls: string }> = {
  A: { label: 'A', cls: 'add' }, M: { label: 'M', cls: 'mod' }, D: { label: 'D', cls: 'del' }, R: { label: 'R', cls: 'mod' },
};

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60, h = m / 60, d = h / 24;
  if (m < 60) return `${Math.floor(m)} min ago`;
  if (h < 24) return `${Math.floor(h)} h ago`;
  if (d < 30) return `${Math.floor(d)} day${Math.floor(d) === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}
function dayLabel(iso: string): string {
  const d = new Date(iso); const t = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (same(d, t)) return 'Today';
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}
const fileName = (p: string) => p.split('/').pop() ?? p;
const fileDir = (p: string) => p.split('/').slice(0, -1).join('/');
const lang = (p: string) => /\.sql$/i.test(p) ? 'sql' : /\.json$/i.test(p) ? 'json' : /\.(md|markdown)$/i.test(p) ? 'markdown' : /\.(ps1)$/i.test(p) ? 'powershell' : /\.sh$/i.test(p) ? 'shell' : 'plaintext';

/** The default commit message for these changes (add when all their files are new) */
function defaultMessage(items: Uncommitted[]): string {
  if (!items.length) return '';
  const allNew = items.every(i => i.files.every(f => f.status === 'A'));
  const verb = allNew ? 'add' : 'update';
  return items.length === 1 ? `feat(dmcr): ${verb} change ${items[0].changeId}` : `feat(dmcr): ${verb} changes ${items.map(i => i.changeId).join(', ')}`;
}

function Copy({ text, title }: { text: string; title?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="cm-copy" title={title ?? `Copy ${text}`} onClick={e => {
      e.stopPropagation();
      navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => undefined);
    }}>{done ? <CheckIcon size={12} /> : <CopyIcon size={12} />}</button>
  );
}

function FileStatus({ s }: { s: string }) {
  const st = STATUS[s] ?? STATUS.M;
  return <span className={`cm-fs cm-fs--${st.cls}`}>{st.label}</span>;
}

export default function CommitsPage(_props: { isDark?: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Selection>(null);
  const [diff, setDiff] = useState<{ key: string; files: DiffFile[] } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [file, setFile] = useState('');
  const [layout, setLayout] = useState<'side' | 'inline'>('side');
  const [query, setQuery] = useState('');
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [messageEdited, setMessageEdited] = useState(false);
  const [busy, setBusy] = useState<'' | 'commit' | 'undo' | 'push' | 'branch'>('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const diffKey = useRef('');

  const refresh = useCallback(() => { setLoading(true); postMsg({ type: 'gitOverview', payload: { limit: 300 } }); }, []);

  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data; if (!m?.type) return;
      if (m.type === 'gitOverview') {
        if (m.payload?.uncommittedOnly) return;   // the Releases tab's banner asked
        const o = m.payload as Overview;
        setData(o); setLoading(false);
        const ids = (o.uncommitted ?? []).map(u => u.changeId);
        setPicked(prev => { const keep = prev.filter(id => ids.includes(id)); return keep.length || !ids.length ? keep : ids; });
        setSel(prev => {
          if (prev?.kind === 'commit' && (o.commits ?? []).some(c => c.sha === prev.sha)) return prev;
          if (prev?.kind === 'work' && prev.changeIds.every(id => ids.includes(id))) return prev;
          return ids.length ? { kind: 'work', changeIds: ids } : o.commits?.[0] ? { kind: 'commit', sha: o.commits[0].sha } : null;
        });
      }
      if (m.type === 'gitCommitDiff' || m.type === 'gitWorkingDiff') {
        const key = m.type === 'gitCommitDiff' ? `c:${m.payload?.sha}` : `w:${(m.payload?.changeIds ?? []).join(',')}`;
        if (key !== diffKey.current) return;
        setDiffLoading(false);
        if (!m.payload?.ok) { setDiff({ key, files: [] }); return; }
        const files = m.payload.files as DiffFile[];
        setDiff({ key, files });
        setFile(f => files.some(x => x.path === f) ? f : (files.find(x => /deploy\.sql$/.test(x.path)) ?? files[0])?.path ?? '');
      }
      if (m.type === 'gitCommitted') {
        if (m.payload?.from === 'banner') { refresh(); return; }
        setBusy('');
        if (m.payload?.ok) { setNote({ ok: true, text: `Committed ${m.payload.hash}: ${m.payload.message}` }); setMessageEdited(false); setSel(null); }
        else setNote({ ok: false, text: m.payload?.error ?? 'Commit failed' });
        refresh();
      }
      if (m.type === 'gitUndone') {
        setBusy(''); setConfirmUndo(false);
        setNote(m.payload?.ok ? { ok: true, text: `Undid ${m.payload.sha}: its files are back under Not committed` } : { ok: false, text: m.payload?.error ?? 'Undo failed' });
        setSel(null); refresh();
      }
      if (m.type === 'gitPushed') {
        setBusy('');
        setNote(m.payload?.ok ? { ok: true, text: `Pushed ${m.payload.branch}` } : { ok: false, text: m.payload?.error ?? 'Push failed' });
        refresh();
      }
      if (m.type === 'gitBranchSwitched') {
        setBusy('');
        setNote({ ok: !!m.payload?.ok, text: m.payload?.message ?? '' });
        setSel(null); refresh();
      }
    };
    window.addEventListener('message', h);
    refresh();
    return () => window.removeEventListener('message', h);
  }, [refresh]);

  // the diff of what is selected
  useEffect(() => {
    if (!sel) { setDiff(null); diffKey.current = ''; return; }
    const key = sel.kind === 'commit' ? `c:${sel.sha}` : `w:${sel.changeIds.join(',')}`;
    if (key === diffKey.current && diff?.key === key) return;
    diffKey.current = key; setDiffLoading(true);
    postMsg(sel.kind === 'commit' ? { type: 'gitCommitDiff', payload: { sha: sel.sha } } : { type: 'gitWorkingDiff', payload: { changeIds: sel.changeIds } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, data]);

  const uncommitted = data?.uncommitted ?? [];
  const pickedItems = uncommitted.filter(u => picked.includes(u.changeId));
  useEffect(() => { if (!messageEdited) setMessage(defaultMessage(pickedItems)); }, [picked.join(','), uncommitted.length, messageEdited]); // eslint-disable-line react-hooks/exhaustive-deps

  const commits = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.commits ?? []).filter(c =>
      (!onlyChanges || c.changeIds.length) &&
      (!q || c.subject.toLowerCase().includes(q) || c.sha.startsWith(q) || c.author.toLowerCase().includes(q) || c.changeIds.some(id => id.toLowerCase().includes(q))));
  }, [data, query, onlyChanges]);

  const selCommit = sel?.kind === 'commit' ? data?.commits?.find(c => c.sha === sel.sha) : undefined;
  const head = data?.commits?.[0];
  const files = diff?.files ?? [];
  const cur = files.find(f => f.path === file);
  // a new or deleted file has one side only: inline, so it gets the whole width
  const oneSided = !!cur && (!cur.before || !cur.after);
  const sideBySide = layout === 'side' && !oneSided;
  const changeIdsInSel = sel?.kind === 'commit' ? selCommit?.changeIds ?? [] : sel?.kind === 'work' ? sel.changeIds : [];

  const commit = () => {
    if (!pickedItems.length || !message.trim()) return;
    setBusy('commit'); setNote(null);
    postMsg({ type: 'gitCommitChanges', payload: { changeIds: pickedItems.map(p => p.changeId), message: message.trim() } });
  };

  if (!data && loading) return <div className="cm-root cm-center"><LoaderView variant="spinner" size="md" /></div>;
  if (data && !data.repo) {
    return (
      <div className="cm-root cm-center">
        <div className="cm-empty"><WarningTriangleIcon size={18} /><div><b>The changes folder is not in a git repository</b><span>Commits show up here once it is.</span></div></div>
      </div>
    );
  }

  let lastDay = '';
  return (
    <div className="cm-root" data-testid="commits-page">
      {/* header: branch, sync state, search */}
      <div className="cm-head">
        <div className="cm-title"><CommitIcon size={16} />Commits</div>
        <div className="cm-branch-wrap">
          <button type="button" className={`cm-branch${branchOpen ? ' is-open' : ''}`} onClick={() => setBranchOpen(o => !o)} title="Switch branch">
            <BranchIcon size={12} /><span>{data?.branch}</span><ChevronDownIcon size={11} className="cm-chev" />
          </button>
          {branchOpen && (
            <div className="cm-branch-menu" onMouseLeave={() => setBranchOpen(false)}>
              {(data?.branches ?? []).map(b => (
                <button key={b} type="button" className={`cm-branch-item${b === data?.branch ? ' is-current' : ''}`} disabled={b === data?.branch}
                  onClick={() => { setBranchOpen(false); setBusy('branch'); postMsg({ type: 'switchGitBranch', payload: { branch: b } }); }}>
                  <BranchIcon size={11} />{b}{b === data?.branch && <CheckIcon size={11} />}
                </button>
              ))}
            </div>
          )}
        </div>
        {data?.upstream
          ? <span className="cm-sync" title={`Tracking ${data.upstream}`}><ArrowUpIcon size={11} />{data.ahead}<ArrowDownIcon size={11} />{data.behind}<span className="cm-sync-up">{data.upstream}</span></span>
          : <span className="cm-sync cm-sync--local" title="No remote branch: commits stay on this machine">local only</span>}
        <span className="cm-stat"><b>{data?.totalCommits ?? 0}</b> commits</span>
        {uncommitted.length > 0 && <span className="cm-stat cm-stat--warn"><b>{uncommitted.length}</b> not committed</span>}
        <span className="cm-path" title={data?.root}><FolderIcon size={11} />{data?.root}{data?.changesRel ? <em>/{data.changesRel}</em> : null}</span>
        <span className="cm-grow" />
        {!!data?.remotes?.length && (
          <ButtonView variant="ghost" iconLeft={<CloudUploadIcon size={13} />} label={busy === 'push' ? 'Pushing…' : `Push${data.ahead ? ` (${data.ahead})` : ''}`} disabled={!!busy}
            onClick={() => { setBusy('push'); setNote(null); postMsg({ type: 'gitPush' }); }} />
        )}
        <ButtonView variant="ghost" iconLeft={<RefreshIcon size={13} />} label="Refresh" onClick={refresh} />
      </div>

      {note && <div className={`cm-note${note.ok ? ' is-ok' : ' is-err'}`}>{note.ok ? <CheckIcon size={13} /> : <WarningTriangleIcon size={13} />}<span>{note.text}</span><button type="button" onClick={() => setNote(null)}>×</button></div>}

      <div className="cm-body">
        {/* left: not committed + history */}
        <div className="cm-left">
          {uncommitted.length > 0 && (
            <section className="cm-work">
              <div className="cm-work-head">
                <span className="cm-pulse" />
                <b>Not committed</b>
                <span className="cm-muted">{uncommitted.length} change{uncommitted.length === 1 ? '' : 's'} saved, not in git yet</span>
                <span className="cm-grow" />
                <button type="button" className="cm-link" onClick={() => setPicked(picked.length === uncommitted.length ? [] : uncommitted.map(u => u.changeId))}>{picked.length === uncommitted.length ? 'None' : 'All'}</button>
              </div>
              <ul className="cm-work-list">
                {uncommitted.map(u => {
                  const on = picked.includes(u.changeId);
                  const active = sel?.kind === 'work' && sel.changeIds.length === 1 && sel.changeIds[0] === u.changeId;
                  return (
                    <li key={u.changeId} className={`cm-work-row${active ? ' is-active' : ''}`} onClick={() => setSel({ kind: 'work', changeIds: [u.changeId] })}>
                      <span onClick={e => e.stopPropagation()}><CheckboxView size="sm" checked={on} accentColor="var(--dm-c-f59e0b)" onChange={c => setPicked(p => c ? [...p, u.changeId] : p.filter(x => x !== u.changeId))} /></span>
                      <FolderIcon size={13} className="cm-folder" />
                      <ChangeIdLabel id={u.changeId} static />
                      <span className="cm-grow" />
                      <span className="cm-files-mini">{['A', 'M', 'D'].map(s => { const n = u.files.filter(f => f.status === s || (s === 'M' && f.status === 'R')).length; return n ? <span key={s} className={`cm-mini cm-mini--${STATUS[s].cls}`}>{s}{n}</span> : null; })}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="cm-compose">
                <TextInputView size="md" width="fullWidth" value={message} placeholder="Commit message"
                  onChange={e => { setMessage(e.target.value); setMessageEdited(true); }}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(); }} />
                <div className="cm-compose-row">
                  <button type="button" className="cm-link" onClick={() => setSel({ kind: 'work', changeIds: picked.length ? picked : uncommitted.map(u => u.changeId) })}>Review all picked</button>
                  <span className="cm-grow" />
                  <ButtonView variant="primary" iconLeft={<CommitIcon size={13} />} disabled={!pickedItems.length || !message.trim() || !!busy}
                    label={busy === 'commit' ? 'Committing…' : `Commit ${pickedItems.length || ''} change${pickedItems.length === 1 ? '' : 's'}`} onClick={commit} />
                </div>
              </div>
            </section>
          )}
          {(data?.otherUncommitted?.length ?? 0) > 0 && (
            <div className="cm-other" title={(data?.otherUncommitted ?? []).map(f => f.path).join('\n')}>
              <WarningTriangleIcon size={12} />{data?.otherUncommitted?.length} other file{data?.otherUncommitted?.length === 1 ? '' : 's'} outside the change folders not committed (DMCR leaves those alone)
            </div>
          )}

          <div className="cm-tools">
            <SearchInputView size="md" value={query} onChange={setQuery} placeholder="Search message, sha, author or change" style={{ flex: 1 }} />
            <span className="cm-only"><CheckboxView size="sm" checked={onlyChanges} onChange={setOnlyChanges} label="Changes only" /></span>
          </div>

          <ol className="cm-log">
            {commits.map((c, i) => {
              const day = dayLabel(c.date);
              const showDay = day !== lastDay; lastDay = day;
              const adds = c.files.reduce((s, f) => s + f.adds, 0), dels = c.files.reduce((s, f) => s + f.dels, 0);
              const active = sel?.kind === 'commit' && sel.sha === c.sha;
              const isHead = c.sha === head?.sha;
              return (
                <li key={c.sha} className="cm-log-item">
                  {showDay && <div className="cm-day">{day}</div>}
                  <div className={`cm-commit${active ? ' is-active' : ''}${c.parents.length > 1 ? ' is-merge' : ''}`} onClick={() => setSel({ kind: 'commit', sha: c.sha })}>
                    <span className="cm-rail"><span className="cm-dot" />{i < commits.length - 1 && <span className="cm-line" />}</span>
                    <div className="cm-commit-main">
                      <div className="cm-commit-top">
                        <span className="cm-subject">{c.subject}</span>
                      </div>
                      <div className="cm-commit-meta">
                        <span className="cm-sha">{c.short}</span>
                        {isHead && <span className="cm-ref cm-ref--head">HEAD</span>}
                        {c.refs.filter(r => !r.startsWith('HEAD')).slice(0, 2).map(r => <span key={r} className="cm-ref">{r.replace('tag: ', '#')}</span>)}
                        <span className="cm-author">{c.author}</span>
                        <span className="cm-when" title={new Date(c.date).toLocaleString()}>{ago(c.date)}</span>
                        <span className="cm-grow" />
                        {(adds > 0 || dels > 0) && <span className="cm-delta"><em>+{adds}</em><i>−{dels}</i></span>}
                      </div>
                      {c.changeIds.length > 0 && (
                        <div className="cm-commit-changes">
                          {c.changeIds.slice(0, 4).map(id => <span key={id} className="cm-chg"><ChangeIdLabel id={id} static /></span>)}
                          {c.changeIds.length > 4 && <span className="cm-more">+{c.changeIds.length - 4}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
            {!commits.length && <li className="cm-muted cm-pad">{query || onlyChanges ? 'No commit matches.' : 'No commits yet.'}</li>}
          </ol>
        </div>

        {/* right: what is selected, file by file */}
        <div className="cm-right">
          {!sel && <div className="cm-center"><div className="cm-empty"><CommitIcon size={18} /><div><b>Pick a commit or a change</b><span>Its files and their diffs show here.</span></div></div></div>}

          {sel?.kind === 'commit' && selCommit && (
            <div className="cm-detail-head">
              <div className="cm-detail-title">{selCommit.subject}</div>
              {selCommit.body && <pre className="cm-detail-body">{selCommit.body}</pre>}
              <div className="cm-detail-meta">
                <span className="cm-sha cm-sha--big">{selCommit.short}</span><Copy text={selCommit.sha} title="Copy the full commit id" />
                <span className="cm-avatar">{selCommit.author.slice(0, 1).toUpperCase()}</span>
                <span className="cm-author-big">{selCommit.author}</span>
                <span className="cm-when" title={selCommit.date}>{new Date(selCommit.date).toLocaleString()}</span>
                {selCommit.parents[0] && <span className="cm-parent">parent <code>{selCommit.parents[0].slice(0, 7)}</code></span>}
                <span className="cm-grow" />
                {selCommit.sha === head?.sha && data?.canUndo && (
                  confirmUndo
                    ? <span className="cm-confirm">Undo this commit? Its files go back to Not committed.
                        <ButtonView variant="danger" label={busy === 'undo' ? 'Undoing…' : 'Undo'} disabled={!!busy} onClick={() => { setBusy('undo'); postMsg({ type: 'gitUndoLastCommit', payload: { sha: selCommit.sha } }); }} />
                        <ButtonView variant="ghost" label="Keep" onClick={() => setConfirmUndo(false)} /></span>
                    : <ButtonView variant="ghost" iconLeft={<UndoIcon size={13} />} label="Undo commit" title="Not pushed yet: undo it and keep its files as not committed" onClick={() => setConfirmUndo(true)} />
                )}
              </div>
            </div>
          )}
          {sel?.kind === 'work' && (
            <div className="cm-detail-head cm-detail-head--work">
              <div className="cm-detail-title"><span className="cm-pulse" />Not committed</div>
              <div className="cm-detail-meta">
                <span className="cm-muted">Saved on disk, compared with the last commit</span>
                <span className="cm-grow" />
                {sel.changeIds.length === 1 && !picked.includes(sel.changeIds[0]) && <ButtonView variant="ghost" label="Pick for commit" onClick={() => setPicked(p => [...p, sel.changeIds[0]])} />}
              </div>
            </div>
          )}

          {sel && changeIdsInSel.length > 0 && (
            <div className="cm-detail-changes">
              {changeIdsInSel.map(id => <span key={id} className="cm-chg"><ChangeIdLabel id={id} /></span>)}
              <button type="button" className="cm-link" onClick={() => openChanges(changeIdsInSel, `${changeIdsInSel.length} change${changeIdsInSel.length === 1 ? '' : 's'}`)}>Open the change files</button>
            </div>
          )}

          {sel && (
            <div className="cm-diff">
              <div className="cm-files">
                <div className="cm-files-head">{files.length} file{files.length === 1 ? '' : 's'}</div>
                {diffLoading && !files.length && <div className="cm-pad"><LoaderView variant="spinner" size="sm" /></div>}
                {files.map(f => {
                  const st = selCommit?.files.find(x => x.path === f.path);
                  return (
                    <button key={f.path} type="button" className={`cm-file${f.path === file ? ' is-active' : ''}`} onClick={() => setFile(f.path)} title={f.path}>
                      <FileStatus s={f.status} />
                      <FileTextIcon size={12} className="cm-file-ico" />
                      <span className="cm-file-name">{fileName(f.path)}</span>
                      <span className="cm-file-dir">{f.changeId || fileDir(f.path)}</span>
                      {st && (st.adds > 0 || st.dels > 0) && <span className="cm-delta cm-delta--sm"><em>+{st.adds}</em><i>−{st.dels}</i></span>}
                    </button>
                  );
                })}
              </div>
              <div className="cm-editor">
                {cur && (
                  <div className="cm-editor-head">
                    <FileStatus s={cur.status} />
                    <code className="cm-editor-path">{cur.path}</code>
                    <Copy text={cur.path} title="Copy the path" />
                    <span className="cm-grow" />
                    {oneSided && <span className="cm-muted">{cur.before ? 'deleted file' : 'new file'}</span>}
                    {!oneSided && <SegmentedControlView size="md" variant="rounded" value={layout} onChange={v => setLayout(v as 'side' | 'inline')}
                      options={[{ value: 'side', label: 'Side by side' }, { value: 'inline', label: 'Inline' }]} />}
                  </div>
                )}
                <div className="cm-editor-body">
                  {cur?.binary && <div className="cm-pad cm-muted">Binary file: no text diff.</div>}
                  {cur && !cur.binary && (
                    <DiffEditorView key={`${diff?.key}:${cur.path}:${sideBySide}`} original={cur.before} modified={cur.after} language={lang(cur.path)}
                      readOnly renderSideBySide={sideBySide} wordWrap height="100%" fontSize={12} />
                  )}
                  {!cur && !diffLoading && <div className="cm-pad cm-muted">No file changes.</div>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {busy === 'branch' && <div className="cm-busy"><LoaderView variant="spinner" size="sm" /></div>}
    </div>
  );
}
