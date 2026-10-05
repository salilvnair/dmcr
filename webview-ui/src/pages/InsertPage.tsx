import { useState, useCallback, useEffect, useRef } from 'react';
import { postMsg } from '../vscode';
import ChangeCard, { type ChangeData } from '../components/ChangeCard';
import ProgressScreen from '../components/ProgressScreen';
import GenErrorBox, { type GenError } from '../components/GenErrorBox';
import StyledDropdown, { type DropdownItem } from '../components/StyledDropdown';
import MultiSelectDropdown from '../components/MultiSelectDropdown';
import DateTimePicker from '../components/DateTimePicker';
import { FieldHint } from '../components/FieldHint';
import { CheckboxView } from '@salilvnair/dui';
import type { FormSnapshot } from '../types';
import './InsertPage.css';

/* ── Types ─────────────────────────────────────────────────────── */
type Screen = 'form' | 'progress' | 'result';
type ColType = 'timestamp' | 'timestamptz' | 'date' | 'time' | 'interval' | 'int' | 'bigint' | 'numeric' | 'text' | 'varchar' | 'boolean' | 'custom';
type ColumnSpec = { name: string; type: ColType; customType: string };

function pgTypeToColType(raw: string): ColType {
  const t = raw.toLowerCase().trim();
  if (t.includes('timestamptz') || t === 'timestamp with time zone') return 'timestamptz';
  if (t.startsWith('timestamp')) return 'timestamp';
  if (t.startsWith('date')) return 'date';
  if (t.startsWith('time')) return 'time';
  if (t.startsWith('interval')) return 'interval';
  if (t === 'bigint' || t === 'int8' || t === 'bigserial') return 'bigint';
  if (t === 'integer' || t === 'int' || t === 'int4' || t === 'int2' || t === 'smallint' || t === 'serial') return 'int';
  if (t.startsWith('numeric') || t.startsWith('decimal') || t.startsWith('real') || t.startsWith('float') || t.startsWith('double')) return 'numeric';
  if (t === 'text') return 'text';
  if (t.startsWith('character varying') || t.startsWith('varchar')) return 'varchar';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  return 'custom';
}
type RowData = Record<string, string | number | boolean | null>;

type Props = { visible: boolean; form: string; availableSchemas?: string[]; existingChanges?: string[]; initialState?: FormSnapshot['insert']; onStateChange?: (p: FormSnapshot['insert']) => void };

const TYPE_ITEMS: DropdownItem[] = [
  { value: 'timestamp', label: 'timestamp' },
  { value: 'timestamptz', label: 'timestamptz' },
  { value: 'date', label: 'date' },
  { value: 'time', label: 'time' },
  { value: 'interval', label: 'interval (H:MM:SS)' },
  { value: 'int', label: 'int' },
  { value: 'bigint', label: 'bigint' },
  { value: 'numeric', label: 'numeric' },
  { value: 'boolean', label: 'boolean' },
  { value: 'text', label: 'text' },
  { value: 'varchar', label: 'varchar(n)' },
  { value: 'custom', label: 'custom\u2026' },
];

const CONFLICT_ITEMS: DropdownItem[] = [
  { value: 'do_nothing', label: 'ON CONFLICT DO NOTHING' },
  { value: 'update', label: 'ON CONFLICT DO UPDATE' },
];

function formatTimestampForSql(value: string): string {
  return value.replace('T', ' ') + (value.length === 16 ? ':00' : '');
}

/* ═══════════════════════════════════════════════════════════════ */
export default function InsertPage({ visible, form, availableSchemas = [], existingChanges = [], initialState, onStateChange }: Props) {
  const [screen, setScreen] = useState<Screen>('form');

  // Form state
  const [tableName, setTableName] = useState(initialState?.tableName || '');
  const [columns, setColumns] = useState<ColumnSpec[]>(() => {
    if (initialState?.columns?.length) {
      return initialState.columns.map(c => {
        const t = pgTypeToColType(c.type);
        return { name: c.name, type: t, customType: t === 'custom' ? c.type : '' };
      });
    }
    return [
      { name: 'timestamp', type: 'timestamp', customType: '' },
      { name: 'chats_in_queue', type: 'int', customType: '' },
    ];
  });
  const [rows, setRows] = useState<RowData[]>([{}]);
  const [idempotent, setIdempotent] = useState(true);
  const [conflictTarget, setConflictTarget] = useState('');
  const [conflictAction, setConflictAction] = useState('do_nothing');
  const [conflictUpdateCols, setConflictUpdateCols] = useState('');
  const [changeNameHint, setChangeNameHint] = useState(initialState?.changeNameHint || '');
  const [metaTags, setMetaTags] = useState('');
  const [metaRequires, setMetaRequires] = useState<string[]>([]);
  const [metaAuthor, setMetaAuthor] = useState(initialState?.metaAuthor || '');
  const [status, setStatus] = useState<{ msg: string; kind: 'ok' | 'error' } | null>(null);
  const [progressMsg, setProgressMsg] = useState('Generating your DMCR change…');
  const [streamChunk, setStreamChunk] = useState('');
  const [changeData, setChangeData] = useState<ChangeData | null>(null);
  const [genError, setGenError] = useState<GenError | null>(null);

  /* Apply prefill when parent updates initialState from Schema Explorer shortcut */
  useEffect(() => {
    if (initialState?.tableName) setTableName(initialState.tableName);
  }, [initialState?.tableName]);

  useEffect(() => {
    if (!initialState?.columns?.length) return;
    setColumns(initialState.columns.map(c => {
      const t = pgTypeToColType(c.type);
      return { name: c.name, type: t, customType: t === 'custom' ? c.type : '' };
    }));
  }, [initialState?.columns]);

  /* Report key field changes to parent for snapshot persistence */
  useEffect(() => {
    onStateChange?.({ tableName, changeNameHint, metaAuthor });
  }, [tableName, changeNameHint, metaAuthor]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // ── Message listener ─────────────────────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.payload?.form && msg.payload.form !== form) return;
      switch (msg.type) {
        case 'showProgress':
          if (msg.payload?.message) setProgressMsg(msg.payload.message);
          setStatus(null);
          setScreen('progress');
          break;
        case 'progressUpdate':
          if (msg.payload?.text) setProgressMsg(msg.payload.text);
          break;
        case 'streamChunk':
          if (msg.payload?.text) setStreamChunk(msg.payload.text);
          break;
        case 'generationDone':
          if (msg.payload.deploySql != null) {
            setChangeData({
              changeName: msg.payload.changeName || 'change',
              deploySql: msg.payload.deploySql || '',
              verifySql: msg.payload.verifySql || '',
              revertSql: msg.payload.revertSql || '',
              metaJson: msg.payload.metaJson || undefined,  // requires, tags and author from the form
              suggestedLocation: msg.payload.suggestedLocation || '',
            });
            setGenError(null);
            setScreen('result');
          }
          break;
        case 'generationError':
          setGenError({
            message: msg.payload?.message || 'Generation failed.',
            stack: msg.payload?.stack,
            code: msg.payload?.code,
            timestamp: msg.payload?.timestamp,
            source: msg.payload?.source,
          });
          setScreen('form');
          break;
        case 'formActivated':
          setGenError(null);
          setScreen('form');
          break;
        case 'formCancelled':
          setGenError(null);
          setStatus(null);
          setScreen('form');
          break;
        case 'gitUser':
          if (!metaAuthor && (msg.payload?.name || msg.payload?.email)) {
            setMetaAuthor(msg.payload.name || msg.payload.email);
          }
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [form, metaAuthor]);

  // Request git user on mount for author auto-fill
  useEffect(() => {
    if (!metaAuthor) postMsg({ type: 'getGitUser' });
  }, []);

  // ── Column CRUD ──────────────────────────────────────────────
  const addColumn = useCallback((init?: Partial<ColumnSpec>) => {
    setColumns(prev => [...prev, { name: init?.name || '', type: init?.type || 'int', customType: init?.customType || '' }]);
  }, []);

  const removeColumn = useCallback((idx: number) => {
    setColumns(prev => {
      const next = [...prev];
      const removed = next.splice(idx, 1)[0];
      // Clean row data for removed column
      if (removed?.name) {
        setRows(rr => rr.map(r => { const c = { ...r }; delete c[removed.name]; return c; }));
      }
      return next;
    });
  }, []);

  const updateColumn = useCallback((idx: number, patch: Partial<ColumnSpec>) => {
    setColumns(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, []);

  // ── Row CRUD ─────────────────────────────────────────────────
  const addRow = useCallback((init?: RowData) => {
    setRows(prev => [...prev, { ...init }]);
  }, []);

  const removeRow = useCallback((idx: number) => {
    setRows(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const updateCell = useCallback((rowIdx: number, colName: string, value: string | number | boolean | null) => {
    setRows(prev => {
      const next = [...prev];
      next[rowIdx] = { ...next[rowIdx], [colName]: value };
      return next;
    });
  }, []);

  const clearRows = useCallback(() => setRows([]), []);

  // ── Example data ─────────────────────────────────────────────
  const loadExample = useCallback(() => {
    setTableName('public.wfm_chat_metrics');
    setColumns([
      { name: 'timestamp', type: 'timestamp', customType: '' },
      { name: 'chats_in_queue', type: 'int', customType: '' },
      { name: 'trending_percent_of_abandons', type: 'int', customType: '' },
      { name: 'longest_wait_time', type: 'interval', customType: '' },
      { name: 'average_time_in_queue', type: 'interval', customType: '' },
      { name: 'trending_avg', type: 'interval', customType: '' },
      { name: 'active_chats', type: 'int', customType: '' },
    ]);
    setRows([{
      timestamp: '2025-11-07T10:00:00',
      chats_in_queue: 41,
      trending_percent_of_abandons: 8,
      longest_wait_time: '0:29:13',
      average_time_in_queue: '0:09:31',
      trending_avg: '0:04:20',
      active_chats: 91,
    }]);
  }, []);

  // ── Submit ───────────────────────────────────────────────────
  const handleGenerate = useCallback(() => {
    setStatus(null);
    const table = tableName.trim();
    const cols = columns.filter(c => c.name.trim());
    if (!table) { setStatus({ msg: 'Enter a target table (schema.table).', kind: 'error' }); return; }
    if (!cols.length) { setStatus({ msg: 'Add at least one column.', kind: 'error' }); return; }
    for (const c of cols) {
      const t = (c.type === 'custom' || c.type === 'varchar') ? c.customType.trim() : c.type;
      if (!t) { setStatus({ msg: 'Every column must have a type (or custom type).', kind: 'error' }); return; }
    }
    if (!rows.length) { setStatus({ msg: 'Add at least one data row.', kind: 'error' }); return; }

    // Build payload matching extension's expected shape
    const payloadRows = rows.map(r => {
      const out: RowData = {};
      for (const c of cols) {
        const v = r[c.name.trim()];
        if (v === undefined || v === null) out[c.name.trim()] = null;
        else if (c.type === 'timestamp' || c.type === 'timestamptz') out[c.name.trim()] = formatTimestampForSql(String(v));
        else out[c.name.trim()] = v;
      }
      return out;
    });

    setStatus({ msg: 'Submitting request\u2026', kind: 'ok' });
    setStreamChunk('');
    setProgressMsg('Generating your DMCR change\u2026');
    postMsg({
      type: 'submit',
      payload: {
        form,
        table, columns: cols, rows: payloadRows,
        idempotent, conflictTarget: conflictTarget.trim(),
        conflictAction, conflictUpdateCols: conflictUpdateCols.trim(),
        changeNameHint: changeNameHint.trim(),
        metaTags: metaTags.trim(),
        metaRequires: metaRequires.join(', '),
        metaAuthor: metaAuthor.trim(),
      },
    });
  }, [tableName, columns, rows, idempotent, conflictTarget, conflictAction, conflictUpdateCols, changeNameHint, metaTags, metaRequires, metaAuthor]);

  const handleCancel = useCallback(() => { setStatus(null); setScreen('form'); postMsg({ type: 'cancel', payload: { form, goHome: true } }); }, [form]);

  // ── Render ───────────────────────────────────────────────────
  if (!visible) return null;
  if (screen === 'progress') return <ProgressScreen message={progressMsg} streamChunk={streamChunk} />;
  if (screen === 'result' && changeData) return <ChangeCard change={changeData} form={form} />;

  const activeCols = columns.filter(c => c.name.trim());

  return (
    <div className="ins-page">
      {genError && <GenErrorBox error={genError} />}

      {/* Header */}
      <h2 className="ins-hd">Insert rows <span className="ins-badge-dml">DML</span> <span className="ins-pill">PostgreSQL</span></h2>
      <div className="ins-hint">
        Step 1: define columns (name + type). Step 2: add one or more data rows.
        Timestamp/time/date fields use the built-in dark picker; interval expects H:MM:SS.
      </div>

      <div className="ins-banner">
        <div className="ins-banner-title">Tip</div>
        <div className="ins-banner-text">
          Keep <b>Idempotent</b> enabled to generate safer &ldquo;re-runnable&rdquo; deploy SQL using <b>ON CONFLICT</b>.
        </div>
      </div>

      {/* Schema */}
      <div className="ins-card">
        <div className="ins-section-title">Schema</div>
        <div className="ins-target-row">
          {availableSchemas.length > 0 ? (
            <StyledDropdown
              items={availableSchemas.map(s => ({ value: s, label: s }))}
              value={tableName.includes('.') ? tableName.split('.')[0] : (availableSchemas[0] || '')}
              onChange={v => {
                const tbl = tableName.includes('.') ? tableName.split('.').slice(1).join('.') : tableName;
                setTableName(v ? `${v}.${tbl}` : tbl);
              }}
            />
          ) : (
            <input className="ins-input" value={tableName.includes('.') ? tableName.split('.')[0] : ''}
              onChange={e => {
                const tbl = tableName.includes('.') ? tableName.split('.').slice(1).join('.') : tableName;
                setTableName(e.target.value ? `${e.target.value}.${tbl}` : tbl);
              }}
              placeholder="e.g. public, zp_st" />
          )}
        </div>
      </div>

      {/* Target table */}
      <div className="ins-card">
        <div className="ins-section-title">Target Table <FieldHint text="Fully-qualified table to seed. Include the schema prefix." example="public.users, zapper.disconnect_requests" /></div>
        <div className="ins-target-row">
          <input className="ins-input" value={tableName} onChange={e => setTableName(e.target.value)}
            placeholder="schema.table (e.g. public.wfm_chat_metrics)" />
          <button type="button" className="ins-btn secondary" onClick={loadExample}>&#x1F4CB; Load example</button>
        </div>
      </div>

      {/* Columns */}
      <div className="ins-card">
        <div className="ins-section-title">Columns</div>
        {columns.map((col, idx) => {
          const hasCustom = col.type === 'varchar' || col.type === 'custom';
          return (
            <div key={idx} className={`ins-col-row${hasCustom ? ' has-custom' : ''}`}>
              <div className="ins-col-field">
                <label className="ins-col-label">Column name</label>
                <input className="ins-input" value={col.name}
                  onChange={e => updateColumn(idx, { name: e.target.value })}
                  placeholder="column_name" />
              </div>
              <div className="ins-col-field">
                <label className="ins-col-label">Data type</label>
                <StyledDropdown
                  items={TYPE_ITEMS}
                  value={col.type}
                  onChange={v => updateColumn(idx, { type: v as ColType })}
                />
              </div>
              {hasCustom && (
                <div className="ins-col-field">
                  <label className="ins-col-label">Type detail</label>
                  <input className="ins-input" value={col.customType}
                    onChange={e => updateColumn(idx, { customType: e.target.value })}
                    placeholder={col.type === 'varchar' ? 'varchar(n) e.g. varchar(100)' : 'custom type e.g. numeric(12,2)'} />
                </div>
              )}
              <button type="button" className="ins-remove-btn" onClick={() => removeColumn(idx)} title="Remove column">×</button>
            </div>
          );
        })}
        <div className="ins-top-actions">
          <button type="button" className="ins-btn secondary" onClick={() => addColumn()}>&#x2795; Add column</button>
        </div>
      </div>

      {/* Rows */}
      <div className="ins-card">
        <div className="ins-section-title">Rows</div>
        <div className="ins-grid">
          <table>
            <thead>
              <tr>
                <th>#</th>
                {activeCols.map(c => <th key={c.name}>{c.name}</th>)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  <td className="ins-row-num">{rIdx + 1}</td>
                  {activeCols.map(col => (
                    <td key={col.name}>
                      <CellEditor col={col} value={row[col.name.trim()] ?? null} onChange={v => updateCell(rIdx, col.name.trim(), v)} />
                    </td>
                  ))}
                  <td>
                    <button type="button" className="ins-row-remove" onClick={() => removeRow(rIdx)}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ins-top-actions">
          <button type="button" className="ins-btn secondary" onClick={() => addRow()}>&#x2795; Add row</button>
          <button type="button" className="ins-btn danger small" onClick={clearRows}>&#x1F5D1; Clear rows</button>
        </div>
      </div>

      {/* Idempotency */}
      <div className="ins-card">
        <div className="ins-section-title">Idempotency (recommended)</div>
        <div className={`ins-setting-card${idempotent ? ' checked' : ''}`} onClick={() => setIdempotent(v => !v)}>
          <span style={{ display: 'flex', flexShrink: 0 }} onClick={e => e.stopPropagation()}><CheckboxView checked={idempotent} onChange={setIdempotent} size="md" accentColor="#4f46e5" /></span>
          <div>
            <div className="ins-setting-title">Idempotent (use ON CONFLICT)</div>
            <div className="ins-setting-desc">If enabled, add conflict target + action so deploy can be re-run safely.</div>
          </div>
        </div>
        <div className="ins-conflict-row">
          <input className="ins-input" value={conflictTarget} onChange={e => setConflictTarget(e.target.value)}
            placeholder="Conflict target columns (comma-separated), e.g. timestamp" />
          <StyledDropdown items={CONFLICT_ITEMS} value={conflictAction} onChange={setConflictAction} />
        </div>
        <input className="ins-input" value={conflictUpdateCols} onChange={e => setConflictUpdateCols(e.target.value)}
          placeholder="If UPDATE: columns to update (comma-separated), blank = all non-key" style={{ marginTop: 10 }} />
      </div>

      {/* Change name hint */}
      <div className="ins-hint-card">
        <label className="ins-col-label">Change name hint (optional) <FieldHint text="Short slug for the generated change folder name. Lowercase, digits, underscores only." example="seed_initial_users, add_config_rows" /></label>
        <input className="ins-input" value={changeNameHint} onChange={e => setChangeNameHint(e.target.value)}
          placeholder="e.g. seed_threshold_level_rows" />
        {changeNameHint && !/^[a-z][a-z0-9_]*$/.test(changeNameHint) && (
          <div className="ins-field-warn">⚠ Use lowercase letters, digits and underscores only — must start with a letter</div>
        )}
      </div>

      {/* Metadata */}
      <div className="ins-card">
        <div className="ins-section-title">
          &#x1F3F7;&#xFE0F; Metadata <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(optional &mdash; AI fills if empty)</span>
        </div>
        <div className="ins-col-field" style={{ marginBottom: 8 }}>
          <label className="ins-col-label">Tags <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(comma-separated)</span></label>
          <input className="ins-input" value={metaTags} onChange={e => setMetaTags(e.target.value)}
            placeholder="e.g. seed-data, hotfix" />
        </div>
        <div className="ins-col-field" style={{ marginBottom: 8 }}>
          <label className="ins-col-label">Requires <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(depends on these change IDs)</span></label>
          <MultiSelectDropdown
            items={existingChanges.map(c => ({ value: c, label: c }))}
            selected={metaRequires}
            onChange={setMetaRequires}
            placeholder="Select dependencies…"
            allowCustom
          />
        </div>
        <div className="ins-col-field">
          <label className="ins-col-label">Author</label>
          <input className="ins-input" value={metaAuthor} onChange={e => setMetaAuthor(e.target.value)}
            placeholder="e.g. jdoe" />
        </div>
      </div>

      {/* Actions */}
      <div className="ins-actions">
        <button type="button" className="ins-btn primary" onClick={handleGenerate}>&#x1FA84; Generate DMCR request</button>
        <button type="button" className="ins-btn danger" onClick={handleCancel}>&#x2715; Cancel</button>
      </div>

      {status && <div className={`ins-status ${status.kind}`}>{status.msg}</div>}
    </div>
  );
}

/* ── Cell editor per column type ──────────────────────────────── */
function CellEditor({ col, value, onChange }: { col: ColumnSpec; value: unknown; onChange: (v: string | number | boolean | null) => void }) {
  if (col.type === 'boolean') {
    const v = value === true ? 'true' : value === false ? 'false' : 'null';
    return (
      <StyledDropdown
        items={[{ value: 'null', label: 'NULL' }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
        value={v}
        onChange={nv => onChange(nv === 'null' ? null : nv === 'true')}
      />
    );
  }
  if (col.type === 'date') {
    return <DateTimePicker mode="date" value={value as string | null} onChange={onChange as (v: string | null) => void} />;
  }
  if (col.type === 'time') {
    return <DateTimePicker mode="time" value={value as string | null} onChange={onChange as (v: string | null) => void} />;
  }
  if (col.type === 'timestamp' || col.type === 'timestamptz') {
    return <DateTimePicker mode="datetime" value={value as string | null} onChange={onChange as (v: string | null) => void} />;
  }
  if (col.type === 'int' || col.type === 'bigint' || col.type === 'numeric') {
    return (
      <input
        type="number"
        className="ins-input"
        step={col.type === 'numeric' ? 'any' : '1'}
        value={value != null ? String(value) : ''}
        onChange={e => onChange(e.target.value === '' ? null : e.target.value)}
      />
    );
  }
  if (col.type === 'interval') {
    return (
      <input
        type="text"
        className="ins-input"
        value={value != null ? String(value) : ''}
        onChange={e => onChange(e.target.value || null)}
        placeholder="H:MM:SS (e.g. 0:29:13)"
      />
    );
  }
  // text, varchar, custom, etc.
  return (
    <input
      type="text"
      className="ins-input"
      value={value != null ? String(value) : ''}
      onChange={e => onChange(e.target.value === '' ? null : e.target.value)}
    />
  );
}
