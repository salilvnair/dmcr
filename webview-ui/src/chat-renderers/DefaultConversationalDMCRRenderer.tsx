import { MarkdownView } from '@salilvnair/dui';
import './DefaultConversationalDMCRRenderer.css';

// ─── Agent badge config ───────────────────────────────────────────────────────

const AGENT_META: Record<string, { label: string; icon: string; color: string }> = {
  SqlFaqAgent:    { label: 'SQL FAQ Agent',     icon: '🔎', color: '#38bdf8' },
  WikiAgent:      { label: 'Wiki Agent',        icon: '📖', color: '#a78bfa' },
  DmcrGenerator:  { label: 'DMCR Generator',    icon: '⚙️',  color: '#34d399' },
  Conversational: { label: 'Conversational',    icon: '💬', color: '#94a3b8' },
};

// ─── Component ────────────────────────────────────────────────────────────────

function DefaultConversationalDMCRRendererComponent({ payload, rawText }: { payload: unknown; rawText?: string; actions: unknown }) {
  const p = payload as Record<string, unknown> | null;
  const text = typeof p?.rawText === 'string'
    ? p.rawText
    : (typeof payload === 'string' ? payload : '');
  const agentKey: string | undefined = p?.agent as string | undefined;
  const agent = agentKey ? AGENT_META[agentKey] : undefined;

  void rawText;

  return (
    <div className="dmcr-md-bubble">
      <MarkdownView content={text || ''} />
      {agent && (
        <div className="dmcr-agent-badge" title={`Answered by ${agent.label}`} style={{ '--agent-color': agent.color } as React.CSSProperties}>
          <span className="dmcr-agent-badge__icon">{agent.icon}</span>
          <span className="dmcr-agent-badge__label">{agent.label}</span>
        </div>
      )}
    </div>
  );
}

// ─── Renderer Definition ──────────────────────────────────────────────────────

export const defaultDmcrRendererProvider = {
  key: 'DefaultDmcrMarkdown',
  priority: 150,
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
