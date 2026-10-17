import { useState } from 'react';
import { BookOpenIcon, CheckIcon, CodeIcon, CopyIcon, DatabaseTableIcon, MarkdownView, MessageIcon, ServerIcon, SparkleIcon } from '@salilvnair/dui';
import './DefaultConversationalDMCRRenderer.css';

// ─── Which agent answered: its name, icon and colour on the card ─────────────

type AgentMeta = { label: string; icon: React.ComponentType<{ size?: number }>; color: string };
const AGENT_META: Record<string, AgentMeta> = {
  SqlFaqAgent:     { label: 'SQL answer',      icon: DatabaseTableIcon, color: 'var(--dm-c-38bdf8)' },
  McpToolAgent:    { label: 'Live database',   icon: ServerIcon,        color: 'var(--dm-c-22d3ee)' },
  WikiAgent:       { label: 'DMCR wiki',       icon: BookOpenIcon,      color: 'var(--dm-c-a78bfa)' },
  GeneralFaqAgent: { label: 'DMCR help',       icon: SparkleIcon,       color: 'var(--dm-c-818cf8)' },
  SqlRefineAgent:  { label: 'Refined SQL',     icon: CodeIcon,          color: 'var(--dm-c-34d399)' },
  Conversational:  { label: 'DMCR Assistant',  icon: MessageIcon,       color: 'var(--dm-c-818cf8)' },
};
const DEFAULT_META: AgentMeta = { label: 'DMCR Assistant', icon: SparkleIcon, color: 'var(--dm-c-818cf8)' };

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// ─── Component: every text reply as a card (icon, title, time, copy) ─────────

function DefaultConversationalDMCRRendererComponent({ payload, rawText }: { payload: unknown; rawText?: string; actions: unknown }) {
  const p = payload as Record<string, unknown> | null;
  const text = typeof p?.rawText === 'string'
    ? p.rawText
    : (typeof payload === 'string' ? payload : '');
  const agent = (typeof p?.agent === 'string' && AGENT_META[p.agent]) || DEFAULT_META;
  const ms = typeof p?.ms === 'number' ? p.ms : undefined;
  const [copied, setCopied] = useState(false);
  void rawText;

  return (
    <div className="dmcr-reply" style={{ '--agent': agent.color } as React.CSSProperties}>
      <div className="dmcr-reply-head">
        <span className="dmcr-reply-icon"><agent.icon size={15} /></span>
        <span className="dmcr-reply-title">{agent.label}</span>
        {ms != null && <span className="dmcr-reply-time">{secs(ms)}</span>}
        <span className="dmcr-reply-grow" />
        <button type="button" className={`dmcr-reply-copy${copied ? ' is-done' : ''}`} title={copied ? 'Copied' : 'Copy the answer (markdown)'}
          onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => undefined)}>
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        </button>
      </div>
      <div className="dmcr-reply-body dmcr-md-bubble">
        <MarkdownView content={text || ''} />
      </div>
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
