import './ProgressScreen.css';

type Props = {
  message: string;
  streamChunk?: string;
};

export default function ProgressScreen({ message, streamChunk }: Props) {
  return (
    <div className="progress-screen">
      <div className="prog-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
        </svg>
      </div>
      <div className="prog-bar" />
      <div className="prog-label">{message}</div>
      {streamChunk && (
        <div className="prog-stream">{streamChunk.slice(-400)}</div>
      )}
    </div>
  );
}
