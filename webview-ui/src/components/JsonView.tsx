/**
 * Postman-style JSON viewer — adapted from DevTrack JsonView.jsx.
 * Renders JSON with syntax-colored keys, values, and collapsible sections.
 */
import { useState, CSSProperties } from 'react';

const COLORS = {
  key:   'var(--dt-json-key, #8b5cf6)',
  str:   'var(--dt-json-str, #22c55e)',
  num:   'var(--dt-json-num, #f59e0b)',
  bool:  'var(--dt-json-bool, #3b82f6)',
  null_: 'var(--dt-json-null, #ef4444)',
  punct: 'var(--dt-json-punct, var(--dt-text-muted, #888))',
};

interface JsonViewProps {
  value: unknown;
  collapsible?: boolean;
  defaultExpanded?: number;
  style?: CSSProperties;
}

export default function JsonView({ value, collapsible = true, defaultExpanded = 2, style = {} }: JsonViewProps) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch {
      return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: 12, ...style }}>{value}</pre>;
    }
  }
  if (parsed == null) return <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, ...style }}>null</pre>;
  return (
    <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6, ...style }}>
      {collapsible ? renderCollapsible(parsed, 0, defaultExpanded) : renderValue(parsed, 0)}
    </pre>
  );
}

function renderValue(v: unknown, depth: number): React.ReactNode {
  if (v === null) return <span style={{ color: COLORS.null_ }}>null</span>;
  if (typeof v === 'boolean') return <span style={{ color: COLORS.bool }}>{String(v)}</span>;
  if (typeof v === 'number') return <span style={{ color: COLORS.num }}>{String(v)}</span>;
  if (typeof v === 'string') return <span style={{ color: COLORS.str }}>"{v}"</span>;
  if (Array.isArray(v)) return renderArray(v, depth);
  if (typeof v === 'object' && v !== null) return renderObject(v as Record<string, unknown>, depth);
  return <span>{String(v)}</span>;
}

function renderArray(arr: unknown[], depth: number): React.ReactNode {
  if (arr.length === 0) return <span style={{ color: COLORS.punct }}>[]</span>;
  return (
    <>
      <span style={{ color: COLORS.punct }}>[</span>
      {arr.map((v, i) => (
        <div key={i} style={{ paddingLeft: (depth + 1) * 16 }}>
          {renderValue(v, depth + 1)}
          {i < arr.length - 1 && <span style={{ color: COLORS.punct }}>,</span>}
        </div>
      ))}
      <div style={{ paddingLeft: depth * 16 }}><span style={{ color: COLORS.punct }}>]</span></div>
    </>
  );
}

function renderObject(obj: Record<string, unknown>, depth: number): React.ReactNode {
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span style={{ color: COLORS.punct }}>{'{}'}</span>;
  return (
    <>
      <span style={{ color: COLORS.punct }}>{'{'}</span>
      {entries.map(([k, v], i) => (
        <div key={k} style={{ paddingLeft: (depth + 1) * 16 }}>
          <span style={{ color: COLORS.key }}>"{k}"</span>
          <span style={{ color: COLORS.punct }}>: </span>
          {renderValue(v, depth + 1)}
          {i < entries.length - 1 && <span style={{ color: COLORS.punct }}>,</span>}
        </div>
      ))}
      <div style={{ paddingLeft: depth * 16 }}><span style={{ color: COLORS.punct }}>{'}'}</span></div>
    </>
  );
}

/* ── Collapsible variants ── */

function renderCollapsible(v: unknown, depth: number, maxOpen: number): React.ReactNode {
  if (v === null) return <span style={{ color: COLORS.null_ }}>null</span>;
  if (typeof v === 'boolean') return <span style={{ color: COLORS.bool }}>{String(v)}</span>;
  if (typeof v === 'number') return <span style={{ color: COLORS.num }}>{String(v)}</span>;
  if (typeof v === 'string') return <span style={{ color: COLORS.str }}>"{v}"</span>;
  if (Array.isArray(v)) return <ColArray arr={v} depth={depth} maxOpen={maxOpen} />;
  if (typeof v === 'object' && v !== null) return <ColObject obj={v as Record<string, unknown>} depth={depth} maxOpen={maxOpen} />;
  return <span>{String(v)}</span>;
}

function ColArray({ arr, depth, maxOpen }: { arr: unknown[]; depth: number; maxOpen: number }) {
  const [open, setOpen] = useState(depth < maxOpen);
  if (arr.length === 0) return <span style={{ color: COLORS.punct }}>[]</span>;
  if (!open) {
    return (
      <span>
        <button onClick={() => setOpen(true)} style={{ background: 'none', border: 'none', color: COLORS.punct, cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, padding: '0 2px' }}>▶</button>
        <span style={{ color: COLORS.punct }}>[</span>
        <span onClick={() => setOpen(true)} style={{ color: 'var(--dt-text-muted)', cursor: 'pointer', fontSize: 11 }}> {arr.length} items </span>
        <span style={{ color: COLORS.punct }}>]</span>
      </span>
    );
  }
  return (
    <>
      <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: COLORS.punct, cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, padding: '0 2px' }}>▼</button>
      <span style={{ color: COLORS.punct }}>[</span>
      {arr.map((v, i) => (
        <div key={i} style={{ paddingLeft: (depth + 1) * 16 }}>
          {renderCollapsible(v, depth + 1, maxOpen)}
          {i < arr.length - 1 && <span style={{ color: COLORS.punct }}>,</span>}
        </div>
      ))}
      <div style={{ paddingLeft: depth * 16 }}><span style={{ color: COLORS.punct }}>]</span></div>
    </>
  );
}

function ColObject({ obj, depth, maxOpen }: { obj: Record<string, unknown>; depth: number; maxOpen: number }) {
  const [open, setOpen] = useState(depth < maxOpen);
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span style={{ color: COLORS.punct }}>{'{}'}</span>;
  if (!open) {
    return (
      <span>
        <button onClick={() => setOpen(true)} style={{ background: 'none', border: 'none', color: COLORS.punct, cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, padding: '0 2px' }}>▶</button>
        <span style={{ color: COLORS.punct }}>{'{'}</span>
        <span onClick={() => setOpen(true)} style={{ color: 'var(--dt-text-muted)', cursor: 'pointer', fontSize: 11 }}> {entries.length} keys </span>
        <span style={{ color: COLORS.punct }}>{'}'}</span>
      </span>
    );
  }
  return (
    <>
      <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: COLORS.punct, cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, padding: '0 2px' }}>▼</button>
      <span style={{ color: COLORS.punct }}>{'{'}</span>
      {entries.map(([k, v], i) => (
        <div key={k} style={{ paddingLeft: (depth + 1) * 16 }}>
          <span style={{ color: COLORS.key }}>"{k}"</span>
          <span style={{ color: COLORS.punct }}>: </span>
          {renderCollapsible(v, depth + 1, maxOpen)}
          {i < entries.length - 1 && <span style={{ color: COLORS.punct }}>,</span>}
        </div>
      ))}
      <div style={{ paddingLeft: depth * 16 }}><span style={{ color: COLORS.punct }}>{'}'}</span></div>
    </>
  );
}
