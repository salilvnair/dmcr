import { useState, useCallback, useEffect, useMemo } from 'react';
import { postMsg } from '../vscode';
import ChangeCard, { type ChangeData } from '../components/ChangeCard';
import ProgressScreen from '../components/ProgressScreen';
import GenErrorBox, { type GenError } from '../components/GenErrorBox';
import StyledDropdown, { type DropdownItem } from '../components/StyledDropdown';
import MultiSelectDropdown from '../components/MultiSelectDropdown';
import { FieldHint } from '../components/FieldHint';
import { CheckboxView } from '@salilvnair/dui';
import type { FormSnapshot } from '../types';
import './DdlPage.css';

/* ── Types ─────────────────────────────────────────────────────── */
type Screen = 'form' | 'progress' | 'result';
type TableAction = 'alter' | 'create' | 'sequence' | 'grant-tables' | 'grant-sequences' | 'create-schema';
type ColumnSpec = { name: string; type: string };
type TableCard = { id: number; table: string; columns: ColumnSpec[]; removed: boolean };

type Props = { visible: boolean; form: string; availableSchemas?: string[]; existingChanges?: string[]; initialState?: FormSnapshot['ddl']; onStateChange?: (p: FormSnapshot['ddl']) => void };

const ACTION_ITEMS: DropdownItem[] = [
  { value: 'create',          label: 'CREATE TABLE' },
  { value: 'alter',           label: 'ALTER TABLE \u2014 add columns' },
  { value: 'sequence',        label: 'CREATE SEQUENCE' },
  { value: 'grant-tables',    label: 'GRANT \u2014 table privileges' },
  { value: 'grant-sequences', label: 'GRANT \u2014 sequence privileges' },
  { value: 'create-schema',   label: 'CREATE SCHEMA' },
];

const COMMON_TYPES: DropdownItem[] = [
  { value: 'varchar(100)', label: 'varchar(100)' },
  { value: 'varchar(255)', label: 'varchar(255)' },
  { value: 'text',         label: 'text' },
  { value: 'date',         label: 'date' },
  { value: 'timestamp',    label: 'timestamp' },
  { value: 'timestamptz',  label: 'timestamptz' },
  { value: 'boolean',      label: 'boolean' },
  { value: 'int',          label: 'int' },
  { value: 'bigint',       label: 'bigint' },
  { value: 'decimal',      label: 'decimal' },
  { value: 'decimal(12,2)',label: 'decimal(12,2)' },
  { value: 'decimal(5,3)', label: 'decimal(5,3)' },
  { value: 'numeric',      label: 'numeric' },
  { value: 'numeric(12,2)',label: 'numeric(12,2)' },
  { value: 'uuid',         label: 'uuid' },
  { value: 'jsonb',        label: 'jsonb' },
  { value: '__custom__',   label: 'custom\u2026' },
];

/* helper: qualify name with default schema if needed */
function qualify(name: string, schema: string): string {
  const n = name.trim();
  if (!n) return n;
  if (n.includes('.') || !schema) return n;
  return schema + '.' + n;
}

let nextCardId = 1;
function freshCard(table = '', cols?: ColumnSpec[]): TableCard {
  return { id: nextCardId++, table, columns: cols ?? [{ name: '', type: '' }], removed: false };
}

/* ═══════════════════════════════════════════════════════════════ */
export default function DdlPage({ visible, form, availableSchemas = [], existingChanges = [], initialState, onStateChange }: Props) {
  const [screen, setScreen] = useState<Screen>('form');

  // Mode
  const [action, setAction] = useState<TableAction>((initialState?.action as TableAction) || 'create');

  // Tables
  const [tables, setTables] = useState<TableCard[]>(() => {
    const cols = initialState?.columns?.length
      ? initialState.columns.map(c => ({ name: c.name, type: c.type }))
      : undefined;
    return [freshCard(initialState?.tableName || '', cols)];
  });
  const [sameColumns, setSameColumns] = useState(false);
  const [defaultSchema, setDefaultSchema] = useState(initialState?.defaultSchema || availableSchemas[0] || '');
  useEffect(() => { if (availableSchemas.length > 0 && !defaultSchema) setDefaultSchema(availableSchemas[0]); }, [availableSchemas]);
  useEffect(() => { if (initialState?.defaultSchema) setDefaultSchema(initialState.defaultSchema); }, [initialState?.defaultSchema]);
  useEffect(() => {
    if (initialState?.tableName) setTables(prev => prev.map((t, i) => i === 0 ? { ...t, table: initialState.tableName! } : t));
  }, [initialState?.tableName]);
  useEffect(() => {
    if (!initialState?.columns?.length) return;
    setTables(prev => prev.map((t, i) => i === 0 ? { ...t, columns: initialState.columns!.map(c => ({ name: c.name, type: c.type })) } : t));
  }, [initialState?.columns]);
  const [changeNameHint, setChangeNameHint] = useState(initialState?.changeNameHint || '');
  const [metaTags, setMetaTags] = useState('');
  const [metaRequires, setMetaRequires] = useState<string[]>([]);
  const [metaAuthor, setMetaAuthor] = useState(initialState?.metaAuthor || '');

  // Table GRANTs
  const [tableGrantEnabled, setTableGrantEnabled] = useState(false);
  const [tableGrantRole, setTableGrantRole] = useState('');
  const [tableGrantPrivs, setTableGrantPrivs] = useState<string[]>([]);
  // For grant-tables mode (textarea)
  const [grantTableNames, setGrantTableNames] = useState('');

  // Schema
  const [schemaEnabled, setSchemaEnabled] = useState(false);
  const [schemaName, setSchemaName] = useState('');
  const [schemaNameManual, setSchemaNameManual] = useState(false);
  const [schemaGrantEnabled, setSchemaGrantEnabled] = useState(false);
  const [schemaGrantRole, setSchemaGrantRole] = useState('');
  const [schemaGrantPrivs, setSchemaGrantPrivs] = useState<string[]>([]);

  // Sequence
  const [sequenceEnabled, setSequenceEnabled] = useState(false);
  const [sequenceName, setSequenceName] = useState('');
  const [seqStart, setSeqStart] = useState('');
  const [seqIncrement, setSeqIncrement] = useState('');
  const [seqMin, setSeqMin] = useState('');
  const [seqMax, setSeqMax] = useState('');
  const [seqCache, setSeqCache] = useState('');
  const [seqGrantEnabled, setSeqGrantEnabled] = useState(false);
  const [seqGrantRole, setSeqGrantRole] = useState('');
  const [seqGrantPrivs, setSeqGrantPrivs] = useState<string[]>([]);
  // For grant-sequences mode
  const [grantSeqName, setGrantSeqName] = useState('');

  // Progress / result
  const [status, setStatus] = useState<{ msg: string; kind: 'ok' | 'error' } | null>(null);
  const [progressMsg, setProgressMsg] = useState('Agent is thinking\u2026');
  const [streamChunk, setStreamChunk] = useState('');
  const [changeData, setChangeData] = useState<ChangeData | null>(null);
  const [genError, setGenError] = useState<GenError | null>(null);

  /* Report key field changes to parent for snapshot persistence */
  useEffect(() => {
    onStateChange?.({ action, defaultSchema, changeNameHint, metaAuthor });
  }, [action, defaultSchema, changeNameHint, metaAuthor]);

  // Sync schema name from defaultSchema
  useEffect(() => {
    if (!schemaNameManual) setSchemaName(defaultSchema);
  }, [defaultSchema, schemaNameManual]);

  const activeTables = useMemo(() => tables.filter(t => !t.removed), [tables]);

  // ── Message listener ────────────────────────────────────────
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

  // ── Table CRUD ──────────────────────────────────────────────
  const addTable = useCallback(() => setTables(prev => [...prev, freshCard()]), []);
  const duplicateTable = useCallback(() => {
    const last = activeTables[activeTables.length - 1];
    if (last) setTables(prev => [...prev, freshCard(last.table, [...last.columns.map(c => ({ ...c }))])]);
    else addTable();
  }, [activeTables, addTable]);
  const removeTable = useCallback((id: number) => {
    setTables(prev => prev.map(t => t.id === id ? { ...t, removed: true } : t));
  }, []);
  const updateTableName = useCallback((id: number, name: string) => {
    setTables(prev => prev.map(t => t.id === id ? { ...t, table: name } : t));
  }, []);

  // ── Column CRUD ─────────────────────────────────────────────
  const addColumn = useCallback((tableId: number) => {
    setTables(prev => prev.map(t => t.id === tableId ? { ...t, columns: [...t.columns, { name: '', type: '' }] } : t));
  }, []);
  const removeColumn = useCallback((tableId: number, colIdx: number) => {
    setTables(prev => prev.map(t => t.id === tableId ? { ...t, columns: t.columns.filter((_, i) => i !== colIdx) } : t));
  }, []);
  const updateColumn = useCallback((tableId: number, colIdx: number, patch: Partial<ColumnSpec>) => {
    setTables(prev => prev.map(t => {
      if (t.id !== tableId) return t;
      const cols = [...t.columns];
      cols[colIdx] = { ...cols[colIdx], ...patch };
      return { ...t, columns: cols };
    }));
  }, []);

  // ── Privilege toggle helpers ────────────────────────────────
  const togglePriv = useCallback((list: string[], setList: (l: string[]) => void, priv: string) => {
    setList(list.includes(priv) ? list.filter(p => p !== priv) : [...list, priv]);
  }, []);

  // ── Load sequence example ───────────────────────────────────
  const loadSeqExample = useCallback(() => {
    setSequenceName('seq_wfm_ahod_threshold_level');
    setSeqStart('1'); setSeqIncrement('1'); setSeqCache('1');
    setSeqMin(''); setSeqMax('');
    setSeqGrantEnabled(true);
    setSeqGrantRole('zp_st');
    setSeqGrantPrivs(['USAGE', 'SELECT']);
  }, []);

  // ── Validate & submit ──────────────────────────────────────
  const submit = useCallback((tblSpecs: { table: string; columns: ColumnSpec[] }[]) => {
    const schema = defaultSchema.trim().replace(/\.$/, '');
    setStatus({ msg: 'Submitting request\u2026', kind: 'ok' });
    setStreamChunk('');
    setProgressMsg('Agent is thinking\u2026');
    postMsg({
      type: 'submit',
      payload: {
        form,
        tableAction: action,
        defaultSchema: schema,
        changeNameHint: changeNameHint.trim(),
        tables: tblSpecs,
        sameColumnsForAllTables: sameColumns,
        tableGrantEnabled,
        tableGrantRole: tableGrantRole.trim(),
        tableGrantPrivs,
        schemaEnabled,
        schemaName: schemaName.trim(),
        schemaGrantEnabled,
        schemaGrantRole: schemaGrantRole.trim(),
        schemaGrantPrivs,
        sequenceEnabled: action === 'sequence' || action === 'grant-sequences' || sequenceEnabled,
        sequenceName: (action === 'grant-sequences' ? qualify(grantSeqName.trim(), schema) : sequenceName.trim()),
        sequenceStartWith: seqStart.trim(),
        sequenceIncrementBy: seqIncrement.trim(),
        sequenceMinValue: seqMin.trim(),
        sequenceMaxValue: seqMax.trim(),
        sequenceCache: seqCache.trim(),
        sequenceGrantEnabled: seqGrantEnabled,
        sequenceGrantRole: seqGrantRole.trim(),
        sequenceGrantPrivs: seqGrantPrivs,
        metaTags: metaTags.trim(),
        metaRequires: metaRequires.join(', '),
        metaAuthor: metaAuthor.trim(),
      },
    });
  }, [action, defaultSchema, changeNameHint, sameColumns, tableGrantEnabled, tableGrantRole, tableGrantPrivs,
      schemaEnabled, schemaName, schemaGrantEnabled, schemaGrantRole, schemaGrantPrivs,
      sequenceEnabled, sequenceName, grantSeqName, seqStart, seqIncrement, seqMin, seqMax, seqCache,
      seqGrantEnabled, seqGrantRole, seqGrantPrivs, metaTags, metaRequires, metaAuthor]);

  const handleGenerate = useCallback(() => {
    setStatus(null);
    const schema = defaultSchema.trim().replace(/\.$/, '');

    // Grant-tables mode
    if (action === 'grant-tables') {
      const rawNames = grantTableNames.trim();
      if (!rawNames) { setStatus({ msg: 'Enter at least one table name to grant on.', kind: 'error' }); return; }
      if (!tableGrantRole.trim()) { setStatus({ msg: 'Enter a role name for table GRANTs.', kind: 'error' }); return; }
      if (!tableGrantPrivs.length) { setStatus({ msg: 'Select at least one privilege for table GRANTs.', kind: 'error' }); return; }
      const tblNames = rawNames.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      const tblSpecs = tblNames.map(n => ({ table: qualify(n, schema), columns: [] as ColumnSpec[] }));
      return submit(tblSpecs);
    }

    // Grant-sequences mode
    if (action === 'grant-sequences') {
      if (!grantSeqName.trim()) { setStatus({ msg: 'Enter the sequence name to grant on.', kind: 'error' }); return; }
      if (!seqGrantRole.trim()) { setStatus({ msg: 'Enter a role name for sequence GRANTs.', kind: 'error' }); return; }
      if (!seqGrantPrivs.length) { setStatus({ msg: 'Select at least one privilege for sequence GRANTs.', kind: 'error' }); return; }
      return submit([]);
    }

    // Sequence-only mode
    if (action === 'sequence') {
      if (!sequenceName.trim()) { setStatus({ msg: 'Enter sequence name.', kind: 'error' }); return; }
      if (seqGrantEnabled && (!seqGrantRole.trim() || !seqGrantPrivs.length)) {
        setStatus({ msg: 'Sequence GRANTs enabled: choose privileges and enter role.', kind: 'error' }); return;
      }
      return submit([]);
    }

    // Create-schema mode
    if (action === 'create-schema') {
      if (!schemaName.trim()) { setStatus({ msg: 'Enter schema name.', kind: 'error' }); return; }
      if (schemaGrantEnabled && (!schemaGrantRole.trim() || !schemaGrantPrivs.length)) {
        setStatus({ msg: 'Schema GRANTs enabled: choose privileges and enter role.', kind: 'error' }); return;
      }
      return submit([]);
    }

    // Create / Alter table
    if (!activeTables.length) { setStatus({ msg: 'Add at least one table.', kind: 'error' }); return; }
    for (const t of activeTables) {
      if (t.columns.some(c => c.name.trim() && !c.type.trim())) {
        setStatus({ msg: "Every column must have a type. Pick 'custom' and enter the full type + constraints.", kind: 'error' }); return;
      }
    }
    let tblSpecs: { table: string; columns: ColumnSpec[] }[];
    if (sameColumns) {
      const sharedCols = activeTables[0].columns.filter(c => c.name.trim() && c.type.trim());
      if (!sharedCols.length) { setStatus({ msg: 'Add at least one column to the first table.', kind: 'error' }); return; }
      tblSpecs = activeTables.map(t => ({ table: t.table.trim(), columns: sharedCols }));
    } else {
      tblSpecs = activeTables.map(t => ({ table: t.table.trim(), columns: t.columns.filter(c => c.name.trim() && c.type.trim()) })).filter(t => t.columns.length > 0);
      if (!tblSpecs.length) { setStatus({ msg: 'Add at least one column.', kind: 'error' }); return; }
    }
    if (schemaEnabled && !schemaName.trim()) { setStatus({ msg: 'Schema enabled: enter schema name (or fill Default schema to auto-fill).', kind: 'error' }); return; }
    if (schemaEnabled && schemaGrantEnabled && (!schemaGrantRole.trim() || !schemaGrantPrivs.length)) {
      setStatus({ msg: 'Schema GRANTs enabled: choose privileges and enter role.', kind: 'error' }); return;
    }
    if (tableGrantEnabled && (!tableGrantRole.trim() || !tableGrantPrivs.length)) {
      setStatus({ msg: 'Table GRANTs enabled: choose privileges and enter role.', kind: 'error' }); return;
    }
    if (sequenceEnabled && !sequenceName.trim()) { setStatus({ msg: 'Sequence enabled: enter sequence name.', kind: 'error' }); return; }
    if (sequenceEnabled && seqGrantEnabled && (!seqGrantRole.trim() || !seqGrantPrivs.length)) {
      setStatus({ msg: 'Sequence GRANTs enabled: choose privileges and enter role.', kind: 'error' }); return;
    }
    submit(tblSpecs);
  }, [action, defaultSchema, grantTableNames, tableGrantRole, tableGrantPrivs,
      grantSeqName, seqGrantRole, seqGrantPrivs, sequenceName, seqGrantEnabled,
      schemaName, schemaGrantEnabled, schemaGrantRole, schemaGrantPrivs,
      activeTables, sameColumns, schemaEnabled, tableGrantEnabled, sequenceEnabled,
      seqStart, seqIncrement, seqMin, seqMax, seqCache, changeNameHint,
      // submit carries Tags / Requires / Author: without it here, a metadata edit made last
      // was sent with the previous values (stale closure)
      submit]);


  const handleCancel = useCallback(() => { setStatus(null); setScreen('form'); postMsg({ type: 'cancel', payload: { form, goHome: true } }); }, [form]);

  // ── Visibility flags ────────────────────────────────────────
  const showTables = action === 'create' || action === 'alter';
  const showGrantTableNames = action === 'grant-tables';
  const showSchema = action === 'create' || action === 'alter' || action === 'create-schema';
  const showSequence = action === 'create' || action === 'alter' || action === 'sequence';
  const showTableGrants = action === 'create' || action === 'alter' || action === 'grant-tables';
  const showSequenceGrants = action === 'create' || action === 'alter' || action === 'sequence' || action === 'grant-sequences';
  const showGrantSeqName = action === 'grant-sequences';

  // ── Render ──────────────────────────────────────────────────
  if (!visible) return null;
  if (screen === 'progress') return <ProgressScreen message={progressMsg} streamChunk={streamChunk} />;
  if (screen === 'result' && changeData) return <ChangeCard change={changeData} form={form} />;

  return (
    <div className="ddl-page">
      {genError && <GenErrorBox error={genError} />}

      {/* Header */}
      <h2 className="ddl-hd">Schema builder <span className="ddl-badge">DDL</span> <span className="ddl-pill">PostgreSQL</span></h2>
      <div className="ddl-hint">
        Use <b>ALTER TABLE</b> to add columns safely (nullable first). Use <b>CREATE SEQUENCE</b> mode when you only need a sequence.
      </div>

      {/* Mode selector */}
      <div className="ddl-card">
        <div className="ddl-mode-row">
          <label className="ddl-field-label">Action</label>
          <StyledDropdown className="sd-action-fixed" items={ACTION_ITEMS} value={action} onChange={v => { setAction(v as TableAction); setStatus(null); }} />
          <label className="ddl-field-label">Schema <FieldHint text="The PostgreSQL schema that qualifies all generated objects. Use 'public' for the default schema." example="public, zapper, reporting" /></label>
          {availableSchemas.length > 0 ? (
            <StyledDropdown
              items={availableSchemas.map(s => ({ value: s, label: s }))}
              value={defaultSchema}
              onChange={setDefaultSchema}
            />
          ) : (
            <>
              <input className="ddl-input" value={defaultSchema} onChange={e => setDefaultSchema(e.target.value)} placeholder="Default schema (optional)" />
              <div style={{ fontSize: 10.5, color: 'var(--text-secondary, #64748b)', marginTop: 4 }}>
                Connect a DB MCP server in <em>Settings → MCP</em> to enable schema autocomplete.
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Grant table names (grant-tables mode) ────────────── */}
      {showGrantTableNames && (
        <div className="ddl-card">
          <div className="ddl-section-title">Tables to grant on</div>
          <textarea className="ddl-textarea" rows={4} value={grantTableNames} onChange={e => setGrantTableNames(e.target.value)}
            placeholder="One table per line or comma-separated, e.g. public.my_table" />
        </div>
      )}

      {/* ── Grant sequence name (grant-sequences mode) ────── */}
      {showGrantSeqName && (
        <div className="ddl-card">
          <div className="ddl-section-title">Sequence to grant on</div>
          <input className="ddl-input" value={grantSeqName} onChange={e => setGrantSeqName(e.target.value)}
            placeholder="schema.sequence_name" />
        </div>
      )}

      {/* ── Table definitions ───────────────────────────────── */}
      {showTables && (
        <div className="ddl-card">
          <div className="ddl-section-title">Tables</div>
          <label className="ddl-check-label">
            <CheckboxView checked={sameColumns} onChange={setSameColumns} size="sm" accentColor="#4f46e5" />
            Use same columns for all tables
          </label>
          {activeTables.map((tc, tIdx) => {
            const disabled = sameColumns && tIdx > 0;
            return (
              <div key={tc.id} className={`ddl-table-card${disabled ? ' disabled' : ''}`}>
                <div className="ddl-table-hdr">
                  <input className="ddl-input" value={tc.table} onChange={e => updateTableName(tc.id, e.target.value)}
                    placeholder={`Table name (e.g. ${defaultSchema || 'public'}.my_table)`} />
                  {activeTables.length > 1 && (
                    <button type="button" className="ddl-remove-btn" onClick={() => removeTable(tc.id)} title="Remove table">×</button>
                  )}
                </div>
                {tc.columns.map((col, cIdx) => (
                  <ColumnRow key={cIdx} col={col} disabled={disabled}
                    onChange={p => updateColumn(tc.id, cIdx, p)}
                    onRemove={() => removeColumn(tc.id, cIdx)} />
                ))}
                {!disabled && (
                  <button type="button" className="ddl-btn secondary small" onClick={() => addColumn(tc.id)}>&#x2795; Add column</button>
                )}
              </div>
            );
          })}
          <div className="ddl-top-actions">
            <button type="button" className="ddl-btn secondary" onClick={addTable}>&#x2795; Add table</button>
            <button type="button" className="ddl-btn secondary" onClick={duplicateTable}>&#x1F4CB; Duplicate last table</button>
          </div>
        </div>
      )}

      {/* ── Table GRANTs ───────────────────────────────────── */}
      {showTableGrants && (
        <GrantSection
          title="Table GRANTs"
          enabled={action === 'grant-tables' || tableGrantEnabled}
          onToggle={action === 'grant-tables' ? undefined : () => setTableGrantEnabled(v => !v)}
          role={tableGrantRole} onRoleChange={setTableGrantRole}
          privs={tableGrantPrivs} onTogglePriv={p => togglePriv(tableGrantPrivs, setTableGrantPrivs, p)}
          privOptions={['SELECT', 'INSERT', 'UPDATE', 'DELETE']}
        />
      )}

      {/* ── Schema ─────────────────────────────────────────── */}
      {showSchema && (
        <div className="ddl-card">
          <div className="ddl-section-title">Schema</div>
          {action !== 'create-schema' && (
            <label className="ddl-check-label">
              <CheckboxView checked={schemaEnabled} onChange={setSchemaEnabled} size="sm" accentColor="#4f46e5" />
              Create schema (if not exists)
            </label>
          )}
          <input className="ddl-input" value={schemaName}
            onChange={e => { setSchemaName(e.target.value); if (e.target.value) setSchemaNameManual(true); else setSchemaNameManual(false); }}
            placeholder="Schema name"
            disabled={action !== 'create-schema' && !schemaEnabled} />
          <GrantSection
            title="Schema GRANTs"
            enabled={schemaGrantEnabled} onToggle={() => setSchemaGrantEnabled(v => !v)}
            role={schemaGrantRole} onRoleChange={setSchemaGrantRole}
            privs={schemaGrantPrivs} onTogglePriv={p => togglePriv(schemaGrantPrivs, setSchemaGrantPrivs, p)}
            privOptions={['USAGE', 'CREATE']}
            disabled={action !== 'create-schema' && !schemaEnabled}
          />
        </div>
      )}

      {/* ── Sequence ───────────────────────────────────────── */}
      {showSequence && (
        <div className="ddl-card">
          <div className="ddl-section-title">Sequence</div>
          {action !== 'sequence' && (
            <label className="ddl-check-label">
              <CheckboxView checked={sequenceEnabled} onChange={setSequenceEnabled} size="sm" accentColor="#4f46e5" />
              Create sequence
            </label>
          )}
          <div className="ddl-seq-row">
            <input className="ddl-input" value={sequenceName} onChange={e => setSequenceName(e.target.value)}
              placeholder="Sequence name (schema.seq_name)" disabled={action !== 'sequence' && !sequenceEnabled} />
            <button type="button" className="ddl-btn secondary small" onClick={loadSeqExample}>&#x1F4CB; Load example</button>
          </div>
          <div className="ddl-seq-grid">
            <LabelledInput label="START WITH" value={seqStart} onChange={setSeqStart} disabled={action !== 'sequence' && !sequenceEnabled} />
            <LabelledInput label="INCREMENT BY" value={seqIncrement} onChange={setSeqIncrement} disabled={action !== 'sequence' && !sequenceEnabled} />
            <LabelledInput label="MINVALUE" value={seqMin} onChange={setSeqMin} disabled={action !== 'sequence' && !sequenceEnabled} />
            <LabelledInput label="MAXVALUE" value={seqMax} onChange={setSeqMax} disabled={action !== 'sequence' && !sequenceEnabled} />
            <LabelledInput label="CACHE" value={seqCache} onChange={setSeqCache} disabled={action !== 'sequence' && !sequenceEnabled} />
          </div>
        </div>
      )}

      {/* ── Sequence GRANTs ────────────────────────────────── */}
      {showSequenceGrants && (
        <GrantSection
          title="Sequence GRANTs"
          enabled={action === 'grant-sequences' || seqGrantEnabled}
          onToggle={action === 'grant-sequences' ? undefined : () => setSeqGrantEnabled(v => !v)}
          role={seqGrantRole} onRoleChange={setSeqGrantRole}
          privs={seqGrantPrivs} onTogglePriv={p => togglePriv(seqGrantPrivs, setSeqGrantPrivs, p)}
          privOptions={['USAGE', 'SELECT', 'UPDATE']}
          disabled={action !== 'grant-sequences' && action !== 'sequence' && !sequenceEnabled}
        />
      )}

      {/* Change name hint */}
      <div className="ddl-hint-card">
        <label className="ddl-col-label">Change name hint (optional) <FieldHint text="A short slug used as part of the generated change folder name. Lowercase letters, digits, and underscores only." example="add_email_column, create_audit_table" /></label>
        <input className="ddl-input" value={changeNameHint} onChange={e => setChangeNameHint(e.target.value)}
          placeholder="e.g. add_reporting_columns" />
        {changeNameHint && !/^[a-z][a-z0-9_]*$/.test(changeNameHint) && (
          <div className="ddl-field-warn">⚠ Use lowercase letters, digits and underscores only — must start with a letter</div>
        )}
      </div>

      {/* Metadata */}
      <div className="ddl-card">
        <div className="ddl-section-title">
          &#x1F3F7;&#xFE0F; Metadata <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(optional &mdash; AI fills if empty)</span>
        </div>
        <div className="ddl-col-field" style={{ marginBottom: 8 }}>
          <label className="ddl-col-label">Tags <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(comma-separated)</span></label>
          <input className="ddl-input" value={metaTags} onChange={e => setMetaTags(e.target.value)}
            placeholder="e.g. schema, hotfix" />
        </div>
        <div className="ddl-col-field" style={{ marginBottom: 8 }}>
          <label className="ddl-col-label">Requires <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(depends on these change IDs)</span></label>
          <MultiSelectDropdown
            items={existingChanges.map(c => ({ value: c, label: c }))}
            selected={metaRequires}
            onChange={setMetaRequires}
            placeholder="Select dependencies…"
            allowCustom
          />
        </div>
        <div className="ddl-col-field">
          <label className="ddl-col-label">Author <FieldHint text="Who is making this change. Stored in change metadata. Auto-filled from git config if left blank." example="jdoe, alice.smith" /></label>
          <input className="ddl-input" value={metaAuthor} onChange={e => setMetaAuthor(e.target.value)}
            placeholder="e.g. jdoe" />
        </div>
      </div>

      {/* Actions */}
      <div className="ddl-actions">
        <button type="button" className="ddl-btn primary" onClick={handleGenerate}>&#x1FA84; Generate DMCR request</button>
        <button type="button" className="ddl-btn danger" onClick={handleCancel}>&#x2715; Cancel</button>
      </div>
      {status && <div className={`ddl-status ${status.kind}`}>{status.msg}</div>}
    </div>
  );
}

/* ── Column row sub-component ──────────────────────────────────── */
function ColumnRow({ col, disabled, onChange, onRemove }: {
  col: ColumnSpec; disabled: boolean;
  onChange: (p: Partial<ColumnSpec>) => void; onRemove: () => void;
}) {
  const isCustom = col.type === '__custom__';
  const [customType, setCustomType] = useState('');

  const handleTypeChange = useCallback((val: string) => {
    if (val === '__custom__') {
      onChange({ type: '__custom__' });
    } else {
      onChange({ type: val });
    }
  }, [onChange]);

  const handleCustomBlur = useCallback(() => {
    if (customType.trim()) onChange({ type: customType.trim() });
  }, [customType, onChange]);

  return (
    <div className={`ddl-col-row${isCustom ? ' has-custom' : ''}`}>
      <div className="ddl-col-field">
        <label className="ddl-col-label">Column name</label>
        <input className="ddl-input" value={col.name} disabled={disabled}
          onChange={e => onChange({ name: e.target.value })} placeholder="column_name" />
      </div>
      <div className="ddl-col-field">
        <label className="ddl-col-label">Data type</label>
        <StyledDropdown items={COMMON_TYPES} value={isCustom ? '__custom__' : col.type} onChange={handleTypeChange} />
      </div>
      {isCustom && (
        <div className="ddl-col-field">
          <label className="ddl-col-label">Custom type</label>
          <input className="ddl-input" value={customType} disabled={disabled}
            onChange={e => setCustomType(e.target.value)} onBlur={handleCustomBlur}
            placeholder="e.g. numeric(12,2) NOT NULL" />
        </div>
      )}
      {!disabled && <button type="button" className="ddl-remove-btn" onClick={onRemove} title="Remove column">×</button>}
    </div>
  );
}

/* ── Grant section sub-component ───────────────────────────────── */
function GrantSection({ title, enabled, onToggle, role, onRoleChange, privs, onTogglePriv, privOptions, disabled }: {
  title: string; enabled: boolean; onToggle?: () => void;
  role: string; onRoleChange: (v: string) => void;
  privs: string[]; onTogglePriv: (p: string) => void;
  privOptions: string[]; disabled?: boolean;
}) {
  return (
    <div className={`ddl-grant-section${disabled ? ' disabled' : ''}`}>
      {onToggle && (
        <label className="ddl-check-label">
          <CheckboxView checked={enabled} onChange={() => onToggle()} disabled={disabled} size="sm" accentColor="#4f46e5" />
          {title}
        </label>
      )}
      {!onToggle && <div className="ddl-grant-title">{title}</div>}
      <input className="ddl-input" value={role} onChange={e => onRoleChange(e.target.value)}
        placeholder="Role name" disabled={!enabled || disabled} />
      <div className="ddl-priv-row">
        {privOptions.map(p => (
          <label key={p} className="ddl-check-label small">
            <CheckboxView checked={privs.includes(p)}
              onChange={() => onTogglePriv(p)} disabled={!enabled || disabled} size="sm" accentColor="#4f46e5" />
            {p}
          </label>
        ))}
      </div>
    </div>
  );
}

/* ── Labelled input ────────────────────────────────────────────── */
function LabelledInput({ label, value, onChange, disabled }: {
  label: string; value: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <div className="ddl-col-field">
      <label className="ddl-col-label">{label}</label>
      <input className="ddl-input" value={value} onChange={e => onChange(e.target.value)} disabled={disabled} />
    </div>
  );
}
