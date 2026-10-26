import { useEffect, useState } from 'react';
import { ButtonView, CheckCircleIcon, EditorView, KeyboardIcon, ShieldAlertIcon, SplitPanelView, TagIcon, TextInputView, TogglePillView, WandIcon, WarningTriangleIcon } from '@salilvnair/dui';
import FormHero from '../components/FormHero';
import { postMsg } from '../vscode';
import ChangeCard, { type ChangeData } from '../components/ChangeCard';
import ProgressScreen from '../components/ProgressScreen';
import MultiSelectDropdown from '../components/MultiSelectDropdown';
import './ManualPage.css';

type Screen = 'form' | 'progress' | 'result';
type SqlTab = 'deploy' | 'verify' | 'revert';
const TABS: { key: SqlTab; label: string; hint: string }[] = [
  { key: 'deploy', label: 'deploy.sql', hint: 'What the change does. No schema in front of names: each environment runs in its own (DMCR Config).' },
  { key: 'verify', label: 'verify.sql', hint: 'Raises an error when the change is applied but its objects are missing (it checks dmcr.change_log first).' },
  { key: 'revert', label: 'revert.sql', hint: 'Undoes deploy.sql exactly: the self-check deploys, verifies, reverts and verifies again.' },
];

/** verify.sql in DMCR's shape: only checks anything once dmcr.change_log says the change is applied */
const VERIFY_TEMPLATE = `-- verify: fails when the change is applied but what it creates is missing
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN
    -- e.g. IF to_regclass('my_table') IS NULL THEN RAISE EXCEPTION 'my_table is missing'; END IF;
    NULL;
  END IF;
END $$;
`;

const lines = (s: string) => (s.trim() ? s.trim().split('\n').length : 0);

/** where you left the divider between the SQL and the side panel (per browser) */
const SPLIT_KEY = 'dmcr.manual.split';
const savedSplit = (): number => { try { const v = Number(localStorage.getItem(SPLIT_KEY)); return v > 20 && v < 90 ? v : 68; } catch { return 68; } };

type Props = { visible: boolean; existingChanges?: string[] };

/**
 * Manual: write deploy, verify and revert yourself. No AI and no MCP: DMCR only test-runs the change on the
 * environment you pick (deploy, verify, revert, verify, rolled back), then it is saved and committed like any other.
 */
export default function ManualPage({ visible, existingChanges = [] }: Props) {
  const form = 'manual';
  const [screen, setScreen] = useState<Screen>('form');
  const [name, setName] = useState('');
  const [sql, setSql] = useState<Record<SqlTab, string>>({ deploy: '', verify: '', revert: '' });
  const [tab, setTab] = useState<SqlTab>('deploy');
  const [envs, setEnvs] = useState<string[]>([]);
  const [prod, setProd] = useState('');
  const [env, setEnv] = useState('');
  const [tags, setTags] = useState('');
  const [ticket, setTicket] = useState('');
  const [requires, setRequires] = useState<string[]>([]);
  const [author, setAuthor] = useState('');
  const [progress, setProgress] = useState('');
  const [change, setChange] = useState<ChangeData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: Record<string, unknown> };
      const p = m?.payload ?? {};
      if (m?.type === 'dmcrConfig') {
        const list = ((p.envs as { name: string }[] | undefined) ?? []).map(x => x.name).filter(Boolean);
        const prodName = String(p.production ?? '');
        setEnvs(list); setProd(prodName);
        // test first: the self-check never needs production
        setEnv(cur => cur && list.includes(cur) ? cur : (list.find(n => n !== prodName && /test|st|qa|dev/i.test(n)) ?? list.find(n => n !== prodName) ?? list[0] ?? ''));
      }
      if (m?.type === 'gitUser' && p.name) setAuthor(cur => cur || String(p.name));
      if (p.form !== form) return;
      if (m?.type === 'showProgress') { setProgress(String(p.message ?? '')); setError(''); setScreen('progress'); }
      if (m?.type === 'generationDone' && p.deploySql != null) {
        setChange({ changeName: String(p.changeName), deploySql: String(p.deploySql), verifySql: String(p.verifySql), revertSql: String(p.revertSql), metaJson: p.metaJson as string | undefined, selfCheck: p.selfCheck as ChangeData['selfCheck'] });
        setScreen('result');
      }
      if (m?.type === 'generationError') { setError(String(p.message ?? 'The self-check could not run.')); setScreen('form'); }
      if (m?.type === 'formCancelled') setScreen('form');
    };
    window.addEventListener('message', on);
    postMsg({ type: 'getDmcrConfig' });
    postMsg({ type: 'getGitUser' });
    return () => window.removeEventListener('message', on);
  }, []);

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const filled = (t: SqlTab) => !!sql[t].trim();
  const guarded = /dmcr\s*\.\s*(change_log|repeatable_log)/i.test(sql.verify);
  const checks = [
    { ok: !!slug, label: slug ? <>Name <code>{slug}</code></> : 'Give the change a name' },
    { ok: filled('deploy'), label: 'deploy.sql written' },
    { ok: filled('verify'), label: 'verify.sql written', warn: filled('verify') && !guarded ? 'does not check dmcr.change_log' : '' },
    { ok: filled('revert'), label: 'revert.sql written' },
  ];
  const ready = checks.every(c => c.ok) && !!env;
  const step = !ready ? 1 : 2;
  const envColor = (n: string) => (n === prod ? 'var(--dm-c-ef4444)' : /test|st|qa/i.test(n) ? 'var(--dm-c-f59e0b)' : 'var(--dm-c-2dd4bf)');

  const check = () => {
    const meta: Record<string, unknown> = { change_id: slug, description: name.trim(), requires, tags: tags.split(/,\s*/).map(t => t.trim()).filter(Boolean), author: author.trim() };
    if (ticket.trim()) meta.ticket = ticket.trim();
    postMsg({ type: 'manualSelfCheck', payload: { changeName: slug, deploySql: sql.deploy, verifySql: sql.verify, revertSql: sql.revert, metaJson: JSON.stringify(meta, null, 2), env } });
  };

  if (!visible) return null;
  if (screen === 'progress') return <ProgressScreen message={progress} form={form} />;
  if (screen === 'result' && change) {
    return (
      <div className="mp-result">
        <ButtonView variant="secondary" size="md" label="Back to your SQL" onClick={() => setScreen('form')} />
        <ChangeCard change={change} form={form} onSaved={() => { setName(''); setSql({ deploy: '', verify: '', revert: '' }); setTags(''); setTicket(''); setRequires([]); setTab('deploy'); }} />
      </div>
    );
  }

  const cur = TABS.find(t => t.key === tab)!;
  return (
    <div className="mp-page">
      <FormHero tone="green" icon={<KeyboardIcon size={22} />} title="Manual change"
        pills={[{ label: 'No AI', tone: 'green' }, { label: 'Runner self-check', tone: 'indigo' }, { label: 'PostgreSQL' }]}
        description="Write deploy, verify and revert yourself. DMCR test-runs them on the environment you pick, rolls everything back, then you save and commit."
        steps={['Write the SQL', `Self-check on ${env || '…'}`, 'Save & commit']} step={step} />

      {error && <div className="mp-error"><WarningTriangleIcon size={13} />{error}</div>}

      {/* the SQL left, the change and its self-check right: drag the divider to give either more room */}
      <SplitPanelView className="mp-body" defaultSplit={savedSplit()} minFirst={420} minSecond={300} accentColor="var(--dm-c-6366f1)"
        onResizeEnd={v => { try { localStorage.setItem(SPLIT_KEY, String(Math.round(v))); } catch { /* private window */ } }}
        first={
        <section className="mp-card mp-sql">
          <div className="mp-tabs">
            {TABS.map(t => (
              <button key={t.key} type="button" className={`mp-tab mp-tab--${t.key}${tab === t.key ? ' is-on' : ''}`} onClick={() => setTab(t.key)}>
                <span className={`mp-dot${filled(t.key) ? ' is-filled' : ''}`} />{t.label}
                {filled(t.key) && <span className="mp-count">{lines(sql[t.key])}</span>}
              </button>
            ))}
            {tab === 'verify' && !filled('verify') && (
              <ButtonView variant="ghost" size="md" iconLeft={<WandIcon size={12} />} label="DMCR verify template" style={{ marginLeft: 'auto' }}
                onClick={() => setSql(s => ({ ...s, verify: VERIFY_TEMPLATE }))} />
            )}
          </div>
          <p className={`mp-hint mp-hint--${tab}`}>{cur.hint}</p>
          {/* the editor takes all the height the card has */}
          <div className="mp-editor">
            <EditorView key={tab} value={sql[tab]} onChange={v => setSql(s => ({ ...s, [tab]: v }))} language="sql" height="100%" fontSize={12.5} wordWrap
              placeholder={`-- ${cur.label}`} editorOptions={{ minimap: false, scrollBeyondLastLine: false, acceptSuggestionOnEnter: 'off', autoClosing: false, autoIndent: 'none' }} />
          </div>
        </section>}
        second={
        <aside className="mp-side">
          <section className="mp-card">
            <div className="mp-card-title"><TagIcon size={13} />Change</div>
            <div className="mp-fields">
              <label>Name</label>
              <TextInputView size="md" value={name} placeholder="create_lookup_code_seq" spellCheck={false} onChange={e => setName(e.target.value)} />
              <label>Tags</label>
              <TextInputView size="md" value={tags} placeholder="sequence, product-a" onChange={e => setTags(e.target.value)} />
              <label>Ticket</label>
              <TextInputView size="md" value={ticket} placeholder="PA-1" onChange={e => setTicket(e.target.value)} />
              <label>Requires</label>
              <MultiSelectDropdown items={existingChanges.map(c => ({ value: c, label: c }))} selected={requires} onChange={setRequires} placeholder="Changes that must run first" />
              <label>Author</label>
              <TextInputView size="md" value={author} placeholder="Author" onChange={e => setAuthor(e.target.value)} />
            </div>
          </section>

          <section className="mp-card mp-run">
            <div className="mp-card-title"><CheckCircleIcon size={13} />Self-check</div>
            <div className="mp-envs">
              {envs.map(n => (
                <TogglePillView key={n} active={env === n} variant={env === n ? 'go' : 'default'} accentColor={envColor(n)}
                  icon={n === prod ? <ShieldAlertIcon size={11} /> : undefined} onClick={() => setEnv(n)}>
                  {n.toUpperCase()}
                </TogglePillView>
              ))}
            </div>
            {env && env === prod && <div className="mp-warn"><ShieldAlertIcon size={12} />Production: the test run is rolled back, but it still runs there</div>}
            <ul className="mp-checks">
              {checks.map((c, i) => (
                <li key={i} className={c.ok ? (c.warn ? 'is-warn' : 'is-ok') : ''}>
                  {c.ok ? (c.warn ? <WarningTriangleIcon size={13} /> : <CheckCircleIcon size={13} />) : <span className="mp-ring" />}
                  <span>{c.label}{c.warn ? <em> · {c.warn}</em> : null}</span>
                </li>
              ))}
            </ul>
            <button type="button" className="mp-go" disabled={!ready} onClick={check}>
              <CheckCircleIcon size={15} />Self-check on {env || '…'}
              <small>deploy · verify · revert · verify, rolled back</small>
            </button>
          </section>
        </aside>} />
    </div>
  );
}
