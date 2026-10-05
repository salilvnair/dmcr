import { useState } from 'react';
import MultiSelectDropdown from '../components/MultiSelectDropdown';
import './DmcrMetadataFormRenderer.css';

/**
 * DmcrMetadataForm Renderer
 *
 * Shown as a follow-up after the AI generates a DMCR change in conversation mode.
 * Auto-populates metadata (tags, requires, author) from AI analysis of:
 * - The deploy SQL content
 * - Previous changes in the workspace
 * - User/git identity
 *
 * The user can edit all fields before confirming. The submitted data is passed
 * back to the extension which merges it into the DmcrChange payload's metaJson.
 *
 * Payload shape from extension:
 * {
 *   type: "DmcrMetadataForm",
 *   changeName: string,
 *   suggestedTags: string[],
 *   suggestedRequires: string[],
 *   suggestedAuthor: string,
 *   suggestedDescription: string,
 *   existingChanges: string[],  // for autocomplete hints
 * }
 */

interface DmcrMetadataFormPayload {
  type: 'DmcrMetadataForm';
  /** Identifies the pending generation on the host, so confirming this form generates THIS request. */
  pendingId?: string;
  changeName: string;
  suggestedTags: string[];
  suggestedRequires: string[];
  suggestedAuthor: string;
  suggestedDescription: string;
  existingChanges?: string[];
}

interface Actions {
  submit: (displayText: string, inputParams: Record<string, unknown>) => void;
  submitSilent: (inputParams: Record<string, unknown>) => void;
  appendBubble: (text: string, role?: string) => void;
}

function DmcrMetadataFormComponent({ payload, actions }: { payload: DmcrMetadataFormPayload; actions: Actions }) {
  const [tags, setTags] = useState(payload.suggestedTags?.join(', ') ?? '');
  const [requires, setRequires] = useState<string[]>(payload.suggestedRequires ?? []);
  const [author, setAuthor] = useState(payload.suggestedAuthor ?? '');
  const [ticket, setTicket] = useState('');
  const [description, setDescription] = useState(payload.suggestedDescription ?? '');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = () => {
    setSubmitted(true);
    const metaData = {
      change_id: payload.changeName,
      description: description.trim(),
      tags: tags.split(/,\s*/).filter(Boolean),
      requires: requires,
      author: author.trim(),
      // change request id, recorded in dmcr.change_log.ticket_id at deploy
      ...(ticket.trim() ? { ticket: ticket.trim() } : {}),
    };
    actions.submitSilent({
      action: 'metadata_confirmed',
      pendingId: payload.pendingId,
      changeName: payload.changeName,
      metadata: metaData,
    });
  };

  const handleSkip = () => {
    setSubmitted(true);
    actions.submitSilent({
      action: 'metadata_skipped',
      pendingId: payload.pendingId,
      changeName: payload.changeName,
    });
  };

  if (submitted) {
    return (
      <div className="dmcr-meta-form" style={{ opacity: 0.7 }}>
        <div className="dmcr-meta-form__hd">
          <span className="dmcr-meta-form__icon">✅</span>
          <span className="dmcr-meta-form__title">Metadata confirmed — generating change…</span>
        </div>
        {tags && (
          <div className="dmcr-meta-form__tag-chips">
            {tags.split(/,\s*/).filter(Boolean).map(t => (
              <span key={t} className="dmcr-meta-form__chip">{t}</span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="dmcr-meta-form">
      <div className="dmcr-meta-form__hd">
        <span className="dmcr-meta-form__icon">🏷️</span>
        <span className="dmcr-meta-form__title">Change Metadata</span>
      </div>
      <div className="dmcr-meta-form__subtitle">
        Before I generate, let me know the metadata for this change. Fields are auto-populated — edit as needed.
      </div>

      {/* Description */}
      <div className="dmcr-meta-form__field">
        <label className="dmcr-meta-form__label">
          <span className="dmcr-meta-form__label-icon">📝</span> Description
        </label>
        <input
          className="dmcr-meta-form__input"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Brief summary of this change"
        />
      </div>

      {/* Tags */}
      <div className="dmcr-meta-form__field">
        <label className="dmcr-meta-form__label">
          <span className="dmcr-meta-form__label-icon">🏷️</span> Tags (comma-separated)
        </label>
        <input
          className="dmcr-meta-form__input"
          value={tags}
          onChange={e => setTags(e.target.value)}
          placeholder="e.g. schema, ddl, hotfix"
        />
        {payload.suggestedTags && payload.suggestedTags.length > 0 && (
          <div className="dmcr-meta-form__tag-chips">
            {payload.suggestedTags.map(t => (
              <span key={t} className="dmcr-meta-form__chip">{t}</span>
            ))}
          </div>
        )}
      </div>

      {/* Ticket */}
      <div className="dmcr-meta-form__field">
        <label className="dmcr-meta-form__label">
          <span className="dmcr-meta-form__label-icon">🎫</span> Ticket (change request)
        </label>
        <input
          className="dmcr-meta-form__input"
          value={ticket}
          onChange={e => setTicket(e.target.value)}
          placeholder="e.g. SHOP-142"
        />
      </div>

      {/* Requires */}
      <div className="dmcr-meta-form__field">
        <label className="dmcr-meta-form__label">
          <span className="dmcr-meta-form__label-icon">🔗</span> Requires (dependencies)
        </label>
        <MultiSelectDropdown
          items={(payload.existingChanges ?? []).map(c => ({ value: c, label: c }))}
          selected={requires}
          onChange={setRequires}
          placeholder="Select dependencies…"
          allowCustom
        />
      </div>

      {/* Author */}
      <div className="dmcr-meta-form__field">
        <label className="dmcr-meta-form__label">
          <span className="dmcr-meta-form__label-icon">👤</span> Author
        </label>
        <input
          className="dmcr-meta-form__input"
          value={author}
          onChange={e => setAuthor(e.target.value)}
          placeholder="Your name or team alias"
        />
      </div>

      {/* Actions */}
      <div className="dmcr-meta-form__actions">
        <button className="dmcr-meta-form__submit" onClick={handleSubmit}>
          ✓ Confirm &amp; Generate
        </button>
        <button className="dmcr-meta-form__skip" onClick={handleSkip}>
          Skip — generate without metadata
        </button>
      </div>
    </div>
  );
}

// ─── Renderer Provider ────────────────────────────────────────────────────────

export const dmcrMetadataFormRendererProvider = {
  key: 'DmcrMetadataForm',
  priority: 290,  // just below DmcrChange (300)
  hideBubble: true,
  match: ({ payload, effectiveType }: { payload: any; effectiveType: string }) => {
    if (effectiveType === 'DmcrMetadataForm') return true;
    if (!payload || typeof payload !== 'object') return false;
    return payload.type === 'DmcrMetadataForm' && typeof payload.changeName === 'string';
  },
  Component: DmcrMetadataFormComponent,
};
