import { useEffect, useState } from 'react';
import { ArrowRightIcon, ButtonView, CameraIcon, CheckCircleIcon, CheckIcon, ModalView, RadioCardView, XCircleIcon } from '@salilvnair/dui';
import { getVsCodeApi } from '../vscode';

/**
 * Snapshot table — creates a change folder that copies a table into
 * <table>_backup_DD_MM_YYYY (src/services/snapshot/table-snapshot.ts writes the SQL).
 * The structure and row counts are read live through the table's MCP server.
 */

export interface SnapshotTarget { serverId?: string; schema: string; table: string }

interface Info {
  server?: string;
  columns?: { name: string; type: string; notNull: boolean }[];
  primaryKey?: string[];
  rowCount?: number;
  suggestedName?: string;
  error?: string;
}

type Rows = 'all' | 'where' | 'none';

const box: React.CSSProperties = { fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 10 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 11.5, padding: '5px 8px', borderRadius: 4, border: '1px solid rgba(148,163,184,0.3)', background: 'rgba(0,0,0,0.2)', color: 'inherit' };

export default function TableSnapshotModal({ target, onClose }: { target: SnapshotTarget | null; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [rows, setRows] = useState<Rows>('all');
  const [where, setWhere] = useState('');
  const [whereCount, setWhereCount] = useState<{ count?: number; error?: string; where?: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ folderRel?: string; backup?: string; rowsAtGeneration?: number; error?: string } | null>(null);

  useEffect(() => {
    if (!target) return;
    setInfo(null); setRows('all'); setWhere(''); setWhereCount(null); setName(''); setResult(null); setBusy(false);
    getVsCodeApi().postMessage({ type: 'snapshotTablePrepare', payload: target });
  }, [target]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'tableSnapshotInfo') {
        setInfo(msg.payload);
        if (msg.payload?.suggestedName) setName(msg.payload.suggestedName);
      } else if (msg?.type === 'tableSnapshotCount') {
        setWhereCount(msg.payload);
      } else if (msg?.type === 'tableSnapshotCreated') {
        setBusy(false);
        setResult(msg.payload);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  if (!target) return null;
  const qualified = `${target.schema}.${target.table}`;
  const canCreate = !!info && !info.error && !busy && !result?.folderRel && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && (rows !== 'where' || where.trim().length > 0);

  const create = () => {
    setBusy(true); setResult(null);
    getVsCodeApi().postMessage({ type: 'createTableSnapshot', payload: { ...target, rows, where: rows === 'where' ? where : undefined, backupName: name } });
  };

  return (
    <ModalView
      open={!!target}
      onClose={onClose}
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><CameraIcon size={16} />{`Snapshot table — ${qualified}`}</span>}
      headerColor="#38bdf8"
      size="lg"
      footerRight={result?.folderRel
        ? <ButtonView variant="secondary" iconLeft={<CheckIcon size={13} />} label="Done" onClick={onClose} />
        : <ButtonView variant="primary" accentColor="#38bdf8" iconLeft={<CameraIcon size={13} />} label={busy ? 'Creating…' : 'Create change folder'} loading={busy} disabled={!canCreate} onClick={create} />}
    >
      <div style={box} data-testid="table-snapshot">
        {!info && <div style={{ color: '#94a3b8' }}>Reading {qualified}…</div>}
        {info?.error && <div style={{ color: '#f87171', display: 'flex', alignItems: 'center', gap: 6 }}><XCircleIcon size={13} />{info.error}</div>}
        {info && !info.error && (
          <>
            <div style={{ color: '#94a3b8' }}>
              {info.server} · {info.columns?.length} columns · primary key {info.primaryKey?.length ? `(${info.primaryKey.join(', ')})` : 'none'} · <strong style={{ color: '#e2e8f0' }}>{info.rowCount?.toLocaleString()}</strong> rows now
            </div>

            <div>
              <div style={{ marginBottom: 4, fontWeight: 600 }}>Backup table</div>
              <input style={input} value={name} onChange={e => setName(e.target.value)} spellCheck={false} aria-label="Backup table name" />
              <div style={{ color: '#64748b', marginTop: 3 }}>Created in schema {target.schema}. Same columns and exact types, NOT NULL and primary key; no defaults, indexes, triggers or foreign keys.</div>
            </div>

            <div>
              <div style={{ marginBottom: 4, fontWeight: 600 }}>Rows</div>
              <RadioCardView
                testId="snapshot-rows"
                size="sm"
                accentColor="#38bdf8"
                columns={3}
                value={rows}
                onChange={v => setRows(v as Rows)}
                options={[
                  { value: 'all', label: 'All rows', description: 'DDL + DML' },
                  { value: 'where', label: 'Matching rows', description: 'DDL + DML with a WHERE condition' },
                  { value: 'none', label: 'Structure only', description: 'DDL, no rows' },
                ]}
              />
              {rows === 'where' && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
                  <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>WHERE</span>
                  <input style={input} value={where} onChange={e => { setWhere(e.target.value); setWhereCount(null); }} placeholder="status = 'active'" spellCheck={false} aria-label="WHERE condition" />
                  <ButtonView variant="secondary" label="Count" disabled={!where.trim()} onClick={() => getVsCodeApi().postMessage({ type: 'snapshotTableCount', payload: { ...target, where } })} />
                </div>
              )}
              {rows === 'where' && whereCount && whereCount.where === where && (
                <div style={{ marginTop: 3, color: whereCount.error ? '#f87171' : '#4ade80', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {whereCount.error ? <XCircleIcon size={13} /> : <CheckCircleIcon size={13} />}
                  {whereCount.error ? whereCount.error : `${whereCount.count?.toLocaleString()} rows match now`}
                </div>
              )}
            </div>

            <div style={{ color: '#64748b' }}>
              Writes a change folder with deploy.sql (CREATE TABLE + INSERT … SELECT + row count recorded on the table),
              verify.sql (copy present with that row count when applied, gone when reverted) and revert.sql (DROP TABLE of the copy only).
              The copy is taken when the change deploys — run it in each environment through the normal pipeline.
              Deploy stops if the table's columns have changed since now (for example a column added by an earlier
              change in the same release), so read the table from the environment where it already looks the way it
              will when this change runs.
            </div>
          </>
        )}
        {result?.error && <div style={{ color: '#f87171', display: 'flex', alignItems: 'center', gap: 6 }}><XCircleIcon size={13} />{result.error}</div>}
        {result?.folderRel && (
          <div style={{ color: '#4ade80' }}>
            <CheckCircleIcon size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />Created <span style={{ fontFamily: 'monospace' }}>{result.folderRel}</span> <ArrowRightIcon size={12} style={{ verticalAlign: '-1px' }} /> {result.backup}
            {rows !== 'none' && <> ({result.rowsAtGeneration?.toLocaleString()} rows match now)</>}
          </div>
        )}
      </div>
    </ModalView>
  );
}
