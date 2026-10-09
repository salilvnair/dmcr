import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ButtonView, CalendarIcon, ChevronLeftIcon, ChevronRightIcon, CheckIcon, CloseIcon, IconButtonView } from '@salilvnair/dui';
import './DateTimePicker.css';

type Mode = 'date' | 'time' | 'datetime';

type Props = {
  mode: Mode;
  value: string | null;
  onChange: (value: string | null) => void;
};

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function pad(n: number) { return String(n).padStart(2, '0'); }
function daysInMonth(y: number, m: number) { return new Date(y, m + 1, 0).getDate(); }
function firstDayOf(y: number, m: number) { return new Date(y, m, 1).getDay(); }

function formatDisplay(iso: string, mode: Mode): string {
  if (!iso) return '';
  if (mode === 'time') return iso;
  try {
    const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    const date = SHORT_MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    if (mode === 'date') return date;
    const h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return date + '  ' + pad(h12) + ':' + pad(m) + ':' + pad(s) + ' ' + ampm;
  } catch { return iso; }
}

export default function DateTimePicker({ mode, value, onChange }: Props) {
  const today = useMemo(() => new Date(), []);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Calendar state
  const parsed = useMemo(() => {
    if (!value) return null;
    const d = new Date(value.includes('T') ? value : value + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }, [value]);

  const [viewYear, setViewYear] = useState(parsed?.getFullYear() ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.getMonth() ?? today.getMonth());
  const [selDay, setSelDay] = useState(parsed?.getDate() ?? today.getDate());

  // Time state
  const initH = parsed ? (parsed.getHours() % 12 || 12) : 12;
  const initM = parsed?.getMinutes() ?? 0;
  const initS = parsed?.getSeconds() ?? 0;
  const initAmpm = parsed ? (parsed.getHours() >= 12 ? 'PM' : 'AM') : 'AM';
  const [hour, setHour] = useState(initH);
  const [minute, setMinute] = useState(initM);
  const [second, setSecond] = useState(initS);
  const [ampm, setAmpm] = useState<'AM' | 'PM'>(initAmpm);

  // Position popup
  useEffect(() => {
    if (!open || !triggerRef.current || !popRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const popW = mode === 'date' ? 260 : 440;
    const popH = 340;
    let left = r.left;
    let top = r.bottom + 6;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    if (top + popH > window.innerHeight - 8) top = r.top - popH - 6;
    popRef.current.style.top = top + 'px';
    popRef.current.style.left = left + 'px';
  }, [open, mode]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const commitValue = useCallback(() => {
    const dateStr = viewYear + '-' + pad(viewMonth + 1) + '-' + pad(selDay);
    let h24 = hour % 12 + (ampm === 'PM' ? 12 : 0);
    if (h24 === 24) h24 = 12;
    if (h24 === 12 && ampm === 'AM') h24 = 0;
    const timeStr = pad(h24) + ':' + pad(minute) + ':' + pad(second);

    if (mode === 'date') onChange(dateStr);
    else if (mode === 'time') onChange(timeStr);
    else onChange(dateStr + 'T' + timeStr);
  }, [viewYear, viewMonth, selDay, hour, minute, second, ampm, mode, onChange]);

  const handleDayClick = useCallback((d: number) => {
    setSelDay(d);
  }, []);

  const handleClear = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
    setOpen(false);
  }, [onChange]);

  const handleDone = useCallback(() => {
    commitValue();
    setOpen(false);
  }, [commitValue]);

  const handleToday = useCallback(() => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    setSelDay(today.getDate());
  }, [today]);

  // Build calendar grid
  const calendarDays = useMemo(() => {
    const fd = firstDayOf(viewYear, viewMonth);
    const dim = daysInMonth(viewYear, viewMonth);
    const prevDim = daysInMonth(viewYear, viewMonth === 0 ? 11 : viewMonth - 1);
    const todayISO = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const days: Array<{ day: number; current: boolean; iso: string; isToday: boolean; isSel: boolean }> = [];

    for (let i = 0; i < fd; i++) {
      days.push({ day: prevDim - fd + 1 + i, current: false, iso: '', isToday: false, isSel: false });
    }
    for (let d = 1; d <= dim; d++) {
      const iso = viewYear + '-' + pad(viewMonth + 1) + '-' + pad(d);
      days.push({ day: d, current: true, iso, isToday: iso === todayISO, isSel: d === selDay });
    }
    const total = fd + dim;
    const trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (let i = 1; i <= trailing; i++) {
      days.push({ day: i, current: false, iso: '', isToday: false, isSel: false });
    }
    return days;
  }, [viewYear, viewMonth, selDay, today]);

  const placeholder = mode === 'date' ? 'Select date\u2026' : mode === 'time' ? 'Select time\u2026' : 'Select date & time\u2026';

  return (
    <div className="dtpk-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`dtpk-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        <CalendarIcon className="dtpk-cal-ico" size={14} />
        <span className={`dtpk-val${value ? '' : ' ph'}`}>
          {value ? formatDisplay(value, mode) : placeholder}
        </span>
        <span className="dtpk-clr" onClick={handleClear}><CloseIcon size={12} /></span>
      </button>

      {open && (
        <div ref={popRef} className="dtpk-pop open" style={{ position: 'fixed', zIndex: 99999 }}>
          {/* Calendar pane */}
          {mode !== 'time' && (
            <div className="dtpk-cal">
              <div className="dtpk-cal-hd">
                <IconButtonView size="md" type="button" icon={<ChevronLeftIcon size={14} />} tooltip="Previous month" onClick={() => {
                  if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
                  else setViewMonth(m => m - 1);
                }} />
                <span className="dtpk-month-lbl">{MONTHS[viewMonth]} <span>{viewYear}</span></span>
                <IconButtonView size="md" type="button" icon={<ChevronRightIcon size={14} />} tooltip="Next month" onClick={() => {
                  if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
                  else setViewMonth(m => m + 1);
                }} />
              </div>
              <div className="dtpk-dow-row">
                {DAYS.map(d => <div key={d} className="dtpk-dow">{d}</div>)}
              </div>
              <div className="dtpk-grid">
                {calendarDays.map((d, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`dtpk-day${d.current ? '' : ' other-month'}${d.isToday ? ' today' : ''}${d.isSel && d.current ? ' sel' : ''}`}
                    onClick={d.current ? () => handleDayClick(d.day) : undefined}
                  >
                    {d.day}
                  </button>
                ))}
              </div>
              <div className="dtpk-cal-ft">
                <ButtonView type="button" variant="ghost" color="#818cf8" label="Today" onClick={handleToday} />
                <ButtonView type="button" variant="primary" accentColor="#6366f1" iconLeft={<CheckIcon size={12} />} label="Done" onClick={handleDone} />
              </div>
            </div>
          )}

          {/* Time pane */}
          {mode !== 'date' && (
            <>
              {mode !== 'time' && <div className="dtpk-vdiv" />}
              <div className="dtpk-time-pane">
                <div className="dtpk-time-title">Time</div>
                <div className="dtpk-time-inputs">
                  <div className="dtpk-time-field">
                    <label>HH</label>
                    <input type="number" min={1} max={12} value={hour} onChange={e => setHour(Math.max(1, Math.min(12, +e.target.value || 1)))} />
                  </div>
                  <span className="dtpk-time-sep">:</span>
                  <div className="dtpk-time-field">
                    <label>MM</label>
                    <input type="number" min={0} max={59} value={pad(minute)} onChange={e => setMinute(Math.max(0, Math.min(59, +e.target.value || 0)))} />
                  </div>
                  <span className="dtpk-time-sep">:</span>
                  <div className="dtpk-time-field">
                    <label>SS</label>
                    <input type="number" min={0} max={59} value={pad(second)} onChange={e => setSecond(Math.max(0, Math.min(59, +e.target.value || 0)))} />
                  </div>
                  <div className="dtpk-ampm-col">
                    <button type="button" className={`dtpk-ampm-btn${ampm === 'AM' ? ' active' : ''}`} onClick={() => setAmpm('AM')}>AM</button>
                    <button type="button" className={`dtpk-ampm-btn${ampm === 'PM' ? ' active' : ''}`} onClick={() => setAmpm('PM')}>PM</button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
