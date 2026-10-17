import { useEffect, useRef, useState } from 'react';
import {
  ModalView, ButtonView, RadioCardView, TextInputView, SelectInputView, CheckboxView, SegmentedControlView, EditorView, ChipView, LoaderView,
  SplitVerticalIcon, CheckCircleIcon, WarningTriangleIcon,
} from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import { LockLintChip, type LintFinding } from '../../components/LockLint';
import { ChangeIdLabel } from '../runner/views/ChangeIdLabel';
import './ZeroDowntime.css';

type Pattern = 'dual-write' | 'not-null' | 'foreign-key' | 'index';
type Phase = { phase: 'expand' | 'contract' | 'single'; changeName: string; kind: string; deploySql: string; verifySql: string; revertSql: string; next?: string; lint?: LintFinding[] };
type Project = { id: string; name?: string; status?: string };

const PATTERNS: { value: Pattern; label: string; description: string }[] = [
  { value: 'dual-write', label: 'Rename / change type', description: 'New column, backfill, both kept in sync; drop the old one later' },
  { value: 'not-null', label: 'NOT NULL', description: 'CHECK ... NOT VALID, then VALIDATE and SET NOT NULL' },
  { value: 'foreign-key', label: 'Foreign key', description: 'FOREIGN KEY ... NOT VALID, then VALIDATE' },
  { value: 'index', label: 'Index', description: 'CREATE INDEX CONCURRENTLY, outside a transaction' },
];

/** Releases > Zero-downtime change: expand / contract templates written as real DMCR changes. */
export function ZeroDowntimeModal({ projects, onClose, onCreated }: { projects: Project[]; onClose: () => void; onCreated: () => void }) {
  const [pattern, setPattern] = useState<Pattern>('dual-write');
  const [mode, setMode] = useState<'rename' | 'retype'>('rename');
  const [f, setF] = useState<Record<string, string>>({ table: '', column: '', newColumn: '', newType: '', oldType: '', toNew: '', toOld: '', refTable: '', refColumn: 'id', columns: '', name: '' });
  const [flags, setFlags] = useState({ oldNotNull: false, unique: false });
  const [project, setProject] = useState(projects.find(p => p.status !== 'dropped')?.id ?? '');
  const [requestedBy, setRequestedBy] = useState('');
  const [preview, setPreview] = useState<{ phases?: Phase[]; error?: string; created?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Record<number, 'deploy' | 'verify' | 'revert'>>({});
  const reqId = useRef('');
  const set = (k: string) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }));

  const params = () => {
    const p: Record<string, unknown> = { table: f.table, name: f.name || undefined };
    if (pattern === 'dual-write') Object.assign(p, { column: f.column, newColumn: f.newColumn, newType: f.newType, oldNotNull: flags.oldNotNull,
      ...(mode === 'retype' ? { oldType: f.oldType || undefined, toNew: f.toNew || undefined, toOld: f.toOld || undefined } : {}) });
    if (pattern === 'not-null') Object.assign(p, { column: f.column });
    if (pattern === 'foreign-key') Object.assign(p, { column: f.column, refTable: f.refTable, refColumn: f.refColumn });
    if (pattern === 'index') Object.assign(p, { columns: f.columns, unique: flags.unique });
    return p;
  };

  useEffect(() => {
    const h = (e: MessageEvent) => {
      if (e.data?.type !== 'zeroDowntimeResult' || e.data.payload?.requestId !== reqId.current) return;
      const d = e.data.payload as { phases?: Phase[]; error?: string; created?: string[] };
      setBusy(false);
      setPreview(prev => d.created ? { ...prev, created: d.created } : d);
      if (d.created) onCreated();
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, [onCreated]);

  // The fields a pattern needs before there is anything to build (no warning on an empty form)
  const missing = (): string[] => {
    const need: [string, string][] = [['table', 'Table']];
    if (pattern === 'dual-write') need.push(['column', 'Column'], ['newColumn', 'New column'], ['newType', 'Type of the new column']);
    if (pattern === 'not-null') need.push(['column', 'Column']);
    if (pattern === 'foreign-key') need.push(['column', 'Column'], ['refTable', 'References table']);
    if (pattern === 'index') need.push(['columns', 'Columns']);
    return need.filter(([k]) => !f[k]?.trim()).map(([, label]) => label);
  };
  const todo = missing();

  // live preview, a moment after the last keystroke
  useEffect(() => {
    if (preview?.created) return;
    if (todo.length) { setPreview(null); return; }
    const t = setTimeout(() => {
      reqId.current = `zd-${Date.now()}`;
      postMsg({ type: 'zeroDowntime', payload: { requestId: reqId.current, pattern, params: params() } });
    }, 300);
    return () => clearTimeout(t);
  }, [pattern, mode, f, flags]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = () => {
    setBusy(true);
    reqId.current = `zd-${Date.now()}`;
    postMsg({ type: 'zeroDowntime', payload: { requestId: reqId.current, pattern, params: params(), project, requestedBy, create: true } });
  };
  const phases = preview?.phases ?? [];
  const field = (label: string, k: string, placeholder: string, mono = true) => (
    <label className="zd-field"><span className="zd-label">{label}</span>
      <TextInputView value={f[k]} placeholder={placeholder} onChange={set(k)} style={mono ? { fontFamily: 'var(--font-mono, ui-monospace, monospace)' } : undefined} /></label>
  );

  return (
    <ModalView open size="xxl" height="95vh" maxHeight="95vh" className="zd-modal" onClose={onClose} headerIcon={<SplitVerticalIcon size={16} />} headerColor="var(--dm-c-22d3ee)"
      title="Zero-downtime change" subtitle="Expand now, contract after the application switched over: real DMCR changes with deploy, verify and revert. The contract requires the expand."
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'hidden' }}
      footerRight={preview?.created ? <ButtonView variant="primary" label="Done" onClick={onClose} /> : <>
        <ButtonView variant="ghost" label="Cancel" onClick={onClose} />
        <ButtonView variant="primary" accentColor="var(--dm-c-22d3ee)" iconLeft={<SplitVerticalIcon size={13} />} loading={busy} disabled={!!todo.length || !phases.length || busy || !!preview?.error}
          label={`Create ${phases.length || ''} change${phases.length === 1 ? '' : 's'}`} onClick={create} />
      </>}>
      <RadioCardView size="md" columns={4} accentColor="var(--dm-c-22d3ee)" value={pattern} onChange={v => setPattern(v as Pattern)} options={PATTERNS} />
      <div className="zd-form">
        {field('Table', 'table', 'orders')}
        {pattern === 'dual-write' && <>
          <label className="zd-field"><span className="zd-label">What</span>
            <SegmentedControlView variant="rounded" size="md" value={mode} onChange={v => setMode(v as 'rename' | 'retype')}
              options={[{ value: 'rename', label: 'Rename' }, { value: 'retype', label: 'Change type' }]} /></label>
          {field('Column', 'column', 'owner')}
          {field('New column', 'newColumn', mode === 'rename' ? 'owner_name' : 'score_big')}
          {field('Type of the new column', 'newType', mode === 'rename' ? 'varchar(100) (same type)' : 'bigint')}
          {mode === 'retype' && <>
            {field('Type of the old column', 'oldType', 'integer')}
            {field('New value from {old}', 'toNew', '{old}::bigint')}
            {field('Old value from {new}', 'toOld', '{new}::integer')}
          </>}
          <label className="zd-field zd-field--check"><CheckboxView checked={flags.oldNotNull} onChange={v => setFlags(x => ({ ...x, oldNotNull: !!v }))} label="The old column is NOT NULL" /></label>
        </>}
        {pattern === 'not-null' && <>{field('Column', 'column', 'updated_at')}{field('Check constraint name', 'name', '(table_column_not_null)')}</>}
        {pattern === 'foreign-key' && <>
          {field('Column', 'column', 'customer_id')}{field('References table', 'refTable', 'customers')}{field('References column', 'refColumn', 'id')}{field('Constraint name', 'name', '(table_column_fkey)')}
        </>}
        {pattern === 'index' && <>
          {field('Columns', 'columns', 'zap_id, started_at')}{field('Index name', 'name', '(table_columns_idx)')}
          <label className="zd-field zd-field--check"><CheckboxView checked={flags.unique} onChange={v => setFlags(x => ({ ...x, unique: !!v }))} label="Unique" /></label>
        </>}
        <label className="zd-field"><span className="zd-label">Project</span>
          <SelectInputView size="md" value={project} onChange={setProject} options={projects.filter(p => p.status !== 'dropped').map(p => ({ value: p.id, label: p.name ? `${p.id} · ${p.name}` : p.id }))} /></label>
        <label className="zd-field"><span className="zd-label">Requested by</span><TextInputView value={requestedBy} placeholder="Developer" onChange={e => setRequestedBy(e.target.value)} /></label>
      </div>

      {preview?.created ? (
        <div className="zd-created">
          <CheckCircleIcon size={16} />
          <div><b>Created {preview.created.length} change{preview.created.length === 1 ? '' : 's'}</b>
            <div className="zd-created-ids">{preview.created.map(id => <ChangeIdLabel key={id} id={id} />)}</div></div>
        </div>
      ) : todo.length ? (
        <div className="zd-hint">Fill in {todo.join(', ')} to see the changes.</div>
      ) : preview?.error ? (
        <div className="zd-hint"><WarningTriangleIcon size={13} />{preview.error}</div>
      ) : !phases.length ? <LoaderView variant="dots" label="Building the changes" center /> : (
        <div className="zd-phases" style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}>
          {phases.map((p, i) => {
            const t = tab[i] ?? 'deploy';
            return (
              <div key={i} className="zd-phase">
                <div className="zd-phase-head">
                  <ChipView size="xs" label={p.phase === 'single' ? 'one change' : `${i + 1} · ${p.phase}`} color={p.phase === 'contract' ? 'var(--dm-c-f87171)' : 'var(--dm-c-22d3ee)'} />
                  <span className="zd-phase-name">{p.changeName}</span>
                  {/\bDROP\s+COLUMN\b/i.test(p.deploySql) && <ChipView size="xs" label="danger_: DBA runs it" color="var(--dm-c-ef4444)" />}
                  <LockLintChip findings={p.lint?.filter(x => x.severity === 'warning')} />
                  <span className="zd-gap" />
                  <SegmentedControlView variant="rounded" size="md" value={t} onChange={v => setTab(x => ({ ...x, [i]: v as 'deploy' }))}
                    options={[{ value: 'deploy', label: 'deploy' }, { value: 'verify', label: 'verify' }, { value: 'revert', label: 'revert' }]} />
                </div>
                <div className="zd-editor"><EditorView value={t === 'deploy' ? p.deploySql : t === 'verify' ? p.verifySql : p.revertSql} language="sql" readOnly height="100%" fontSize={12.5} editorOptions={{ minimap: false, scrollBeyondLastLine: false, wordWrap: 'on' }} /></div>
                {p.next && <div className="zd-next"><b>Before the next change:</b> {p.next}</div>}
              </div>
            );
          })}
        </div>
      )}
    </ModalView>
  );
}
