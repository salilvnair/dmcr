import React, { useState, useEffect, useCallback, useMemo } from 'react';

const STORAGE_KEY = 'dmcr:ai-features:enabled';

interface WhereEntry { label: string; color: string }

interface Feature {
  id: string;
  tag: string;
  tagColor: string;
  title: string;
  tagline: string;
  how: string;
  status: 'available' | 'coming-soon';
  icon: string;
  group: string;
  where: WhereEntry[];
  promptKey: string;
}

const AI_FEATURES: Feature[] = [
  // ── Change Intelligence ───────────────────────────────────────────────────────
  {
    id: 'D18.1', tag: 'EXPLAIN', tagColor: '#6366f1', group: 'Change Intelligence',
    title: 'AI Change Explainer',
    tagline: 'Human-readable explanation for every SQL change.',
    how: 'Open Runner → Recent Runs, click the ✦ Explain button next to any run. AI reads the deploy.sql and tells you what the change does, which tables are affected, the risk level, and whether it is safely reversible.',
    status: 'available', icon: '💬',
    promptKey: 'AI_CHANGE_EXPLAINER',
    where: [
      { label: 'Runner tab', color: '#6366f1' },
      { label: '✦ Explain button', color: '#818cf8' },
      { label: 'on each run row', color: '#475569' },
    ],
  },
  {
    id: 'D18.5', tag: 'DEPS', tagColor: '#8b5cf6', group: 'Change Intelligence',
    title: 'AI Dependency Analyzer',
    tagline: 'Auto-fills dmcr:requires: so you never miss a dependency.',
    how: 'In the ChangeCard header, click "✦ Deps". AI scans your existing changes directory and identifies which prior migrations this new SQL depends on. Found dependencies appear as clickable chips — click any chip to add it to the meta.json requires field.',
    status: 'available', icon: '🔗',
    promptKey: 'AI_DEPENDENCY_ANALYZER',
    where: [
      { label: 'DMCR Copilot', color: '#8b5cf6' },
      { label: 'change card header', color: '#a78bfa' },
      { label: '✦ Deps button', color: '#475569' },
    ],
  },
  {
    id: 'D18.9', tag: 'SEMVER', tagColor: '#7c3aed', group: 'Change Intelligence',
    title: 'AI Semantic Versioning',
    tagline: 'Patch / Minor / Major badge on every change you generate.',
    how: 'After every AI change generation, a version badge appears next to the change name: PATCH for index/constraint changes, MINOR for new columns/tables/views, MAJOR for drops or breaking renames. Determined instantly using SQL pattern analysis — no LLM round-trip needed.',
    status: 'available', icon: '🏷️',
    promptKey: 'AI_SEMANTIC_VERSION',
    where: [
      { label: 'DMCR Copilot', color: '#8b5cf6' },
      { label: 'change card', color: '#a78bfa' },
      { label: 'next to change name', color: '#475569' },
    ],
  },
  {
    id: 'D18.10', tag: 'DRIFT', tagColor: '#f97316', group: 'Change Intelligence',
    title: 'AI Drift Detective',
    tagline: 'Scheduled background schema drift detection with AI summaries.',
    how: 'In Schema Diff, click "↺ Drift Check". DMCR immediately compares source vs target schema objects via MCP, calls AI for a risk-scored summary, and fires a VS Code notification if drift is detected. Run it any time to get an instant drift report with migration advice.',
    status: 'available', icon: '🔍',
    promptKey: 'AI_DRIFT_DETECTIVE',
    where: [
      { label: 'Schema Diff tab', color: '#f97316' },
      { label: 'action bar', color: '#fb923c' },
      { label: '↺ Drift Check button', color: '#475569' },
    ],
  },
  // ── Schema & Documentation ────────────────────────────────────────────────────
  {
    id: 'D18.3', tag: 'DOCS', tagColor: '#10b981', group: 'Schema & Documentation',
    title: 'AI Schema Documenter',
    tagline: 'Auto-generate a full data dictionary from your live schema.',
    how: 'Right-click a schema in Schema Explorer → "✦ Document Schema". AI queries your MCP-connected database and generates a complete Markdown data dictionary: tables, columns, types, nullable flags, and plain-English descriptions. Export to .md with one click.',
    status: 'available', icon: '📖',
    promptKey: 'AI_SCHEMA_DOCUMENTER',
    where: [
      { label: 'Schema Explorer', color: '#10b981' },
      { label: 'right-click schema', color: '#34d399' },
      { label: '✦ Document Schema', color: '#475569' },
    ],
  },
  {
    id: 'D18.6', tag: 'CHANGELOG', tagColor: '#0ea5e9', group: 'Schema & Documentation',
    title: 'AI Changelog Generator',
    tagline: 'Release-quality CHANGELOG.md from your migration history.',
    how: 'In Runner → Recent Runs, click "✦ Generate Changelog". AI reads the run history and descriptions from meta.json, groups them by date in Keep a Changelog format, and offers a one-click export to CHANGELOG.md.',
    status: 'available', icon: '📋',
    promptKey: 'AI_CHANGELOG_GENERATOR',
    where: [
      { label: 'Runner tab', color: '#6366f1' },
      { label: 'Recent Runs header', color: '#818cf8' },
      { label: '✦ Generate Changelog', color: '#0ea5e9' },
    ],
  },
  {
    id: 'D18.7', tag: 'DEAD COLS', tagColor: '#64748b', group: 'Schema & Documentation',
    title: 'AI Dead Column Detector',
    tagline: 'Find columns that nobody reads or writes — safely.',
    how: 'Right-click a schema in Schema Explorer → "🔍 Detect Dead Columns". AI analyzes column naming patterns, table statistics from pg_stat_user_tables, and schema signals to identify potentially unused columns. Results show table, column, confidence (high/medium/low), and reasoning.',
    status: 'available', icon: '🕵️',
    promptKey: 'AI_DEAD_COLUMN_DETECTOR',
    where: [
      { label: 'Schema Explorer', color: '#10b981' },
      { label: 'right-click schema', color: '#34d399' },
      { label: '🔍 Detect Dead Columns', color: '#475569' },
    ],
  },
  {
    id: 'D19.10', tag: 'TICKETS', tagColor: '#0ea5e9', group: 'Schema & Documentation',
    title: 'AI Ticket Linker',
    tagline: 'Auto-link every deploy to its Jira or Linear ticket.',
    how: 'In Runner history, click "Link Tickets". AI reads recent git commit messages and meta.json files to infer ticket IDs (Jira ABC-123, Linear, GitHub #123). Returns a table of change → ticket mappings with confidence scores so you can review and save the links.',
    status: 'available', icon: '🎫',
    promptKey: 'AI_TICKET_LINKER',
    where: [
      { label: 'Runner tab', color: '#6366f1' },
      { label: 'Recent Runs header', color: '#818cf8' },
      { label: '🎫 Link Tickets', color: '#0ea5e9' },
    ],
  },
  // ── Deploy Safety ─────────────────────────────────────────────────────────────
  {
    id: 'D18.2', tag: 'RISK', tagColor: '#f59e0b', group: 'Deploy Safety',
    title: 'AI Migration Risk Scorer',
    tagline: 'Know the blast radius before you deploy.',
    how: 'In the Runner tab, run "deploy --dry-run" and click "✦ Analyze Risk". AI reads each pending deploy.sql and assigns LOW / MEDIUM / HIGH / CRITICAL with a one-line justification. Badges appear inline on each change row.',
    status: 'available', icon: '⚠️',
    promptKey: 'AI_RISK_SCORER',
    where: [
      { label: 'Runner tab', color: '#6366f1' },
      { label: '✦ Analyze Risk', color: '#f59e0b' },
      { label: 'after deploy --dry-run', color: '#475569' },
    ],
  },
  {
    id: 'D18.4', tag: 'REVERT', tagColor: '#ef4444', group: 'Deploy Safety',
    title: 'AI Rollback Advisor',
    tagline: "Safe revert scripts even when revert.sql doesn't exist.",
    how: 'Click "↩ Revert Advice" on any run in Runner → Recent Runs. AI reads deploy.sql and synthesises a safe revert script with risk assessment. Warns if the operation is data-destructive or irreversible.',
    status: 'available', icon: '↩️',
    promptKey: 'AI_ROLLBACK_ADVISOR',
    where: [
      { label: 'Runner tab', color: '#6366f1' },
      { label: 'Recent Runs', color: '#818cf8' },
      { label: '↩ Revert Advice', color: '#ef4444' },
    ],
  },
  {
    id: 'D18.8', tag: 'POLICY', tagColor: '#dc2626', group: 'Deploy Safety',
    title: 'AI SQL Policy Guard',
    tagline: 'Define rules. AI enforces them before every save.',
    how: 'Set custom policies in Settings → SQL Policies. Before each change card renders, AI validates the SQL against your active policy set. Violations appear as a banner between the header and SQL tabs — red for errors, amber for warnings — with the policy name and a description of the breach.',
    status: 'available', icon: '🛡️',
    promptKey: 'AI_SQL_POLICY_GUARD',
    where: [
      { label: 'Settings → SQL Policies', color: '#dc2626' },
      { label: 'auto-triggers in Copilot', color: '#f87171' },
      { label: 'change card banner', color: '#475569' },
    ],
  },
  {
    id: 'D18.12', tag: 'PERF', tagColor: '#b45309', group: 'Deploy Safety',
    title: 'AI Performance Impact Predictor',
    tagline: 'Know the lock time and index build cost before you hit deploy.',
    how: 'On a change card in Runner, click "⚡ Perf Impact" before deploying an index creation or ALTER TABLE. AI queries pg_class for table row count and returns: lock type, whether CONCURRENTLY is safe, estimated block time, and a SAFE/USE CONCURRENTLY/SCHEDULE MAINTENANCE WINDOW recommendation.',
    status: 'available', icon: '⚡',
    promptKey: 'AI_PERF_PREDICTOR',
    where: [
      { label: 'Runner tab', color: '#6366f1' },
      { label: 'Recent Runs', color: '#818cf8' },
      { label: '⚡ Perf button', color: '#b45309' },
    ],
  },
  {
    id: 'D19.6', tag: 'HEALTH', tagColor: '#16a34a', group: 'Deploy Safety',
    title: 'AI Post-Deploy Health Check',
    tagline: 'Auto-verify your PROD deploy landed cleanly.',
    how: 'On a completed run in Runner history, click "🩺 Health Check". AI generates targeted diagnostic queries for your specific change (row counts, constraint checks, index verification), runs them via MCP, and produces a health report — healthy/warning/critical — with recovery recommendations.',
    status: 'available', icon: '🩺',
    promptKey: 'AI_POST_DEPLOY_HEALTH',
    where: [
      { label: 'Runner tab', color: '#6366f1' },
      { label: 'Recent Runs', color: '#818cf8' },
      { label: '🩺 Health Check (backend)', color: '#16a34a' },
    ],
  },
  {
    id: 'D19.7', tag: 'COMPLY', tagColor: '#b45309', group: 'Deploy Safety',
    title: 'AI Compliance Checker',
    tagline: 'GDPR, SOC 2, and HIPAA guard before every PROD promotion.',
    how: 'On a change card in Runner, click "⚖ Compliance". Select the profiles you want to check (GDPR, SOC 2, HIPAA). AI inspects the SQL against each profile\'s rules — PII handling, audit trail requirements, row-level security — and lists any violations before promotion.',
    status: 'available', icon: '⚖️',
    promptKey: 'AI_COMPLIANCE_CHECKER',
    where: [
      { label: 'Backend handler', color: '#b45309' },
      { label: 'checkCompliance', color: '#fbbf24' },
      { label: 'Runner (future UI)', color: '#475569' },
    ],
  },
  // ── ST-to-PROD Workflow ───────────────────────────────────────────────────────
  {
    id: 'D19.1', tag: 'GATE', tagColor: '#4f46e5', group: 'ST-to-PROD Workflow',
    title: 'AI Promotion Gatekeeper',
    tagline: 'Pre-flight checklist before every ST→PROD promotion.',
    how: 'On any change card in Runner, click "🚦 Gatekeep". AI runs a pre-flight checklist: ticket reference in meta.json, deploy.sql and revert.sql present, dependencies satisfied, policy violations. Blocked promotions show the exact failing check with remediation steps.',
    status: 'available', icon: '🚦',
    promptKey: 'AI_PROMOTION_GATEKEEPER',
    where: [
      { label: 'Runner tab', color: '#6366f1' },
      { label: 'Recent Runs', color: '#818cf8' },
      { label: '🚦 Gate button', color: '#4f46e5' },
    ],
  },
  {
    id: 'D19.2', tag: 'ENV DIFF', tagColor: '#0284c7', group: 'ST-to-PROD Workflow',
    title: 'AI Environment Diff Explainer',
    tagline: 'Understand why ST and PROD schemas diverged — and what to do next.',
    how: 'In Schema Diff, after comparing two environments, click "Explain Diff". AI reads the diff alongside your applied-changes history and explains in plain English which migrations caused each divergence, the recommended promotion order, and any conflicts requiring manual resolution.',
    status: 'available', icon: '🔀',
    promptKey: 'AI_ENV_DIFF_EXPLAINER',
    where: [
      { label: 'Schema Diff tab', color: '#f97316' },
      { label: 'after compare', color: '#fb923c' },
      { label: 'Explain Diff button', color: '#0284c7' },
    ],
  },
  {
    id: 'D19.3', tag: 'ORDER', tagColor: '#7c3aed', group: 'ST-to-PROD Workflow',
    title: 'AI Promotion Order Optimizer',
    tagline: 'AI figures out the safest promotion sequence for you.',
    how: 'Select multiple pending changes in Runner and click "Optimize Order". AI analyzes FK and view dependencies, lock contention patterns across all changes, and returns an ordered apply sequence. Conflicts between changes are flagged with resolution suggestions before any deploy runs.',
    status: 'available', icon: '📊',
    promptKey: 'AI_PROMOTION_ORDER',
    where: [
      { label: 'Backend handler', color: '#7c3aed' },
      { label: 'optimizePromotionOrder', color: '#a78bfa' },
      { label: 'Runner (future UI)', color: '#475569' },
    ],
  },
  {
    id: 'D19.4', tag: 'BLAST', tagColor: '#dc2626', group: 'ST-to-PROD Workflow',
    title: 'AI Blast Radius Estimator',
    tagline: 'Know downstream impact before touching PROD.',
    how: 'On a change card, click "💥 Blast Radius". AI queries pg_depend for downstream views, functions, and triggers that reference the affected table, estimates the lock type and blocking duration, and produces a blast radius report with a recommended notify list.',
    status: 'available', icon: '💥',
    promptKey: 'AI_BLAST_RADIUS',
    where: [
      { label: 'Backend handler', color: '#dc2626' },
      { label: 'estimateBlastRadius', color: '#f87171' },
      { label: 'Runner (future UI)', color: '#475569' },
    ],
  },
  {
    id: 'D19.5', tag: 'BLUE/GREEN', tagColor: '#0891b2', group: 'ST-to-PROD Workflow',
    title: 'AI Blue/Green Deploy Planner',
    tagline: 'Zero-downtime migration plan for breaking schema changes.',
    how: 'On a change card with a breaking DDL (DROP COLUMN, RENAME, type change), click "🔵 Blue/Green Plan". AI generates a two-phase migration: Phase 1 adds new structure while keeping old (backward-compatible), Phase 2 removes old after app deploy. Each phase is ready-to-use SQL.',
    status: 'available', icon: '🔵',
    promptKey: 'AI_BLUE_GREEN_PLAN',
    where: [
      { label: 'Backend handler', color: '#0891b2' },
      { label: 'blueGreenPlan', color: '#22d3ee' },
      { label: 'Runner (future UI)', color: '#475569' },
    ],
  },
  {
    id: 'D19.8', tag: 'CONFLICT', tagColor: '#9333ea', group: 'ST-to-PROD Workflow',
    title: 'AI Conflict Resolver',
    tagline: 'Merge concurrent ST and PROD edits to the same tables.',
    how: 'When Schema Diff detects the same table was altered in both ST and PROD, a conflict badge appears. Click "Resolve" to open the AI conflict resolver — it shows both versions side by side and generates a synthesized migration that safely incorporates both changes.',
    status: 'available', icon: '🔁',
    promptKey: 'AI_CONFLICT_RESOLVER',
    where: [
      { label: 'Schema Diff tab', color: '#f97316' },
      { label: 'conflict banner', color: '#9333ea' },
      { label: 'Resolve button', color: '#475569' },
    ],
  },
  {
    id: 'D19.9', tag: 'CANARY', tagColor: '#ea580c', group: 'ST-to-PROD Workflow',
    title: 'AI Canary Rollout Advisor',
    tagline: 'Large table migrations? AI designs a phased rollout strategy.',
    how: 'On a change card with large-table operations (ALTER or index CREATE), click "🐤 Canary Plan". AI queries pg_class for actual row count, advises whether canary is needed, and designs the rollout: what percentage to apply first, which pg_stat_activity metrics to monitor, and the green-light threshold.',
    status: 'available', icon: '🐤',
    promptKey: 'AI_CANARY_ADVISOR',
    where: [
      { label: 'Backend handler', color: '#ea580c' },
      { label: 'canaryRolloutAdvisor', color: '#fb923c' },
      { label: 'Runner (future UI)', color: '#475569' },
    ],
  },
  // ── Data & Testing ────────────────────────────────────────────────────────────
  {
    id: 'D18.11', tag: 'SEED', tagColor: '#059669', group: 'Data & Testing',
    title: 'AI Test Data Generator',
    tagline: 'Realistic seed data that respects your schema constraints.',
    how: 'Type "Seed test data for public.my_table" in DMCR Copilot, or use the "Seed test data" chip. AI inspects the table schema via MCP — column names, types, NOT NULL constraints, foreign keys — and generates 10-20 realistic INSERT rows that satisfy all constraints.',
    status: 'available', icon: '🌱',
    promptKey: 'AI_TEST_DATA_GENERATOR',
    where: [
      { label: 'DMCR Copilot', color: '#059669' },
      { label: '🧪 Seed test data chip', color: '#34d399' },
      { label: 'chat input', color: '#475569' },
    ],
  },
];

const GROUP_ORDER = [
  'Change Intelligence',
  'Schema & Documentation',
  'Deploy Safety',
  'ST-to-PROD Workflow',
  'Data & Testing',
];

const GROUP_COLORS: Record<string, string> = {
  'Change Intelligence':   '#6366f1',
  'Schema & Documentation': '#10b981',
  'Deploy Safety':          '#ef4444',
  'ST-to-PROD Workflow':    '#f59e0b',
  'Data & Testing':         '#059669',
};

// ── Persistence ───────────────────────────────────────────────────────────────

function loadEnabledMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistEnabledMap(map: Record<string, boolean>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* noop */ }
}

function buildInitialMap(): Record<string, boolean> {
  const stored = loadEnabledMap();
  const map: Record<string, boolean> = {};
  AI_FEATURES.forEach(f => { map[f.id] = stored[f.id] !== false; }); // default true
  return map;
}

// ── Toggle pill ───────────────────────────────────────────────────────────────

function Toggle({ on, onToggle, color, size = 'md' }: { on: boolean; onToggle: () => void; color: string; size?: 'sm' | 'md' }) {
  const w = size === 'sm' ? 30 : 36;
  const h = size === 'sm' ? 17 : 20;
  const dot = size === 'sm' ? 11 : 14;
  const dotTop = size === 'sm' ? 3 : 3;
  const dotOn = size === 'sm' ? w - dot - 2 : w - dot - 3;
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onToggle(); }}
      style={{
        width: w, height: h, borderRadius: h / 2, border: 'none', cursor: 'pointer',
        background: on ? color : 'rgba(255,255,255,0.12)',
        position: 'relative', flexShrink: 0, transition: 'background 0.2s',
        padding: 0,
      }}
      title={on ? 'Enabled — click to disable' : 'Disabled — click to enable'}
    >
      <span style={{
        position: 'absolute', top: dotTop, width: dot, height: dot, borderRadius: '50%',
        background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
        left: on ? dotOn : 3, transition: 'left 0.18s ease',
        display: 'block',
      }} />
    </button>
  );
}

// ── Feature card ──────────────────────────────────────────────────────────────

function BookIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function FeatureCard({ f, enabled, onToggle, onGoToPrompts }: { f: Feature; enabled: boolean; onToggle: () => void; onGoToPrompts: (key: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const groupColor = GROUP_COLORS[f.group] ?? f.tagColor;

  return (
    <div
      style={{
        background: enabled ? 'var(--bg-secondary, rgba(255,255,255,0.03))' : 'rgba(0,0,0,0.18)',
        border: `1px solid ${enabled ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)'}`,
        borderRadius: 9, padding: '11px 13px', marginBottom: 7,
        opacity: enabled ? 1 : 0.48,
        transition: 'opacity 0.2s, background 0.2s, border-color 0.2s',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }} onClick={() => setExpanded(e => !e)}>
        <span style={{ fontSize: 17, opacity: enabled ? 1 : 0.4, flexShrink: 0 }}>{f.icon}</span>
        <span style={{
          fontSize: 8.5, fontWeight: 800, letterSpacing: 0.9, padding: '1.5px 6px', borderRadius: 4,
          background: enabled ? `${f.tagColor}22` : 'rgba(255,255,255,0.04)',
          color: enabled ? f.tagColor : '#475569',
          border: `1px solid ${enabled ? `${f.tagColor}44` : 'rgba(255,255,255,0.06)'}`,
          flexShrink: 0, transition: 'all 0.2s',
        }}>{f.tag}</span>
        <span style={{
          flex: 1, fontSize: 12.5, fontWeight: 600,
          color: enabled ? 'var(--text-primary, #e2e8f0)' : '#475569',
          transition: 'color 0.2s',
        }}>{f.title}</span>
        {/* ON / OFF text label */}
        <span style={{ fontSize: 9, fontWeight: 700, color: enabled ? '#4ade80' : '#475569', flexShrink: 0, letterSpacing: 0.4 }}>
          {enabled ? 'ON' : 'OFF'}
        </span>
        {/* 📖 Prompt Library link */}
        <button
          onClick={(e) => { e.stopPropagation(); onGoToPrompts(f.promptKey); }}
          title="Open in Prompt Library"
          style={{
            background: 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5,
            padding: '3px 5px', cursor: 'pointer', color: '#64748b', display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            transition: 'color 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#818cf8'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(99,102,241,0.4)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#64748b'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.08)'; }}
        >
          <BookIcon />
        </button>
        <Toggle on={enabled} onToggle={() => onToggle()} color={groupColor} />
        <span style={{ fontSize: 9, color: '#475569', flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
      </div>

      {/* Tagline */}
      <p style={{ margin: '5px 0 0 24px', fontSize: 11.5, color: enabled ? 'var(--text-secondary, #94a3b8)' : '#334155', lineHeight: 1.5 }}>
        {f.tagline}
      </p>

      {/* ↳ Location breadcrumb — always visible, Daakia-style */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 3, marginTop: 5, marginLeft: 24 }}>
        <span style={{ fontSize: 10, color: '#334155', fontWeight: 600, flexShrink: 0 }}>↳</span>
        {f.where.map((loc, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {i > 0 && <span style={{ fontSize: 9, color: '#334155' }}>·</span>}
            <span style={{ fontSize: 10.5, color: enabled ? loc.color : '#334155', fontWeight: 500, transition: 'color 0.2s' }}>{loc.label}</span>
          </span>
        ))}
      </div>

      {/* Expanded how-to */}
      {expanded && (
        <p style={{ margin: '8px 0 0 24px', fontSize: 11, color: enabled ? '#64748b' : '#334155', lineHeight: 1.7, padding: '7px 10px', background: 'rgba(0,0,0,0.14)', borderRadius: 6, borderLeft: `3px solid ${enabled ? f.tagColor : '#1e293b'}` }}>
          {enabled ? f.how : 'Enable this feature to see usage details.'}
        </p>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function AiFeaturesPanel({ onGoToPrompts }: { onGoToPrompts?: (key: string) => void }) {
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(buildInitialMap);
  const [showDisabled, setShowDisabled] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    persistEnabledMap(enabledMap);
  }, [enabledMap]);

  const toggleFeature = useCallback((id: string) => {
    setEnabledMap(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const setGroupEnabled = useCallback((group: string, val: boolean) => {
    setEnabledMap(prev => {
      const next = { ...prev };
      AI_FEATURES.filter(f => f.group === group).forEach(f => { next[f.id] = val; });
      return next;
    });
  }, []);

  const setAllEnabled = useCallback((val: boolean) => {
    setEnabledMap(prev => {
      const next = { ...prev };
      AI_FEATURES.forEach(f => { next[f.id] = val; });
      return next;
    });
  }, []);

  const toggleCollapse = useCallback((group: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }, []);

  const q = searchQuery.trim().toLowerCase();

  const enabledCount = AI_FEATURES.filter(f => enabledMap[f.id]).length;
  const allEnabled = enabledCount === AI_FEATURES.length;
  const liveCount = AI_FEATURES.filter(f => f.status === 'available' && enabledMap[f.id]).length;

  const grouped = useMemo(() => {
    return GROUP_ORDER.map(g => ({
      group: g,
      color: GROUP_COLORS[g] ?? '#6366f1',
      features: AI_FEATURES.filter(f => {
        if (f.group !== g) return false;
        if (!showDisabled && !enabledMap[f.id]) return false;
        if (!q) return true;
        return (
          f.title.toLowerCase().includes(q) ||
          f.tag.toLowerCase().includes(q) ||
          f.group.toLowerCase().includes(q) ||
          f.tagline.toLowerCase().includes(q) ||
          f.how.toLowerCase().includes(q)
        );
      }),
    })).filter(g => g.features.length > 0);
  }, [q, showDisabled, enabledMap]);

  return (
    <div style={{ width: '100%' }}>

      {/* Hero */}
      <div style={{ marginBottom: 18, padding: '17px 20px', background: 'linear-gradient(135deg, rgba(99,102,241,0.12) 0%, rgba(139,92,246,0.08) 100%)', borderRadius: 12, border: '1px solid rgba(99,102,241,0.22)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <span style={{ fontSize: 24 }}>🤖</span>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--text-primary, #e2e8f0)' }}>AI Power Features</h2>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: '#818cf8' }}>Capabilities you won't find in Flyway, Liquibase, or Sqitch</p>
          </div>
          {/* Stats + master toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 19, fontWeight: 700, color: '#4ade80', lineHeight: 1 }}>{liveCount}</div>
              <div style={{ fontSize: 9, color: '#64748b', marginTop: 1 }}>live now</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 19, fontWeight: 700, color: '#818cf8', lineHeight: 1 }}>{enabledCount}/{AI_FEATURES.length}</div>
              <div style={{ fontSize: 9, color: '#64748b', marginTop: 1 }}>enabled</div>
            </div>
            <Toggle on={allEnabled} onToggle={() => setAllEnabled(!allEnabled)} color="#6366f1" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['Explains every change', 'Risk scores before deploy', 'Auto-generates docs', 'Policy enforcement', 'Schema drift alerts', 'Zero-downtime planning', 'ST→PROD gatekeeper', 'Compliance checks'].map(tag => (
            <span key={tag} style={{ fontSize: 9.5, padding: '2px 8px', borderRadius: 20, background: 'rgba(99,102,241,0.12)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.2)' }}>{tag}</span>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <input
          type="text"
          placeholder="Search features by name, tag, or description…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{
            flex: 1, padding: '6px 10px', borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.09)',
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-primary, #e2e8f0)',
            fontSize: 11.5, outline: 'none',
          }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#64748b', cursor: 'pointer', flexShrink: 0, userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={showDisabled}
            onChange={e => setShowDisabled(e.target.checked)}
            style={{ cursor: 'pointer', accentColor: '#6366f1' }}
          />
          Show disabled
        </label>
      </div>

      {/* Grouped feature cards */}
      {grouped.map(({ group, color, features }) => {
        const isCollapsed = collapsed.has(group);
        const groupEnabledCount = features.filter(f => enabledMap[f.id]).length;
        const allGroupEnabled = features.length > 0 && groupEnabledCount === features.length;
        return (
          <div key={group} style={{ marginBottom: 14 }}>
            {/* Group header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
              <button
                type="button"
                onClick={() => toggleCollapse(group)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, padding: 0 }}
              >
                <span style={{
                  fontSize: 9, color, opacity: 0.7,
                  display: 'inline-block',
                  transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                  transition: 'transform 0.18s ease',
                }}>▶</span>
                <span style={{
                  fontSize: 9, fontWeight: 800, letterSpacing: 1.4, padding: '2px 8px', borderRadius: 4,
                  background: `${color}18`, color, border: `1px solid ${color}30`,
                }}>
                  {group}
                </span>
              </button>
              <div style={{ flex: 1, height: 1, background: `${color}22` }} />
              <span style={{ fontSize: 8.5, color: '#475569' }}>{groupEnabledCount}/{features.length}</span>
              <Toggle on={allGroupEnabled} onToggle={() => setGroupEnabled(group, !allGroupEnabled)} color={color} size="sm" />
            </div>

            {/* Feature list */}
            {(!isCollapsed || !!q) && (
              <div>
                {features.map(f => (
                  <FeatureCard
                    key={f.id}
                    f={f}
                    enabled={enabledMap[f.id]}
                    onToggle={() => toggleFeature(f.id)}
                    onGoToPrompts={onGoToPrompts ?? (() => {})}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Footer note */}
      <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(99,102,241,0.06)', borderRadius: 8, fontSize: 11, color: '#64748b', lineHeight: 1.6 }}>
        <strong style={{ color: '#818cf8' }}>Sprint D18 + D19</strong> — Feature toggles are persisted locally in the webview.
        "Available" features are active now. "Coming Soon" features are in the implementation backlog.
        Disabling a feature hides its buttons and prevents LLM calls for that action.
      </div>
    </div>
  );
}
