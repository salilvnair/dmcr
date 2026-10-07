import { WarningTriangleIcon } from '@salilvnair/dui';
import './DmcrErrorRenderer.css';

interface DmcrErrorPayload {
  type: 'dmcrError';
  message: string;
}

function DmcrErrorRendererComponent({ payload }: { payload: DmcrErrorPayload; actions: any }) {
  return (
    <div className="dmcr-chat-error">
      <div className="dmcr-chat-error__icon" aria-hidden="true"><WarningTriangleIcon size={13} /></div>
      <div className="dmcr-chat-error__body">
        <div className="dmcr-chat-error__title">Action failed</div>
        <div className="dmcr-chat-error__message">{payload.message || 'Something went wrong.'}</div>
      </div>
    </div>
  );
}

export const dmcrErrorRendererProvider = {
  key: 'DmcrError',
  priority: 295,
  hideBubble: true,
  match: ({ payload, effectiveType }: { payload: any; effectiveType: string }) => {
    if (effectiveType === 'dmcrError') return true;
    if (!payload || typeof payload !== 'object') return false;
    return payload.type === 'dmcrError' && typeof payload.message === 'string';
  },
  Component: DmcrErrorRendererComponent,
};
