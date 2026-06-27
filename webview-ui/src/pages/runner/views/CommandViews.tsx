import './CommandViews.css';

// ── Shared types ──────────────────────────────────────────────────────────────
export interface JsonCommandResult {
  command:  string;
  args:     string[];
  exitCode: number | null;
  data:     unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function Badge({ status }: { status: string }) {
  const cls = `cv-badge cv-badge--${status.toLowerCase().replace(/[^a-z]/g, '-')}`;
  const icons: Record<string, string> = {
    applied: '✓', success: '✓', ok: '✓',
    pending: '◌',
    failure: '✗', error: '✗', failed: '✗',
    created: '◆', deleted: '✕',
    'applied-action': '✓',
    'dry-run': '◎', nothing: '—',
  };
  const icon = icons[status.toLowerCase()] ?? '';
  return <span className={cls}>{icon && <>{icon}&nbsp;</>}{status}</span>;
}

function SectionHd({ title }: { title: string }) {
  return (
    <div className="cv-section-hd">
      <span className="cv-section-title">{title}</span>
      <span className="cv-section-line" />
    </div>
  );
}

function EmptyState({ icon = '◌', text = 'No data' }: { icon?: string; text?: string }) {
  return (
    <div className="cv-empty">
      <span className="cv-empty-icon">{icon}</span>
      <span className="cv-empty-text">{text}</span>
    </div>
  );
}

// ── StatusView ────────────────────────────────────────────────────────────────
type StatusRow = { change_id: string; status: string };

function StatusView({ data }: { data: StatusRow[] }) {
  const applied = data.filter(r => r.status === 'applied').length;
  const pending = data.filter(r => r.status === 'pending').length;

  return (
    <div className="cv-root">
      <div className="cv-stats-row">
        <div className="cv-stat">
          <span className="cv-stat-label">Total</span>
          <span className="cv-stat-value">{data.length}</span>
        </div>
        <div className="cv-stat cv-stat--green">
          <span className="cv-stat-label">Applied</span>
          <span className="cv-stat-value">{applied}</span>
        </div>
        <div className="cv-stat cv-stat--amber">
          <span className="cv-stat-label">Pending</span>
          <span className="cv-stat-value">{pending}</span>
        </div>
      </div>

      {data.length === 0 ? (
        <EmptyState icon="◌" text="No change folders found" />
      ) : (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr 120px' }}>
            <div className="cv-th">Change</div>
            <div className="cv-th">Status</div>
          </div>
          <div className="cv-table-body">
            {data.map(r => (
              <div key={r.change_id} className="cv-table-row" style={{ gridTemplateColumns: '1fr 120px' }}>
                <div className="cv-td cv-td-main">{r.change_id}</div>
                <div className="cv-td"><Badge status={r.status} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── HistoryView ───────────────────────────────────────────────────────────────
type HistoryRow = {
  change_id: string; applied_at: string; applied_by: string;
  deploy_checksum: string; ticket_id: string; git_commit: string;
  environment: string; actor: string;
};

function HistoryView({ data }: { data: HistoryRow[] }) {
  const formatDate = (s: string) => {
    if (!s) return '—';
    try { return new Date(s).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); }
    catch { return s; }
  };
  const shortHash = (s: string) => s ? s.slice(0, 8) : '—';
  const shortChk  = (s: string) => s ? s.slice(0, 10) + '…' : '—';

  return (
    <div className="cv-root">
      <div className="cv-summary">
        <span className="cv-summary-num cv-summary-num--green">{data.length}</span>
        <span>applied change{data.length !== 1 ? 's' : ''}</span>
      </div>
      {data.length === 0 ? (
        <EmptyState icon="◌" text="No history yet" />
      ) : (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr 130px 90px 90px 70px' }}>
            <div className="cv-th">Change</div>
            <div className="cv-th">Applied At</div>
            <div className="cv-th">Commit</div>
            <div className="cv-th">Checksum</div>
            <div className="cv-th">Env</div>
          </div>
          <div className="cv-table-body">
            {data.map(r => (
              <div key={r.change_id + r.applied_at} className="cv-table-row" style={{ gridTemplateColumns: '1fr 130px 90px 90px 70px' }}>
                <div className="cv-td cv-td-main" title={r.change_id}>{r.change_id}</div>
                <div className="cv-td cv-td-mono" title={r.applied_at}>{formatDate(r.applied_at)}</div>
                <div className="cv-td cv-td-mono" title={r.git_commit}>{shortHash(r.git_commit)}</div>
                <div className="cv-td cv-td-mono" title={r.deploy_checksum}>{shortChk(r.deploy_checksum)}</div>
                <div className="cv-td cv-td-mono">{r.environment || '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── InfoView ──────────────────────────────────────────────────────────────────
type InfoData = {
  environment: string; total_changes: number; applied: number;
  pending: number; danger: number; registry_ok: boolean | string; checksum_policy: string;
};

function InfoView({ data }: { data: InfoData }) {
  const isOk = data.registry_ok === true || data.registry_ok === 'true';
  const envColor = data.environment?.toLowerCase().includes('prod') ? 'env-prod' : 'env-dev';

  return (
    <div className="cv-root">
      <div className="cv-stats-row">
        <div className="cv-stat">
          <span className="cv-stat-label">Total</span>
          <span className="cv-stat-value">{data.total_changes ?? 0}</span>
        </div>
        <div className="cv-stat cv-stat--green">
          <span className="cv-stat-label">Applied</span>
          <span className="cv-stat-value">{data.applied ?? 0}</span>
        </div>
        <div className="cv-stat cv-stat--amber">
          <span className="cv-stat-label">Pending</span>
          <span className="cv-stat-value">{data.pending ?? 0}</span>
        </div>
        {(data.danger ?? 0) > 0 && (
          <div className="cv-stat cv-stat--red">
            <span className="cv-stat-label">Danger</span>
            <span className="cv-stat-value">{data.danger}</span>
          </div>
        )}
        <div className={`cv-stat ${isOk ? 'cv-stat--green' : 'cv-stat--red'}`}>
          <span className="cv-stat-label">Registry</span>
          <span className="cv-stat-value" style={{ fontSize: 13, fontWeight: 700, marginTop: 3 }}>{isOk ? '✓ OK' : '✗ Not found'}</span>
        </div>
        <div className="cv-stat cv-stat--muted">
          <span className="cv-stat-label">Checksum</span>
          <span className="cv-stat-value">{data.checksum_policy ?? '—'}</span>
        </div>
      </div>

      <div className="cv-kv-grid">
        <div className="cv-kv-row">
          <div className="cv-kv-key">Environment</div>
          <div className={`cv-kv-val cv-kv-val--${envColor}`}>{data.environment ?? '—'}</div>
        </div>
        <div className="cv-kv-row">
          <div className="cv-kv-key">Checksum Policy</div>
          <div className="cv-kv-val">{data.checksum_policy ?? '—'}</div>
        </div>
      </div>
    </div>
  );
}

// ── CheckView ─────────────────────────────────────────────────────────────────
type CheckData = { ok: boolean | string; issues: string[] };

function CheckView({ data }: { data: CheckData }) {
  const isOk = data.ok === true || data.ok === 'true';
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isOk ? 'success' : 'warn'}`}>
        <div className="cv-alert-title">
          {isOk ? '✓  All preflight checks passed' : '⚠  Preflight issues found'}
        </div>
        {!isOk && data.issues?.length > 0 && (
          <div className="cv-alert-body">
            {data.issues.map((issue, i) => (
              <div key={i} className="cv-alert-issue">{issue}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── PlanView ──────────────────────────────────────────────────────────────────
type PlanRow = { change_id: string; status: string; requires: string[] };

function PlanView({ data }: { data: PlanRow[] }) {
  const applied = data.filter(r => r.status === 'applied').length;
  const pending = data.filter(r => r.status === 'pending').length;

  return (
    <div className="cv-root">
      <div className="cv-summary">
        <span className="cv-summary-num cv-summary-num--green">{applied}</span><span>applied</span>
        <span style={{ color: '#334155' }}>·</span>
        <span className="cv-summary-num cv-summary-num--amber">{pending}</span><span>pending</span>
      </div>
      {data.length === 0 ? (
        <EmptyState icon="◌" text="No changes found" />
      ) : (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '36px 1fr 110px 1fr' }}>
            <div className="cv-th">#</div>
            <div className="cv-th">Change</div>
            <div className="cv-th">Status</div>
            <div className="cv-th">Requires</div>
          </div>
          <div className="cv-table-body">
            {data.map((r, i) => (
              <div key={r.change_id} className="cv-table-row" style={{ gridTemplateColumns: '36px 1fr 110px 1fr' }}>
                <div className="cv-td" style={{ color: '#334155', fontSize: 11 }}>{i + 1}</div>
                <div className="cv-td cv-td-main" title={r.change_id}>{r.change_id}</div>
                <div className="cv-td"><Badge status={r.status} /></div>
                <div className="cv-td">
                  {r.requires?.length > 0 ? (
                    <div className="cv-deps">
                      {r.requires.map(dep => <span key={dep} className="cv-dep">{dep}</span>)}
                    </div>
                  ) : <span style={{ color: '#334155' }}>—</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── DeployView ────────────────────────────────────────────────────────────────
type DeployData =
  | { status: 'ok';       changes: Array<{ change_id: string; status: string; duration_s?: number; error?: string }> }
  | { status: 'dry_run';  count:   number; changes: Array<{ change_id: string }> }
  | { status: 'ok';       message: string; changes: [] };

type DeployChange = { change_id: string; status?: string; duration_s?: number; error?: string };

function DeployView({ data }: { data: DeployData | Record<string, unknown> }) {
  const d = data as Record<string, unknown>;
  const status  = (d['status'] as string) ?? 'ok';
  const changes = (d['changes'] as DeployChange[]) ?? [];
  const message = d['message'] as string | undefined;

  if (status === 'dry_run') {
    return (
      <div className="cv-root">
        <div className="cv-alert cv-alert--info">
          <div className="cv-alert-title">◎  Dry-run: {changes.length} change{changes.length !== 1 ? 's' : ''} would be deployed</div>
        </div>
        {changes.length > 0 && (
          <div className="cv-table-wrap">
            <div className="cv-table-head" style={{ gridTemplateColumns: '36px 1fr' }}>
              <div className="cv-th">#</div>
              <div className="cv-th">Change</div>
            </div>
            <div className="cv-table-body">
              {changes.map((c, i) => (
                <div key={c.change_id} className="cv-table-row" style={{ gridTemplateColumns: '36px 1fr' }}>
                  <div className="cv-td" style={{ color: '#334155', fontSize: 11 }}>{i + 1}</div>
                  <div className="cv-td cv-td-main">{c.change_id}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (message && changes.length === 0) {
    return (
      <div className="cv-root">
        <div className="cv-alert cv-alert--info">
          <div className="cv-alert-title">◌  {message}</div>
        </div>
      </div>
    );
  }

  const allOk = changes.every(c => c.status === 'success' || c.status === 'applied');
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${allOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {allOk ? `✓  ${changes.length} change${changes.length !== 1 ? 's' : ''} deployed successfully` : '✗  Deploy failed'}
        </div>
      </div>
      {changes.length > 0 && (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr 100px 70px' }}>
            <div className="cv-th">Change</div>
            <div className="cv-th">Status</div>
            <div className="cv-th">Time</div>
          </div>
          <div className="cv-table-body">
            {changes.map(c => (
              <div key={c.change_id} className="cv-table-row" style={{ gridTemplateColumns: '1fr 100px 70px' }}>
                <div className="cv-td cv-td-main" title={c.change_id}>{c.change_id}</div>
                <div className="cv-td"><Badge status={c.status ?? 'success'} /></div>
                <div className="cv-td cv-td-mono">{c.duration_s != null ? `${c.duration_s}s` : '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── VerifyView ────────────────────────────────────────────────────────────────
type VerifyData =
  | { change_id: string; status: string }
  | Array<{ change_id: string; status: string }>;

function VerifyView({ data }: { data: VerifyData }) {
  const rows = Array.isArray(data) ? data : [data as { change_id: string; status: string }];
  const allOk = rows.every(r => r.status === 'ok');

  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${allOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {allOk ? `✓  ${rows.length === 1 ? rows[0]?.change_id : `${rows.length} changes`} verified OK` : '✗  Verify failed'}
        </div>
      </div>
      {rows.length > 1 && (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr 100px' }}>
            <div className="cv-th">Change</div>
            <div className="cv-th">Status</div>
          </div>
          <div className="cv-table-body">
            {rows.map(r => (
              <div key={r.change_id} className="cv-table-row" style={{ gridTemplateColumns: '1fr 100px' }}>
                <div className="cv-td cv-td-main">{r.change_id}</div>
                <div className="cv-td"><Badge status={r.status} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ConfigView ────────────────────────────────────────────────────────────────
type ConfigData = {
  command?: string; path: string; env: string; changes_dir: string;
  psql_path: string; lock_timeout: string; stmt_timeout: string;
  checksum_policy: string; placeholders: string; conn: string;
};

function ConfigView({ data }: { data: ConfigData }) {
  const envColor = data.env?.toLowerCase().includes('prod') ? 'env-prod' : 'env-dev';
  const rows: Array<[string, string, string?]> = [
    ['Config Path', data.path],
    ['Environment', data.env, envColor],
    ['Changes Dir', data.changes_dir],
    ['psql Path', data.psql_path ?? 'auto'],
    ['Lock Timeout', data.lock_timeout],
    ['Stmt Timeout', data.stmt_timeout],
    ['Checksum Policy', data.checksum_policy],
    ['Placeholders', data.placeholders],
    ['Connection', data.conn, 'muted'],
  ];

  return (
    <div className="cv-root">
      <div className="cv-kv-grid">
        {rows.map(([key, val, mod]) => (
          <div key={key} className="cv-kv-row">
            <div className="cv-kv-key">{key}</div>
            <div className={`cv-kv-val${mod ? ` cv-kv-val--${mod}` : ''}`}>{val || '—'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── InitView ──────────────────────────────────────────────────────────────────
type InitData = { command?: string; status: string; message: string };

function InitView({ data }: { data: InitData }) {
  const isOk = data.status === 'ok';
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {isOk ? '✓  ' : '✗  '}{data.message ?? (isOk ? 'Registry initialized' : 'Init failed')}
        </div>
      </div>
    </div>
  );
}

// ── TagView ───────────────────────────────────────────────────────────────────
type TagData =
  | Array<{ tag_name: string; change_id: string; created_at: string; description: string }>
  | { tag: string; change_id?: string; status: string };

function TagView({ data }: { data: TagData }) {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <div className="cv-root"><EmptyState icon="◌" text="No tags yet" /></div>;
    }
    const formatDate = (s: string) => {
      if (!s) return '—';
      try { return new Date(s).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); }
      catch { return s; }
    };
    return (
      <div className="cv-root">
        <div className="cv-table-wrap">
          {data.map(t => (
            <div key={t.tag_name} className="cv-tag-item">
              <span className="cv-tag-name">@{t.tag_name}</span>
              <span className="cv-tag-change">→ {t.change_id}</span>
              {t.description && <span style={{ fontSize: 11, color: '#64748b' }}>{t.description}</span>}
              <span className="cv-tag-date">{formatDate(t.created_at)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const d = data as { tag: string; change_id?: string; status: string };
  const isOk = d.status === 'created' || d.status === 'deleted' || d.status === 'ok';
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {isOk ? '✓  ' : '✗  '}Tag <span style={{ color: '#f9a8d4', marginLeft: 4, marginRight: 4 }}>@{d.tag}</span>
          {d.status === 'created' ? ' created' : d.status === 'deleted' ? ' deleted' : ` — ${d.status}`}
          {d.change_id && ` → ${d.change_id}`}
        </div>
      </div>
    </div>
  );
}

// ── RevertView ────────────────────────────────────────────────────────────────
type RevertData =
  | { status: string; change_id: string | null; action: string }
  | { status: string; target: string; action: string }
  | Array<{ change_id: string; applied_at: string }>;

function RevertView({ data, args }: { data: RevertData; args: string[] }) {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <div className="cv-root"><EmptyState icon="◌" text="No applied changes" /></div>;
    }
    const formatDate = (s: string) => {
      if (!s) return '—';
      try { return new Date(s).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); }
      catch { return s; }
    };
    return (
      <div className="cv-root">
        <div className="cv-summary">
          <span className="cv-summary-num cv-summary-num--green">{data.length}</span>
          <span>applied change{data.length !== 1 ? 's' : ''} (most recent first)</span>
        </div>
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr 150px' }}>
            <div className="cv-th">Change</div>
            <div className="cv-th">Applied At</div>
          </div>
          <div className="cv-table-body">
            {data.map(r => (
              <div key={r.change_id} className="cv-table-row" style={{ gridTemplateColumns: '1fr 150px' }}>
                <div className="cv-td cv-td-main">{r.change_id}</div>
                <div className="cv-td cv-td-mono">{formatDate(r.applied_at)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const d = data as Record<string, unknown>;
  const status = d['status'] as string;
  const isNothing = status === 'nothing_to_revert';
  const isOk = status === 'ok';

  if (isNothing) {
    return (
      <div className="cv-root">
        <div className="cv-alert cv-alert--info">
          <div className="cv-alert-title">◌  Nothing to revert</div>
        </div>
      </div>
    );
  }

  const changeId = (d['change_id'] ?? d['target']) as string;
  const action = (d['action'] as string) ?? args.join(' ');
  const isRevertTo = action === 'revert_to';

  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {isOk ? '✓ ' : '✗ '}
          {isRevertTo ? `Reverted to: ${changeId}` : `Reverted: ${changeId ?? '—'}`}
        </div>
      </div>
    </div>
  );
}

// ── RepeatableView ────────────────────────────────────────────────────────────
type RepeatableData = { status: string; applied: string[] | Array<Record<string, unknown>> };

function RepeatableView({ data }: { data: RepeatableData }) {
  const applied = (data.applied ?? []) as unknown[];
  const count = applied.length;
  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${count > 0 ? 'success' : 'info'}`}>
        <div className="cv-alert-title">
          {count > 0
            ? `✓  ${count} repeatable migration${count !== 1 ? 's' : ''} applied`
            : '◌  No repeatable migrations needed updating'}
        </div>
      </div>
      {count > 0 && (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr' }}>
            <div className="cv-th">Change</div>
          </div>
          <div className="cv-table-body">
            {applied.map((a, i) => (
              <div key={i} className="cv-table-row" style={{ gridTemplateColumns: '1fr' }}>
                <div className="cv-td cv-td-main">{typeof a === 'string' ? a : JSON.stringify(a)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── BaselineView ──────────────────────────────────────────────────────────────
type BaselineData = { status: string; baselined: string[] };

function BaselineView({ data }: { data: BaselineData }) {
  const count = data.baselined?.length ?? 0;
  return (
    <div className="cv-root">
      <div className="cv-alert cv-alert--success">
        <div className="cv-alert-title">✓  Baseline complete — {count} change{count !== 1 ? 's' : ''} marked as applied</div>
      </div>
      {count > 0 && (
        <div className="cv-table-wrap">
          <div className="cv-table-head" style={{ gridTemplateColumns: '1fr' }}>
            <div className="cv-th">Change</div>
          </div>
          <div className="cv-table-body">
            {data.baselined.map(id => (
              <div key={id} className="cv-table-row" style={{ gridTemplateColumns: '1fr' }}>
                <div className="cv-td cv-td-main">{id}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── RepairView ────────────────────────────────────────────────────────────────
type RepairData =
  | { action: 'checksums'; repaired: string[] }
  | { change_id: string; action: string; status: string };

function RepairView({ data }: { data: RepairData }) {
  const d = data as Record<string, unknown>;
  if (d['action'] === 'checksums') {
    const repaired = (d['repaired'] as string[]) ?? [];
    return (
      <div className="cv-root">
        <div className="cv-alert cv-alert--success">
          <div className="cv-alert-title">✓  {repaired.length} checksum{repaired.length !== 1 ? 's' : ''} reconciled</div>
        </div>
        {repaired.length > 0 && (
          <div className="cv-table-wrap">
            <div className="cv-table-head" style={{ gridTemplateColumns: '1fr' }}>
              <div className="cv-th">Change</div>
            </div>
            <div className="cv-table-body">
              {repaired.map(id => (
                <div key={id} className="cv-table-row" style={{ gridTemplateColumns: '1fr' }}>
                  <div className="cv-td cv-td-main">{id}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const action = d['action'] as string;
  const changeId = d['change_id'] as string;
  const status = (d['status'] as string) ?? 'ok';
  const isOk = status === 'ok';
  const actionLabel = action === 'mark-applied' ? 'marked as applied' : action === 'mark-reverted' ? 'marked as reverted' : action;

  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isOk ? 'success' : 'error'}`}>
        <div className="cv-alert-title">
          {isOk ? '✓  ' : '✗  '}{changeId} {actionLabel}
        </div>
      </div>
    </div>
  );
}

// ── HelpView ──────────────────────────────────────────────────────────────────
const HELP_CMDS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/status',              desc: 'Show applied / pending changes' },
  { cmd: '/deploy',              desc: 'Apply all pending changes' },
  { cmd: '/deploy --dry-run',    desc: 'Preview pending changes (no DB writes)' },
  { cmd: '/deploy --to <id>',    desc: 'Deploy up to a specific change or @tag' },
  { cmd: '/verify',              desc: 'Run verify.sql for last change' },
  { cmd: '/history',             desc: 'Show change_log history' },
  { cmd: '/info',                desc: 'Summary stats and registry health' },
  { cmd: '/plan',                desc: 'Show dependency-aware execution plan' },
  { cmd: '/check',               desc: 'Preflight validation (no DB writes)' },
  { cmd: '/parse <sql>',         desc: 'Validate SQL in a rolled-back transaction' },
  { cmd: '/repeatable',          desc: 'Apply R__ migrations with changed checksums' },
  { cmd: '/tag list',            desc: 'List release tags' },
  { cmd: '/tag create <name>',   desc: 'Create a release tag at current state' },
  { cmd: '/tag delete <name>',   desc: 'Delete a release tag' },
  { cmd: '/revertLast',          desc: 'Revert the last applied change' },
  { cmd: '/revert list',         desc: 'List all applied changes' },
  { cmd: '/revert <id>',         desc: 'Revert a specific change (must be latest)' },
  { cmd: '/revert to <id|@t>',   desc: 'Revert all changes down to target' },
  { cmd: '/baseline <id>',       desc: 'Mark change as applied without running SQL' },
  { cmd: '/repair --checksums',  desc: 'Recalculate all stored checksums' },
  { cmd: '/init',                desc: 'Initialize DMCR registry tables (once)' },
  { cmd: '/config',              desc: 'Show active configuration' },
  { cmd: '/ls [pattern]',        desc: 'Tree view of changes directory' },
  { cmd: '/it',                  desc: 'Interactive revert mode (arrow keys)' },
];

const HELP_SHORTCUTS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/clear',   desc: 'Clear the terminal' },
  { cmd: '/help',    desc: 'Show this help' },
  { cmd: '↑ / ↓',    desc: 'Navigate command history' },
];

function HelpView() {
  return (
    <div className="cv-root">
      <SectionHd title="DMCR Commands" />
      <div className="cv-table-wrap">
        <div className="cv-table-head" style={{ gridTemplateColumns: '190px 1fr' }}>
          <div className="cv-th">Command</div>
          <div className="cv-th">Description</div>
        </div>
        <div className="cv-table-body">
          {HELP_CMDS.map(r => (
            <div key={r.cmd} className="cv-table-row" style={{ gridTemplateColumns: '190px 1fr' }}>
              <div className="cv-td cv-td-mono" style={{ color: '#67e8f9' }}>{r.cmd}</div>
              <div className="cv-td" style={{ color: '#94a3b8' }}>{r.desc}</div>
            </div>
          ))}
        </div>
      </div>
      <SectionHd title="Shell Shortcuts" />
      <div className="cv-table-wrap">
        <div className="cv-table-body">
          {HELP_SHORTCUTS.map(r => (
            <div key={r.cmd} className="cv-table-row" style={{ gridTemplateColumns: '190px 1fr' }}>
              <div className="cv-td cv-td-mono" style={{ color: '#67e8f9' }}>{r.cmd}</div>
              <div className="cv-td" style={{ color: '#94a3b8' }}>{r.desc}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="cv-help-tip">Tip: /<code>command</code> --help for detailed docs on any command</div>
    </div>
  );
}

// ── GenericResultView ─────────────────────────────────────────────────────────
function GenericResultView({ result }: { result: JsonCommandResult }) {
  const { exitCode, data } = result;
  const d = data as Record<string, unknown>;
  const status = d?.status as string | undefined;
  const rawMsg = d?.message as string | undefined;

  const isError = status === 'error' || (exitCode != null && exitCode !== 0);

  // Strip leading DMCR log symbols, then split into title + body lines
  const lines = (rawMsg ?? '')
    .split('\n')
    .map(l => l.replace(/^[\s›✓✗◇◌×✕⏳]+\s*/, '').trim())
    .filter(Boolean);

  const titleLine = lines[0] ?? (isError ? 'Command failed' : 'Done');
  const bodyLines = lines.slice(1);

  return (
    <div className="cv-root">
      <div className={`cv-alert cv-alert--${isError ? 'error' : 'info'}`}>
        <div className="cv-alert-title">
          {isError ? '✗  ' : '◌  '}{titleLine}
        </div>
        {bodyLines.length > 0 && (
          <div className="cv-alert-body">
            {bodyLines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── CommandResultView — routes to the right sub-view ─────────────────────────
export function CommandResultView({ result }: { result: JsonCommandResult }) {
  const { command, args, data } = result;
  const cmd = command.toLowerCase();
  const subArg = args[1]?.toLowerCase();

  // Synthetic results (no JSON stdout) — always go to generic view
  if ((data as Record<string, unknown>)?.__synthetic) {
    return <GenericResultView result={result} />;
  }

  try {
    if (cmd === 'help')                            return <HelpView />;
    if (cmd === 'status')                          return <StatusView data={data as StatusRow[]} />;
    if (cmd === 'history')                         return <HistoryView data={data as HistoryRow[]} />;
    if (cmd === 'info')                            return <InfoView data={data as InfoData} />;
    if (cmd === 'check')                           return <CheckView data={data as CheckData} />;
    if (cmd === 'plan')                            return <PlanView data={data as PlanRow[]} />;
    if (cmd === 'deploy')                          return <DeployView data={data as DeployData} />;
    if (cmd === 'verify')                          return <VerifyView data={data as VerifyData} />;
    if (cmd === 'show')                            return <ConfigView data={data as ConfigData} />;
    if (cmd === 'init')                            return <InitView data={data as InitData} />;
    if (cmd === 'tag')                             return <TagView data={data as TagData} />;
    if (cmd === 'revert' && subArg !== 'list')     return <RevertView data={data as RevertData} args={args} />;
    if (cmd === 'revert' && subArg === 'list')     return <RevertView data={data as RevertData} args={args} />;
    if (cmd === 'revertlast' || cmd === 'revert-last') return <RevertView data={data as RevertData} args={args} />;
    if (cmd === 'repeatable')                      return <RepeatableView data={data as RepeatableData} />;
    if (cmd === 'baseline')                        return <BaselineView data={data as BaselineData} />;
    if (cmd === 'repair')                          return <RepairView data={data as RepairData} />;
  } catch {
    // Fall through to generic view
  }

  return <GenericResultView result={result} />;
}
