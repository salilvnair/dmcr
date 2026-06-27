import { useState, useCallback, useEffect, useRef } from 'react';
import { postMsg } from '../vscode';
import ChangeCard, { type ChangeData } from '../components/ChangeCard';
import ProgressScreen from '../components/ProgressScreen';
import GenErrorBox, { type GenError } from '../components/GenErrorBox';
import SqlEditor from '../components/SqlEditor';
import StyledDropdown from '../components/StyledDropdown';
import MultiSelectDropdown from '../components/MultiSelectDropdown';
import { FieldHint } from '../components/FieldHint';
import './FreeformPage.css';

import type { FormSnapshot } from '../types';

type Screen = 'form' | 'progress' | 'result';
type LintState = 'hidden' | 'linting' | 'good' | 'bad';
type LintInfo = { state: LintState; msg: string };

type Props = { visible: boolean; form: string; availableSchemas?: string[]; existingChanges?: string[]; initialState?: FormSnapshot['freeform']; onStateChange?: (p: FormSnapshot['freeform']) => void };

export default function FreeformPage({ visible, form, availableSchemas = [], existingChanges = [], initialState, onStateChange }: Props) {
  const [screen, setScreen] = useState<Screen>('form');
  const [sql, setSql] = useState('');
  const [includePrev, setIncludePrev] = useState(false);
  const [prevSql, setPrevSql] = useState('');
  const [dbSchema, setDbSchema] = useState(initialState?.dbSchema || availableSchemas[0] || '');
  useEffect(() => { if (availableSchemas.length > 0 && !dbSchema) setDbSchema(availableSchemas[0]); }, [availableSchemas]);
  const [changeHint, setChangeHint] = useState(initialState?.changeHint || '');
  useEffect(() => { if (initialState?.changeHint) setChangeHint(initialState.changeHint); }, [initialState?.changeHint]);
  useEffect(() => { if (initialState?.sql) setSql(initialState.sql); }, [initialState?.sql]);
  const [isRepeatable, setIsRepeatable] = useState(false);
  const [metaTags, setMetaTags] = useState('');
  const [metaRequires, setMetaRequires] = useState<string[]>([]);
  const [metaAuthor, setMetaAuthor] = useState(initialState?.metaAuthor || '');
  const [status, setStatus] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const [currentLint, setCurrentLint] = useState<LintInfo>({ state: 'hidden', msg: '' });
  const [prevLint, setPrevLint] = useState<LintInfo>({ state: 'hidden', msg: '' });
  const [progressMsg, setProgressMsg] = useState('Generating your DMCR change\u2026');
  const [streamChunk, setStreamChunk] = useState('');
  const [changeData, setChangeData] = useState<ChangeData | null>(null);
  const [genError, setGenError] = useState<GenError | null>(null);

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
              suggestedLocation: msg.payload.suggestedLocation || '',
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

    if (includePrev) {
      const pSql = prevSql.trim();
      if (!pSql) { setStatus({ msg: 'Paste previous SQL or disable Previous version.', kind: 'err' }); return; }
      const r2 = await lintNow('previous', pSql);
      if (!r2.ok) { setStatus({ msg: 'Fix previous SQL issues: ' + r2.msg, kind: 'err' }); return; }
    }

    setStatus(null);
    setGenError(null);
    setStreamChunk('');
    setProgressMsg('Generating your DMCR change\u2026');
    postMsg({
      type: 'submit',
      payload: {
        sql: currentSql,
        includePrevious: includePrev,
        previousSql: includePrev ? prevSql.trim() : '',
        changeNameHint: isRepeatable
          ? (changeHint.trim() ? `R__${changeHint.trim()}` : 'R__repeatable_change')
          : changeHint.trim(),
        dbSchema: dbSchema.trim(),
        dialect: 'postgresql',
        metaTags: metaTags.trim(),
        metaRequires: metaRequires.join(', '),
        metaAuthor: metaAuthor.trim(),
        isRepeatable,
      },
    });
  }, [sql, includePrev, prevSql, changeHint, dbSchema, metaTags, metaRequires, metaAuthor, lintNow]);

  const handleCancel = useCallback(() => { setStatus(null); setScreen('form'); postMsg({ type: 'cancel', payload: { form, goHome: true } }); }, [form]);

  // ── Render ───────────────────────────────────────────────────────
  if (!visible) return null;

  if (screen === 'progress') {
    return <ProgressScreen message={progressMsg} streamChunk={streamChunk} />;
  }
  if (screen === 'result' && changeData) {
    return <ChangeCard change={changeData} form={form} />;
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

      {/* Banner */}
      <div className="ff-banner">
        <div className="ff-banner-title">Heads up</div>
        <div className="ff-banner-text">
          For <b>CREATE OR REPLACE FUNCTION</b>, enable <b>Previous version</b> and paste the old body
          so revert can restore it exactly.
        </div>
      </div>

      {/* Current SQL */}
      <div className="ff-card">
        <div className="ff-section-label">Current SQL (deploy)</div>
        <SqlEditor
          className="ff-textarea ff-code"
          value={sql}
          onChange={val => { setSql(val); scheduleLint('current', val); }}
          onBlur={() => { if (sql.trim()) lintNow('current', sql); }}
          placeholder={'-- Paste your SQL here (DDL/DML/function)\n-- ALTER TABLE, CREATE FUNCTION, INSERT INTO, etc.'}
        />
        <LintChip info={currentLint} />

        {/* Previous version toggle */}
        <div className={`ff-toggle-row${includePrev ? ' is-active' : ''}`} onClick={() => setIncludePrev(v => !v)}>
          <label onClick={e => e.stopPropagation()}>
            <input
              type="checkbox"
              className="ff-check"
              checked={includePrev}
              onChange={e => setIncludePrev(e.target.checked)}
            />
            <div>
              <div><strong>Previous version</strong> (for revert)</div>
              <div className="sub">Enable when replacing an existing function/view — lets revert restore it exactly.</div>
            </div>
          </label>
        </div>

        {includePrev && (
          <div className="ff-prev-area">
            <div className="ff-section-label" style={{ marginTop: 14 }}>Previous SQL (restore on revert)</div>
            <SqlEditor
              className="ff-textarea ff-code"
              value={prevSql}
              onChange={val => { setPrevSql(val); scheduleLint('previous', val); }}
              onBlur={() => { if (prevSql.trim()) lintNow('previous', prevSql); }}
              placeholder="-- Paste the PREVIOUS version here"
            />
            <LintChip info={prevLint} />
          </div>
        )}
      </div>

      {/* Optional */}
      <div className="ff-card">
        <div className="ff-section-label" style={{ marginBottom: 10 }}>Optional</div>
        <div className="ff-field">
          <label className="ff-label">DB Schema context <FieldHint text="Hint for the AI to qualify generated verify/revert SQL with the right schema. Not required but improves accuracy." example="public, zapper" /></label>
          {availableSchemas.length > 0 ? (
            <StyledDropdown
              items={availableSchemas.map(s => ({ value: s, label: s }))}
              value={dbSchema}
              onChange={setDbSchema}
            />
          ) : (
            <input className="ff-input" value={dbSchema} onChange={e => setDbSchema(e.target.value)}
              placeholder="e.g. public, zp_st — LLM uses for verify/revert qualification" />
          )}
        </div>
        <div className="ff-field">
          <label className="ff-label">Change name hint <FieldHint text="Short slug for the generated change folder name. Lowercase letters, digits, and underscores only — must start with a letter." example="update_pricing_fn, fix_trigger_logic" /></label>
          <input className="ff-input" value={changeHint} onChange={e => setChangeHint(e.target.value)}
            placeholder="e.g. update_my_fn_logic" />
          {changeHint && !/^[a-z][a-z0-9_]*$/.test(changeHint) && (
            <div className="ff-field-warn">⚠ Use lowercase letters, digits and underscores only — must start with a letter</div>
          )}
        </div>
        <div className="ff-hint">Tip: Include a uniqueness key in comments so revert can safely delete DML rows.</div>
        <div className="ff-field" style={{ marginTop: 10 }}>
          <label className="ff-repeatable-row">
            <input
              type="checkbox"
              checked={isRepeatable}
              onChange={e => setIsRepeatable(e.target.checked)}
              style={{ accentColor: '#a5b4fc', width: 14, height: 14, cursor: 'pointer' }}
            />
            <span className="ff-label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12.5 }}>
              Repeatable migration <span className="ff-r-badge">R__</span>
            </span>
          </label>
          {isRepeatable && (
            <div className="ff-repeatable-note">
              ⚠ Repeatable migrations re-run whenever the file checksum changes. They must be fully idempotent — no errors on re-run, no ROLLBACK dependency.
            </div>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="ff-card">
        <div className="ff-section-label" style={{ marginBottom: 10 }}>
          &#x1F3F7;&#xFE0F; Metadata <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(optional &mdash; AI fills if empty)</span>
        </div>
        <div className="ff-field">
          <label className="ff-label">Tags <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11 }}>(comma-separated)</span></label>
          <input className="ff-input" value={metaTags} onChange={e => setMetaTags(e.target.value)}
            placeholder="e.g. schema, hotfix, data-migration" />
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
            placeholder="e.g. jdoe (defaults to git user.name)" />
        </div>
      </div>

      {/* Actions */}
      <div className="ff-actions">
        <button type="button" className="ff-btn accent" onClick={handleGenerate}>&#x1FA84; Generate DMCR request</button>
        <button type="button" className="ff-btn danger" onClick={handleCancel}>&#x2715; Cancel</button>
      </div>

      {status && <div className={`ff-status ${status.kind}`}>{status.msg}</div>}
    </div>
  );
}

function LintChip({ info }: { info: LintInfo }) {
  if (info.state === 'hidden') return null;
  const cls = info.state === 'good' ? 'good' : info.state === 'bad' ? 'bad' : 'linting';
  const text = info.state === 'good' ? '\u2713 SQL valid' : info.state === 'bad' ? `\u26A0 ${info.msg || 'parse error'}` : '\u23F3 Linting\u2026';
  return (
    <div className="ff-lint-row">
      <span className={`ff-lint-chip ${cls}`}>{text}</span>
    </div>
  );
}
