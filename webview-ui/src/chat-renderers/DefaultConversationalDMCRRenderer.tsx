import { Fragment, useState } from 'react';
import {
  ArrowRightIcon, BookOpenIcon, ButtonView, CheckIcon, CodeIcon, CopyIcon, DatabaseIndexIcon, DatabaseTableIcon, FileTextIcon,
  FolderIcon, FolderOpenIcon, HashIcon, KeyIcon, LayersIcon, MarkdownView, MessageIcon, ServerIcon, SparkleIcon, TypeIcon, ColumnsIcon,
} from '@salilvnair/dui';
import './DefaultConversationalDMCRRenderer.css';

// ─── Which kind of answer: a short tag, icon and colour on the card (the title comes from the answer) ──

type AgentMeta = { label: string; icon: React.ComponentType<{ size?: number }>; color: string };
const AGENT_META: Record<string, AgentMeta> = {
  SqlFaqAgent:     { label: 'Database',       icon: DatabaseTableIcon, color: 'var(--dm-c-38bdf8)' },
  McpToolAgent:    { label: 'Live database',  icon: ServerIcon,        color: 'var(--dm-c-22d3ee)' },
  WikiAgent:       { label: 'DMCR docs',      icon: BookOpenIcon,      color: 'var(--dm-c-a78bfa)' },
  GeneralFaqAgent: { label: 'DMCR',           icon: SparkleIcon,       color: 'var(--dm-c-818cf8)' },
  SqlRefineAgent:  { label: 'Refined change', icon: CodeIcon,          color: 'var(--dm-c-34d399)' },
  Conversational:  { label: 'Assistant',      icon: MessageIcon,       color: 'var(--dm-c-818cf8)' },
};
const DEFAULT_META: AgentMeta = { label: 'Assistant', icon: SparkleIcon, color: 'var(--dm-c-818cf8)' };

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// ─── The answer's parts: "# title" first line, the body, "Next: a | b | c" last line ──────────────

export function parseReply(text: string): { title?: string; body: string; next: string[] } {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let title: string | undefined;
  const t = /^#{1,3}\s+(.+?)\s*#*$/.exec(lines[0] ?? '');
  if (t) { title = t[1].replace(/\*\*/g, '').trim(); lines.shift(); }
  let next: string[] = [];
  const n = /^\s*(?:\*\*)?next(?:\*\*)?\s*:\s*(.+)$/i.exec(lines[lines.length - 1] ?? '');
  if (n) {
    next = n[1].split('|').map(s => s.replace(/^[\s"'`*]+|[\s"'`*]+$/g, '')).filter(Boolean).slice(0, 3);
    lines.pop();
  }
  return { title, body: lines.join('\n').trim(), next };
}

// ─── ```tree blocks: an indented list drawn with folder / table / function icons ─────────────────

type TreeLine = { depth: number; label: string; kind: string; group: boolean };

function parseTree(src: string): TreeLine[] {
  return src.split('\n').filter(l => l.trim()).map(l => {
    const indent = (/^[\s│├└─|`-]*/.exec(l)?.[0] ?? '').replace(/[│├└─|`-]/g, ' ').length;
    let label = l.replace(/^[\s│├└─|`-]*/, '').trim();
    const group = label.endsWith('/');
    if (group) label = label.slice(0, -1);
    const k = /\s*\[([^\]]+)\]\s*$/.exec(label);
    const kind = k ? k[1].trim().toLowerCase() : group ? 'group' : /\(.*\)\s*$/.test(label) ? 'function' : '';
    if (k) label = label.slice(0, k.index).trim();
    return { depth: Math.floor(indent / 2), label, kind, group };
  });
}

function kindIcon(kind: string, group: boolean) {
  if (group) return <FolderOpenIcon size={13} />;
  if (/function|procedure|trigger/.test(kind)) return <CodeIcon size={13} />;
  if (/materialized|view/.test(kind)) return <LayersIcon size={13} />;
  if (/table/.test(kind)) return <DatabaseTableIcon size={13} />;
  if (/index/.test(kind)) return <DatabaseIndexIcon size={13} />;
  if (/sequence/.test(kind)) return <HashIcon size={13} />;
  if (/type|enum/.test(kind)) return <TypeIcon size={13} />;
  if (/column/.test(kind)) return <ColumnsIcon size={13} />;
  if (/key|constraint/.test(kind)) return <KeyIcon size={13} />;
  if (/schema|folder|release|project/.test(kind)) return <FolderIcon size={13} />;
  return <FileTextIcon size={13} />;
}

function TreeBlock({ src }: { src: string }) {
  const items = parseTree(src);
  return (
    <div className="dmcr-tree" role="tree">
      {items.map((it, i) => (
        <div key={i} role="treeitem" className={`dmcr-tree-row${it.group ? ' is-group' : ''}`} style={{ paddingLeft: 8 + it.depth * 18 }}>
          {it.depth > 0 && <span className="dmcr-tree-guide" style={{ left: 8 + (it.depth - 1) * 18 + 6 }} />}
          <span className="dmcr-tree-icon">{kindIcon(it.kind, it.group)}</span>
          <span className="dmcr-tree-label">{it.label}</span>
          {it.kind && !it.group && <span className="dmcr-tree-kind">{it.kind}</span>}
        </div>
      ))}
    </div>
  );
}

/** The body as markdown, with each ```tree block drawn as a tree */
function Body({ text }: { text: string }) {
  const parts = text.split(/```tree[^\n]*\n([\s\S]*?)```/g);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1
        ? <TreeBlock key={i} src={p} />
        : p.trim() ? <Fragment key={i}><MarkdownView content={p} /></Fragment> : null))}
    </>
  );
}

// ─── Component: every text reply as a card (icon, title, kind, time, copy, follow-ups) ──────────

type Actions = { submit?: (text: string, inputParams?: Record<string, unknown>) => void } | undefined;

function DefaultConversationalDMCRRendererComponent({ payload, rawText, actions }: { payload: unknown; rawText?: string; actions: unknown }) {
  const p = payload as Record<string, unknown> | null;
  const text = typeof p?.rawText === 'string'
    ? p.rawText
    : (typeof payload === 'string' ? payload : '');
  const agent = (typeof p?.agent === 'string' && AGENT_META[p.agent]) || DEFAULT_META;
  const ms = typeof p?.ms === 'number' ? p.ms : undefined;
  const [copied, setCopied] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  void rawText;
  const { title, body, next } = parseReply(text);
  const submit = (actions as Actions)?.submit;

  return (
    <div className="dmcr-reply" style={{ '--agent': agent.color } as React.CSSProperties}>
      <div className="dmcr-reply-head">
        <span className="dmcr-reply-icon"><agent.icon size={15} /></span>
        <span className="dmcr-reply-title">{title || agent.label}</span>
        {title && <span className="dmcr-reply-kind">{agent.label}</span>}
        {ms != null && <span className="dmcr-reply-time">{secs(ms)}</span>}
        <span className="dmcr-reply-grow" />
        <button type="button" className={`dmcr-reply-copy${copied ? ' is-done' : ''}`} title={copied ? 'Copied' : 'Copy the answer (markdown)'}
          onClick={() => navigator.clipboard?.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => undefined)}>
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        </button>
      </div>
      <div className="dmcr-reply-body dmcr-md-bubble">
        <Body text={body} />
      </div>
      {next.length > 0 && typeof submit === 'function' && (
        <div className="dmcr-reply-next">
          {next.map(q => (
            <ButtonView key={q} size="md" variant="secondary" iconRight={<ArrowRightIcon size={12} />} label={q}
              disabled={asked !== null} title={`Ask: ${q}`}
              onClick={() => { setAsked(q); submit(q); }} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Renderer Definition ──────────────────────────────────────────────────────

export const defaultDmcrRendererProvider = {
  key: 'DefaultDmcrMarkdown',
  priority: 150,
  // the card is the bubble: no grey library bubble around it
  hideBubble: true,
  match: ({ effectiveType, payload }: { effectiveType: string; rawText: string; payload: unknown }) => {
    if (effectiveType === 'DmcrChange') return false;
    if (effectiveType === 'DmcrMetadataForm') return false;
    if (effectiveType === 'SchemaServerPicker') return false;
    const p = payload as Record<string, unknown> | null;
    if (effectiveType === 'text' && typeof p?.rawText === 'string' && p.rawText.trim().length > 0) return true;
    if (typeof payload === 'string' && (payload as string).trim().length > 0) return true;
    return false;
  },
  Component: DefaultConversationalDMCRRendererComponent,
};
