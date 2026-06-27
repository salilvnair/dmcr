import React, { useState } from 'react';
import type { ProcessEntry } from '../../../types';

const TOP_N = 20;

export function ProcessListSection({
  processList, totalMem, fmtBytes,
}: { processList: ProcessEntry[]; totalMem: number; fmtBytes: (b: number) => string }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? processList : processList.slice(0, TOP_N);
  const maxMem = processList[0]?.mem ?? 1;

  return (
    <section>
      <div className="bs-info-section-title" style={{ marginBottom: 10 }}>
        Processes by Memory
        <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 10, color: '#64748b', textTransform: 'none' }}>
          — sorted desc, top {processList.length}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {shown.map((p, i) => {
          const barPct = totalMem > 0 ? (p.mem / totalMem) * 100 : 0;
          const barW   = Math.max(2, (p.mem / maxMem) * 100);
          const color  = barPct > 5 ? '#f87171' : barPct > 2 ? '#fbbf24' : barPct > 0.5 ? '#6366f1' : '#334155';
          return (
            <div key={`${p.pid}-${i}`} style={{
              display: 'grid', gridTemplateColumns: '20px 1fr 72px 56px',
              gap: 8, alignItems: 'center',
              padding: '4px 8px', borderRadius: 6,
              background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
            }}>
              <span style={{ fontSize: 10, color: '#475569', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {i + 1}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: 12, fontWeight: 500, color: 'var(--text-primary, #e2e8f0)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  marginBottom: 2,
                }} title={`PID ${p.pid}`}>
                  {p.name}
                </div>
                <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: barW + '%', background: color, borderRadius: 2, transition: 'width 300ms ease' }} />
                </div>
              </div>
              <span style={{ fontSize: 11.5, color: barPct > 5 ? '#f87171' : barPct > 2 ? '#fbbf24' : '#94a3b8', fontVariantNumeric: 'tabular-nums', textAlign: 'right', fontFamily: 'ui-monospace,Consolas,monospace' }}>
                {fmtBytes(p.mem)}
              </span>
              <span style={{ fontSize: 10.5, color: '#475569', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                {totalMem > 0 ? ((p.mem / totalMem) * 100).toFixed(1) + '%' : '—'}
              </span>
            </div>
          );
        })}
      </div>
      {processList.length > TOP_N && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            marginTop: 8, background: 'transparent', border: 'none',
            color: '#6366f1', fontSize: 11.5, cursor: 'pointer', padding: '4px 0',
          }}
        >
          {expanded ? `▲ Show fewer` : `▼ Show all ${processList.length} processes`}
        </button>
      )}
    </section>
  );
}
