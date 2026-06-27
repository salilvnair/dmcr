import { useState } from 'react';
import './DmcrSchemaServerPickerRenderer.css';

interface PickerServer { id: string; name: string; connAvailable: boolean; }

interface PickerPayload {
  question?: string;
  servers?: PickerServer[];
}

function DmcrSchemaServerPickerComponent({ payload, actions }: { payload: unknown; actions: { submit: (text: string, params: Record<string, unknown>) => void } }) {
  const p = payload as PickerPayload;
  const question = p?.question ?? 'Which database would you like to compare against?';
  const servers: PickerServer[] = p?.servers ?? [];
  const [selected, setSelected] = useState<string | null>(null);

  function handleConfirm() {
    if (!selected) return;
    const srv = servers.find(s => s.id === selected);
    if (!srv) return;
    actions.submit(srv.name, { _dmcr_schema_picker: true, serverId: srv.id, serverName: srv.name });
  }

  if (servers.length === 0) {
    return (
      <div className="dmcr-ssp-card">
        <div className="dmcr-ssp-empty">
          No MCP servers configured. Add one in <strong>Settings → MCP Servers</strong>.
        </div>
      </div>
    );
  }

  return (
    <div className="dmcr-ssp-card">
      <div className="dmcr-ssp-hd">
        <span className="dmcr-ssp-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
        </span>
        <span className="dmcr-ssp-title">Schema Comparison</span>
      </div>
      <p className="dmcr-ssp-q">{question}</p>
      <div className="dmcr-ssp-list">
        {servers.map(srv => (
          <label key={srv.id} className={`dmcr-ssp-item${selected === srv.id ? ' is-selected' : ''}${!srv.connAvailable ? ' is-disabled' : ''}`}>
            <input
              type="radio"
              name="dmcr-server-pick"
              value={srv.id}
              disabled={!srv.connAvailable}
              checked={selected === srv.id}
              onChange={() => setSelected(srv.id)}
            />
            <span className="dmcr-ssp-name">{srv.name}</span>
            {!srv.connAvailable && (
              <span className="dmcr-ssp-warn" title="No connection URL found in server config">no conn</span>
            )}
          </label>
        ))}
      </div>
      <button className="dmcr-ssp-btn" disabled={!selected} onClick={handleConfirm}>
        Compare →
      </button>
    </div>
  );
}

export const dmcrSchemaServerPickerRenderer = {
  key: 'SchemaServerPicker',
  priority: 250,
  match: ({ effectiveType }: { effectiveType: string }) => effectiveType === 'SchemaServerPicker',
  hideBubble: true,
  Component: DmcrSchemaServerPickerComponent,
};
