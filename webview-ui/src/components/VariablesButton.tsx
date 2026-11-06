import { useEffect, useState } from 'react';
import { IconButtonView } from '@salilvnair/dui';
import { postMsg } from '../vscode';

type Variable = { name: string; values: Record<string, string>; source: string };
type Variables = { envs: string[]; variables: Variable[] };

const CODE: React.CSSProperties = { fontSize: 10.5, color: 'var(--dm-c-818cf8)', background: 'color-mix(in srgb, var(--dm-c-6366f1) 12%, transparent)', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' };
const CELL: React.CSSProperties = { padding: '5px 12px 5px 0', textAlign: 'left', verticalAlign: 'top', whiteSpace: 'nowrap' };
const MUTED = 'var(--text-secondary, var(--dm-c-94a3b8))';

/** {x}: a variable */
const BracedXIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 2.5H4.2C3.3 2.5 2.8 3 2.8 3.9v2.4c0 .9-.4 1.4-1.3 1.7.9.3 1.3.8 1.3 1.7v2.4c0 .9.5 1.4 1.4 1.4H5" />
    <path d="M11 2.5h.8c.9 0 1.4.5 1.4 1.4v2.4c0 .9.4 1.4 1.3 1.7-.9.3-1.3.8-1.3 1.7v2.4c0 .9-.5 1.4-1.4 1.4H11" />
    <path d="M6.2 6l3.6 4M9.8 6l-3.6 4" />
  </svg>
);

/** Top bar: what ${name} a change file can use, and what each one becomes on each environment (read from dmcr.cfg on every open). */
export default function VariablesButton() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Variables | null>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'dmcrVariables') setData(e.data.payload); };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  useEffect(() => { if (open) postMsg({ type: 'getDmcrVariables' }); }, [open]);

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <IconButtonView size="md" icon={<BracedXIcon />} active={open} color="var(--dm-c-a5b4fc)" title="Variables" aria-label="Variables" onClick={() => setOpen(v => !v)} />
      {open && (
        <div
          style={{
            position: 'absolute', top: 28, right: 0, zIndex: 999, width: 'max-content', maxWidth: 'min(620px, 90vw)', overflowX: 'auto',
            background: 'var(--bs-surface, var(--dm-c-0f172a))', border: '1px solid color-mix(in srgb, var(--dm-c-6366f1) 30%, transparent)',
            borderRadius: 10, padding: '12px 16px', boxShadow: '0 8px 32px color-mix(in srgb, var(--dm-c-000000) 45%, transparent)', fontSize: 12,
          }}
          onMouseLeave={() => setOpen(false)}
        >
          <div style={{ fontWeight: 700, color: 'var(--dm-c-a5b4fc)', marginBottom: 4, fontSize: 11.5, letterSpacing: 0.4 }}>Variables</div>
          <div style={{ color: MUTED, marginBottom: 8, whiteSpace: 'normal' }}>Write these in deploy.sql, verify.sql and revert.sql. DMCR fills them in for the environment it runs on.</div>
          {data ? (
            <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: MUTED, fontSize: 10.5 }}>
                  <th style={CELL}>Variable</th>
                  {data.envs.map(e => <th key={e} style={CELL}>{e}</th>)}
                  <th style={CELL}>Set in</th>
                </tr>
              </thead>
              <tbody>
                {data.variables.map(v => (
                  <tr key={v.name}>
                    <td style={CELL}><code style={CODE}>{'${' + v.name + '}'}</code></td>
                    {data.envs.map(e => <td key={e} style={{ ...CELL, fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, color: v.values[e] ? undefined : 'var(--dm-c-fbbf24)' }}>{v.values[e] || 'not set'}</td>)}
                    <td style={{ ...CELL, color: MUTED }}>{v.source}</td>
                  </tr>
                ))}
                <tr>
                  <td style={CELL}><code style={CODE}>__DMCR_CHANGE_ID__</code></td>
                  <td colSpan={data.envs.length} style={{ ...CELL, color: MUTED }}>the change's id</td>
                  <td style={{ ...CELL, color: MUTED }}>filled in on save</td>
                </tr>
              </tbody>
            </table>
          ) : <div style={{ color: MUTED }}>Reading dmcr.cfg…</div>}
          <div style={{ color: MUTED, marginTop: 8, whiteSpace: 'normal' }}>Table and other object names need no variable: write them with no schema. A <code style={CODE}>{'${name}'}</code> with no value stops the deploy.</div>
        </div>
      )}
    </div>
  );
}
