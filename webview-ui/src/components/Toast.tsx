import type { ToastData } from '../App';

export default function Toast({ data }: { data: ToastData }) {
  const cls = data.type === 'ok' ? 'bs-toast-ok'
            : data.type === 'error' ? 'bs-toast-error'
            : 'bs-toast-warn';
  return (
    <div className={`bs-toast ${cls}`}>
      {data.message}
    </div>
  );
}

