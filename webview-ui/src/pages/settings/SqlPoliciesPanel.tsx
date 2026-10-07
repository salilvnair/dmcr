import React, { useState, useEffect, useCallback } from 'react';
import { ShieldCheckIcon } from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import type { ToastData } from '../../App';

interface Props {
  addToast: (msg: string, type?: ToastData['type']) => void;
}

const EXAMPLE_POLICIES = [
  'All tables must have a created_at column',
  "Never DROP without a -- reason: comment",
  'ALTER TABLE ADD COLUMN must be nullable or have a DEFAULT',
  'No TRUNCATE in deploy.sql',
  'All foreign key columns must have an index',
];

export function SqlPoliciesPanel({ addToast }: Props) {
  const [policies, setPolicies] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newPolicy, setNewPolicy] = useState('');
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editVal, setEditVal] = useState('');

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === 'sqlPoliciesResult') {
        setPolicies(msg.payload?.policies ?? []);
        setLoading(false);
      }
      if (msg?.type === 'sqlPoliciesSaved') {
        setSaving(false);
        addToast('SQL policies saved', 'ok');
      }
    };
    window.addEventListener('message', handler);
    postMsg({ type: 'getSqlPolicies' });
    return () => window.removeEventListener('message', handler);
  }, [addToast]);

  const handleSave = useCallback((updated: string[]) => {
    setSaving(true);
    postMsg({ type: 'saveSqlPolicies', payload: { policies: updated } });
    setPolicies(updated);
  }, []);

  const handleAdd = () => {
    const trimmed = newPolicy.trim();
    if (!trimmed) return;
    const updated = [...policies, trimmed];
    handleSave(updated);
    setNewPolicy('');
  };

  const handleDelete = (idx: number) => {
    const updated = policies.filter((_, i) => i !== idx);
    handleSave(updated);
  };

  const handleEditCommit = (idx: number) => {
    const trimmed = editVal.trim();
    if (!trimmed) return;
    const updated = policies.map((p, i) => (i === idx ? trimmed : p));
    handleSave(updated);
    setEditIdx(null);
    setEditVal('');
  };

  const handleAddExample = (ex: string) => {
    if (policies.includes(ex)) return;
    const updated = [...policies, ex];
    handleSave(updated);
  };

  return (
    <div style={{ padding: '20px 24px', maxWidth: 720, fontFamily: 'sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 20 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(220,38,38,0.12)', border: '1px solid rgba(220,38,38,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#f87171' }}><ShieldCheckIcon size={20} /></div>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #e2e8f0)' }}>SQL Policies</h2>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: '#64748b', lineHeight: 1.45 }}>
            Rules that AI enforces before saving any generated change. Violations appear as inline banners in each change card.
          </p>
        </div>
      </div>

      {/* Add new policy */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          value={newPolicy}
          onChange={e => setNewPolicy(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          placeholder='e.g. "All tables must have a created_at column"'
          style={{
            flex: 1, padding: '7px 11px', borderRadius: 7, fontSize: 12,
            border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-primary, #e2e8f0)', outline: 'none',
          }}
        />
        <button
          onClick={handleAdd}
          disabled={!newPolicy.trim() || saving}
          style={{
            padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            background: 'rgba(220,38,38,0.15)', border: '1px solid rgba(220,38,38,0.35)', color: '#f87171',
            opacity: !newPolicy.trim() ? 0.5 : 1,
          }}
        >+ Add Policy</button>
      </div>

      {/* Policy list */}
      {loading ? (
        <div style={{ padding: '20px 0', textAlign: 'center', color: '#64748b', fontSize: 12 }}>Loading policies…</div>
      ) : policies.length === 0 ? (
        <div style={{ padding: '16px 14px', borderRadius: 8, border: '1px dashed rgba(220,38,38,0.2)', background: 'rgba(220,38,38,0.03)', color: '#64748b', fontSize: 12, textAlign: 'center' }}>
          No policies defined. Add your first policy above or use an example below.
        </div>
      ) : (
        <div style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden', marginBottom: 16 }}>
          {policies.map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: i < policies.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none', background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
              <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'rgba(220,38,38,0.12)', border: '1px solid rgba(220,38,38,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#f87171', fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
              {editIdx === i ? (
                <>
                  <input
                    autoFocus
                    value={editVal}
                    onChange={e => setEditVal(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleEditCommit(i); if (e.key === 'Escape') { setEditIdx(null); setEditVal(''); } }}
                    style={{ flex: 1, padding: '4px 8px', borderRadius: 5, fontSize: 12, border: '1px solid rgba(220,38,38,0.4)', background: 'rgba(220,38,38,0.06)', color: '#e2e8f0', outline: 'none' }}
                  />
                  <button onClick={() => handleEditCommit(i)} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(74,222,128,0.3)', background: 'rgba(74,222,128,0.08)', color: '#4ade80', cursor: 'pointer' }}>Save</button>
                  <button onClick={() => { setEditIdx(null); setEditVal(''); }} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.1)', background: 'none', color: '#64748b', cursor: 'pointer' }}>Cancel</button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, fontSize: 12, color: '#cbd5e1', lineHeight: 1.45 }}>{p}</span>
                  <button onClick={() => { setEditIdx(i); setEditVal(p); }} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(129,140,248,0.3)', background: 'rgba(99,102,241,0.08)', color: '#818cf8', cursor: 'pointer', flexShrink: 0 }}>Edit</button>
                  <button onClick={() => handleDelete(i)} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.06)', color: '#f87171', cursor: 'pointer', flexShrink: 0 }}>✕</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Examples */}
      <div style={{ marginTop: 20, padding: '14px 16px', borderRadius: 8, background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.15)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#818cf8', marginBottom: 8, letterSpacing: 0.3 }}>EXAMPLE POLICIES</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {EXAMPLE_POLICIES.map(ex => {
            const already = policies.includes(ex);
            return (
              <div key={ex} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, fontSize: 11.5, color: already ? '#4ade80' : '#94a3b8' }}>{already ? '✓ ' : ''}{ex}</span>
                {!already && (
                  <button
                    onClick={() => handleAddExample(ex)}
                    style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.08)', color: '#818cf8', cursor: 'pointer', flexShrink: 0 }}
                  >Add</button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Info box */}
      <div style={{ marginTop: 16, padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
        <span style={{ color: '#f87171', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4, verticalAlign: 'middle' }}><ShieldCheckIcon size={12} />How it works: </span>
        Policies are checked by AI every time a change card loads in DMCR Copilot. The AI reads your deploy SQL and evaluates it against each policy. Violations show as a red/amber banner between the change name and the SQL tabs. Policies are stored locally in the DMCR SQLite database.
      </div>

      {saving && (
        <div style={{ marginTop: 10, fontSize: 11, color: '#818cf8' }}>Saving…</div>
      )}
    </div>
  );
}
