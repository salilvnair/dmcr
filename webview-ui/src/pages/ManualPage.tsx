import { useEffect, useState } from 'react';
import { ButtonView, CheckCircleIcon, KeyboardIcon, SelectInputView, ShieldAlertIcon, TextInputView, WandIcon } from '@salilvnair/dui';
import { postMsg } from '../vscode';
import ChangeCard, { type ChangeData } from '../components/ChangeCard';
import ProgressScreen from '../components/ProgressScreen';
import SqlEditor from '../components/SqlEditor';
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
  const missing = TABS.filter(t => !sql[t.key].trim()).map(t => t.label);
  const why = !slug ? 'Give the change a name' : missing.length ? `Write ${missing.join(', ')}` : !env ? 'Pick an environment' : '';

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
        <ButtonView variant="ghost" label="Back to your SQL" onClick={() => setScreen('form')} />
        <ChangeCard change={change} form={form} onSaved={() => { setName(''); setSql({ deploy: '', verify: '', revert: '' }); setTags(''); setTicket(''); setRequires([]); setTab('deploy'); }} />
      </div>
    );
  }

  return (
    <div className="mp-page">
      <div className="mp-head">
        <span className="mp-head-icon"><KeyboardIcon size={18} /></span>
        <div>
          <h2>Manual change</h2>
          <p>Write deploy, verify and revert yourself. No AI: DMCR test-runs them on the environment you pick, then you save and commit.</p>
        </div>
      </div>

      <div className="mp-grid">
        <label>Change name</label>
        <TextInputView size="md" value={name} placeholder="create_lookup_code_seq" spellCheck={false} onChange={e => setName(e.target.value)} />
        <label>Self-check on</label>
        <div className="mp-envs">
          <SelectInputView size="md" value={env} onChange={v => setEnv(v)} options={envs.map(n => ({ value: n, label: n === prod ? `${n} (production)` : n }))} />
          {env && env === prod && <span className="mp-warn"><ShieldAlertIcon size={12} />Production: the test run is rolled back, but it still runs there</span>}
        </div>
        <label>Tags</label>
        <TextInputView size="md" value={tags} placeholder="sequence, product-a" onChange={e => setTags(e.target.value)} />
        <label>Ticket</label>
        <TextInputView size="md" value={ticket} placeholder="PA-1" onChange={e => setTicket(e.target.value)} />
        <label>Requires</label>
        <MultiSelectDropdown items={existingChanges.map(c => ({ value: c, label: c }))} selected={requires} onChange={setRequires} placeholder="Changes that must run first" />
        <label>Author</label>
        <TextInputView size="md" value={author} placeholder="Author" onChange={e => setAuthor(e.target.value)} />
      </div>

      <div className="mp-sql">
        <div className="mp-tabs">
          {TABS.map(t => (
            <button key={t.key} type="button" className={`mp-tab mp-tab--${t.key}${tab === t.key ? ' is-on' : ''}`} onClick={() => setTab(t.key)}>
              <span className={`mp-dot${sql[t.key].trim() ? ' is-filled' : ''}`} />{t.label}
            </button>
          ))}
          {tab === 'verify' && !sql.verify.trim() && (
            <ButtonView variant="ghost" size="md" iconLeft={<WandIcon size={12} />} label="DMCR verify template" style={{ marginLeft: 'auto' }}
              onClick={() => setSql(s => ({ ...s, verify: VERIFY_TEMPLATE }))} />
          )}
        </div>
        <p className="mp-hint">{TABS.find(t => t.key === tab)!.hint}</p>
        <SqlEditor key={tab} value={sql[tab]} onChange={v => setSql(s => ({ ...s, [tab]: v }))} height={340} placeholder={`-- ${TABS.find(t => t.key === tab)!.label}`} />
      </div>

      {error && <div className="mp-error">{error}</div>}
      <div className="mp-foot">
        {why ? <span className="mp-why">{why}</span> : <span className="mp-ready"><CheckCircleIcon size={13} />Ready to test-run on {env}</span>}
        <ButtonView variant="primary" accentColor="var(--dm-c-6366f1)" iconLeft={<CheckCircleIcon size={13} />} label={`Self-check on ${env || '…'}`} disabled={!!why} title={why || undefined} onClick={check} />
      </div>
    </div>
  );
}
