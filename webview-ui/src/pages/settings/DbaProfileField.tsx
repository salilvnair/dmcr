import { useEffect, useState } from 'react';
import { ButtonView, TextInputView, UserSingleIcon, CheckCircleIcon } from '@salilvnair/dui';
import { postMsg } from '../../vscode';

/** The DBA's name: written as created_by in meta.json of every change DMCR saves, and recorded in dmcr.change_log. */
export default function DbaProfileField() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'dbaProfile') { const n = String(e.data.payload?.dbaName ?? ''); setName(n); setSaved(n); }
    };
    window.addEventListener('message', handler);
    postMsg({ type: 'getDbaProfile' });
    return () => window.removeEventListener('message', handler);
  }, []);
  const dirty = name.trim() !== saved;
  return (
    <div className="bs-field-group" style={{ marginBottom: 20 }}>
      <label className="bs-label">Your name (DBA) <span style={{ color: '#f87171' }}>*</span></label>
      <p className="bs-hint" style={{ marginBottom: 8 }}>
        Required: DMCR does not save a change, a release or a project until it is set. Written as <code>created_by</code> in the meta.json of every change you save, and recorded in <code>dmcr.change_log</code> when it is deployed. The developer who asked for a change is entered on the change card (<code>requested_by</code>).
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <TextInputView
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && dirty) postMsg({ type: 'saveDbaProfile', payload: { dbaName: name } }); }}
          placeholder="Your name"
          iconLeft={<UserSingleIcon size={13} />}
          size="sm"
          error={!saved}
          style={{ flex: 1, maxWidth: 320 }}
        />
        <ButtonView
          label={dirty ? 'Save' : 'Saved'}
          variant={dirty ? 'primary' : 'ghost'}
          size="sm"
          disabled={!dirty}
          iconLeft={dirty ? undefined : <CheckCircleIcon size={13} />}
          onClick={() => postMsg({ type: 'saveDbaProfile', payload: { dbaName: name } })}
        />
      </div>
    </div>
  );
}
