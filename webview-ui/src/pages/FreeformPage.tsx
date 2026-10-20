import { useState, useCallback, useEffect, useRef } from 'react';
import { postMsg } from '../vscode';
import ChangeCard, { type ChangeData } from '../components/ChangeCard';
import ProgressScreen from '../components/ProgressScreen';
import GenErrorBox, { type GenError } from '../components/GenErrorBox';
import SqlEditor from '../components/SqlEditor';
import MultiSelectDropdown from '../components/MultiSelectDropdown';
import { FieldHint } from '../components/FieldHint';
import { ButtonView, CheckboxView, CloseIcon, DatabaseTableIcon, HistoryClockIcon, InfoCircleIcon, BulkEditIcon, SelectInputView, SandClockIcon, TagIcon, WandIcon, WarningTriangleIcon } from '@salilvnair/dui';
import './FreeformPage.css';

import type { FormSnapshot } from '../types';

type Screen = 'form' | 'progress' | 'result';
type LintState = 'hidden' | 'linting' | 'good' | 'bad';
type LintInfo = { state: LintState; msg: string };
/** Previous version as DMCR found it: where it came from, or which replaced objects are new. */
type PrevFound =
  | { state: 'looking' }
  | { state: 'filled'; source: string; sourceKind: 'repo' | 'live'; objects: string[] }
  | { state: 'new'; objects: string[] };
type PrevItem = { object: string; sql: string | null; source: string | null; sourceKind: 'repo' | 'live' | null };
const REPLACES_RX = /create\s+or\s+replace\s+(?:(?:temp|temporary)\s+)?(?:recursive\s+)?(?:function|procedure|view)\b/i;

type Props = { visible: boolean; form: string; availableSchemas?: string[]; existingChanges?: string[]; initialState?: FormSnapshot['freeform']; onStateChange?: (p: FormSnapshot['freeform']) => void };

export default function FreeformPage({ visible, form, availableSchemas = [], existingChanges = [], initialState, onStateChange }: Props) {
  const [screen, setScreen] = useState<Screen>('form');
  const [sql, setSql] = useState('');
  const [includePrev, setIncludePrev] = useState(false);
  const [prevSql, setPrevSql] = useState('');
  // Previous version filled by DMCR (from the repository / the live test database) until you edit it
  const [prevFound, setPrevFound] = useState<PrevFound | null>(null);
  const [prevEdited, setPrevEdited] = useState(false);
  const prevReqRef = useRef(0);
  const prevTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prevEditedRef = useRef(false);   // you changed Previous version: DMCR no longer overwrites it
  const prevAutoRef = useRef(false);     // Previous version currently holds what DMCR filled in
  const markPrevEdited = (v: boolean) => { prevEditedRef.current = v; setPrevEdited(v); };

  // Current SQL replaces a function / procedure / view: ask DMCR for its previous definition (repository
  // first, then the live test database through MCP) and fill Previous version with it
  const lookupPrevious = useCallback((sqlVal: string) => {
    if (prevTimerRef.current) clearTimeout(prevTimerRef.current);
    if (!REPLACES_RX.test(sqlVal) || isRepeatableRef.current) {
      prevReqRef.current++;
      if (prevAutoRef.current) { setPrevSql(''); setIncludePrev(false); prevAutoRef.current = false; }
      setPrevFound(null);
      return;
    }
    prevTimerRef.current = setTimeout(() => {
      const requestId = ++prevReqRef.current;
      if (!prevEditedRef.current) setPrevFound({ state: 'looking' });
      postMsg({ type: 'previousDefinition', payload: { requestId, sql: sqlVal } });
    }, 700);
  }, []);
  // No schema: names are written without one; each environment's schema (DMCR Config) is the session search_path
  const dbSchema = '';
  const [changeHint, setChangeHint] = useState(initialState?.changeHint || '');
  useEffect(() => { if (initialState?.changeHint) setChangeHint(initialState.changeHint); }, [initialState?.changeHint]);
  useEffect(() => { if (initialState?.sql) setSql(initialState.sql); }, [initialState?.sql]);
  const [isRepeatable, setIsRepeatable] = useState(false);
  const isRepeatableRef = useRef(false);
  useEffect(() => { isRepeatableRef.current = isRepeatable; }, [isRepeatable]);
  const [metaTags, setMetaTags] = useState('');
  const [metaRequires, setMetaRequires] = useState<string[]>([]);
  const [metaAuthor, setMetaAuthor] = useState(initialState?.metaAuthor || '');
  const [metaTicket, setMetaTicket] = useState('');
  const [status, setStatus] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const [currentLint, setCurrentLint] = useState<LintInfo>({ state: 'hidden', msg: '' });
  const [prevLint, setPrevLint] = useState<LintInfo>({ state: 'hidden', msg: '' });
  const [progressMsg, setProgressMsg] = useState('Generating your DMCR change\u2026');
  const [streamChunk, setStreamChunk] = useState('');
  const [changeData, setChangeData] = useState<ChangeData | null>(null);
  const [genError, setGenError] = useState<GenError | null>(null);
  const replaces = REPLACES_RX.test(sql) && !isRepeatable;

  /* Report key field changes to parent for snapshot persistence */
  useEffect(() => {
    onStateChange?.({ dbSchema, changeHint, metaAuthor });
  }, [dbSchema, changeHint, metaAuthor]);

  const lintSeqRef = useRef(0);
  const pendingRef = useRef<Map<number, (r: { ok: boolean; msg: string }) => void>>(new Map());
  const lintTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lintCacheRef = useRef<Record<string, { sql: string; ok: boolean; msg: string } | null>>({});

  // ── Lint helpers ─────────────────────────────────────────────────
  const requestLint = useCallback((which: 'current' | 'previous', sqlVal: string) => {
    const id = ++lintSeqRef.current;
    const setter = which === 'current' ? setCurrentLint : setPrevLint;
    setter({ state: 'linting', msg: '' });
    postMsg({ type: 'lint', payload: { id, which, sql: sqlVal, dialect: 'postgresql' } });
    return new Promise<{ ok: boolean; msg: string }>(resolve => { pendingRef.current.set(id, resolve); });
  }, []);

  const scheduleLint = useCallback((which: 'current' | 'previous', sqlVal: string) => {
    const timers = lintTimersRef.current;
    if (timers[which]) clearTimeout(timers[which]);
    const setter = which === 'current' ? setCurrentLint : setPrevLint;
    if (!sqlVal.trim()) { setter({ state: 'hidden', msg: '' }); lintCacheRef.current[which] = null; return; }
    setter({ state: 'linting', msg: '' });
    timers[which] = setTimeout(() => {
      requestLint(which, sqlVal).then(res => {
        lintCacheRef.current[which] = { sql: sqlVal, ...res };
        setter({ state: res.ok ? 'good' : 'bad', msg: res.msg });
      });
    }, 600);
  }, [requestLint]);

  const lintNow = useCallback(async (which: 'current' | 'previous', sqlVal: string) => {
    const timers = lintTimersRef.current;
    if (timers[which]) { clearTimeout(timers[which]); delete timers[which]; }
    const setter = which === 'current' ? setCurrentLint : setPrevLint;
    if (!sqlVal.trim()) { setter({ state: 'hidden', msg: '' }); lintCacheRef.current[which] = null; return { ok: true, msg: '' }; }
    const c = lintCacheRef.current[which];
    if (c && c.sql === sqlVal) { setter({ state: c.ok ? 'good' : 'bad', msg: c.msg }); return c; }
    const res = await requestLint(which, sqlVal);
    lintCacheRef.current[which] = { sql: sqlVal, ...res };
    setter({ state: res.ok ? 'good' : 'bad', msg: res.msg });
    return res;
  }, [requestLint]);

  // ── Message listener ─────────────────────────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.payload?.form && msg.payload.form !== form) return;

      switch (msg.type) {
        case 'lintResult': {
          const id = msg.payload?.id;
          if (typeof id === 'string') break; // handled by ChangeCard
          const resolve = pendingRef.current.get(id);
          if (resolve) { pendingRef.current.delete(id); resolve({ ok: !!msg.payload.ok, msg: msg.payload.msg || '' }); }
          break;
        }
        case 'showProgress':
          if (msg.payload?.message) setProgressMsg(msg.payload.message);
          setStatus(null);
          setScreen('progress');
          break;
        case 'progressUpdate':
          if (msg.payload?.text) setProgressMsg(msg.payload.text);
          break;
        case 'streamChunk':
          if (msg.payload?.text) setStreamChunk(msg.payload.text);
          break;
        case 'generationDone':
          if (msg.payload.deploySql != null) {
            setChangeData({
              changeName: msg.payload.changeName || 'change',
              deploySql: msg.payload.deploySql || '',
              verifySql: msg.payload.verifySql || '',
              revertSql: msg.payload.revertSql || '',
              metaJson: msg.payload.metaJson || undefined,  // requires, tags and author from the form
              suggestedLocation: msg.payload.suggestedLocation || '',
              selfCheck: msg.payload.selfCheck,
            });
            setGenError(null);
            setScreen('result');
          }
          break;
        case 'generationError':
          setGenError({
            message: msg.payload?.message || 'Generation failed.',
            stack: msg.payload?.stack,
            code: msg.payload?.code,
            timestamp: msg.payload?.timestamp,
            source: msg.payload?.source,
          });
          setScreen('form');
          break;
        case 'formActivated':
          setGenError(null);
          setScreen('form');
          break;
        case 'formCancelled':
          setGenError(null);
          setStatus(null);
          setScreen('form');
          break;
        case 'previousDefinitionResult': {
          if (msg.payload?.requestId !== prevReqRef.current) break; // an older lookup
          const items = (msg.payload?.items ?? []) as PrevItem[];
          const known = items.filter(i => i.sql);
          if (prevEditedRef.current) { setPrevFound(null); break; } // what you typed stays
          if (known.length) {
            setPrevSql(known.map(i => i.sql).join('\n\n'));
            setIncludePrev(true);
            const live = known.find(i => i.sourceKind === 'live');
            setPrevFound({ state: 'filled', source: [...new Set(known.map(i => i.source ?? ''))].join(', '), sourceKind: live ? 'live' : 'repo', objects: known.map(i => i.object) });
          } else {
            if (prevAutoRef.current) { setPrevSql(''); setIncludePrev(false); }
            setPrevFound(items.length ? { state: 'new', objects: items.map(i => i.object) } : null);
          }
          prevAutoRef.current = known.length > 0;
          break;
        }
        case 'gitUser':
          if (!metaAuthor && (msg.payload?.name || msg.payload?.email)) {
            setMetaAuthor(msg.payload.name || msg.payload.email);
          }
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [form, metaAuthor]);

  // Request git user on mount for author auto-fill
  useEffect(() => {
    if (!metaAuthor) postMsg({ type: 'getGitUser' });
  }, []);

  // ── Actions ──────────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    setStatus(null);
    const currentSql = sql.trim();
    if (!currentSql) { setStatus({ msg: 'Paste SQL first.', kind: 'err' }); return; }

    setStatus({ msg: 'Validating\u2026', kind: 'ok' });
    const r1 = await lintNow('current', currentSql);
    if (!r1.ok) { setStatus({ msg: 'Fix SQL issues before generating: ' + r1.msg, kind: 'err' }); return; }

    const withPrev = replaces && includePrev;
    if (withPrev && prevEdited) {
      const pSql = prevSql.trim();
      if (!pSql) { setStatus({ msg: "Paste the previous definition, or click Use DMCR's.", kind: 'err' }); return; }
      const r2 = await lintNow('previous', pSql);
      if (!r2.ok) { setStatus({ msg: 'Fix the previous definition: ' + r2.msg, kind: 'err' }); return; }
    }

    setStatus(null);
    setGenError(null);
    setStreamChunk('');
    setProgressMsg('Generating your DMCR change\u2026');
    postMsg({
      type: 'submit',
      payload: {
        form,
        sql: currentSql,
        includePrevious: withPrev && !!prevSql.trim(),
        previousSql: withPrev ? prevSql.trim() : '',
        // where Previous version came from when DMCR filled it (shown on the card)
        previousSource: withPrev && !prevEdited && prevFound?.state === 'filled' ? prevFound.source : '',
        changeNameHint: isRepeatable
          ? (changeHint.trim() ? `R__${changeHint.trim()}` : 'R__repeatable_change')
          : changeHint.trim(),
        dbSchema: dbSchema.trim(),
        dialect: 'postgresql',
        metaTags: metaTags.trim(),
        metaRequires: metaRequires.join(', '),
        metaAuthor: metaAuthor.trim(),
        metaTicket: metaTicket.trim(),
        isRepeatable,
      },
    });
  }, [sql, replaces, isRepeatable, includePrev, prevSql, prevEdited, prevFound, changeHint, dbSchema, metaTags, metaRequires, metaAuthor, metaTicket, lintNow]);   // isRepeatable: ticked last, it was ignored

  // Override: your own text from now on (starting from what DMCR found); Use DMCR's: look it up again
  const startOverride = () => { markPrevEdited(true); prevAutoRef.current = false; setIncludePrev(true); };
  const useFound = () => { markPrevEdited(false); setPrevSql(''); setIncludePrev(false); setPrevLint({ state: 'hidden', msg: '' }); lookupPrevious(sql); };

  const handleCancel = useCallback(() => { setStatus(null); setScreen('form'); postMsg({ type: 'cancel', payload: { form, goHome: true } }); }, [form]);

  // ── Render ───────────────────────────────────────────────────────
  if (!visible) return null;

  if (screen === 'progress') {
    return <ProgressScreen message={progressMsg} streamChunk={streamChunk} form="freeform" />;
  }
  if (screen === 'result' && changeData) {
    // Repeatable and Previous version belong to one change: once it is saved, the next one starts with both off
    return <ChangeCard change={changeData} form={form} onSaved={() => { setIsRepeatable(false); setIncludePrev(false); setPrevSql(''); setPrevFound(null); markPrevEdited(false); prevAutoRef.current = false; }} />;
  }

  return (
    <div className="ff-page">
      {genError && <GenErrorBox error={genError} />}

      {/* Header */}
      <div className="ff-hd">
        <h1 className="ff-title">Freeform SQL &rarr; DMCR</h1>
        <span className="ff-badge">SQL</span>
        <span className="ff-pill">PostgreSQL</span>
      </div>

      {/* Current SQL */}
      <div className="ff-card">
        <div className="ff-section-label">Current SQL (deploy)</div>
        <SqlEditor
          className="ff-textarea ff-code"
          value={sql}
          onChange={val => { setSql(val); scheduleLint('current', val); lookupPrevious(val); }}
          onBlur={() => { if (sql.trim()) lintNow('current', sql); }}
          placeholder={'-- Paste your SQL here (DDL/DML/function)\n-- ALTER TABLE, CREATE FUNCTION, INSERT INTO, etc.'}
        />
        <LintChip info={currentLint} />

        {/* Previous version: only when the SQL replaces a function / procedure / view. DMCR finds it itself
            (newest change in the repository, else the live test database); Override is for the rare case
            it should restore something else, or there is nothing to find (an object only on prod) */}
        {replaces && (
          <div className="ff-prev-area">
            <div className="ff-prev-head">
              <span className="ff-section-label">Previous version <span className="ff-prev-sub">revert restores it word for word</span></span>
              {prevEdited
                ? <ButtonView size="sm" variant="ghost" iconLeft={<HistoryClockIcon size={12} />} label="Use DMCR's" title="Drop your text and use the definition DMCR finds" onClick={useFound} />
                : <ButtonView size="sm" variant="ghost" iconLeft={<BulkEditIcon size={12} />} label="Override" title="Restore something else on revert (paste or edit the previous definition)" onClick={startOverride} />}
            </div>
            <PrevSourceChip found={prevFound} edited={prevEdited} />
            {(prevEdited || prevFound?.state === 'filled') && (
              <>
                <SqlEditor
                  className="ff-textarea ff-code"
                  value={prevSql}
                  readOnly={!prevEdited}
                  height={prevEdited ? 300 : 220}
                  onChange={val => { setPrevSql(val); scheduleLint('previous', val); }}
                  onBlur={() => { if (prevEdited && prevSql.trim()) lintNow('previous', prevSql); }}
                  placeholder="-- Paste the definition revert should restore"
                />
                {prevEdited && <LintChip info={prevLint} />}
              </>
            )}
          </div>
        )}
      </div>

      {/* Optional */}
      <div className="ff-card">
        <div className="ff-section-label" style={{ marginBottom: 10 }}>Optional</div>
        <div className="ff-field">
          <label className="ff-label">Change name hint <FieldHint text="Short slug for the generated change folder name. Lowercase letters, digits, and underscores only — must start with a letter." example="update_pricing_fn, fix_trigger_logic" /></label>
          <input className="ff-input" value={changeHint} onChange={e => setChangeHint(e.target.value)}
            placeholder="snake_case name (optional)" />
          {changeHint && !/^[a-z][a-z0-9_]*$/.test(changeHint) && (
            <div className="ff-field-warn"><WarningTriangleIcon size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />Use lowercase letters, digits and underscores only — must start with a letter</div>
          )}
        </div>
        <div className="ff-hint">Tip: Include a uniqueness key in comments so revert can safely delete DML rows.</div>
        <div className="ff-field" style={{ marginTop: 10 }}>
          <label className="ff-repeatable-row">
            <CheckboxView
              checked={isRepeatable}
              onChange={setIsRepeatable}
              size="sm"
              accentColor="var(--dm-c-a5b4fc)"
            />
            <span className="ff-label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12.5 }}>
              Repeatable migration <span className="ff-r-badge">R__</span>
            </span>
          </label>
          {isRepeatable && (
            <div className="ff-repeatable-note">
              <WarningTriangleIcon size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />Repeatable migrations re-run whenever the file checksum changes. They must be fully idempotent — no errors on re-run, no ROLLBACK dependency.
            </div>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="ff-card">
        <div className="ff-section-label" style={{ marginBottom: 10 }}>
          <TagIcon size={12} style={{ verticalAlign: '-2px', marginRight: 6 }} />Metadata <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(optional &mdash; AI fills if empty)</span>
        </div>
        <div className="ff-field">
          <label className="ff-label">Tags <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(comma-separated)</span></label>
          <input className="ff-input" value={metaTags} onChange={e => setMetaTags(e.target.value)}
            placeholder="Comma-separated tags" />
        </div>
        <div className="ff-field">
          <label className="ff-label">Ticket <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(change request)</span></label>
          <input className="ff-input" value={metaTicket} onChange={e => setMetaTicket(e.target.value)}
            placeholder="Ticket or change request id" />
        </div>
        <div className="ff-field">
          <label className="ff-label">Requires <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(depends on these change IDs)</span></label>
          <MultiSelectDropdown
            items={existingChanges.map(c => ({ value: c, label: c }))}
            selected={metaRequires}
            onChange={setMetaRequires}
            placeholder="Select dependencies…"
            allowCustom
          />
        </div>
        <div className="ff-field">
          <label className="ff-label">Author</label>
          <input className="ff-input" value={metaAuthor} onChange={e => setMetaAuthor(e.target.value)}
            placeholder="Author (defaults to git user.name)" />
        </div>
      </div>

      {/* Actions */}
      <div className="ff-actions">
        <ButtonView variant="primary" iconLeft={<WandIcon size={13} />} label="Generate DMCR request" onClick={handleGenerate} />
        <ButtonView variant="danger" iconLeft={<CloseIcon size={12} />} label="Cancel" onClick={handleCancel} />
      </div>

      {status && <div className={`ff-status ${status.kind}`}>{status.msg}</div>}
    </div>
  );
}

function LintChip({ info }: { info: LintInfo }) {
  if (info.state === 'hidden') return null;
  const cls = info.state === 'good' ? 'good' : info.state === 'bad' ? 'bad' : 'linting';
  const text = info.state === 'good'
    ? <>{'\u2713'} SQL valid</>
    : info.state === 'bad'
      ? <><WarningTriangleIcon size={11} />{info.msg || 'parse error'}</>
      : <><SandClockIcon size={11} />Linting{'\u2026'}</>;
  return (
    <div className="ff-lint-row">
      <span className={`ff-lint-chip ${cls}`}>{text}</span>
    </div>
  );
}

/** Where Previous version came from: the repository change, the live test database, edited by you; or that the object is new. */
function PrevSourceChip({ found, edited }: { found: PrevFound | null; edited: boolean }) {
  if (edited) return <div className="ff-prev-src ff-prev-src--edited"><BulkEditIcon size={12} /><span>Overridden by you: revert restores your text, not the definition DMCR finds</span></div>;
  if (!found) return null;
  if (found.state === 'looking') return <div className="ff-prev-src"><SandClockIcon size={12} /><span>Looking up the previous definition{'…'}</span></div>;
  if (found.state === 'new') return (
    <div className="ff-prev-src ff-prev-src--new"><InfoCircleIcon size={12} />
      <span>New: <code>{found.objects.join(', ')}</code> is not in any change or in the test database, so there is nothing to restore; revert drops it. If it exists only on prod, click Override and paste it.</span>
    </div>
  );
  return (
    <div className={`ff-prev-src ff-prev-src--${found.sourceKind}`}>
      {found.sourceKind === 'repo' ? <HistoryClockIcon size={12} /> : <DatabaseTableIcon size={12} />}
      <span>DMCR found <code>{found.objects.join(', ')}</code> in <b>{found.source}</b>
        {found.sourceKind === 'live' ? ': no change in the repository defines it; PostgreSQL rebuilt this text, so check it' : ''}</span>
    </div>
  );
}
