import React, { useRef, useState, useEffect, useCallback } from 'react';
import { postMsg } from '../../vscode';
import '../WikiPanel.css';

/* ── Lightweight syntax colorizer for wiki <pre> blocks ── */

/** Apply regex replacements only to text outside of HTML tags */
function colorizeText(html: string, rules: [RegExp, string][]): string {
  // Split into tags and text segments; only transform text segments
  const parts = html.split(/(<[^>]*>)/);
  for (let i = 0; i < parts.length; i++) {
    // Skip HTML tags (odd indices from split on captured group)
    if (parts[i].startsWith('<')) continue;
    for (const [rx, repl] of rules) {
      parts[i] = parts[i].replace(rx, repl);
    }
  }
  return parts.join('');
}

function colorizePreBlocks(container: HTMLElement) {
  const pres = container.querySelectorAll('pre');
  pres.forEach(pre => {
    if (pre.dataset.colorized) return;
    pre.dataset.colorized = '1';
    let html = pre.innerHTML;

    // Terminal/PowerShell log lines: INFO, WARN, ERROR, DONE, SKIP, VERIFY, INIT, REVERT
    html = html.replace(/^(INFO\b)/gm, '<span class="wc-info">$1</span>');
    html = html.replace(/^(WARN\b)/gm, '<span class="wc-warn">$1</span>');
    html = html.replace(/^(ERROR\b)/gm, '<span class="wc-error">$1</span>');
    html = html.replace(/^(DONE\b)/gm, '<span class="wc-done">$1</span>');
    html = html.replace(/^(SKIP\b)/gm, '<span class="wc-skip">$1</span>');
    html = html.replace(/^(VERIFY\b)/gm, '<span class="wc-verify">$1</span>');
    html = html.replace(/^(INIT\b)/gm, '<span class="wc-init">$1</span>');
    html = html.replace(/^(REVERT\b)/gm, '<span class="wc-revert">$1</span>');
    html = html.replace(/^(LOCK\b)/gm, '<span class="wc-info">$1</span>');
    html = html.replace(/^(UNLOCK\b)/gm, '<span class="wc-info">$1</span>');

    // Apply text-safe rules (won't touch attributes inside HTML tags)
    html = colorizeText(html, [
      // Shell comments: # ...
      [/(#[^\n]*)/g, '<span class="wc-comment">$1</span>'],
      // Shell commands at line start
      [/^(dmcr|git|npm|docker|az|kubectl|psql|node|npx|pnpm|yarn|cd|mkdir|cp|mv|rm|cat|echo|export|source|chmod)\b/gm, '<span class="wc-shell-cmd">$1</span>'],
      // Numbered steps: 1. 2. 3.
      [/^(\d+\.)/gm, '<span class="wc-info">$1</span>'],
      // JSON keys: "key":
      [/("[\w_-]+")\s*:/g, '<span class="wc-json-key">$1</span>:'],
      // JSON string values
      [/:\s*("(?:[^"\\]|\\.)*")/g, ': <span class="wc-json-str">$1</span>'],
      // JSON booleans/numbers
      [/:\s*(true|false|null|\d+)/g, ': <span class="wc-json-val">$1</span>'],
      // SQL keywords
      [/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE|INTO|VALUES|SET|TABLE|INDEX|COLUMN|ADD|NOT NULL|DEFAULT|PRIMARY KEY|FOREIGN KEY|REFERENCES|CASCADE|IF EXISTS|IF NOT EXISTS|OR REPLACE|BEGIN|COMMIT|ROLLBACK|GRANT|REVOKE|ON|TO|AS|VIEW|FUNCTION|TRIGGER|RETURNS|SCHEMA|EXECUTE|PROCEDURE|WITH|DECLARE|RAISE|EXCEPTION|NOTICE)\b/g, '<span class="wc-sql-kw">$1</span>'],
      // Flags: --something or -c (only after whitespace)
      [/(?<=\s)(--?[a-zA-Z][\w-]*)/g, '<span class="wc-flag">$1</span>'],
      // File tree: directories ending with /
      [/([\w._-]+\/)/g, '<span class="wc-dir">$1</span>'],
      // Known file names
      [/\b(deploy\.sql|verify\.sql|revert\.sql|meta\.json|dmcr\.ps1|prod\.ini)\b/g, '<span class="wc-file">$1</span>'],
      // Box drawing characters
      [/([┌┐└┘├┤┬┴┼│─═║╔╗╚╝╠╣╦╩╬]+)/g, '<span class="wc-box">$1</span>'],
    ]);

    pre.innerHTML = html;
  });

  // Also colorize wiki-cmd-example-code blocks (shell commands)
  const cmdBlocks = container.querySelectorAll('.wiki-cmd-example-code');
  cmdBlocks.forEach(block => {
    const el = block as HTMLElement;
    if (el.dataset.colorized) return;
    el.dataset.colorized = '1';
    // Use colorizeText to avoid corrupting HTML attributes
    el.innerHTML = colorizeText(el.innerHTML, [
      // Shell commands at line start or after newline
      [/^(dmcr|git|npm|docker|az|kubectl|psql|node|npx|pnpm|yarn|cd|mkdir|cp|mv|rm|cat|echo|export|source|chmod)\b/gm, '<span class="wc-shell-cmd">$1</span>'],
      // Flags after whitespace
      [/(?<=\s)(--?[a-zA-Z][\w-]*)/g, '<span class="wc-flag">$1</span>'],
      // Strings in quotes (but not HTML attributes since we skip tags)
      [/("(?:[^"\\]|\\.)*")/g, '<span class="wc-shell-str">$1</span>'],
      // File paths with extensions
      [/\b([\w._-]+\.(sql|json|ini|ps1|sh|yml|yaml|toml))\b/g, '<span class="wc-file">$1</span>'],
    ]);
  });
}

export function WikiPanel({ sidebar = false }: { sidebar?: boolean }) {
  const cmd = (command: string) => postMsg({ type: 'executeCommand', payload: { command } });
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollToSection = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const scrollToTop = () => {
    const el = panelRef.current;
    if (!el) return;
    if (sidebar) { el.scrollTo({ top: 0, behavior: 'smooth' }); }
    else { (el.closest('.bs-settings-content') || el).scrollTo({ top: 0, behavior: 'smooth' }); }
  };
  const tryIt = (tab: string) => {
    if (sidebar) { cmd('dmcr.open'); }
    else { window.postMessage({ type: 'navigateToTab', payload: { tab } }, '*'); }
  };

  const [wikiSearch, setWikiSearch] = useState('');
  const [showTop, setShowTop] = useState(false);
  const onScroll = useCallback((e: Event) => {
    const el = e.currentTarget as HTMLElement;
    if (!el) return;
    const pct = el.scrollTop / (el.scrollHeight - el.clientHeight || 1);
    setShowTop(pct > 0.05);
  }, []);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const scrollTarget = sidebar ? el : (el.closest('.bs-settings-content') as HTMLElement || el);
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollTarget.removeEventListener('scroll', onScroll);
  }, [onScroll, sidebar]);

  /* Colorize code blocks after render */
  useEffect(() => {
    const el = panelRef.current;
    if (el) colorizePreBlocks(el);
  }, []);

  /* Filter wiki sections by search query */
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const sections = el.querySelectorAll<HTMLElement>('section[id^="wiki-"], .wiki-hero');
    const q = wikiSearch.trim().toLowerCase();
    if (!q) {
      sections.forEach(s => { s.style.display = ''; });
      return;
    }
    sections.forEach(s => {
      const text = s.textContent?.toLowerCase() ?? '';
      s.style.display = text.includes(q) ? '' : 'none';
    });
  }, [wikiSearch]);

  return (
    <div className={`wiki-panel${sidebar ? ' wiki-panel--sidebar' : ''}`} ref={panelRef}>
      {/* ── Sticky TOC ── */}
      <nav className="wiki-toc">
        <div className="wiki-toc-title">📑 Contents</div>
        <input
          type="search"
          placeholder="Search wiki…"
          value={wikiSearch}
          onChange={e => setWikiSearch(e.target.value)}
          style={{
            display: 'block', width: '100%', boxSizing: 'border-box',
            margin: '6px 0 8px', padding: '5px 10px', borderRadius: 6,
            border: '1px solid var(--ce-border, rgba(255,255,255,0.1))',
            background: 'var(--bg-secondary, rgba(255,255,255,0.05))',
            color: 'var(--text-primary, #e2e8f0)', fontSize: 11, outline: 'none',
          }}
        />
        <div className="wiki-toc-group-label">DMCR Framework</div>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-what')}>🤔 What is DMCR?</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-versions')}>📦 v1.0.0 vs v1.1.0</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-git')}>🌿 Git &amp; GitHub</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-glance')}>⚡ At A Glance</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-change-model')}>📂 Change Model</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-deploy-steps')}>⚙️ How Deploy Works</button>
        <div className="wiki-toc-group-label">Copilot Extension</div>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-home')}>🏠 Home &amp; Navigation</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ddl')}>🧱 Schema Builder</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-insert')}>📥 Insert Rows</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-freeform')}>✏️ Freeform SQL</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-schema-diff')}>🔀 Schema Diff</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-conversation')}>💬 DMCR Assistant</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-schema-explorer')}>🗂️ Schema Explorer</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-runner-tab')}>🖥️ Runner Tab</button>
        <div className="wiki-toc-group-label">AI &amp; Intelligence</div>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ai-arch')}>🧠 AI Architecture</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-prompts')}>📚 Prompt Library</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-mcp')}>🔌 MCP Integration</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-providers')}>🤖 LLM Providers</button>
        <div className="wiki-toc-group-label">Developer Tools</div>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-devtools')}>🧰 Dev Tools Overview</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ai-footprint')}>🤖 AI Footprint</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-audit-log')}>📋 Audit Log</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-memory')}>🧠 Memory Footprint</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-debug')}>🐛 Debug Snapshot</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-db-explorer')}>🗄️ DB Explorer</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-git-sync')}>🔄 Git Sync</button>
        <div className="wiki-toc-group-label">Command Reference</div>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-core-cmds')}>🚀 Core Commands</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-revert-cmds')}>↩️ Revert Commands</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-inspect-cmds')}>🔎 Inspect Commands</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-repair-cmds')}>🔧 Repair Commands</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-tag-cmds')}>🏷️ Tag Commands</button>
        <div className="wiki-toc-group-label">Configuration</div>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-global-opts')}>🎛️ Global Options</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-config')}>⚙️ Configuration</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-registry')}>🗄️ Registry Tables</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-safety')}>🛡️ Safety Model</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-scenario')}>🎬 Real-World Scenario</button>
        <div className="wiki-toc-group-label">Getting Started</div>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-gs-setup')}>⚙️ Initial Setup</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-gs-first-change')}>🗂️ First Change</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-gs-quickref')}>⚡ Quick Reference</button>
        <div className="wiki-toc-group-label">New Features</div>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-conv-history')}>🕐 Conversation History</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-agent-trace')}>🕵️ Agent Trace</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-schema-node-graph')}>🔀 Schema Node Graph</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-multi-env')}>🌐 Multi-Environment</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-runner-limit')}>⏱️ Recent Runs Limit</button>
        <div className="wiki-toc-group-label">AI Power Features</div>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ai-features-overview')}>🤖 D18 Overview</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ai-explainer')}>💬 Change Explainer</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ai-semver')}>🏷️ Semantic Versioning</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ai-risk')}>⚠️ Risk Scorer</button>
        <div className="wiki-toc-group-label">Script Internals</div>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-overview')}>📜 dmcr.ps1 Overview</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-startup')}>🚀 Startup &amp; Cleanup</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-entrypoint')}>🎯 Entrypoint &amp; Routing</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-config')}>⚙️ Config &amp; INI Parser</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-psql')}>🔧 psql Helpers</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-danger')}>🚨 Danger Gate</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-locking')}>🔒 Advisory Locking</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-deploy')}>📦 Deploy Engine</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-revert')}>↩️ Revert Engine</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-planner')}>🧩 Dependency Planner</button>
        <button className="wiki-toc-link" onClick={() => scrollToSection('wiki-ps1-display')}>🎨 Display &amp; Tables</button>
      </nav>

      <div className="wiki-stack">
        {/* ── Hero ── */}
        <section className="wiki-hero">
          <div className="wiki-hero-head">
            <div>
              <div className="wiki-eyebrow">DMCR Wiki</div>
              <h1>Transactional PostgreSQL Change Ops</h1>
            </div>
          </div>
          <p className="wiki-hero-copy">DMCR combines AI-assisted change generation, versioned change folders, transactional deploy and revert, and a runner with safety gates for destructive SQL.</p>
          <div className="wiki-chips">
            <span className="wiki-chip">deploy.sql</span>
            <span className="wiki-chip">verify.sql</span>
            <span className="wiki-chip">revert.sql</span>
            <span className="wiki-chip">meta.json</span>
            <span className="wiki-chip">R__ repeatable</span>
            <span className="wiki-chip">${'${placeholders}'}</span>
            <span className="wiki-chip">@tags</span>
            <span className="wiki-chip">danger_ gate</span>
            <span className="wiki-chip">advisory lock</span>
            <span className="wiki-chip">--json</span>
            <span className="wiki-chip wiki-chip--accent">AI Chat</span>
            <span className="wiki-chip wiki-chip--accent">Schema Builder</span>
            <span className="wiki-chip wiki-chip--accent">MCP Tools</span>
            <span className="wiki-chip wiki-chip--accent">Prompt Library</span>
            <span className="wiki-chip wiki-chip--accent">Audit Trail</span>
          </div>
        </section>



        {/* ── What is DMCR? ── */}
        <section id="wiki-what" className="wiki-card">
          <h2>🤔 What is DMCR?</h2>
          <p>Think of DMCR as a <strong>version control system for your database</strong>. Just like you save versions of your code, DMCR saves versions of your database changes.</p>
          <div className="wiki-callout info">
            <div>💡</div>
            <div><b>Simple analogy</b> Imagine you're writing an essay. You save drafts as "v1", "v2", "v3". If v3 is bad, you go back to v2. DMCR does exactly this — but for your PostgreSQL database.</div>
          </div>
          <p style={{marginTop: 8}}>Every change you make to the database is stored as a <strong>numbered folder</strong> with three SQL files:</p>
          <div className="wiki-flow">
            <div className="wiki-flow-step green">📝 deploy.sql</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step blue">✅ verify.sql</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step red">↩️ revert.sql</div>
          </div>
          <div className="wiki-table" style={{marginTop: 8}}>
            <div className="wiki-row"><strong>deploy.sql</strong><span>The SQL that MAKES the change (e.g. adds a column, creates a table)</span></div>
            <div className="wiki-row"><strong>verify.sql</strong><span>The SQL that CHECKS the change worked correctly (like a test)</span></div>
            <div className="wiki-row"><strong>revert.sql</strong><span>The SQL that UNDOES the change if you need to go back</span></div>
          </div>
        </section>

        {/* ── v1.0 vs v1.1 ── */}
        <section id="wiki-versions" className="wiki-card">
          <h2>📦 v1.0.0 vs v1.1.0 — What Changed?</h2>
          <p>In the older <code>v1.0.0</code>, DMCR was simple — just deploy, verify, and revert. The newer version adds much more:</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>v1.0.0</strong><span>Basic deploy/verify/revert. Manual folder management. No tags, no dependency tracking, no checksums.</span></div>
            <div className="wiki-row"><strong>v1.1.0</strong><span>Advisory locks, dependency graphs via <code>meta.json</code>, checksum policies, <code>@tags</code> for releases, <code>baseline</code> &amp; <code>repair</code> commands, JSON output, repeatable migrations (<code>R__</code>), <code>--dry-run</code>, enriched audit trail with actor/environment/git commit.</span></div>
          </div>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Backwards compatible</b> Everything from v1.0.0 still works exactly the same. The new features are additive — you only use them when you need them.</div>
          </div>
        </section>

        {/* ── Git & GitHub ── */}
        <section id="wiki-git" className="wiki-card">
          <h2>🌿 Git &amp; GitHub — Integrated Version Control</h2>
          <p>DMCR has <strong>built-in Git integration</strong> — auto-commit, push, pull, and manual sync — all configured from <strong>Settings → DMCR Config → Git Integration</strong>.</p>

          <h3>⚙️ Configuration (DMCR Config)</h3>
          <div className="wiki-table">
            <div className="wiki-row"><strong>GitHub Remote URL</strong><span>HTTPS or SSH URL (e.g. <code>https://github.com/org/repo.git</code>). When saved, DMCR runs <code>git remote set-url origin &lt;url&gt;</code>.</span></div>
            <div className="wiki-row"><strong>Branch</strong><span>Target branch for push/pull (e.g. <code>main</code>, <code>develop</code>). Click <strong>🔄 Fetch</strong> to auto-populate a dropdown of remote branches from your URL. Leave empty to use the currently checked-out branch.</span></div>
            <div className="wiki-row"><strong>Auto-commit</strong><span>Enabled by default (<code>dmcr.gitAutoCommit = true</code>). Stages, commits with AI message, and pushes after every change generation. Disable to use manual <code>/sync</code>.</span></div>
          </div>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Branch auto-detection.</b> When you enter a Remote URL and click Fetch, DMCR runs <code>git ls-remote --heads</code> to list all available branches and populates a dropdown. Select your target branch — it&apos;s used for every <code>git pull</code> and <code>git push</code>.</div>
          </div>
          <div className="wiki-callout">
            <div>💡</div>
            <div><b>Settings location:</b> Stored in <code>.vscode/settings.json</code> as <code>dmcr.gitRemoteUrl</code>, <code>dmcr.gitBranch</code>, and <code>dmcr.gitAutoCommit</code>.</div>
          </div>

          <h3>⚡ Auto-Commit Flow</h3>
          <p>When you generate a change (DDL, Insert, Freeform, Schema Diff) and save it:</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>1. Check</strong><span>Is <code>dmcr.gitAutoCommit</code> enabled? Is <code>git</code> on PATH? Is this a git repo?</span></div>
            <div className="wiki-row"><strong>2. AI Prompt</strong><span>Calls the LLM with the <code>GIT_COMMIT_MESSAGE</code> prompt (Prompt Library → Git &amp; Version Control). Passes folder name, SQL, and branch.</span></div>
            <div className="wiki-row"><strong>3. Stage</strong><span><code>git add -- &lt;folderPath&gt;</code></span></div>
            <div className="wiki-row"><strong>4. Commit</strong><span><code>git commit -m "&lt;AI message&gt;"</code>. Falls back to <code>feat(db): add &lt;folder&gt;</code> if AI fails.</span></div>
            <div className="wiki-row"><strong>5. Push</strong><span><code>git push origin &lt;branch&gt;</code> — uses your configured branch (or current HEAD).</span></div>
            <div className="wiki-row"><strong>6. Notify</strong><span>Home page GenBar shows ✓ commit hash. Errors show inline.</span></div>
          </div>

          <h3>🖥️ Manual Sync — <code>/sync</code></h3>
          <p>Available in the <strong>Runner tab</strong> or via the Home page Sync button. Full cycle:</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Pull</strong><span><code>git pull --rebase origin &lt;branch&gt;</code></span></div>
            <div className="wiki-row"><strong>Stage</strong><span><code>git add -- &lt;changesDir&gt;</code> — stages ALL files in your changes directory.</span></div>
            <div className="wiki-row"><strong>AI Commit</strong><span>Generates a commit message summarizing all staged changes.</span></div>
            <div className="wiki-row"><strong>Push</strong><span><code>git push origin &lt;branch&gt;</code></span></div>
          </div>

          <details open>
            <summary>🔄 The Full Workflow</summary>
            <div className="wiki-section-copy">
              <div className="wiki-steps">
                <div className="wiki-step"><div className="wiki-step-num">1</div><div className="wiki-step-text"><strong>Configure</strong> — Set Remote URL and Branch in Settings → DMCR Config → Git Integration</div></div>
                <div className="wiki-step"><div className="wiki-step-num">2</div><div className="wiki-step-text"><strong>Generate SQL</strong> — Use DMCR Copilot to generate deploy.sql, verify.sql, revert.sql</div></div>
                <div className="wiki-step"><div className="wiki-step-num">3</div><div className="wiki-step-text"><strong>Save</strong> — DMCR saves into a numbered folder like <code>005_add_email_to_users/</code></div></div>
                <div className="wiki-step"><div className="wiki-step-num">4</div><div className="wiki-step-text"><strong>Auto-commit</strong> — DMCR stages, generates AI commit message, commits, and pushes to your configured branch</div></div>
                <div className="wiki-step"><div className="wiki-step-num">5</div><div className="wiki-step-text"><strong>Or /sync</strong> — If auto-commit is off, use <code>/sync</code> to pull → stage → commit → push manually</div></div>
                <div className="wiki-step"><div className="wiki-step-num">6</div><div className="wiki-step-text"><strong>Code review</strong> — Team reviews the SQL on GitHub (pull request)</div></div>
                <div className="wiki-step"><div className="wiki-step-num">7</div><div className="wiki-step-text"><strong>Deploy</strong> — Run <code>dmcr deploy</code> to apply changes. DMCR records the git commit hash in the audit trail.</div></div>
              </div>
            </div>
          </details>

          <details>
            <summary>🛡️ Fallbacks &amp; Errors</summary>
            <div className="wiki-section-copy">
              <div className="wiki-table">
                <div className="wiki-row"><strong>No git installed</strong><span>Auto-commit silently skips. <code>/sync</code> shows error.</span></div>
                <div className="wiki-row"><strong>Not a git repo</strong><span>Same — skips auto-commit, shows error for manual sync.</span></div>
                <div className="wiki-row"><strong>AI unavailable</strong><span>Falls back to <code>feat(db): add &lt;folder&gt;</code> or <code>chore(db): sync changes</code>.</span></div>
                <div className="wiki-row"><strong>Nothing to commit</strong><span>Returns ok without creating an empty commit.</span></div>
                <div className="wiki-row"><strong>Push fails</strong><span>Commit preserved locally. Retry with <code>/sync</code>.</span></div>
                <div className="wiki-row"><strong>No branch configured</strong><span>Falls back to <code>git rev-parse --abbrev-ref HEAD</code> (current branch).</span></div>
              </div>
            </div>
          </details>

          <details>
            <summary>🤷 Why not just use Git alone?</summary>
            <div className="wiki-section-copy">
              <div className="wiki-git-flow">
                <div className="wiki-git-row">
                  <div className="wiki-git-icon">📁</div>
                  <div className="wiki-git-content">
                    <div className="wiki-git-title">Git tracks files, not database state</div>
                    <div className="wiki-git-desc">Git knows which SQL files exist. But it has NO idea whether those SQL files have been run against the database.</div>
                  </div>
                </div>
                <div className="wiki-git-row">
                  <div className="wiki-git-icon">🗄️</div>
                  <div className="wiki-git-content">
                    <div className="wiki-git-title">DMCR tracks database state</div>
                    <div className="wiki-git-desc">DMCR's <code>dmcr.change_log</code> records exactly which changes are applied. <code>dmcr deploy</code> only runs the new ones.</div>
                  </div>
                </div>
                <div className="wiki-git-row">
                  <div className="wiki-git-icon">👥</div>
                  <div className="wiki-git-content">
                    <div className="wiki-git-title">GitHub enables collaboration</div>
                    <div className="wiki-git-desc">Multiple developers create changes on branches. PRs let the team review SQL before it touches production.</div>
                  </div>
                </div>
                <div className="wiki-git-row">
                  <div className="wiki-git-icon">🔗</div>
                  <div className="wiki-git-content">
                    <div className="wiki-git-title">DMCR links code to DB state</div>
                    <div className="wiki-git-desc"><code>dmcr deploy</code> captures the git commit hash and stores it in <code>dmcr.change_log.git_commit</code>.</div>
                  </div>
                </div>
              </div>
            </div>
          </details>
        </section>

        {/* ── At a Glance ── */}
        <section id="wiki-glance" className="wiki-card">
          <h2>⚡ At A Glance</h2>
          <div className="wiki-metric-row">
            <div className="wiki-metric"><strong>3+1</strong><span>SQL + meta.json</span></div>
            <div className="wiki-metric"><strong>Atomic</strong><span>deploy and revert</span></div>
            <div className="wiki-metric"><strong>danger_</strong><span>manual-only path</span></div>
          </div>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Production-ready v1.1.0</b> Advisory locking, dependency graphs, checksum policies, JSON output, baseline/repair, tags, repeatable migrations, and enriched audit trail.</div>
          </div>
        </section>

        {/* ── Change Model ── */}
        <section id="wiki-change-model" className="wiki-card">
          <h2>📂 Change Model</h2>
          <p>Every normal change folder must start with a 3-digit prefix and include deploy, verify, and revert SQL.</p>
          <pre>{`changes_dir/
├── 001_create_users/
│   ├── deploy.sql          # DDL/DML to apply the change
│   ├── verify.sql          # Assertions run after deploy
│   ├── revert.sql          # SQL to undo the change
│   └── meta.json           # Optional: dependencies, tags, ticket, author
├── 002_add_email_index/
│   ├── deploy.sql
│   ├── verify.sql
│   └── revert.sql
├── 003_danger_truncate_logs/    # ⚠️ danger_ = manual-only, DBA runs
│   ├── deploy.sql
│   ├── verify.sql
│   └── revert.sql
├── R__user_summary_view/        # ♻️ Repeatable: re-runs when checksum changes
│   ├── deploy.sql               # Must be idempotent (CREATE OR REPLACE)
│   └── verify.sql               # Optional
└── R__audit_triggers/
    └── deploy.sql`}</pre>

          <details>
            <summary>📝 meta.json explained</summary>
            <div className="wiki-section-copy">
              <p>Optional file inside any change folder to declare dependencies and metadata:</p>
              <pre>{`{
  "requires": ["001_create_users"],
  "tags": ["schema", "sprint-42"],
  "ticket": "JIRA-1234",
  "author": "jane.doe"
}`}</pre>
              <div className="wiki-table">
                <div className="wiki-row"><strong>requires</strong><span>Array of change_ids this change depends on. Used by <code>dmcr plan</code> to compute execution order.</span></div>
                <div className="wiki-row"><strong>tags</strong><span>Informational labels. Shown in <code>dmcr plan</code> and <code>dmcr status</code> output.</span></div>
                <div className="wiki-row"><strong>ticket</strong><span>Jira/ticket reference. Stored in <code>dmcr.change_log.ticket_id</code> for audit.</span></div>
                <div className="wiki-row"><strong>author</strong><span>Who created this change. Informational.</span></div>
              </div>
            </div>
          </details>

          <details>
            <summary>♻️ Repeatable migrations (R__)</summary>
            <div className="wiki-section-copy">
              <p>Folders starting with <code>R__</code> are <strong>repeatable</strong> — they re-run automatically whenever the deploy.sql checksum changes.</p>
              <div className="wiki-callout info">
                <div>💡</div>
                <div><b>Use case</b> Views, functions, triggers — anything that can be safely re-created with <code>CREATE OR REPLACE</code>. Unlike versioned changes, repeatables don't have a revert.sql.</div>
              </div>
              <div className="wiki-cmd-example">
                <div className="wiki-cmd-example-label">Example: repeatable view</div>
                <div className="wiki-cmd-example-code">
                  <span className="wiki-cmd-example-comment">-- R__user_summary_view/deploy.sql</span>{'\n'}
                  CREATE OR REPLACE VIEW app.user_summary AS{'\n'}
                  SELECT u.id, u.name, COUNT(o.id) AS order_count{'\n'}
                  FROM app.users u{'\n'}
                  LEFT JOIN app.orders o ON o.user_id = u.id{'\n'}
                  GROUP BY u.id, u.name;
                </div>
              </div>
            </div>
          </details>
        </section>

        {/* ── How Deploy Works ── */}
        <section id="wiki-deploy-steps" className="wiki-card">
          <h2>⚙️ How Deploy Works (Step by Step)</h2>
          <p>When you run <code>dmcr deploy</code>, here's exactly what happens for each pending change:</p>
          <div className="wiki-flow">
            <div className="wiki-flow-step purple">🔒 Lock</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step blue">BEGIN</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step green">deploy.sql</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step amber">INSERT log</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step green">COMMIT</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step blue">verify.sql</div>
          </div>
          <div className="wiki-steps">
            <div className="wiki-step"><div className="wiki-step-num">1</div><div className="wiki-step-text">Acquire PostgreSQL <strong>advisory lock</strong> — prevents two DMCR runners from deploying at the same time</div></div>
            <div className="wiki-step"><div className="wiki-step-num">2</div><div className="wiki-step-text"><strong>BEGIN</strong> transaction — everything below happens atomically</div></div>
            <div className="wiki-step"><div className="wiki-step-num">3</div><div className="wiki-step-text">Execute <strong>deploy.sql</strong> — your actual DDL/DML changes</div></div>
            <div className="wiki-step"><div className="wiki-step-num">4</div><div className="wiki-step-text"><strong>INSERT</strong> into <code>dmcr.change_log</code> — records change_id, checksums, actor, environment, git commit</div></div>
            <div className="wiki-step"><div className="wiki-step-num">5</div><div className="wiki-step-text"><strong>COMMIT</strong> — if deploy.sql fails, NOTHING is recorded (atomic)</div></div>
            <div className="wiki-step"><div className="wiki-step-num">6</div><div className="wiki-step-text">Run <strong>verify.sql</strong> (separate transaction) — if it fails, DMCR auto-reverts the change</div></div>
            <div className="wiki-step"><div className="wiki-step-num">7</div><div className="wiki-step-text">Release advisory lock</div></div>
          </div>
          <div className="wiki-callout warn">
            <div>⚠️</div>
            <div><b>Auto-revert on verify failure</b> If verify.sql fails after deploy, DMCR automatically runs revert.sql and removes the change_log entry. Your database is never left in a half-broken state.</div>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            COPILOT EXTENSION
            ═══════════════════════════════════════════════════════════════ */}

        {/* ── Home & Navigation ── */}
        <section id="wiki-home" className="wiki-card">
          <h2>🏠 Home &amp; Navigation</h2>
          <p>The Home tab is your launch pad. A hero card with the DMCR bot mascot greets you, and a grid of <strong>7 feature cards</strong> links to every major tool:</p>
          <div className="wiki-metric-row">
            <div className="wiki-metric"><strong>🧱</strong><span>Schema Builder</span></div>
            <div className="wiki-metric"><strong>📥</strong><span>Insert Rows</span></div>
            <div className="wiki-metric"><strong>✏️</strong><span>Freeform SQL</span></div>
            <div className="wiki-metric"><strong>💬</strong><span>Assistant</span></div>
            <div className="wiki-metric"><strong>🖥️</strong><span>Runner</span></div>
            <div className="wiki-metric"><strong>🔀</strong><span>Schema Diff</span></div>
            <div className="wiki-metric"><strong>🗂️</strong><span>Explorer</span></div>
          </div>
          <div className="wiki-callout info">
            <div>💡</div>
            <div><b>Generation status bar</b> Whenever the AI is generating a change, a status bar appears at the bottom of the home page showing real-time progress (idle → opening → running → done). When complete, a link reveals the generated change folder in VS Code.</div>
          </div>
          <div className="wiki-callout warn">
            <div>⚠️</div>
            <div><b>SQLite ABI warning</b> If the bundled native SQLite binary has an ABI mismatch with your Electron/Node version, a red banner appears at the top with a one-click "Install SQLite" button that rebuilds the native module.</div>
          </div>
          {!sidebar && <button className="wiki-try-btn" onClick={() => tryIt('home')}>🚀 Open Home Tab</button>}
        </section>

        {/* ── Schema Builder ── */}
        <section id="wiki-ddl" className="wiki-card">
          <h2>🧱 Schema Builder (DDL)</h2>
          <p>A form-driven page for generating PostgreSQL DDL changes without writing SQL. Pick an action, define your tables & columns, and DMCR generates a full change folder with deploy, verify, and revert scripts.</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>CREATE TABLE</strong><span>Define one or more tables with columns, types, and constraints. Supports "same columns for all" toggle.</span></div>
            <div className="wiki-row"><strong>ALTER TABLE</strong><span>Add columns to existing tables. Select target schema from live MCP data or type manually.</span></div>
            <div className="wiki-row"><strong>CREATE SEQUENCE</strong><span>Configure name, start, increment, min, max, and cache values for a new sequence.</span></div>
            <div className="wiki-row"><strong>CREATE SCHEMA</strong><span>Create a new PostgreSQL schema with optional GRANT privileges.</span></div>
            <div className="wiki-row"><strong>GRANT</strong><span>Grant table/sequence/schema privileges to a role. Checkboxes for SELECT, INSERT, UPDATE, DELETE, USAGE, etc.</span></div>
          </div>
          <details>
            <summary>Example: Creating a table with the Schema Builder</summary>
            <div className="wiki-section-copy">
              <div className="wiki-steps">
                <div className="wiki-step"><div className="wiki-step-num">1</div><div className="wiki-step-text">Select <strong>CREATE TABLE</strong> from the action dropdown</div></div>
                <div className="wiki-step"><div className="wiki-step-num">2</div><div className="wiki-step-text">Pick a schema (e.g. <code>app</code>) — schemas are auto-populated from MCP if a database server is connected</div></div>
                <div className="wiki-step"><div className="wiki-step-num">3</div><div className="wiki-step-text">Type a table name (e.g. <code>orders</code>), then add columns: <code>id uuid</code>, <code>customer_id int</code>, <code>total numeric</code>, <code>created_at timestamp</code></div></div>
                <div className="wiki-step"><div className="wiki-step-num">4</div><div className="wiki-step-text">Optionally configure metadata: change name hint, tags, requires (dependencies), author</div></div>
                <div className="wiki-step"><div className="wiki-step-num">5</div><div className="wiki-step-text">Click <strong>Generate</strong> → AI produces deploy.sql (CREATE TABLE), verify.sql (check table exists), revert.sql (DROP TABLE)</div></div>
              </div>
            </div>
          </details>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Column types</b> Built-in types include varchar, text, timestamp, boolean, int, bigint, uuid, jsonb, numeric, date, and custom (free text). The type dropdown lets you quickly pick common PostgreSQL types.</div>
          </div>
          {!sidebar && <button className="wiki-try-btn" onClick={() => tryIt('ddl')}>🚀 Open Schema Builder</button>}
        </section>

        {/* ── Insert Rows ── */}
        <section id="wiki-insert" className="wiki-card">
          <h2>📥 Insert Rows (DML)</h2>
          <p>A spreadsheet-like form for building <strong>idempotent INSERT statements</strong>. Define columns with types, fill in a data grid, and configure ON CONFLICT behavior. DMCR generates deploy/verify/revert scripts for your data.</p>
          <div className="wiki-flow">
            <div className="wiki-flow-step green">📋 Define columns</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step blue">📊 Fill data grid</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step amber">🔀 ON CONFLICT</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step purple">⚡ Generate</div>
          </div>
          <details>
            <summary>Idempotency options</summary>
            <div className="wiki-section-copy">
              <div className="wiki-table">
                <div className="wiki-row"><strong>ON CONFLICT DO NOTHING</strong><span>Inserts new rows, silently skips duplicates. Safe for re-runs.</span></div>
                <div className="wiki-row"><strong>ON CONFLICT DO UPDATE</strong><span>Upsert — inserts new rows and updates existing ones. You specify which columns to update.</span></div>
                <div className="wiki-row"><strong>Conflict target</strong><span>Specify which columns form the unique constraint (e.g. <code>id</code> or <code>email</code>).</span></div>
              </div>
            </div>
          </details>
          <div className="wiki-callout info">
            <div>💡</div>
            <div><b>Smart editors</b> Timestamp/date/time columns get a built-in DateTimePicker. Boolean columns show checkboxes. Everything else is a text input. A "Load example" button pre-fills a sample table to explore the UI.</div>
          </div>
          {!sidebar && <button className="wiki-try-btn" onClick={() => tryIt('insert')}>🚀 Open Insert Rows</button>}
        </section>

        {/* ── Freeform SQL ── */}
        <section id="wiki-freeform" className="wiki-card">
          <h2>✏️ Freeform SQL</h2>
          <p>Paste or write any SQL — DDL, DML, functions, views, triggers — and DMCR wraps it into a full change folder with deploy, verify, and revert scripts. Includes <strong>real-time SQL linting</strong> that validates your syntax as you type.</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>SQL Editor</strong><span>Syntax-highlighted editor with a lint chip showing ✓ valid, ⚠ parse error, or ⏳ linting. Validation runs on blur and on a 600ms debounce while typing.</span></div>
            <div className="wiki-row"><strong>Previous version</strong><span>Toggle to paste the OLD function/view body. DMCR uses this to generate an exact revert script that restores the previous version instead of just dropping.</span></div>
            <div className="wiki-row"><strong>Schema context</strong><span>Dropdown to set the default schema. Passed to the AI for correct schema-qualified names.</span></div>
          </div>
          <details>
            <summary>Example: CREATE OR REPLACE FUNCTION workflow</summary>
            <div className="wiki-section-copy">
              <div className="wiki-steps">
                <div className="wiki-step"><div className="wiki-step-num">1</div><div className="wiki-step-text">Paste your new function body in the main SQL editor</div></div>
                <div className="wiki-step"><div className="wiki-step-num">2</div><div className="wiki-step-text">Toggle <strong>"Previous version"</strong> and paste the old function body</div></div>
                <div className="wiki-step"><div className="wiki-step-num">3</div><div className="wiki-step-text">Click <strong>Generate</strong> → deploy.sql uses the new body, revert.sql uses the old body to restore it</div></div>
              </div>
            </div>
          </details>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Lint blocks generation</b> If the SQL fails linting, the Generate button is disabled. Fix the syntax error first — the lint chip shows the exact parse error message.</div>
          </div>
          {!sidebar && <button className="wiki-try-btn" onClick={() => tryIt('freeform')}>🚀 Open Freeform SQL</button>}
        </section>

        {/* ── Schema Diff ── */}
        <section id="wiki-schema-diff" className="wiki-card">
          <h2>🔀 Schema Diff</h2>
          <p>A side-by-side two-pane editor for comparing a <strong>Current Schema</strong> (what the DB has today) with a <strong>Target Schema</strong> (what you want). DMCR diffs the two and generates a complete deploy/verify/revert change covering every structural difference.</p>
          <div className="wiki-flow">
            <div className="wiki-flow-step green">🟢 Current (left)</div>
            <div className="wiki-flow-arrow">↔</div>
            <div className="wiki-flow-step blue">🔵 Target (right)</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step purple">⚡ DMCR Change</div>
          </div>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Per-pane SQL editor</strong><span>Each side has its own syntax-highlighted editor with independent lint validation and schema dropdown.</span></div>
            <div className="wiki-row"><strong>Swap button (↔)</strong><span>Exchanges left and right panes with a single click.</span></div>
            <div className="wiki-row"><strong>Change metadata</strong><span>Optional change name hint, tags, requires, and author — same as other generators.</span></div>
          </div>
          <div className="wiki-callout info">
            <div>💡</div>
            <div><b>Best for refactoring</b> Copy your current table DDL into the left pane, edit the right pane with desired changes (rename columns, change types, add constraints), and let the AI figure out the ALTER statements.</div>
          </div>
          {!sidebar && <button className="wiki-try-btn" onClick={() => tryIt('schemaDiff')}>🚀 Open Schema Diff</button>}
        </section>

        {/* ── DMCR Assistant ── */}
        <section id="wiki-conversation" className="wiki-card">
          <h2>💬 DMCR Assistant (Conversational AI)</h2>
          <p>A full chat interface powered by <strong>ConvEngine</strong> that lets you interact with DMCR using natural language. Behind the scenes, a multi-agent AI system routes your message to the right specialist.</p>
          <div className="wiki-callout info">
            <div>🧠</div>
            <div><b>Multi-agent routing</b> Your message is first classified by a <strong>MasterAgent</strong> (temperature 0.0 for precision) into one of 5 categories: DMCR change generation, general FAQ, SQL FAQ, wiki documentation, or greeting. Each category has a specialized sub-agent with its own system prompt and temperature.</div>
          </div>
          <div className="wiki-table">
            <div className="wiki-row"><strong>DMCR Agent</strong><span>Generates full deploy/verify/revert SQL changes. Temp 0.5. Uses MCP tools for live schema introspection.</span></div>
            <div className="wiki-row"><strong>General FAQ</strong><span>Answers questions about DMCR concepts, features, and workflows. Temp 0.3.</span></div>
            <div className="wiki-row"><strong>SQL FAQ</strong><span>Answers PostgreSQL and SQL questions with code examples. Temp 0.3.</span></div>
            <div className="wiki-row"><strong>Wiki Agent</strong><span>Searches DMCR documentation using BM25 text search and answers with context. Temp 0.3.</span></div>
            <div className="wiki-row"><strong>Greeting Agent</strong><span>Warm, friendly responses to hellos and casual messages. Temp 0.7.</span></div>
          </div>
          <details>
            <summary>Example conversation flow</summary>
            <div className="wiki-section-copy">
              <div className="wiki-steps">
                <div className="wiki-step"><div className="wiki-step-num">1</div><div className="wiki-step-text">You type: <em>"Add an email column to the users table"</em></div></div>
                <div className="wiki-step"><div className="wiki-step-num">2</div><div className="wiki-step-text"><strong>Dialogue Intent</strong> resolves any follow-up context from previous messages (temp 0.1)</div></div>
                <div className="wiki-step"><div className="wiki-step-num">3</div><div className="wiki-step-text"><strong>MasterAgent</strong> classifies → routes to <strong>DMCR Agent</strong></div></div>
                <div className="wiki-step"><div className="wiki-step-num">4</div><div className="wiki-step-text">A metadata form appears for tags, author, and dependencies</div></div>
                <div className="wiki-step"><div className="wiki-step-num">5</div><div className="wiki-step-text">AI generates deploy/verify/revert SQL, saves to a numbered change folder</div></div>
              </div>
            </div>
          </details>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Conversation history</b> The assistant maintains context across messages within a session. Asking follow-ups like "now add a NOT NULL constraint to that column" works naturally.</div>
          </div>
          {!sidebar && <button className="wiki-try-btn" onClick={() => tryIt('conversation')}>🚀 Open DMCR Assistant</button>}
        </section>

        {/* ── Schema Explorer ── */}
        <section id="wiki-schema-explorer" className="wiki-card">
          <h2>🗂️ Schema Explorer</h2>
          <p>A sidebar tree view that connects to your database via MCP and provides live introspection of schemas, tables, columns, functions, and sequences — all without leaving VS Code.</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Schema discovery</strong><span>Lists all schemas in your connected PostgreSQL database via the <code>discover_schemas</code> MCP capability.</span></div>
            <div className="wiki-row"><strong>Object browsing</strong><span>Expand any schema to see tables, views, functions, sequences. Uses <code>discover_objects</code> capability.</span></div>
            <div className="wiki-row"><strong>Column details</strong><span>Click a table to see all columns with types, nullable, defaults via <code>describe_table</code>.</span></div>
            <div className="wiki-row"><strong>Live DDL</strong><span>View the full CREATE statement for any object with <code>get_ddl</code>.</span></div>
          </div>
          <div className="wiki-callout warn">
            <div>⚠️</div>
            <div><b>Requires MCP database server</b> The Schema Explorer only appears when at least one MCP server with category <code>database</code> is configured. The server auto-detection uses keyword matching on tool descriptions.</div>
          </div>
        </section>

        {/* ── Runner Tab ── */}
        <section id="wiki-runner-tab" className="wiki-card">
          <h2>🖥️ Runner Tab</h2>
          <p>A full <strong>xterm.js terminal emulator</strong> embedded inside VS Code. It wraps the DMCR PowerShell runner (<code>dmcr.ps1</code>) with slash commands, autocomplete, preset buttons, folder browsing, and interactive revert mode.</p>
          <div className="wiki-metric-row">
            <div className="wiki-metric"><strong>25+</strong><span>Slash commands</span></div>
            <div className="wiki-metric"><strong>12</strong><span>Preset buttons</span></div>
            <div className="wiki-metric"><strong>↑↓</strong><span>Command history</span></div>
            <div className="wiki-metric"><strong>🔍</strong><span>Fuzzy autocomplete</span></div>
          </div>

          <details open>
            <summary>Command examples with output</summary>
            <div className="wiki-section-copy">

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/status</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Shows applied vs pending changes in a boxed table.</p>
              <pre className="wiki-pre">{`┌───────────────────────────────────────┐
│           Change Status               │
├────────────┬──────────────────────────┤
│ Status     │ Change                   │
├────────────┼──────────────────────────┤
│ APPLIED ✅ │ 001_create_users         │
│ APPLIED ✅ │ 002_add_index            │
│ PENDING ⏹  │ 003_add_roles            │
└────────────┴──────────────────────────┘`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/deploy</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Applies pending changes in order with advisory locking.</p>
              <pre className="wiki-pre">{`INFO    Starting DMCR deploy
INFO    Environment: dev
INFO    Pre-flight OK — all change folders validated
SKIP    001_create_users already applied
SKIP    002_add_index already applied
APPLY   003_add_roles
INFO    Executing deploy.sql + recording change
VERIFY  003_add_roles
DONE    003_add_roles applied successfully (42ms)`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/deploy --dry-run</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Shows what would be applied without touching the database.</p>
              <pre className="wiki-pre">{`WARN    DRY RUN — the following 1 change(s) would deploy:
INFO    --- 003_add_roles ---
        CREATE TABLE app.roles (
          id serial PRIMARY KEY,
          name text NOT NULL UNIQUE
        );
WARN    DRY RUN complete — re-run without --dry-run to apply`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/verify [all | &lt;id&gt;]</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Runs verify.sql for applied changes inside a rollback transaction.</p>
              <pre className="wiki-pre">{`VERIFY  001_create_users
DONE    001_create_users verified OK
VERIFY  002_add_index
DONE    002_add_index verified OK
VERIFY  003_add_roles
DONE    003_add_roles verified OK`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/history</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Shows applied changes with timestamps, checksums, and actor.</p>
              <pre className="wiki-pre">{`INFO    Change history (most recent first):
 change_id        | applied_at                 | actor      | environment
------------------+----------------------------+------------+-------------
 003_add_roles    | 2024-03-16 14:22:00+00     | dev@host   | dev
 002_add_index    | 2024-03-15 10:30:00+00     | dev@host   | dev
 001_create_users | 2024-03-14 09:00:00+00     | dev@host   | dev`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/info</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Environment summary — counts, registry health, config.</p>
              <pre className="wiki-pre">{`┌───────────────────────────────────────┐
│              DMCR Info                │
├──────────────────┬────────────────────┤
│ Property         │ Value              │
├──────────────────┼────────────────────┤
│ Environment      │ dev                │
│ Total Changes    │ 5                  │
│ Applied          │ 3                  │
│ Pending          │ 2                  │
│ Danger (manual)  │ 0                  │
│ Registry         │ OK ✅              │
│ Checksum Policy  │ warn               │
└──────────────────┴────────────────────┘`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/plan</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Dependency-aware execution order (reads meta.json).</p>
              <pre className="wiki-pre">{`INFO    Dependency-aware execution plan:
┌───────┬───────────────────┬────────────┬──────────────────┐
│ Order │ Change            │ Status     │ Requires         │
├───────┼───────────────────┼────────────┼──────────────────┤
│ 1     │ 001_create_users  │ APPLIED ✅ │ —                │
│ 2     │ 002_add_index     │ APPLIED ✅ │ 001_create_users │
│ 3     │ 003_add_roles     │ PENDING ⏹  │ 001_create_users │
└───────┴───────────────────┴────────────┴──────────────────┘`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/check</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Preflight validation — folder structure, duplicates, gaps, deps.</p>
              <pre className="wiki-pre">{`DONE    All preflight checks passed
DONE    Dependency graph OK (5 changes in order)`}</pre>
              <p style={{fontSize:'10px',color:'var(--wp-muted)',margin:'2px 0'}}>If issues exist:</p>
              <pre className="wiki-pre">{`WARN    Preflight issues found:
WARN      >> MISSING  002_add_index/verify.sql
WARN      >> GAP  prefix gap between 001 and 003
ERROR   Dependency graph: Cycle detected`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/revertLast</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Reverts the most recently applied change.</p>
              <pre className="wiki-pre">{`INFO    Reverting change: 003_add_roles
REVERT  003_add_roles
INFO    Executing revert.sql + removing record
VERIFY  003_add_roles (after revert)
DONE    003_add_roles reverted successfully (38ms)`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/revert &lt;id&gt; | to &lt;id|@tag&gt;</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Reverts a specific change or peels back to a target.</p>
              <pre className="wiki-pre">{`INFO    Reverting to target: @v1.0
REVERT  003_add_roles
DONE    003_add_roles reverted (35ms)
REVERT  002_add_index
DONE    002_add_index reverted (28ms)
DONE    Revert complete — 2 change(s) reverted`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/repeatable</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Applies repeatable migrations (R__*) with changed checksums.</p>
              <pre className="wiki-pre">{`INFO    Checking repeatable migrations...
SKIP    R__views — unchanged (checksum matches)
APPLY   R__functions (repeatable)
VERIFY  R__functions
DONE    R__functions applied (85ms)`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/tag list | create | delete</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Manage release tags for deployment state snapshots.</p>
              <pre className="wiki-pre">{`INFO    Release tags:
 tag_name │ change_id        │ created_at          │ description
──────────┼──────────────────┼─────────────────────┼────────────────
 v1.1     │ 003_add_roles    │ 2024-03-16 14:30:00 │ Sprint 43
 v1.0     │ 001_create_users │ 2024-03-10 08:00:00 │ Initial release`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/parse &lt;sql&gt;</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Validates SQL in a BEGIN/ROLLBACK — no data touched.</p>
              <pre className="wiki-pre">{`/parse SELECT * FROM users WHERE id = 1
{"ok":true,"msg":"Parsed OK."}

/parse SELECT * FROM nonexistent
{"ok":false,"msg":"ERROR: relation \\"nonexistent\\" does not exist","line":1}`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/config</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Prints active configuration (connection redacted).</p>
              <pre className="wiki-pre">{`┌────────────────────────────────────────────────────┐
│                     Config                         │
├──────────────────┬─────────────────────────────────┤
│ Key              │ Value                           │
├──────────────────┼─────────────────────────────────┤
│ path             │ C:\\project\\.dmcr.json          │
│ env              │ dev                             │
│ changes_dir      │ C:\\project\\changes             │
│ psql_path        │ psql                            │
│ lock_timeout     │ 5s                              │
│ stmt_timeout     │ 30s                             │
│ checksum_policy  │ warn                            │
│ conn             │ postgres://user:****@host/mydb  │
└──────────────────┴─────────────────────────────────┘`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/init</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Creates the DMCR schema and registry tables (safe to re-run).</p>
              <pre className="wiki-pre">{`INIT    Creating DMCR registry
DONE    DMCR registry ready`}</pre>

              <h3 style={{fontSize:'11px',color:'var(--wp-accent)',marginTop:12}}>/baseline &lt;id&gt;</h3>
              <p style={{fontSize:'11px',color:'var(--wp-muted)',margin:'2px 0 4px'}}>Marks changes as applied without executing SQL (for existing DBs).</p>
              <pre className="wiki-pre">{`SKIP    001_create_users already applied
DONE    002_add_index baselined
DONE    003_add_roles baselined
DONE    Baseline complete — 2 change(s) marked as applied`}</pre>

            </div>
          </details>

          <details>
            <summary>Special modes</summary>
            <div className="wiki-section-copy">
              <div className="wiki-table">
                <div className="wiki-row"><strong>/ls [pattern]</strong><span>Renders a tree view of the configured changes directory. Optionally filter by glob pattern.</span></div>
                <div className="wiki-row"><strong>/it</strong><span>Interactive revert picker — use arrow keys to navigate change folders, Enter to select, then choose <code>revert</code> or <code>revert to</code> action. Esc to cancel.</span></div>
              </div>
            </div>
          </details>
          <details>
            <summary>Quick keys</summary>
            <div className="wiki-kbdgrid">
              <div className="wiki-kbdrow"><div className="wiki-kbdstack"><kbd>Up</kbd><kbd>Down</kbd></div><div>Navigate command history and interactive selection.</div></div>
              <div className="wiki-kbdrow"><div className="wiki-kbdstack"><kbd>Enter</kbd></div><div>Submit the command or confirm the interactive revert action.</div></div>
              <div className="wiki-kbdrow"><div className="wiki-kbdstack"><kbd>Esc</kbd></div><div>Exit interactive mode or go back from action selection.</div></div>
              <div className="wiki-kbdrow"><div className="wiki-kbdstack"><kbd>/help</kbd></div><div>Show the built-in runner quick reference.</div></div>
            </div>
          </details>
          <div className="wiki-callout info">
            <div>💡</div>
            <div><b>Toolbar presets</b> A row of 12 buttons provides one-click access to: status, deploy, deploy --dry-run, verify, history, check, repeatable, tag list, revertLast, revert list, init, and show config.</div>
          </div>
          {!sidebar && <button className="wiki-try-btn" onClick={() => tryIt('runner')}>🚀 Open Runner Tab</button>}
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            AI & INTELLIGENCE
            ═══════════════════════════════════════════════════════════════ */}

        {/* ── AI Architecture ── */}
        <section id="wiki-ai-arch" className="wiki-card">
          <h2>🧠 AI Architecture</h2>
          <p>DMCR Copilot uses a <strong>multi-agent pipeline</strong> with two stages: <em>Dialogue Intent</em> resolution and <em>MasterAgent</em> classification. Every LLM call is fully audited to the <code>ce_audit</code> table.</p>
          <div className="wiki-flow">
            <div className="wiki-flow-step blue">💬 User message</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step amber">🔍 Dialogue Intent</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step purple">🧠 MasterAgent</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step green">🤖 Sub-agent</div>
          </div>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Stage 1: Dialogue Intent</strong><span>If conversation history exists, resolves follow-up messages into standalone questions. Temp 0.1. Example: "add that column" → "Add an email column to the users table"</span></div>
            <div className="wiki-row"><strong>Stage 2: MasterAgent</strong><span>Classifies the resolved message into one of 5 agent types. Temp 0.0 for maximum precision. If confidence &lt; 0.6 and the message looks like a question, falls back to General FAQ.</span></div>
          </div>
          <details>
            <summary>Agent temperature guide</summary>
            <div className="wiki-section-copy">
              <div className="wiki-table">
                <div className="wiki-row"><strong>MasterAgent</strong><span>0.0 — Deterministic classification. No creativity needed for routing.</span></div>
                <div className="wiki-row"><strong>Dialogue Intent</strong><span>0.1 — Slight variation in context resolution, mostly deterministic.</span></div>
                <div className="wiki-row"><strong>General FAQ</strong><span>0.3 — Factual but allows some natural phrasing variation.</span></div>
                <div className="wiki-row"><strong>SQL FAQ</strong><span>0.3 — Accurate SQL examples with slight explanation variation.</span></div>
                <div className="wiki-row"><strong>Wiki Agent</strong><span>0.3 — Documentation answers grounded in BM25 search results.</span></div>
                <div className="wiki-row"><strong>DMCR Agent</strong><span>0.5 — Balanced creativity for SQL generation. Needs to infer reasonable defaults.</span></div>
                <div className="wiki-row"><strong>Greeting Agent</strong><span>0.7 — More creative for warm, varied responses.</span></div>
              </div>
            </div>
          </details>
          <div className="wiki-callout info">
            <div>💡</div>
            <div><b>Every LLM call is audited</b> Stage name, model, system/user prompts, request/response payloads, duration, and your raw input are all captured in the <code>ce_audit</code> table. View them in Settings → Dev Tools → AI Footprint or Audit Log.</div>
          </div>
        </section>

        {/* ── Prompt Library ── */}
        <section id="wiki-prompts" className="wiki-card">
          <h2>📚 Prompt Library</h2>
          <p>A <strong>database-backed, user-editable</strong> prompt template system with <strong>15 scenarios</strong>. Every AI agent's system prompt and user prompt is stored in SQLite and can be customized in Settings → Prompt Library.</p>
          <div className="wiki-table">
            <div className="wiki-row" style={{background:'rgba(245,158,11,0.08)'}}><strong>Routing</strong><span><code>MASTER_AGENT</code>, <code>DIALOGUE_INTENT</code></span></div>
            <div className="wiki-row" style={{background:'rgba(56,189,248,0.08)'}}><strong>Conversation</strong><span><code>GREETING_AGENT</code>, <code>GENERAL_FAQ_AGENT</code>, <code>SQL_FAQ_AGENT</code>, <code>WIKI_AGENT</code>, <code>MCP_AGENT</code></span></div>
            <div className="wiki-row" style={{background:'rgba(34,197,94,0.08)'}}><strong>Generation pipeline</strong><span><code>INTENT_DETECTOR</code>, <code>REQUEST_PLANNER</code>, <code>FOLLOWUP_DECIDER</code>, <code>DMCR_RULES</code></span></div>
            <div className="wiki-row" style={{background:'rgba(168,85,247,0.08)'}}><strong>Form-based</strong><span><code>FREEFORM_SQL</code>, <code>SCHEMA_DIFF</code>, <code>ADD_COLUMNS</code>, <code>INSERT_ROWS</code></span></div>
          </div>
          <details>
            <summary>Template variables reference</summary>
            <div className="wiki-section-copy">
              <div className="wiki-table">
                <div className="wiki-row"><strong>{'{{userMessage}}'}</strong><span>The user's chat message (resolved after Dialogue Intent).</span></div>
                <div className="wiki-row"><strong>{'{{conversationHistory}}'}</strong><span>Last N turns of conversation for context.</span></div>
                <div className="wiki-row"><strong>{'{{toolList}}'}</strong><span>Dynamically discovered MCP tools available to the agent.</span></div>
                <div className="wiki-row"><strong>{'{{dmcrContext}}'}</strong><span>DMCR configuration context (changes dir, config path, etc.).</span></div>
                <div className="wiki-row"><strong>{'{{dangerContextPrompt}}'}</strong><span>Danger rules for destructive SQL patterns.</span></div>
                <div className="wiki-row"><strong>{'{{sql}}'}</strong><span>User's SQL input (Freeform, Schema Diff).</span></div>
                <div className="wiki-row"><strong>{'{{fromSchema}}'} / {'{{toSchema}}'}</strong><span>Current and target schemas for Schema Diff.</span></div>
                <div className="wiki-row"><strong>{'{{cleanTables}}'}</strong><span>Table definitions for DDL generation.</span></div>
                <div className="wiki-row"><strong>{'{{rows}}'}</strong><span>Data grid rows for INSERT generation.</span></div>
                <div className="wiki-row"><strong>{'{{schemaContext}}'}</strong><span>Live schema context from MCP introspection.</span></div>
                <div className="wiki-row"><strong>{'{{changeNameHint}}'}</strong><span>User-provided hint for the change folder name.</span></div>
                <div className="wiki-row"><strong>{'{{context}}'}</strong><span>Wiki BM25 search results for documentation queries.</span></div>
              </div>
            </div>
          </details>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Fully editable</b> Every prompt can be customized in Settings → Prompt Library. Click "Reset to Default" to restore the original. Changes are stored per-scenario in the SQLite <code>prompt_library</code> table.</div>
          </div>
        </section>

        {/* ── MCP Integration ── */}
        <section id="wiki-mcp" className="wiki-card">
          <h2>🔌 MCP Integration</h2>
          <p><strong>Model Context Protocol (MCP)</strong> lets DMCR connect to external tool servers for live database introspection, schema discovery, and custom tool execution. No hardcoded tool names — everything is discovered dynamically at runtime.</p>
          <div className="wiki-flow">
            <div className="wiki-flow-step blue">🔌 Connect server</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step green">📋 Discover tools</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step amber">⚡ Call tools</div>
            <div className="wiki-flow-arrow">→</div>
            <div className="wiki-flow-step purple">📋 Audit trail</div>
          </div>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Transports</strong><span><strong>STDIO</strong> (persistent subprocess with JSON-RPC) and <strong>HTTP</strong> (JSON-RPC POST). STDIO includes MCP handshake (initialize → notifications/initialized).</span></div>
            <div className="wiki-row"><strong>Tool discovery</strong><span><code>tools/list</code> call to each server. 2-pass strategy: cached first, then refresh if tool not found.</span></div>
            <div className="wiki-row"><strong>Server categories</strong><span><code>database</code>, <code>general</code>, <code>docs</code>, <code>code</code>. Category <code>database</code> enables Schema Explorer. Auto-detected via keyword matching on tool descriptions.</span></div>
            <div className="wiki-row"><strong>Audit</strong><span>Every tool call is audited with stages: <code>MCP_TOOL_CALL</code> (before), <code>MCP_TOOL_RESULT</code> (success), <code>MCP_TOOL_ERROR</code> (failure).</span></div>
          </div>
          <details>
            <summary>Database capabilities (semantic matching)</summary>
            <div className="wiki-section-copy">
              <p>DMCR defines 6 standard database capabilities. Any MCP server's tools are <strong>semantically matched</strong> by analyzing description keywords and input schema shape:</p>
              <div className="wiki-table">
                <div className="wiki-row"><strong>discover_schemas</strong><span>List all schemas in the database.</span></div>
                <div className="wiki-row"><strong>discover_objects</strong><span>List tables, views, functions in a schema.</span></div>
                <div className="wiki-row"><strong>describe_table</strong><span>Get column names, types, nullable, defaults for a table.</span></div>
                <div className="wiki-row"><strong>describe_function</strong><span>Get function signature and body.</span></div>
                <div className="wiki-row"><strong>describe_sequence</strong><span>Get sequence properties.</span></div>
                <div className="wiki-row"><strong>get_ddl</strong><span>Get the full CREATE statement for any object.</span></div>
              </div>
            </div>
          </details>
          <div className="wiki-callout warn">
            <div>⚠️</div>
            <div><b>Server configs are persisted</b> in SQLite collection <code>mcpServers</code>. Configure via Settings → MCP Servers. Each server stores: id, name, transport type, command/URL, args, and category.</div>
          </div>
        </section>

        {/* ── LLM Providers ── */}
        <section id="wiki-providers" className="wiki-card">
          <h2>🤖 LLM Providers</h2>
          <p>DMCR supports <strong>two provider modes</strong>: VS Code Copilot (built-in) and custom providers (bring your own API key). The active selection is persisted across sessions in SQLite.</p>
          <div className="wiki-table">
            <div className="wiki-row" style={{background:'rgba(56,189,248,0.08)'}}><strong>VS Code Copilot</strong><span>Uses the <code>vscode.lm.selectChatModels()</code> API. Automatically picks from available Copilot models. No API key needed — uses your GitHub Copilot subscription.</span></div>
            <div className="wiki-row" style={{background:'rgba(34,197,94,0.08)'}}><strong>OpenAI</strong><span>Any OpenAI-compatible API. Bearer token auth. Supports SSE streaming. Works with Azure OpenAI, Together AI, Groq, etc.</span></div>
            <div className="wiki-row" style={{background:'rgba(245,158,11,0.08)'}}><strong>Anthropic</strong><span>Claude models via <code>x-api-key</code> header. API version <code>2023-06-01</code>. System prompt as separate field. Max 4096 tokens.</span></div>
            <div className="wiki-row" style={{background:'rgba(168,85,247,0.08)'}}><strong>Ollama</strong><span>Local models, no auth. Default endpoint <code>http://localhost:11434</code>. No streaming. Great for offline development.</span></div>
            <div className="wiki-row" style={{background:'rgba(248,113,113,0.08)'}}><strong>LM Studio</strong><span>Local models via OpenAI-compatible API. Thin wrapper over OpenAI adapter. Default <code>http://localhost:1234</code>.</span></div>
          </div>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Retry on invalid JSON</b> All adapters automatically retry when the model returns invalid JSON for structured output requests. The model is re-prompted with the error to self-correct.</div>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            DEVELOPER TOOLS
            ═══════════════════════════════════════════════════════════════ */}

        {/* ── Dev Tools Overview ── */}
        <section id="wiki-devtools" className="wiki-card">
          <h2>🧰 Developer Tools</h2>
          <p>Five diagnostic tools in <strong>Settings → Dev Tools</strong> for debugging, profiling, and auditing the DMCR extension. Each opens a dedicated panel:</p>
          <div className="wiki-metric-row">
            <div className="wiki-metric"><strong>🧠</strong><span>Memory Footprint</span></div>
            <div className="wiki-metric"><strong>🤖</strong><span>AI Footprint</span></div>
            <div className="wiki-metric"><strong>📋</strong><span>Audit Log</span></div>
            <div className="wiki-metric"><strong>🐛</strong><span>Debug Snapshot</span></div>
            <div className="wiki-metric"><strong>🗄️</strong><span>DB Explorer</span></div>
          </div>
        </section>

        {/* ── AI Footprint ── */}
        <section id="wiki-ai-footprint" className="wiki-card">
          <h2>🤖 AI Footprint</h2>
          <p>A detailed inspector showing <strong>every LLM interaction</strong> with full request/response payloads, timing, and model info. Each entry is color-coded by stage (18 stages mapped).</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>List view</strong><span>All <code>ce_audit</code> entries sorted by time. Each row shows: audit ID, stage badge (color-coded), model name, and duration in milliseconds.</span></div>
            <div className="wiki-row"><strong>Detail view (7 tabs)</strong><span><strong>System Prompt</strong> — the agent's system instructions. <strong>User Prompt</strong> — what was sent. <strong>Request</strong> — full LLM request payload. <strong>Response</strong> — the raw model response. <strong>Headers</strong> — HTTP headers sent. <strong>Meta</strong> — userInput, routedTo, serverId metadata. <strong>Audit</strong> — combined single-scroll view of all tabs.</span></div>
          </div>
          <details>
            <summary>Stage color reference</summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 8px', padding: '10px 0' }}>
              {[
                { color: '#a78bfa', label: 'DIALOGUE_INTENT' },
                { color: '#f59e0b', label: 'MASTER_AGENT' },
                { color: '#22c55e', label: 'DMCR_AGENT' },
                { color: '#38bdf8', label: 'FAQ / WIKI' },
                { color: '#f87171', label: 'MCP_ERROR' },
                { color: '#34d399', label: 'MCP_RESULT' },
                { color: '#22d3ee', label: 'GIT_COMMIT' },
              ].map(s => (
                <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 4, background: s.color + '18', border: `1px solid ${s.color}44`, fontSize: 10, fontFamily: 'monospace', color: s.color, fontWeight: 600 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.color, flexShrink: 0 }}></span>
                  {s.label}
                </span>
              ))}
            </div>
          </details>
          <div className="wiki-callout info">
            <div>💡</div>
            <div><b>Multi-select delete</b> Check multiple entries and delete them in bulk. Useful for clearing test/debug entries. Refresh button re-fetches the latest audit data.</div>
          </div>
        </section>

        {/* ── Audit Log ── */}
        <section id="wiki-audit-log" className="wiki-card">
          <h2>📋 Audit Log</h2>
          <p>A <strong>timeline-based audit viewer</strong> with filtering, search, and conversation grouping. Richer than AI Footprint — shows MCP tool calls alongside AI calls with human-readable row descriptions.</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>4 filters</strong><span><strong>All</strong> — everything. <strong>AI Calls</strong> — non-MCP entries only. <strong>MCP Tools</strong> — <code>MCP_TOOL_*</code> stages only. <strong>Errors</strong> — entries with error fields.</span></div>
            <div className="wiki-row"><strong>Free-text search</strong><span>Searches across stage, conversation_id, model, request_payload, meta, and error fields simultaneously.</span></div>
            <div className="wiki-row"><strong>Conversation grouping</strong><span>Entries grouped by <code>conversation_id</code> for timeline visualization. Each session shows all its AI calls and MCP tool invocations in order.</span></div>
            <div className="wiki-row"><strong>Detail view (7 tabs)</strong><span>Overview, System Prompt, User Prompt, Request, Response, Meta, Raw JSON. Same depth as AI Footprint plus meta context.</span></div>
          </div>
          <details>
            <summary>Row descriptions</summary>
            <div className="wiki-section-copy">
              <p>Each row shows a human-readable description extracted from metadata:</p>
              <div className="wiki-table">
                <div className="wiki-row"><strong>AI entries</strong><span>Shows <code>meta.userInput</code> — the raw text you typed, not the full agent prompt.</span></div>
                <div className="wiki-row"><strong>MCP_TOOL_CALL</strong><span>Shows the tool arguments (e.g. <code>schema: "app", table: "users"</code>).</span></div>
                <div className="wiki-row"><strong>MCP_TOOL_RESULT</strong><span>Shows a preview of the response data.</span></div>
              </div>
            </div>
          </details>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Duration color coding</b> Green (&lt; 2s), amber (2–5s), red (&gt; 5s). Helps quickly spot slow AI calls or MCP timeouts.</div>
          </div>
        </section>

        {/* ── Memory Footprint ── */}
        <section id="wiki-memory" className="wiki-card">
          <h2>🧠 Memory Footprint</h2>
          <p>Real-time memory monitoring for the DMCR extension process and OS-level statistics.</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Extension Process</strong><span><strong>Heap Used</strong> (with % and color-coded bar), <strong>Heap Total</strong>, <strong>RSS</strong> (resident set), <strong>External</strong> (native C++ memory), <strong>Array Buffers</strong> (off-heap binary data).</span></div>
            <div className="wiki-row"><strong>OS Memory</strong><span>System-wide total and free memory statistics.</span></div>
            <div className="wiki-row"><strong>CPU Info</strong><span>Processor model, core count, speed, and system uptime.</span></div>
          </div>
          <div className="wiki-callout info">
            <div>💡</div>
            <div><b>Heap utilization bar</b> A visual progress bar shows heap usage as a percentage. Color changes from green (healthy) to amber (moderate) to red (high pressure). Click Refresh to update stats.</div>
          </div>
        </section>

        {/* ── Debug Snapshot ── */}
        <section id="wiki-debug" className="wiki-card">
          <h2>🐛 Debug Snapshot</h2>
          <p>Generates a comprehensive JSON snapshot of the entire extension state — perfect for bug reports and diagnostics. One click to copy everything to clipboard.</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>DMCR version</strong><span>Extension version, VS Code version, Node/Electron/V8/OpenSSL versions, app host, remote name.</span></div>
            <div className="wiki-row"><strong>SQLite info</strong><span>Database path, file size, SQLite engine version, table count.</span></div>
            <div className="wiki-row"><strong>AI footprint</strong><span>Summary of last 10 AI/LLM calls with timing.</span></div>
            <div className="wiki-row"><strong>Memory stats</strong><span>Heap used/total, RSS, external, array buffers — same data as Memory Footprint.</span></div>
            <div className="wiki-row"><strong>JS errors</strong><span>Any JavaScript errors captured during the session.</span></div>
          </div>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>One-click copy</b> Click "Copy to Clipboard" to get the full JSON. Paste it into a GitHub issue or share with the team for debugging.</div>
          </div>
        </section>

        {/* ── DB Explorer ── */}
        <section id="wiki-db-explorer" className="wiki-card">
          <h2>🗄️ DB Explorer</h2>
          <p>A full database browser for the internal DMCR SQLite store. Browse tables, inspect rows, and perform bulk deletions — all from within VS Code. Think of it as a mini "DBeaver" for your extension's local database.</p>
          <div className="wiki-metric-row">
            <div className="wiki-metric"><strong>3</strong><span>Tables</span></div>
            <div className="wiki-metric"><strong>∞</strong><span>Pagination</span></div>
            <div className="wiki-metric"><strong>🖱️</strong><span>Drag splitter</span></div>
            <div className="wiki-metric"><strong>🗑️</strong><span>Bulk delete</span></div>
          </div>

          <h3>Layout</h3>
          <p>The panel uses a <strong>sidebar + content</strong> layout (like Prompt Library). A draggable splitter separates the two panes — drag to resize or click to collapse the sidebar entirely.</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Left sidebar</strong><span>Lists all SQLite tables with colorful SVG icons, column names, and row counts. Click a table to load it.</span></div>
            <div className="wiki-row"><strong>Right content</strong><span>Data table with sticky header, sortable columns, monospace cell values, and NULL highlighting.</span></div>
            <div className="wiki-row"><strong>HUD popup</strong><span>Appears when rows are selected — shows selection count with Delete and Deselect action buttons.</span></div>
          </div>

          <details open>
            <summary>Table icons &amp; colors</summary>
            <div className="wiki-section-copy">
              <p>Each table gets a unique icon and color for quick visual identification:</p>
              <div className="wiki-table">
                <div className="wiki-row"><span style={{color:'#6366f1'}}>■</span><span><code>kv</code> — Indigo. The key-value store (collections, settings, prompt library data).</span></div>
                <div className="wiki-row"><span style={{color:'#f59e0b'}}>■</span><span><code>ce_audit</code> — Amber. AI/LLM interaction audit trail (same data as AI Footprint).</span></div>
                <div className="wiki-row"><span style={{color:'#22c55e'}}>■</span><span><code>runner_event_log</code> — Green. Runner lifecycle events (start, stop, errors).</span></div>
              </div>
            </div>
          </details>

          <details>
            <summary>Row selection &amp; deletion</summary>
            <div className="wiki-section-copy">
              <div className="wiki-steps">
                <div className="wiki-step"><div className="wiki-step-num">1</div><div className="wiki-step-text"><strong>Select rows:</strong> Click checkboxes on individual rows, or use the header checkbox to select all visible rows.</div></div>
                <div className="wiki-step"><div className="wiki-step-num">2</div><div className="wiki-step-text"><strong>HUD appears:</strong> A floating action bar shows "N selected" with Delete and Deselect buttons.</div></div>
                <div className="wiki-step"><div className="wiki-step-num">3</div><div className="wiki-step-text"><strong>Confirm delete:</strong> A modal dialog asks for confirmation (same pattern as AI Footprint delete). Deletion is by SQLite <code>rowid</code>.</div></div>
                <div className="wiki-step"><div className="wiki-step-num">4</div><div className="wiki-step-text"><strong>Table refreshes:</strong> After deletion, the table reloads with updated data and row counts.</div></div>
              </div>
              <div className="wiki-callout wiki-callout-warn">
                <strong>Warning:</strong> Deletions are permanent. There is no undo — the SQLite rows are removed immediately.
              </div>
            </div>
          </details>

          <details>
            <summary>Backend API</summary>
            <div className="wiki-section-copy">
              <p>Three functions in <code>db.ts</code> power the explorer:</p>
              <div className="wiki-table">
                <div className="wiki-row"><strong><code>getDbExplorerTables()</code></strong><span>Lists all tables via <code>sqlite_master</code>, fetches columns from <code>PRAGMA table_info</code>, and counts rows.</span></div>
                <div className="wiki-row"><strong><code>getDbExplorerRows(table, limit, offset)</code></strong><span>Fetches paginated rows. Table name is <strong>whitelisted</strong> against actual <code>sqlite_master</code> entries to prevent SQL injection.</span></div>
                <div className="wiki-row"><strong><code>deleteDbExplorerRows(table, pkValues, pkColumn)</code></strong><span>Bulk deletes by primary key. Whitelists table name against <code>sqlite_master</code> before executing.</span></div>
              </div>
            </div>
          </details>

          <div className="wiki-callout wiki-callout-info">
            <strong>Tip:</strong> The DB Explorer shows <code>rowid</code> as the first column for every table. This is SQLite's internal row identifier — useful for targeted deletions even when tables have no explicit primary key visible in the data.
          </div>
        </section>

        {/* ── GIT SYNC ── */}
        <section id="wiki-git-sync" className="wiki-card">
          <h2>🔄 Git Sync — GitHub Integration</h2>
          <p>Full-featured Git integration built directly into DMCR. Automatically commits your generated change folders with AI-written commit messages, pushes to your GitHub remote, and provides manual sync controls — all without leaving VS Code.</p>

          <h3>🛠️ Setup &amp; Configuration</h3>
          <p>Navigate to <strong>Settings → DMCR Config → Git Integration</strong> to configure:</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>GitHub Remote URL</strong><span>Enter your repository URL (e.g. <code>https://github.com/org/repo.git</code> or <code>git@github.com:org/repo.git</code>). When saved, DMCR automatically runs <code>git remote set-url origin &lt;url&gt;</code>. If no origin exists, it creates one.</span></div>
            <div className="wiki-row"><strong>Branch</strong><span>Target branch for push/pull. Click <strong>🔄 Fetch</strong> to auto-populate a dropdown with branches from the remote (<code>git ls-remote --heads</code>). Leave empty to use the currently checked-out branch (<code>git rev-parse --abbrev-ref HEAD</code>).</span></div>
            <div className="wiki-row"><strong>Auto-commit on change generation</strong><span>Enabled by default (<code>dmcr.gitAutoCommit = true</code>). When a change folder is saved to disk, DMCR stages the folder, asks the AI for a commit message, and commits+pushes in the background. Disable to only allow manual <code>/sync</code>.</span></div>
          </div>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>VS Code Settings</b> All values are stored in your workspace settings (<code>.vscode/settings.json</code>) as <code>dmcr.gitRemoteUrl</code>, <code>dmcr.gitBranch</code>, and <code>dmcr.gitAutoCommit</code>. You can also set them there directly.</div>
          </div>

          <h3>🤖 AI Commit Messages (Prompt Library)</h3>
          <p>Git Sync uses the <strong>GIT_COMMIT_MESSAGE</strong> prompt scenario from the Prompt Library (under <em>Git &amp; Version Control</em> group). The AI generates commit messages in <strong>Conventional Commits</strong> format by default.</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Prompt Location</strong><span>Settings → Prompt Library → Git &amp; Version Control → Git Commit Message. You&apos;ll see the GitHub icon (  ) next to it.</span></div>
            <div className="wiki-row"><strong>Variables Available</strong><span><code>{'{{folderName}}'}</code> — change folder ID, <code>{'{{deploySql}}'}</code> — deploy SQL content (truncated to 2000 chars), <code>{'{{changeSummary}}'}</code> — human-readable description, <code>{'{{branch}}'}</code> — current git branch name.</span></div>
            <div className="wiki-row"><strong>Customization</strong><span>Edit the system prompt to change commit style: gitmoji (<code>✨ feat: ...</code>), Angular style, Jira ticket prefixes, or plain text. The user prompt template controls what context the AI sees.</span></div>
            <div className="wiki-row"><strong>Temperature</strong><span>Set to <code>0.1</code> for consistent, deterministic commit messages. Low creativity = predictable format.</span></div>
          </div>
          <div className="wiki-callout">
            <div>💡</div>
            <div><b>Default format:</b> <code>feat(db): add users table with email constraint</code> — the AI infers scope from the SQL content and branch name.</div>
          </div>

          <h3>⚡ How It Works — Auto-Commit Flow</h3>
          <p>When you generate a change (DDL, Insert, Freeform, Schema Diff) and save it:</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>1. Check</strong><span>Is <code>dmcr.gitAutoCommit</code> enabled? Is <code>git</code> available on PATH? Is the workspace a git repo?</span></div>
            <div className="wiki-row"><strong>2. AI Prompt</strong><span>Calls the active LLM with the GIT_COMMIT_MESSAGE prompt. Passes folder name, deploy SQL, and branch as variables.</span></div>
            <div className="wiki-row"><strong>3. Stage</strong><span>Runs <code>git add -- &lt;folderPath&gt;</code> to stage only the new change folder.</span></div>
            <div className="wiki-row"><strong>4. Commit</strong><span>Runs <code>git commit -m &quot;&lt;AI message&gt;&quot;</code>. If AI fails, falls back to <code>feat(db): add &lt;folderId&gt;</code>.</span></div>
            <div className="wiki-row"><strong>5. Push</strong><span>Runs <code>git push origin &lt;branch&gt;</code>. If push fails, the commit is still local — you can retry with <code>/sync</code>.</span></div>
            <div className="wiki-row"><strong>6. Notify</strong><span>The Home page GenBar updates with ✓ commit hash. Errors show as inline messages.</span></div>
          </div>

          <h3>🖥️ Manual Sync — <code>/sync</code> Command</h3>
          <p>Available in the <strong>Runner tab</strong>. Type <code>/sync</code> or click it from the command palette. Performs a full sync cycle:</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Pull</strong><span><code>git pull --rebase origin &lt;branch&gt;</code> — brings in remote changes first.</span></div>
            <div className="wiki-row"><strong>Stage</strong><span><code>git add -- &lt;changesDir&gt;</code> — stages ALL files under your changes directory.</span></div>
            <div className="wiki-row"><strong>AI Commit</strong><span>Generates a commit message summarizing all staged changes. Gets a summary of modified/new files from <code>git status --porcelain</code>.</span></div>
            <div className="wiki-row"><strong>Push</strong><span><code>git push origin &lt;branch&gt;</code> — pushes to the configured remote.</span></div>
          </div>
          <p>The terminal shows inline results: ✓ commit hash on success, ✗ error message on failure.</p>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Home Page Sync Button</b> After generating a change, a "🔄 Sync" button appears in the GenBar. Click it to trigger the same full sync — equivalent to <code>/sync</code>.</div>
          </div>

          <h3>📋 Audit Log &amp; AI Footprint</h3>
          <p>Every AI commit message generation is fully tracked in the audit system — visible in both the <strong>Audit Log</strong> and <strong>AI Footprint</strong> panels.</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Stage</strong><span><code>GIT_COMMIT_MESSAGE</code> — shows up in the AI Footprint feed with this label.</span></div>
            <div className="wiki-row"><strong>Conversation ID</strong><span><code>git-autocommit-&lt;folderId&gt;</code> for auto-commits, <code>git-sync-manual</code> for <code>/sync</code> command.</span></div>
            <div className="wiki-row"><strong>Duration</strong><span>Records LLM call latency in milliseconds — helps identify slow commit message generation.</span></div>
            <div className="wiki-row"><strong>System Prompt</strong><span>The resolved GIT_COMMIT_MESSAGE system prompt (truncated to 2000 chars in audit).</span></div>
            <div className="wiki-row"><strong>User Prompt</strong><span>The rendered user prompt with variables filled in (folder name, SQL, branch).</span></div>
            <div className="wiki-row"><strong>Response</strong><span>The generated commit message in <code>response_payload</code> JSON.</span></div>
            <div className="wiki-row"><strong>Meta</strong><span>Additional context: <code>folderRel</code>, <code>branch</code>, and <code>trigger</code> (either &quot;auto-commit&quot; or &quot;/sync&quot;).</span></div>
          </div>
          <div className="wiki-callout">
            <div>💡</div>
            <div><b>Debug Snapshot</b> includes Git Commit AI calls in the &quot;AI footprint&quot; section — useful for verifying commit messages are being generated correctly.</div>
          </div>

          <h3>🛡️ Fallbacks &amp; Error Handling</h3>
          <div className="wiki-table">
            <div className="wiki-row"><strong>No git installed</strong><span>Auto-commit silently skips (returns <code>null</code>). Manual <code>/sync</code> shows: <em>&quot;git is not installed or not in PATH&quot;</em>.</span></div>
            <div className="wiki-row"><strong>Not a git repo</strong><span>Same behavior — silently skips auto-commit, shows error for manual sync.</span></div>
            <div className="wiki-row"><strong>AI unavailable</strong><span>Falls back to default messages: <code>feat(db): add &lt;folder&gt;</code> (auto) or <code>chore(db): sync changes</code> (manual).</span></div>
            <div className="wiki-row"><strong>Nothing to commit</strong><span>If <code>git diff --cached --quiet</code> succeeds (no staged changes), returns <code>ok: true, committed: false</code> — no empty commits.</span></div>
            <div className="wiki-row"><strong>Push fails</strong><span>Commit is preserved locally. Error shown in Runner terminal. Re-run <code>/sync</code> to retry.</span></div>
            <div className="wiki-row"><strong>Merge conflicts</strong><span><code>git pull --rebase</code> may fail on conflicts. The error is displayed — resolve manually in the terminal, then <code>/sync</code> again.</span></div>
          </div>

          <h3>🔐 Security Notes</h3>
          <div className="wiki-table">
            <div className="wiki-row"><strong>Credentials</strong><span>Git authentication uses your system&apos;s credential manager (Windows Credential Manager, macOS Keychain, etc.). DMCR does not store git passwords.</span></div>
            <div className="wiki-row"><strong>SSH keys</strong><span>Supported — use an SSH remote URL (<code>git@github.com:...</code>) and ensure your SSH agent is running.</span></div>
            <div className="wiki-row"><strong>SQL in prompts</strong><span>Deploy SQL is truncated to 2000 characters before sending to the LLM. Full SQL never leaves your machine beyond what the LLM provider sees.</span></div>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            COMPREHENSIVE COMMAND REFERENCE
            ═══════════════════════════════════════════════════════════════ */}

        {/* ── CORE COMMANDS ── */}
        <section id="wiki-core-cmds" className="wiki-card">
          <h2>🚀 Core Commands — Detailed Reference</h2>

          {/* dmcr init */}
          <details open>
            <summary>dmcr init</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">🏗️</span>
                  <span className="wiki-cmd-name">dmcr init</span>
                </div>
                <div className="wiki-cmd-desc">
                  Creates the DMCR registry schema and tables in your PostgreSQL database. This is a <strong>one-time setup</strong> — you run it once per database, and it creates the <code>dmcr</code> schema with <code>change_log</code>, <code>event_log</code>, <code>tags</code>, and <code>repeatable_log</code> tables.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: First-time setup</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># You just set up a new dev database. Run init once:</span>{'\n'}
                    dmcr init{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Output:</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># INIT    creating DMCR registry</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    DMCR registry ready</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: After team member sets up a fresh DB</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># Jane joins the team, creates her local postgres DB</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># She runs init, then deploy to catch up:</span>{'\n'}
                    dmcr init{'\n'}
                    dmcr deploy
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Creates the <code>dmcr</code> schema and 4 tables: <code>change_log</code> (tracks applied changes), <code>event_log</code> (audit trail), <code>tags</code> (release markers), <code>repeatable_log</code> (repeatable migration checksums).</p>
                </div>
                <div className="wiki-cmd-without">
                  <div className="wiki-cmd-without-title">❌ Without it</div>
                  <p>Every other DMCR command will fail with <strong>"DMCR registry not found"</strong> because there's no table to track changes.</p>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr deploy */}
          <details>
            <summary>dmcr deploy</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">🚀</span>
                  <span className="wiki-cmd-name">dmcr deploy [--dry-run] [--to &lt;id|@tag&gt;] [--json]</span>
                </div>
                <div className="wiki-cmd-desc">
                  Applies all pending changes in numbered order. Each change is deployed inside a single transaction — if the SQL fails, nothing is recorded. After deploy, verify.sql runs to confirm the change worked. If verify fails, the change is automatically reverted.
                </div>
                <div className="wiki-cmd-flags">
                  <span className="wiki-cmd-flag">--dry-run</span>
                  <span className="wiki-cmd-flag">--to &lt;id|@tag&gt;</span>
                  <span className="wiki-cmd-flag">--json</span>
                  <span className="wiki-cmd-flag">--debug</span>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Deploy all pending changes</div>
                  <div className="wiki-cmd-example-code">
                    dmcr deploy{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Output:</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># INFO    Starting DMCR deploy</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># SKIP    001_create_users already applied</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># APPLY   002_add_email_index (before deploy)</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># VERIFY  002_add_email_index (after deploy)</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    002_add_email_index applied successfully (145ms)</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: Dry run — see what WOULD be deployed</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># Preview without touching the database:</span>{'\n'}
                    dmcr deploy --dry-run{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Shows each pending change and its deploy.sql content</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># Nothing is executed. Perfect for CI/CD review.</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 3: Deploy up to a specific change or tag</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># Deploy only up to (and including) this change:</span>{'\n'}
                    dmcr deploy --to 003_seed_roles{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Or deploy up to a tagged release:</span>{'\n'}
                    dmcr deploy --to @v1.0{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Useful when you want partial deployment</span>
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>For each pending change: acquires advisory lock → begins transaction → runs deploy.sql → inserts into change_log → commits → runs verify.sql. Skips already-applied and danger_ folders.</p>
                </div>
                <div className="wiki-cmd-without">
                  <div className="wiki-cmd-without-title">❌ Without it</div>
                  <p>Your SQL files just sit in folders doing nothing. The database doesn't change. You'd have to manually copy-paste SQL into psql.</p>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr status */}
          <details>
            <summary>dmcr status</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">📊</span>
                  <span className="wiki-cmd-name">dmcr status [--json]</span>
                </div>
                <div className="wiki-cmd-desc">
                  Shows a colored table of ALL change folders and their status — <strong>APPLIED ✅</strong> or <strong>PENDING ⏹</strong>. This is how you check "which changes are deployed?" at a glance.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Check what's deployed</div>
                  <div className="wiki-cmd-example-code">
                    dmcr status{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Output (colored table):</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># ┌─────────────────┬────────────────────────────┐</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ Status          │ Change                     │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># ├─────────────────┼────────────────────────────┤</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ APPLIED ✅      │ 001_create_users           │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ APPLIED ✅      │ 002_add_email_index        │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ PENDING ⏹       │ 003_seed_roles             │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># └─────────────────┴────────────────────────────┘</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: JSON output for scripts/CI</div>
                  <div className="wiki-cmd-example-code">
                    dmcr status --json{'\n\n'}
                    <span className="wiki-cmd-example-comment">{`# [{"change_id":"001_create_users","status":"applied"},`}</span>{'\n'}
                    <span className="wiki-cmd-example-comment">{`#  {"change_id":"003_seed_roles","status":"pending"}]`}</span>
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Scans the changes_dir for folders, checks each against <code>dmcr.change_log</code>, and displays a pretty table. Read-only — never modifies anything.</p>
                </div>
                <div className="wiki-cmd-without">
                  <div className="wiki-cmd-without-title">❌ Without it</div>
                  <p>You'd have to manually query <code>SELECT * FROM dmcr.change_log</code> in psql and compare against the folder list.</p>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr verify */}
          <details>
            <summary>dmcr verify</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">✅</span>
                  <span className="wiki-cmd-name">dmcr verify [all | &lt;change_id&gt;] [--json]</span>
                </div>
                <div className="wiki-cmd-desc">
                  Runs verify.sql for applied changes to confirm they're still valid. Verify scripts are assertions — they SELECT from the database and fail if the expected state isn't there.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Verify the last applied change</div>
                  <div className="wiki-cmd-example-code">
                    dmcr verify{'\n\n'}
                    <span className="wiki-cmd-example-comment"># VERIFY  002_add_email_index</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    002_add_email_index verified OK</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: Verify ALL applied changes</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># Run every verify.sql for every applied change:</span>{'\n'}
                    dmcr verify all{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Great for after restoring a database backup</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># or to confirm nothing drifted</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 3: Verify a specific change</div>
                  <div className="wiki-cmd-example-code">
                    dmcr verify 001_create_users
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Runs the verify.sql inside a rolled-back transaction so it has no side effects. It's a read-only health check.</p>
                </div>
                <div className="wiki-cmd-without">
                  <div className="wiki-cmd-without-title">❌ Without it</div>
                  <p>You wouldn't know if someone manually altered the database and broke an applied change. Drift detection requires verify.</p>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr parse */}
          <details>
            <summary>dmcr parse</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">🔍</span>
                  <span className="wiki-cmd-name">dmcr parse "SQL"</span>
                </div>
                <div className="wiki-cmd-desc">
                  Validates SQL by executing it inside a <code>BEGIN / ROLLBACK</code> block. The SQL runs against the real database (so it can check table/column existence) but nothing is persisted.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Check if SQL is valid</div>
                  <div className="wiki-cmd-example-code">
                    dmcr parse "SELECT id, name FROM app.users;"{'\n\n'}
                    <span className="wiki-cmd-example-comment">{`# Returns: {"ok":true}`}</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: Catch syntax errors</div>
                  <div className="wiki-cmd-example-code">
                    dmcr parse "SELECTT id FROM users;"{'\n\n'}
                    <span className="wiki-cmd-example-comment">{`# Returns: {"ok":false,"msg":"ERROR: syntax error at or near 'SELECTT'"}`}</span>
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Sends the SQL to PostgreSQL inside a transaction that always rolls back. If PostgreSQL accepts it, it's valid. If not, you get the error message.</p>
                </div>
                <div className="wiki-cmd-without">
                  <div className="wiki-cmd-without-title">❌ Without it</div>
                  <p>You'd have to open psql and manually test SQL, or wait until deploy to find out it's broken.</p>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr repeatable */}
          <details>
            <summary>dmcr repeatable</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">♻️</span>
                  <span className="wiki-cmd-name">dmcr repeatable</span>
                </div>
                <div className="wiki-cmd-desc">
                  Applies all repeatable migrations (<code>R__*</code> folders) whose deploy.sql checksum has changed since last run. Repeatable migrations are for views, functions, triggers — things that can be safely re-created.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Apply changed repeatables</div>
                  <div className="wiki-cmd-example-code">
                    dmcr repeatable{'\n\n'}
                    <span className="wiki-cmd-example-comment"># SKIP    R__user_summary_view — unchanged</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># APPLY   R__audit_triggers (repeatable)</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    R__audit_triggers applied (89ms)</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: Nothing changed</div>
                  <div className="wiki-cmd-example-code">
                    dmcr repeatable{'\n\n'}
                    <span className="wiki-cmd-example-comment"># SKIP    R__user_summary_view — unchanged (checksum matches)</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># SKIP    R__audit_triggers — unchanged (checksum matches)</span>
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Compares the SHA-256 checksum of each R__ folder's deploy.sql against the stored checksum in <code>dmcr.repeatable_log</code>. Only re-runs if the file changed. Also runs after <code>dmcr deploy</code> automatically.</p>
                </div>
              </div>
            </div>
          </details>
        </section>

        {/* ── REVERT COMMANDS ── */}
        <section id="wiki-revert-cmds" className="wiki-card">
          <h2>↩️ Revert Commands — Detailed Reference</h2>

          {/* dmcr revert */}
          <details open>
            <summary>dmcr revert &lt;change_id&gt;</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">↩️</span>
                  <span className="wiki-cmd-name">dmcr revert &lt;change_id&gt;</span>
                </div>
                <div className="wiki-cmd-desc">
                  Reverts a specific change by running its revert.sql and removing it from <code>dmcr.change_log</code>. <strong>Important:</strong> you can only revert the most recently applied change (stack order — last in, first out).
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Revert a specific change</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># 003_seed_roles was the last applied change</span>{'\n'}
                    dmcr revert 003_seed_roles{'\n\n'}
                    <span className="wiki-cmd-example-comment"># REVERT  003_seed_roles</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    003_seed_roles reverted successfully</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: What happens if it's NOT the latest?</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># If 003 is applied but 004 is also applied:</span>{'\n'}
                    dmcr revert 003_seed_roles{'\n\n'}
                    <span className="wiki-cmd-example-comment"># ERROR: Can only revert the latest applied change.</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># Revert 004_xxx first, then try again.</span>
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Acquires advisory lock → runs revert.sql in a transaction → deletes the row from change_log → logs to event_log. Atomic — if revert.sql fails, the change stays applied.</p>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr revert to */}
          <details>
            <summary>dmcr revert to &lt;id|@tag&gt;</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">⏪</span>
                  <span className="wiki-cmd-name">dmcr revert to &lt;change_id | @tag&gt;</span>
                </div>
                <div className="wiki-cmd-desc">
                  Reverts all changes <strong>down to and including</strong> the target. Peels back changes one at a time from the most recent. Supports <code>@tag</code> syntax.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Revert to a specific change</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># Currently applied: 001, 002, 003, 004, 005</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># Revert back to (and including) 003:</span>{'\n'}
                    dmcr revert to 003_seed_roles{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Reverts: 005 → 004 → 003 (in that order)</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># After: only 001 and 002 remain applied</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: Revert to a tagged release</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># Tag @v1.0 points to 002_add_email_index</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># Currently applied: 001 through 005</span>{'\n'}
                    dmcr revert to @v1.0{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Reverts: 005 → 004 → 003 → 002</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># After: only 001 remains applied</span>
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Resolves the target (or @tag → change_id), then reverts each change one by one from the top. Each revert is a separate transaction. Stops after the target is reverted.</p>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr revert list */}
          <details>
            <summary>dmcr revert list</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">📋</span>
                  <span className="wiki-cmd-name">dmcr revert list</span>
                </div>
                <div className="wiki-cmd-desc">
                  Lists all currently applied changes in reverse chronological order (most recent first). Useful to see what you CAN revert.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example</div>
                  <div className="wiki-cmd-example-code">
                    dmcr revert list{'\n\n'}
                    <span className="wiki-cmd-example-comment"># change_id              | applied_at</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># ──────────────────────────────────────</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># 003_seed_roles         | 2026-05-13 14:22:01</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># 002_add_email_index    | 2026-05-13 14:21:58</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># 001_create_users       | 2026-05-13 14:21:55</span>
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr revertLast */}
          <details>
            <summary>dmcr revertLast</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">⏮️</span>
                  <span className="wiki-cmd-name">dmcr revertLast</span>
                </div>
                <div className="wiki-cmd-desc">
                  Reverts the single most recently applied change. Quick shortcut — you don't need to know the change_id.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Quick undo</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># "Oops, the last deploy had a bug. Undo it!"</span>{'\n'}
                    dmcr revertLast{'\n\n'}
                    <span className="wiki-cmd-example-comment"># INFO    Resolving latest applied change: 003_seed_roles</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># REVERT  003_seed_roles</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    003_seed_roles reverted successfully</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: Nothing to revert</div>
                  <div className="wiki-cmd-example-code">
                    dmcr revertLast{'\n\n'}
                    <span className="wiki-cmd-example-comment"># INFO    nothing to revert</span>
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Finds the latest entry in <code>dmcr.change_log</code>, then runs its revert.sql atomically. Same as <code>dmcr revert &lt;last_id&gt;</code> but you don't need to look up the ID.</p>
                </div>
              </div>
            </div>
          </details>
        </section>

        {/* ── INSPECT COMMANDS ── */}
        <section id="wiki-inspect-cmds" className="wiki-card">
          <h2>🔎 Inspect Commands — Detailed Reference</h2>

          {/* dmcr history */}
          <details open>
            <summary>dmcr history</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">📜</span>
                  <span className="wiki-cmd-name">dmcr history [--json]</span>
                </div>
                <div className="wiki-cmd-desc">
                  Shows the full audit trail of applied changes — who deployed what, when, with what git commit, and from which environment.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: View history</div>
                  <div className="wiki-cmd-example-code">
                    dmcr history{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Shows: change_id, applied_at, applied_by, deploy_checksum,</span>{'\n'}
                    <span className="wiki-cmd-example-comment">#        ticket_id, git_commit, environment, actor</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: JSON for CI pipelines</div>
                  <div className="wiki-cmd-example-code">
                    dmcr history --json{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Returns structured JSON array of all applied changes</span>
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr info */}
          <details>
            <summary>dmcr info</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">ℹ️</span>
                  <span className="wiki-cmd-name">dmcr info [--json]</span>
                </div>
                <div className="wiki-cmd-desc">
                  Shows a summary dashboard: environment name, total/applied/pending/danger change counts, registry health, and checksum policy.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example</div>
                  <div className="wiki-cmd-example-code">
                    dmcr info{'\n\n'}
                    <span className="wiki-cmd-example-comment"># ┌──────────────────┬─────────────┐</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ Property         │ Value       │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># ├──────────────────┼─────────────┤</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ Environment      │ dev         │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ Total Changes    │ 5           │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ Applied          │ 3           │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ Pending          │ 1           │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ Danger (manual)  │ 1           │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ Registry         │ OK ✅       │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ Checksum Policy  │ warn        │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># └──────────────────┴─────────────┘</span>
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr plan */}
          <details>
            <summary>dmcr plan</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">🗺️</span>
                  <span className="wiki-cmd-name">dmcr plan [--json]</span>
                </div>
                <div className="wiki-cmd-desc">
                  Shows the dependency-aware execution order. Reads <code>meta.json</code> files to build a dependency graph and displays the safe execution order with requirements.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example</div>
                  <div className="wiki-cmd-example-code">
                    dmcr plan{'\n\n'}
                    <span className="wiki-cmd-example-comment"># ┌───────┬────────────────────────┬────────────┬──────────────────┐</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ Order │ Change                 │ Status     │ Requires         │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># ├───────┼────────────────────────┼────────────┼──────────────────┤</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ 1     │ 001_create_users       │ APPLIED ✅ │ —                │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ 2     │ 002_add_email_index    │ APPLIED ✅ │ 001_create_users │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># │ 3     │ 003_seed_roles         │ PENDING ⏹  │ —                │</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># └───────┴────────────────────────┴────────────┴──────────────────┘</span>
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Reads all meta.json <code>requires</code> fields, performs a topological sort, and shows the safe order. If there's a circular dependency, it throws an error.</p>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr check */}
          <details>
            <summary>dmcr check</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">🩺</span>
                  <span className="wiki-cmd-name">dmcr check [--json]</span>
                </div>
                <div className="wiki-cmd-desc">
                  Runs preflight validation without deploying. Checks for missing files, numbering gaps, checksum mismatches, and dependency graph issues.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Everything OK</div>
                  <div className="wiki-cmd-example-code">
                    dmcr check{'\n\n'}
                    <span className="wiki-cmd-example-comment"># DONE    All preflight checks passed</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    Dependency graph OK (5 changes in order)</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: Issues found</div>
                  <div className="wiki-cmd-example-code">
                    dmcr check{'\n\n'}
                    <span className="wiki-cmd-example-comment"># WARN    Preflight issues found:</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># WARN      &gt;&gt; 004_add_orders: missing verify.sql</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># WARN      &gt;&gt; 002_add_email: checksum mismatch (file changed after deploy)</span>
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Validates all change folders: required files exist, checksums match stored values, dependencies are valid. Run this before <code>dmcr deploy</code> to catch problems early.</p>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr show config */}
          <details>
            <summary>dmcr show config</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">⚙️</span>
                  <span className="wiki-cmd-name">dmcr show config</span>
                </div>
                <div className="wiki-cmd-desc">
                  Displays the active configuration — environment, connection (password redacted), changes_dir, lock/statement timeouts, checksum policy, and placeholders.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example</div>
                  <div className="wiki-cmd-example-code">
                    dmcr show config{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Shows: env=dev, conn=postgresql://user:****@host:5432/db,</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># changes_dir=C:\db\changes, lock_timeout=30s, etc.</span>
                  </div>
                </div>
              </div>
            </div>
          </details>
        </section>

        {/* ── REPAIR COMMANDS ── */}
        <section id="wiki-repair-cmds" className="wiki-card">
          <h2>🔧 Repair Commands — Detailed Reference</h2>
          <div className="wiki-callout warn">
            <div>⚠️</div>
            <div><b>Use with caution</b> Repair commands modify the registry without running SQL. Only use when the registry is out of sync with the actual database state (e.g. after manual psql changes or database restores).</div>
          </div>

          {/* dmcr baseline */}
          <details open>
            <summary>dmcr baseline &lt;change_id&gt;</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">📌</span>
                  <span className="wiki-cmd-name">dmcr baseline &lt;change_id&gt;</span>
                </div>
                <div className="wiki-cmd-desc">
                  Marks all changes <strong>up to and including</strong> the target as applied — <strong>without executing any SQL</strong>. Use when you have an existing database that was set up manually or from a dump and you want DMCR to start tracking from a known point.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Adopt DMCR on an existing database</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># Your database already has changes 001-003 applied manually.</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># Tell DMCR those are already done:</span>{'\n'}
                    dmcr baseline 003_seed_roles{'\n\n'}
                    <span className="wiki-cmd-example-comment"># DONE    001_create_users baselined</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    002_add_email_index baselined</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    003_seed_roles baselined</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    Baseline complete — 3 change(s) marked as applied</span>{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Now 'dmcr deploy' will only apply 004+ onwards</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: Onboard a production database</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># Production DB already has everything through 010:</span>{'\n'}
                    dmcr init{'\n'}
                    dmcr baseline 010_final_prod_state{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Now future dmcr deploy commands only apply new changes</span>
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr repair --mark-applied */}
          <details>
            <summary>dmcr repair --mark-applied</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">✅</span>
                  <span className="wiki-cmd-name">dmcr repair --mark-applied &lt;change_id&gt;</span>
                </div>
                <div className="wiki-cmd-desc">
                  Manually marks a single change as applied in the registry without executing its deploy.sql. Use when a DBA manually ran the SQL and you need the registry to reflect that.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># DBA ran 005_add_index/deploy.sql manually via psql</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># Tell DMCR it's done:</span>{'\n'}
                    dmcr repair --mark-applied 005_add_index{'\n\n'}
                    <span className="wiki-cmd-example-comment"># DONE    '005_add_index' marked as applied</span>
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr repair --mark-reverted */}
          <details>
            <summary>dmcr repair --mark-reverted</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">🗑️</span>
                  <span className="wiki-cmd-name">dmcr repair --mark-reverted &lt;change_id&gt;</span>
                </div>
                <div className="wiki-cmd-desc">
                  Removes a change from the registry without executing its revert.sql. Use when a change was manually reverted by a DBA or the database was restored from backup.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># DBA manually reverted 005, but DMCR still thinks it's applied:</span>{'\n'}
                    dmcr repair --mark-reverted 005_add_index{'\n\n'}
                    <span className="wiki-cmd-example-comment"># DONE    '005_add_index' marked as reverted</span>
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr repair --checksums */}
          <details>
            <summary>dmcr repair --checksums</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">🔄</span>
                  <span className="wiki-cmd-name">dmcr repair --checksums</span>
                </div>
                <div className="wiki-cmd-desc">
                  Recalculates and updates stored checksums for all applied changes. Use after editing deploy/verify/revert SQL files for documentation or formatting fixes that don't change behavior.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># You reformatted SQL files (whitespace only, no logic change):</span>{'\n'}
                    dmcr repair --checksums{'\n\n'}
                    <span className="wiki-cmd-example-comment"># DONE    001_create_users checksums updated</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    002_add_email_index checksums updated</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># DONE    2 change(s) checksums reconciled</span>
                  </div>
                </div>
              </div>
            </div>
          </details>
        </section>

        {/* ── TAG COMMANDS ── */}
        <section id="wiki-tag-cmds" className="wiki-card">
          <h2>🏷️ Tag Commands — Detailed Reference</h2>
          <p>Tags are named bookmarks that point to a specific change_id. Think of them like Git tags but for your database state. They're used with <code>--to @tag</code> in deploy and revert.</p>

          {/* dmcr tag list */}
          <details open>
            <summary>dmcr tag [list]</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">📋</span>
                  <span className="wiki-cmd-name">dmcr tag [list]</span>
                </div>
                <div className="wiki-cmd-desc">
                  Lists all release tags with their target change_id, creation date, and optional description.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example</div>
                  <div className="wiki-cmd-example-code">
                    dmcr tag list{'\n\n'}
                    <span className="wiki-cmd-example-comment"># tag_name    | change_id              | created_at          | description</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># ──────────────────────────────────────────────────────────────────────</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># v2.0        | 010_add_notifications  | 2026-05-13 15:00:00 | Sprint 44</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># v1.0        | 005_add_index          | 2026-04-01 10:00:00 | Initial release</span>
                  </div>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr tag create */}
          <details>
            <summary>dmcr tag create</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">🆕</span>
                  <span className="wiki-cmd-name">dmcr tag create &lt;name&gt; [description]</span>
                </div>
                <div className="wiki-cmd-desc">
                  Creates a tag pointing to the <strong>last applied change</strong>. Tag names must be alphanumeric (letters, digits, dots, dashes, underscores).
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 1: Tag a release</div>
                  <div className="wiki-cmd-example-code">
                    <span className="wiki-cmd-example-comment"># After deploying all Sprint 42 changes:</span>{'\n'}
                    dmcr tag create v1.0 "Sprint 42 release"{'\n\n'}
                    <span className="wiki-cmd-example-comment"># DONE    Tag 'v1.0' created → 005_add_index</span>
                  </div>
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example 2: Tag a hotfix</div>
                  <div className="wiki-cmd-example-code">
                    dmcr tag create hotfix-2026-05 "Emergency fix for user table"{'\n\n'}
                    <span className="wiki-cmd-example-comment"># Now you can: dmcr deploy --to @hotfix-2026-05</span>{'\n'}
                    <span className="wiki-cmd-example-comment"># Or revert:   dmcr revert to @hotfix-2026-05</span>
                  </div>
                </div>
                <div className="wiki-cmd-what-happens">
                  <div className="wiki-cmd-what-happens-title">✅ What it does</div>
                  <p>Records the tag name, target change_id (the latest applied change), description, and timestamp in <code>dmcr.tags</code>. You can then use <code>@v1.0</code> anywhere a change_id is accepted.</p>
                </div>
              </div>
            </div>
          </details>

          {/* dmcr tag delete */}
          <details>
            <summary>dmcr tag delete</summary>
            <div className="wiki-section-copy">
              <div className="wiki-cmd-card">
                <div className="wiki-cmd-header">
                  <span className="wiki-cmd-emoji">🗑️</span>
                  <span className="wiki-cmd-name">dmcr tag delete &lt;name&gt;</span>
                </div>
                <div className="wiki-cmd-desc">
                  Removes a tag. Does NOT revert or modify any changes — only removes the tag pointer.
                </div>
                <div className="wiki-cmd-example">
                  <div className="wiki-cmd-example-label">Example</div>
                  <div className="wiki-cmd-example-code">
                    dmcr tag delete v1.0{'\n\n'}
                    <span className="wiki-cmd-example-comment"># DONE    Tag 'v1.0' deleted</span>
                  </div>
                </div>
              </div>
            </div>
          </details>
        </section>

        {/* ── Global Options ── */}
        <section id="wiki-global-opts" className="wiki-card">
          <h2>🎛️ Global Options</h2>
          <div className="wiki-table">
            <div className="wiki-row"><strong>--dry-run</strong><span>(deploy only) Shows what would be deployed without actually running anything. Safe to use anytime.</span></div>
            <div className="wiki-row"><strong>--to &lt;id|@tag&gt;</strong><span>(deploy/revert) Stops at a specific change or tag. Supports <code>@tag</code> syntax.</span></div>
            <div className="wiki-row"><strong>--json</strong><span>Machine-readable JSON output. Use in CI/CD pipelines, scripts, or programmatic access.</span></div>
            <div className="wiki-row"><strong>--debug</strong><span>Verbose debug logging. Shows every SQL call, folder scan, and decision. Set <code>DMCR_DEBUG=1</code> env var for always-on.</span></div>
            <div className="wiki-row"><strong>-c, --config</strong><span>Path to config file. Default: <code>dmcr.cfg</code> next to the script. Override with <code>DMCR_CONFIG</code> env var.</span></div>
          </div>
        </section>

        {/* ── Configuration ── */}
        <section id="wiki-config" className="wiki-card">
          <h2>⚙️ Configuration</h2>
          <p>DMCR uses an INI-style config file (<code>dmcr.cfg</code>) with a main <code>[dmcr]</code> section, environment sections, and optional placeholders.</p>
          <pre>{`[dmcr]
env               = dev
changes_dir       = C:\\path\\to\\db\\changes
psql_path         = C:\\path\\to\\psql.exe
lock_timeout      = 30s
statement_timeout = 5min
checksum_policy   = warn

[dev]
conn = postgresql://user:pass@host:5432/mydb?sslmode=require

[prod]
conn =                    # Use DMCR_CONN env var for production

[placeholders]
schema_name       = myapp
default_tenant    = 1`}</pre>
          <div className="wiki-table">
            <div className="wiki-row"><strong>DMCR_CONN</strong><span>Overrides the connection string from config. Essential for production where passwords come from secrets.</span></div>
            <div className="wiki-row"><strong>DMCR_CONFIG</strong><span>Overrides the config file path (default: dmcr.cfg next to the script).</span></div>
            <div className="wiki-row"><strong>DMCR_PSQL</strong><span>Overrides the <code>psql</code> executable path.</span></div>
            <div className="wiki-row"><strong>DMCR_ACTOR</strong><span>Overrides the actor name for audit logging.</span></div>
            <div className="wiki-row"><strong>DMCR_PLACEHOLDER_*</strong><span>Override placeholder values. E.g. <code>DMCR_PLACEHOLDER_schema_name=prod_app</code>.</span></div>
            <div className="wiki-row"><strong>checksum_policy</strong><span><code>warn</code> (default) — logs mismatch. <code>block</code> — refuses deploy. <code>repair</code> — auto-updates checksums.</span></div>
          </div>
          <div className="wiki-callout info">
            <div>💡</div>
            <div><b>Placeholders</b> Use <code>{'${name}'}</code> syntax in SQL files. DMCR substitutes values from <code>[placeholders]</code> config or <code>DMCR_PLACEHOLDER_*</code> env vars before execution. Unresolved placeholders cause an immediate error.</div>
          </div>
        </section>

        {/* ── Registry Tables ── */}
        <section id="wiki-registry" className="wiki-card">
          <h2>🗄️ Registry Tables</h2>
          <p>Created by <code>dmcr init</code> in the <code>dmcr</code> schema. These tables are DMCR's "brain" — they track everything.</p>
          <div className="wiki-table">
            <div className="wiki-row"><strong>dmcr.change_log</strong><span>Tracks applied changes: change_id (PK), applied_at, deploy/verify/revert checksums, ticket_id, git_commit, environment, actor.</span></div>
            <div className="wiki-row"><strong>dmcr.event_log</strong><span>Append-only audit trail: every deploy, revert, baseline, and repair action with timestamps and duration.</span></div>
            <div className="wiki-row"><strong>dmcr.tags</strong><span>Release tags: tag_name (PK), change_id, created_at, description.</span></div>
            <div className="wiki-row"><strong>dmcr.repeatable_log</strong><span>Tracks repeatable migration checksums: change_id (PK), last_checksum, applied_at.</span></div>
          </div>
        </section>

        {/* ── Safety Model ── */}
        <section id="wiki-safety" className="wiki-card">
          <h2>🛡️ Safety Model</h2>
          <p>DMCR has multiple safety layers to prevent accidents:</p>
          <div className="wiki-callout info">
            <div>🔒</div>
            <div><b>Advisory locking</b> Deploy and revert acquire a PostgreSQL advisory lock to prevent concurrent runners from modifying the database simultaneously.</div>
          </div>
          <div className="wiki-callout danger">
            <div>✕</div>
            <div><b>Automatic execution is blocked</b> for patterns like <code>TRUNCATE</code>, <code>DROP TABLE</code>, <code>DROP SCHEMA</code>, <code>DROP DATABASE</code>, <code>DROP FUNCTION/VIEW/TRIGGER</code>, and <code>DELETE</code>/<code>UPDATE</code> without <code>WHERE</code>. SQL inside comments is ignored by the scanner.</div>
          </div>
          <div className="wiki-callout ok">
            <div>✓</div>
            <div><b>Manual-only path</b> Rename the folder to include <code>danger_</code>. DMCR will skip it during deploy and refuse automatic revert, leaving execution to a DBA.</div>
          </div>
          <div className="wiki-cmd-example" style={{marginTop: 10}}>
            <div className="wiki-cmd-example-label">Example: danger_ folder</div>
            <div className="wiki-cmd-example-code">
              <span className="wiki-cmd-example-comment"># Normal folder — DMCR deploys and reverts automatically:</span>{'\n'}
              001_add_users_table/{'\n\n'}
              <span className="wiki-cmd-example-comment"># Danger folder — DMCR SKIPs it, DBA runs manually:</span>{'\n'}
              003_danger_truncate_audit_log/{'\n\n'}
              <span className="wiki-cmd-example-comment"># DBA runs manually:</span>{'\n'}
              psql $conn -f changes/003_danger_truncate_audit_log/deploy.sql
            </div>
          </div>
        </section>

        {/* ── Real World Scenario ── */}
        <section id="wiki-scenario" className="wiki-card">
          <h2>🎬 Real-World Scenario: End to End</h2>
          <p>Let's walk through a complete example — from generating a change to deploying and (if needed) reverting it.</p>
          <div className="wiki-steps">
            <div className="wiki-step"><div className="wiki-step-num">1</div><div className="wiki-step-text"><strong>Ask DMCR Copilot:</strong> "Add an email column to the users table"</div></div>
            <div className="wiki-step"><div className="wiki-step-num">2</div><div className="wiki-step-text"><strong>AI generates 3 files</strong> in <code>005_add_email_to_users/</code>:<br/>deploy.sql: <code>ALTER TABLE app.users ADD COLUMN email VARCHAR(255);</code><br/>verify.sql: checks column exists in <code>information_schema</code><br/>revert.sql: <code>ALTER TABLE app.users DROP COLUMN email;</code></div></div>
            <div className="wiki-step"><div className="wiki-step-num">3</div><div className="wiki-step-text"><strong>Git workflow:</strong> <code>git add changes/005_add_email_to_users/ &amp;&amp; git commit -m "feat: add email" &amp;&amp; git push</code></div></div>
            <div className="wiki-step"><div className="wiki-step-num">4</div><div className="wiki-step-text"><strong>Team reviews</strong> on GitHub → PR approved and merged</div></div>
            <div className="wiki-step"><div className="wiki-step-num">5</div><div className="wiki-step-text"><strong>Deploy:</strong> <code>dmcr deploy</code> → change applied, verified, logged with git commit hash</div></div>
            <div className="wiki-step"><div className="wiki-step-num">6</div><div className="wiki-step-text"><strong>Tag release:</strong> <code>dmcr tag create v2.1 "Added email column"</code></div></div>
            <div className="wiki-step"><div className="wiki-step-num">7</div><div className="wiki-step-text"><strong>Oh no, bug!</strong> <code>dmcr revertLast</code> → email column removed, database back to previous state</div></div>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════════
             SCRIPT INTERNALS — dmcr.ps1 Functions & Methods
             ═══════════════════════════════════════════════════════════════════ */}

        <section id="wiki-ps1-overview" className="wiki-card">
          <h2>📜 dmcr.ps1 — Script Overview</h2>
          <p>The <code>dmcr.ps1</code> file (~3,100 lines) is the <strong>heart of the DMCR system</strong>. It's a single PowerShell script that handles everything: reading your config, talking to PostgreSQL, applying changes, reverting them, validating safety, managing locks, and displaying pretty tables in your terminal.</p>
          <div className="wiki-callout wiki-callout-info">
            <strong>Think of it like this:</strong> <code>dmcr.ps1</code> is the engine under the hood. The VS Code extension is the dashboard — but the engine is what actually moves your database changes from point A to point B safely.
          </div>
          <p>The script is organized into logical groups of functions. Each group has a single responsibility:</p>
          <div className="wiki-table">
            <div className="wiki-row"><span>Logging &amp; Colors</span><span>Pretty terminal output with ANSI colors</span></div>
            <div className="wiki-row"><span>Config &amp; INI</span><span>Read your <code>dmcr.ini</code> settings file</span></div>
            <div className="wiki-row"><span>psql Helpers</span><span>Run SQL queries safely through PostgreSQL's <code>psql</code></span></div>
            <div className="wiki-row"><span>Danger Gate</span><span>Block destructive SQL from running accidentally</span></div>
            <div className="wiki-row"><span>Locking</span><span>Prevent two people deploying at the same time</span></div>
            <div className="wiki-row"><span>Deploy Engine</span><span>Apply pending changes to your database</span></div>
            <div className="wiki-row"><span>Revert Engine</span><span>Undo changes and roll back safely</span></div>
            <div className="wiki-row"><span>Dependency Planner</span><span>Figure out the correct order using <code>meta.json</code></span></div>
            <div className="wiki-row"><span>Display</span><span>Render bordered tables with Unicode support</span></div>
          </div>
        </section>

        <section id="wiki-ps1-startup" className="wiki-card">
          <h2>🚀 Startup &amp; Cleanup</h2>
          <p>When <code>dmcr.ps1</code> loads, it does some housekeeping before any command runs.</p>

          <details open>
            <summary>ANSI Colour Support</summary>
            <div className="wiki-section-copy">
              <p>The script checks if your terminal supports colours. If it does, it uses special escape codes (like <code>\x1b[32m</code> for green) to make output readable. If not, it falls back to PowerShell's built-in <code>Write-Host</code> with <code>-ForegroundColor</code>.</p>
              <div className="wiki-table">
                <div className="wiki-row"><span><code>$UseAnsi</code></span><span>Boolean — <code>true</code> if terminal supports ANSI escape sequences</span></div>
                <div className="wiki-row"><span><code>$ESC</code></span><span>The escape character (<code>[char]27</code>) used to start colour codes</span></div>
                <div className="wiki-row"><span><code>$AnsiMap</code></span><span>Hashtable mapping colour names → ANSI codes (e.g. Green → <code>\x1b[32m</code>)</span></div>
              </div>
            </div>
          </details>

          <details>
            <summary>Log-* Functions (Logging)</summary>
            <div className="wiki-section-copy">
              <p>Every message you see in the terminal comes from one of these functions. They prefix your message with a coloured label so you can instantly tell what's happening:</p>
              <div className="wiki-table">
                <div className="wiki-row"><span><code>Log-Info</code></span><span>General information (blue "INFO")</span></div>
                <div className="wiki-row"><span><code>Log-Init</code></span><span>Initialization steps (cyan "INIT")</span></div>
                <div className="wiki-row"><span><code>Log-Apply</code></span><span>Applying a change (green "APPLY")</span></div>
                <div className="wiki-row"><span><code>Log-Verify</code></span><span>Running verification (cyan "VERIFY")</span></div>
                <div className="wiki-row"><span><code>Log-Revert</code></span><span>Reverting a change (yellow "REVERT")</span></div>
                <div className="wiki-row"><span><code>Log-Skip</code></span><span>Skipping already-applied change (gray "SKIP")</span></div>
                <div className="wiki-row"><span><code>Log-Done</code></span><span>Success (green "DONE")</span></div>
                <div className="wiki-row"><span><code>Log-Warn</code></span><span>Warning (yellow "WARN")</span></div>
                <div className="wiki-row"><span><code>Log-Error</code></span><span>Error (red "ERROR")</span></div>
                <div className="wiki-row"><span><code>Log-Debug</code></span><span>Only shown with <code>--debug</code> flag (magenta "DEBUG")</span></div>
              </div>
              <pre className="wiki-pre">{`# Internal example — what Log-Apply does:
function Log-Apply($msg) {
    Write-Color "APPLY" "Green" $msg
}
# Output: APPLY   003_add_roles`}</pre>
            </div>
          </details>

          <details>
            <summary>Cleanup-OrphanedTempFiles</summary>
            <div className="wiki-section-copy">
              <p>When DMCR runs, it creates temporary <code>.lock</code> files to prevent conflicts. If the script crashes or your terminal closes unexpectedly, these files can get left behind. This function runs at startup and deletes any stale lock/temp files that are older than a few minutes.</p>
              <pre className="wiki-pre">{`# What it does (simplified):
# 1. Look for *.lock and *.tmp files in the changes directory
# 2. If any are older than 5 minutes → delete them
# 3. Log how many were cleaned up`}</pre>
              <div className="wiki-callout wiki-callout-ok">
                <strong>Why it matters:</strong> Without this, a crash could leave a lock file that permanently blocks future deployments. The cleanup runs silently every time — you'll never notice unless <code>--debug</code> is on.
              </div>
            </div>
          </details>

          <details>
            <summary>Redact-Conn &amp; Format-Args</summary>
            <div className="wiki-section-copy">
              <p><code>Redact-Conn</code> takes a PostgreSQL connection string and hides the password for safe logging. <code>Format-Args</code> turns command-line arguments into a readable string for debug output.</p>
              <pre className="wiki-pre">{`# Redact-Conn example:
Input:  "host=db.example.com user=admin password=s3cr3t dbname=prod"
Output: "host=db.example.com user=admin password=****** dbname=prod"

# Format-Args example:
Input:  @("deploy", "--dry-run", "-c", "prod.ini")
Output: "deploy --dry-run -c prod.ini"`}</pre>
            </div>
          </details>
        </section>

        <section id="wiki-ps1-entrypoint" className="wiki-card">
          <h2>🎯 Entrypoint &amp; Command Routing</h2>
          <p>The <code>dmcr</code> function is the main entry point — it's what gets called when you type <code>dmcr deploy</code> or <code>dmcr status</code>. Think of it as a receptionist that reads your request and sends you to the right department.</p>

          <details open>
            <summary>How routing works</summary>
            <div className="wiki-section-copy">
              <p>The function parses your arguments first (flags like <code>--debug</code>, <code>--dry-run</code>, <code>--json</code>, <code>--to</code>, <code>-c</code>) and then uses a <code>switch</code> statement on the first non-flag argument (the command name) to call the right internal function.</p>
              <pre className="wiki-pre">{`# Simplified flow:
dmcr deploy --dry-run -c prod.ini

1. Parse flags → $DryRun=$true, $ConfigPath="prod.ini"
2. First remaining arg → "deploy"
3. switch("deploy") → calls Deploy-Changes($cfg, $DryRun)

# Available commands:
help, init, parse, status, deploy, verify,
history, info, plan, check, baseline, repair,
revertLast, revert, tag, repeatable, show config`}</pre>
              <div className="wiki-callout wiki-callout-info">
                <strong>Tip:</strong> The <code>--debug</code> flag sets a script-level <code>$DebugMode</code> variable. When active, every psql command, its arguments, and timing info are logged — extremely useful for troubleshooting.
              </div>
            </div>
          </details>
        </section>

        <section id="wiki-ps1-config" className="wiki-card">
          <h2>⚙️ Config &amp; INI Parser</h2>
          <p>DMCR uses a simple <code>.ini</code> file for configuration (like <code>dmcr.ini</code> or <code>prod.ini</code>). The config system reads this file and builds an object that every other function uses.</p>

          <details open>
            <summary>Read-Ini — The INI Parser</summary>
            <div className="wiki-section-copy">
              <p>Reads a plain-text INI file and converts it into a nested hashtable. Supports sections (<code>[section]</code>), key-value pairs (<code>key=value</code>), and comments (<code># comment</code>).</p>
              <pre className="wiki-pre">{`# Example INI file:
[dmcr]
environment = dev
connection  = host=localhost dbname=myapp
changes_dir = ./changes
psql_path   = psql

[placeholders]
schema = app
owner  = appuser

# Read-Ini returns:
@{
  dmcr = @{ environment="dev"; connection="host=localhost dbname=myapp"; ... }
  placeholders = @{ schema="app"; owner="appuser" }
}`}</pre>
            </div>
          </details>

          <details>
            <summary>Get-Cfg — Build Config Object</summary>
            <div className="wiki-section-copy">
              <p>Takes the raw INI data and creates a clean config object with validated fields. It also applies defaults and resolves environment variable overrides.</p>
              <div className="wiki-table">
                <div className="wiki-row"><span><code>EnvName</code></span><span>Environment name ("dev", "staging", "prod")</span></div>
                <div className="wiki-row"><span><code>Conn</code></span><span>PostgreSQL connection string</span></div>
                <div className="wiki-row"><span><code>ChangesDir</code></span><span>Path to the folder containing your numbered changes</span></div>
                <div className="wiki-row"><span><code>PsqlPath</code></span><span>Path to <code>psql</code> binary (defaults to just "psql")</span></div>
                <div className="wiki-row"><span><code>LockTimeout</code></span><span>How long to wait for a database lock (default: 30s)</span></div>
                <div className="wiki-row"><span><code>StmtTimeout</code></span><span>Max time any single SQL statement can run (default: 120s)</span></div>
                <div className="wiki-row"><span><code>ChecksumPolicy</code></span><span>"warn" or "error" — what to do if a file changed after deploy</span></div>
                <div className="wiki-row"><span><code>Placeholders</code></span><span>Key-value map for <code>${'${name}'}</code> substitution in SQL</span></div>
              </div>
            </div>
          </details>

          <details>
            <summary>Build-Placeholders</summary>
            <div className="wiki-section-copy">
              <p>Merges placeholders from two sources: the <code>[placeholders]</code> section in your INI file, and any environment variables prefixed with <code>DMCR_PLACEHOLDER_</code>. Environment variables win (override INI values).</p>
              <pre className="wiki-pre">{`# INI file has:
[placeholders]
schema = app

# Environment has:
DMCR_PLACEHOLDER_SCHEMA=public

# Result: schema → "public" (env wins)

# Used in SQL like:
# CREATE TABLE \${schema}.users (...)`}</pre>
            </div>
          </details>
        </section>

        <section id="wiki-ps1-psql" className="wiki-card">
          <h2>🔧 psql Helpers</h2>
          <p>These functions are the "glue" between DMCR and PostgreSQL. They all work by calling <code>psql</code> (the official PostgreSQL command-line client) with the right arguments.</p>

          <details open>
            <summary>Invoke-DmcrPsql — The Raw Executor</summary>
            <div className="wiki-section-copy">
              <p>The lowest-level function. Every other psql helper calls this. It builds the <code>psql</code> command with proper timeouts, runs it, captures output and exit code, and logs everything in debug mode.</p>
              <pre className="wiki-pre">{`# What happens internally:
# 1. Set lock_timeout and statement_timeout
# 2. Run: psql "connection_string" -c "your SQL here"
# 3. Capture stdout + stderr
# 4. Return @{ ExitCode=0; Output="..."; Error="..." }`}</pre>
            </div>
          </details>

          <details>
            <summary>Escape-SqlLiteral</summary>
            <div className="wiki-section-copy">
              <p>Doubles any single quotes in a string so it's safe to embed in SQL. This prevents SQL injection.</p>
              <pre className="wiki-pre">{`# Example:
Input:  "O'Brien's table"
Output: "O''Brien''s table"

# Used when inserting values into SQL:
# INSERT INTO dmcr.change_log (change_id) VALUES ('O''Brien''s table')`}</pre>
            </div>
          </details>

          <details>
            <summary>Get-FileChecksum</summary>
            <div className="wiki-section-copy">
              <p>Computes a SHA-256 hash of a file's contents. This "fingerprint" is stored in the registry so DMCR can detect if someone modified a file after it was already deployed.</p>
              <pre className="wiki-pre">{`# Example:
Get-FileChecksum "changes/001_create_users/deploy.sql"
# Returns: "a7f3b2c1d4e5f6..."  (64 hex characters)

# If you change even one space in the file, the checksum changes completely`}</pre>
            </div>
          </details>

          <details>
            <summary>Exec-PsqlScalar &amp; Exec-PsqlScalarSafe</summary>
            <div className="wiki-section-copy">
              <p><code>Exec-PsqlScalar</code> runs SQL and returns a single value (like counting rows or checking if something exists). <code>Exec-PsqlScalarSafe</code> does the same but uses <strong>parameterized queries</strong> (psql <code>:'var'</code> syntax) so user input can't break the SQL.</p>
              <pre className="wiki-pre">{`# Exec-PsqlScalar example:
$count = Exec-PsqlScalar $cfg "SELECT count(*) FROM dmcr.change_log"
# Returns: "5"

# Exec-PsqlScalarSafe — safe with untrusted values:
$exists = Exec-PsqlScalarSafe $cfg "SELECT 1 FROM dmcr.change_log WHERE change_id = :'id'" @{id="001_create_users"}
# The value is properly escaped by psql itself — no injection possible`}</pre>
            </div>
          </details>

          <details>
            <summary>Exec-PsqlFileTx &amp; Exec-PsqlFileTx-Rollback</summary>
            <div className="wiki-section-copy">
              <p><strong>Exec-PsqlFileTx</strong> runs a <code>.sql</code> file inside a transaction (<code>BEGIN</code> … <code>COMMIT</code>). If anything fails, the whole thing rolls back — your database is never left in a half-done state.</p>
              <p><strong>Exec-PsqlFileTx-Rollback</strong> is the "read-only" version — it always rolls back. Used by <code>verify</code> and <code>parse</code> to test SQL without making permanent changes.</p>
              <pre className="wiki-pre">{`# Exec-PsqlFileTx (used during deploy):
BEGIN;
  \\i 'changes/003_add_roles/deploy.sql'
  INSERT INTO dmcr.change_log (...) VALUES (...);
COMMIT;
# → If deploy.sql fails, nothing is committed

# Exec-PsqlFileTx-Rollback (used during verify):
BEGIN;
  \\i 'changes/003_add_roles/verify.sql'
ROLLBACK;
# → verify.sql runs, but no changes persist`}</pre>
            </div>
          </details>

          <details>
            <summary>Invoke-DmcrParseSql</summary>
            <div className="wiki-section-copy">
              <p>Validates SQL syntax by running it in a rolled-back transaction. Returns a simple object: <code>ok</code> (boolean) and <code>msg</code> (error message with line/column if it failed).</p>
              <pre className="wiki-pre">{`# Success:
Invoke-DmcrParseSql $cfg "SELECT 1"
# → @{ ok=$true; msg="Parsed OK." }

# Failure:
Invoke-DmcrParseSql $cfg "SELEC 1"
# → @{ ok=$false; msg="ERROR: syntax error at \"SELEC\""; line=1 }`}</pre>
            </div>
          </details>
        </section>

        <section id="wiki-ps1-danger" className="wiki-card">
          <h2>🚨 Danger Gate — SQL Safety Scanner</h2>
          <p>Before any SQL runs, DMCR checks it for potentially dangerous operations. This is like a security guard that stops you from accidentally running <code>DROP TABLE</code> in production.</p>

          <details open>
            <summary>How it works</summary>
            <div className="wiki-section-copy">
              <p>There are two sets of patterns (regex rules):</p>
              <div className="wiki-table">
                <div className="wiki-row"><span><strong>Deploy-Only Patterns</strong></span><span>Dangerous but allowed in <code>deploy/</code> folders — blocked everywhere else</span></div>
                <div className="wiki-row"><span><strong>Always Patterns</strong></span><span>Dangerous everywhere — requires the change folder to be named <code>DANGER_*</code></span></div>
              </div>
              <pre className="wiki-pre">{`# Deploy-Only examples (blocked in verify/revert):
DROP TABLE, DROP INDEX, ALTER TABLE ... DROP COLUMN

# Always-dangerous examples (need DANGER_ prefix):
DROP SCHEMA, DROP DATABASE, TRUNCATE
DELETE ... (without WHERE), UPDATE ... (without WHERE)`}</pre>
            </div>
          </details>

          <details>
            <summary>Key Functions</summary>
            <div className="wiki-section-copy">
              <div className="wiki-table">
                <div className="wiki-row"><span><code>Strip-SqlComments</code></span><span>Removes <code>--</code> and <code>/* */</code> comments so they don't trigger false alarms</span></div>
                <div className="wiki-row"><span><code>Get-DangerousOps</code></span><span>Scans SQL text against all patterns, returns list of matches</span></div>
                <div className="wiki-row"><span><code>Assert-SafeChange</code></span><span>The actual gate — throws an error if dangerous SQL is found in the wrong place</span></div>
                <div className="wiki-row"><span><code>Load-DangerRulesFromJson</code></span><span>Loads custom rules from <code>dmcr_danger.json</code> alongside the built-in ones</span></div>
              </div>
              <pre className="wiki-pre">{`# Example — what happens if you put DROP TABLE in a normal folder:
ERROR   Dangerous operation detected in 003_add_roles/deploy.sql
ERROR     >> DROP TABLE (matched: "DROP TABLE app.old_users")
ERROR   Move to a DANGER_ prefixed folder or remove the statement.
ERROR   Deployment aborted.

# Fix: rename folder to DANGER_003_add_roles → gate passes`}</pre>
            </div>
          </details>

          <details>
            <summary>dmcr_danger.json — Custom Rules</summary>
            <div className="wiki-section-copy">
              <p>You can add your own patterns to <code>scripts/runner/dmcr_danger.json</code>. The file has two arrays:</p>
              <pre className="wiki-pre">{`{
  "deployOnlyPatterns": [
    "DROP\\\\s+TABLE",
    "DROP\\\\s+INDEX",
    "ALTER\\\\s+TABLE\\\\s+.*DROP\\\\s+COLUMN"
  ],
  "alwaysPatterns": [
    "DROP\\\\s+SCHEMA",
    "DROP\\\\s+DATABASE",
    "TRUNCATE",
    "DELETE\\\\s+FROM\\\\s+(?!.*WHERE)",
    "UPDATE\\\\s+\\\\S+\\\\s+SET\\\\s+(?!.*WHERE)"
  ]
}`}</pre>
              <div className="wiki-callout wiki-callout-warn">
                <strong>Note:</strong> Patterns are case-insensitive regex. Comments in SQL are stripped before matching, so <code>-- DROP TABLE</code> in a comment won't trigger it.
              </div>
            </div>
          </details>
        </section>

        <section id="wiki-ps1-locking" className="wiki-card">
          <h2>🔒 Advisory Locking</h2>
          <p>When DMCR deploys changes, it uses a <strong>double-lock</strong> system to make sure two people (or two CI pipelines) can't deploy at the same time.</p>

          <details open>
            <summary>Acquire-AdvisoryLock</summary>
            <div className="wiki-section-copy">
              <p>This function grabs two locks:</p>
              <div className="wiki-steps">
                <div className="wiki-step"><div className="wiki-step-num">1</div><div className="wiki-step-text"><strong>File lock:</strong> Creates a <code>.dmcr.lock</code> file in your changes directory. If it already exists, another process is deploying.</div></div>
                <div className="wiki-step"><div className="wiki-step-num">2</div><div className="wiki-step-text"><strong>PostgreSQL advisory lock:</strong> Calls <code>pg_advisory_lock(0xDEADBEEF)</code> — a database-level lock that blocks other connections using the same key.</div></div>
              </div>
              <pre className="wiki-pre">{`# Why two locks?
# File lock  → prevents conflicts on the SAME machine
# DB lock    → prevents conflicts across DIFFERENT machines
#               (e.g. two CI servers hitting the same database)

# The magic number 0xDEADBEEF (3735928559) is just a unique ID
# so DMCR locks don't collide with your application's locks`}</pre>
            </div>
          </details>

          <details>
            <summary>Release-AdvisoryLock</summary>
            <div className="wiki-section-copy">
              <p>Releases both locks in reverse order (DB lock first, then file lock). Always runs, even if deployment fails — so you never get permanently locked out.</p>
              <pre className="wiki-pre">{`# Called in a try/finally block:
try {
    Acquire-AdvisoryLock $cfg
    # ... do deployment ...
} finally {
    Release-AdvisoryLock $cfg   # ← always runs
}`}</pre>
            </div>
          </details>
        </section>

        <section id="wiki-ps1-deploy" className="wiki-card">
          <h2>📦 Deploy Engine</h2>
          <p>The deploy engine is the core workflow that applies pending changes to your database. Here's what happens under the hood.</p>

          <details open>
            <summary>Get-ChangeFolders</summary>
            <div className="wiki-section-copy">
              <p>Lists all folders in your changes directory that start with a 3-digit number prefix (like <code>001_</code>, <code>002_</code>). Returns them sorted numerically.</p>
              <pre className="wiki-pre">{`# Your changes/ directory:
001_create_users/
002_add_index/
003_add_roles/
DANGER_004_drop_old_tables/
R__views/            ← ignored (repeatable, not numbered)
README.md            ← ignored (not a folder)

# Get-ChangeFolders returns:
@("001_create_users", "002_add_index", "003_add_roles", "DANGER_004_drop_old_tables")`}</pre>
            </div>
          </details>

          <details>
            <summary>Is-Applied &amp; Last-Applied</summary>
            <div className="wiki-section-copy">
              <p><code>Is-Applied</code> checks if a specific change is already in the registry (already deployed). <code>Last-Applied</code> returns the most recently deployed change ID.</p>
              <pre className="wiki-pre">{`# Is-Applied:
Is-Applied $cfg "001_create_users"  → $true
Is-Applied $cfg "003_add_roles"     → $false (pending)

# Last-Applied:
Last-Applied $cfg  → "002_add_index"`}</pre>
            </div>
          </details>

          <details>
            <summary>Deploy Flow (step by step)</summary>
            <div className="wiki-section-copy">
              <div className="wiki-steps">
                <div className="wiki-step"><div className="wiki-step-num">1</div><div className="wiki-step-text"><strong>Preflight:</strong> Validate all change folders (files exist, no duplicates, no gaps)</div></div>
                <div className="wiki-step"><div className="wiki-step-num">2</div><div className="wiki-step-text"><strong>Acquire lock:</strong> File lock + advisory lock so no one else can deploy</div></div>
                <div className="wiki-step"><div className="wiki-step-num">3</div><div className="wiki-step-text"><strong>Loop over pending changes:</strong> For each one not yet applied...</div></div>
                <div className="wiki-step"><div className="wiki-step-num">4</div><div className="wiki-step-text"><strong>Safety check:</strong> Run danger gate on <code>deploy.sql</code></div></div>
                <div className="wiki-step"><div className="wiki-step-num">5</div><div className="wiki-step-text"><strong>Resolve placeholders:</strong> Replace <code>${'${schema}'}</code> tokens in SQL</div></div>
                <div className="wiki-step"><div className="wiki-step-num">6</div><div className="wiki-step-text"><strong>Execute in transaction:</strong> <code>BEGIN → deploy.sql → INSERT registry row → COMMIT</code></div></div>
                <div className="wiki-step"><div className="wiki-step-num">7</div><div className="wiki-step-text"><strong>Verify:</strong> Run <code>verify.sql</code> in a rollback transaction</div></div>
                <div className="wiki-step"><div className="wiki-step-num">8</div><div className="wiki-step-text"><strong>Log event:</strong> Record in <code>dmcr.event_log</code> (audit trail)</div></div>
              </div>
              <div className="wiki-callout wiki-callout-ok">
                <strong>Atomic guarantee:</strong> Steps 6 is one PostgreSQL transaction. If <code>deploy.sql</code> succeeds but the registry INSERT fails, everything rolls back. Your database is NEVER in a "half-applied" state.
              </div>
            </div>
          </details>

          <details>
            <summary>Require-Registry</summary>
            <div className="wiki-section-copy">
              <p>Before any deploy, this function checks that the <code>dmcr.change_log</code> table exists. If it doesn't (first time running DMCR), it creates the schema and tables automatically. It also handles upgrades — e.g., adding columns that were introduced in newer versions (v1.1.0 added <code>event_log</code> and <code>tags</code>).</p>
            </div>
          </details>
        </section>

        <section id="wiki-ps1-revert" className="wiki-card">
          <h2>↩️ Revert Engine</h2>
          <p>Reverting undoes a deployed change by running its <code>revert.sql</code> and removing the registry entry. DMCR is extra careful here because reverting is destructive.</p>

          <details open>
            <summary>Revert-Change</summary>
            <div className="wiki-section-copy">
              <p>Reverts a single change. Built-in safety checks:</p>
              <div className="wiki-steps">
                <div className="wiki-step"><div className="wiki-step-num">1</div><div className="wiki-step-text"><strong>Checksum guard:</strong> Verifies the <code>revert.sql</code> file hasn't been modified since deploy (if checksumPolicy is "error", it blocks)</div></div>
                <div className="wiki-step"><div className="wiki-step-num">2</div><div className="wiki-step-text"><strong>Danger gate:</strong> Scans <code>revert.sql</code> for destructive operations</div></div>
                <div className="wiki-step"><div className="wiki-step-num">3</div><div className="wiki-step-text"><strong>Execute:</strong> Runs <code>revert.sql</code> in a transaction + removes the registry row</div></div>
                <div className="wiki-step"><div className="wiki-step-num">4</div><div className="wiki-step-text"><strong>Verify (optional):</strong> Re-runs <code>verify.sql</code> to confirm the revert worked (should fail = change is gone)</div></div>
                <div className="wiki-step"><div className="wiki-step-num">5</div><div className="wiki-step-text"><strong>Log event:</strong> Records "REVERT" in event_log with actor, timestamp, git commit</div></div>
              </div>
            </div>
          </details>

          <details>
            <summary>Revert-To</summary>
            <div className="wiki-section-copy">
              <p>Reverts multiple changes in reverse order until reaching a target. Like peeling layers off an onion — it always goes from the most recent change backwards.</p>
              <pre className="wiki-pre">{`# Current state: 001, 002, 003 applied
# Command: dmcr revert to 001_create_users

# Revert-To will:
# 1. Revert 003_add_roles     (most recent first)
# 2. Revert 002_add_index     (keep going)
# 3. Stop — 001 is the target, don't revert it

# Also supports tags:
# dmcr revert to @v1.0 → resolves tag to a change_id first`}</pre>
            </div>
          </details>

          <details>
            <summary>Metadata Helpers</summary>
            <div className="wiki-section-copy">
              <div className="wiki-table">
                <div className="wiki-row"><span><code>Get-DmcrActor</code></span><span>Returns who is running the command. Checks <code>DMCR_ACTOR</code> env var, falls back to <code>username@machine</code></span></div>
                <div className="wiki-row"><span><code>Get-GitCommit</code></span><span>Gets the short git SHA from the changes directory — stored in registry for traceability</span></div>
                <div className="wiki-row"><span><code>Read-MetaJson</code></span><span>Reads optional <code>meta.json</code> from a change folder (contains ticket, description, requires)</span></div>
              </div>
            </div>
          </details>
        </section>

        <section id="wiki-ps1-planner" className="wiki-card">
          <h2>🧩 Dependency Planner</h2>
          <p>Sometimes changes depend on each other. For example, you can't create an index on a table that doesn't exist yet. The dependency planner figures out the correct order automatically.</p>

          <details open>
            <summary>Build-DependencyPlan — Topological Sort</summary>
            <div className="wiki-section-copy">
              <p>Uses <strong>Kahn's algorithm</strong> (a well-known computer science technique) to sort changes based on their <code>meta.json → requires</code> field. Think of it as "figure out what needs to happen first."</p>
              <pre className="wiki-pre">{`# meta.json in 003_add_roles/:
{ "requires": ["001_create_users"] }

# meta.json in 004_role_assignments/:
{ "requires": ["001_create_users", "003_add_roles"] }

# Build-DependencyPlan figures out:
# 001 → 002 → 003 → 004  (respects all "requires" constraints)

# If there's a circular dependency (A requires B, B requires A):
# ERROR  Dependency graph: Cycle detected`}</pre>
              <div className="wiki-callout wiki-callout-info">
                <strong>How Kahn's algorithm works (simplified):</strong><br/>
                1. Find all changes with zero dependencies → deploy those first<br/>
                2. Remove them from the graph<br/>
                3. Repeat until all changes are placed<br/>
                4. If anything is left → it's a cycle (error!)
              </div>
            </div>
          </details>

          <details>
            <summary>Preflight Checks</summary>
            <div className="wiki-section-copy">
              <p><code>Invoke-EnhancedPreflight</code> runs 5 validation checks before any deploy:</p>
              <div className="wiki-table">
                <div className="wiki-row"><span><strong>Missing files</strong></span><span>Every change folder must have <code>deploy.sql</code>, <code>verify.sql</code>, <code>revert.sql</code></span></div>
                <div className="wiki-row"><span><strong>Duplicate prefixes</strong></span><span>Two folders can't start with the same number (e.g. two <code>003_</code> folders)</span></div>
                <div className="wiki-row"><span><strong>Malformed names</strong></span><span>Folder names must match the pattern <code>NNN_description</code></span></div>
                <div className="wiki-row"><span><strong>Prefix gaps</strong></span><span>Warning if you jump from 001 to 005 (missing 002/003/004)</span></div>
                <div className="wiki-row"><span><strong>Dependency errors</strong></span><span>Cycles or references to non-existent changes</span></div>
              </div>
            </div>
          </details>

          <details>
            <summary>Repeatable Migrations</summary>
            <div className="wiki-section-copy">
              <p>Folders prefixed with <code>R__</code> are "repeatable" — they run every time their content changes (based on checksum comparison).</p>
              <div className="wiki-table">
                <div className="wiki-row"><span><code>Get-RepeatableFolders</code></span><span>Lists all <code>R__*</code> prefixed folders</span></div>
                <div className="wiki-row"><span><code>Test-RepeatableNeedsRun</code></span><span>Compares current file checksum vs. stored checksum — if different, it needs re-running</span></div>
              </div>
              <pre className="wiki-pre">{`# Typical use: database views or functions that you redefine
R__views/deploy.sql:
  CREATE OR REPLACE VIEW app.active_users AS
  SELECT * FROM app.users WHERE deleted_at IS NULL;

# Every time you edit this file, DMCR re-applies it on next deploy`}</pre>
            </div>
          </details>

          <details>
            <summary>Resolve-Placeholders</summary>
            <div className="wiki-section-copy">
              <p>Scans SQL for <code>${'${name}'}</code> tokens and replaces them with values from config. If any placeholder is unresolved, deployment <strong>fails immediately</strong> (fail-fast) rather than running broken SQL.</p>
              <pre className="wiki-pre">{`# Input SQL:
CREATE TABLE \${schema}.users (id serial PRIMARY KEY);
GRANT SELECT ON \${schema}.users TO \${reader_role};

# Config placeholders: { schema: "app", reader_role: "readonly" }

# Output:
CREATE TABLE app.users (id serial PRIMARY KEY);
GRANT SELECT ON app.users TO readonly;

# If "reader_role" is missing from config:
# ERROR  Unresolved placeholder: \${reader_role}
# ERROR  Deployment aborted.`}</pre>
            </div>
          </details>
        </section>

        <section id="wiki-ps1-display" className="wiki-card">
          <h2>🎨 Display &amp; Table Rendering</h2>
          <p>DMCR outputs attractive bordered tables to the terminal. These functions handle Unicode width (for CJK characters), console buffer sizing, and drawing box characters.</p>

          <details open>
            <summary>BoxedColorTable &amp; BoxedColorTableWithTitle</summary>
            <div className="wiki-section-copy">
              <p>These render the bordered tables you see in <code>/status</code>, <code>/info</code>, and <code>/plan</code> output. They handle column alignment, padding, and colour per cell.</p>
              <pre className="wiki-pre">{`# BoxedColorTable takes:
#   - Headers: @("Status", "Change")
#   - Rows:    @(@("APPLIED ✅", "001_create_users"), ...)
#   - Colours: optional per-row colour

# Produces:
┌────────────┬──────────────────────────┐
│ Status     │ Change                   │
├────────────┼──────────────────────────┤
│ APPLIED ✅ │ 001_create_users         │
└────────────┴──────────────────────────┘`}</pre>
            </div>
          </details>

          <details>
            <summary>Unicode Width Helpers</summary>
            <div className="wiki-section-copy">
              <p>Characters like Chinese/Japanese/Korean glyphs and emojis take up 2 columns in a terminal. These functions measure "display width" correctly so tables align properly.</p>
              <div className="wiki-table">
                <div className="wiki-row"><span><code>Get-TextElements</code></span><span>Breaks a string into individual grapheme clusters (handles emojis like 👨‍👩‍👧)</span></div>
                <div className="wiki-row"><span><code>Test-DoubleWidth</code></span><span>Returns <code>true</code> if a character occupies 2 terminal columns</span></div>
                <div className="wiki-row"><span><code>Get-DisplayWidth</code></span><span>Returns the total terminal columns a string occupies</span></div>
              </div>
            </div>
          </details>

          <details>
            <summary>Write-Color &amp; Ensure-ConsoleBufferWidth</summary>
            <div className="wiki-section-copy">
              <p><code>Write-Color</code> is the universal output function — uses ANSI codes if available, falls back to <code>Write-Host</code>. <code>Ensure-ConsoleBufferWidth</code> widens the PowerShell console buffer if a table is wider than the current window (prevents line wrapping).</p>
              <pre className="wiki-pre">{`# Write-Color("DONE", "Green", "003_add_roles applied (42ms)")
# Output (with ANSI):  \\x1b[32mDONE\\x1b[0m    003_add_roles applied (42ms)
# Output (fallback):   DONE    003_add_roles applied (42ms)  [green text via Write-Host]`}</pre>
            </div>
          </details>
        </section>

        {/* ══════════ Getting Started ══════════ */}
        <section id="wiki-gs-setup" className="wiki-section">
          <h2 className="wiki-section-h">⚙️ Initial Setup</h2>
          <div className="wiki-section-copy">
            <p><strong>Step 1 — DMCR Config</strong>: Open <em>Settings → DMCR Config</em>. Set your <code>Changes directory</code> (e.g. <code>db/changes</code>), <code>DEV connection URL</code>, and optionally <code>PROD</code>. Passwords are stored securely in the OS keychain via VS Code SecretStorage. Click <em>Save &amp; Write Cfg</em>.</p>
            <p><strong>Step 2 — Initialize the registry</strong>: Run <code>dmcr init</code> from the Runner tab (or terminal). This creates the <code>dmcr_change_log</code> table in your database. Run once per environment.</p>
            <pre className="wiki-pre">{`[dmcr]
env = dev
changes_dir = ./db/changes
psql_path = auto
lock_timeout = 30s
statement_timeout = 5min

[dev]
conn = postgresql://user@localhost:5432/mydb

[prod]
conn = postgresql://user@prod-host:5432/mydb`}</pre>
          </div>
        </section>

        <section id="wiki-gs-first-change" className="wiki-section">
          <h2 className="wiki-section-h">🗂️ Your First Change</h2>
          <div className="wiki-section-copy">
            <p><strong>Option A — DMCR Copilot (recommended)</strong>: Open the <em>DMCR Copilot</em> tab. Type what you want: <em>"Add a nullable email varchar(320) column to public.users"</em>. DMCR generates the SQL, meta.json, verify.sql, and revert.sql automatically.</p>
            <p><strong>Option B — Schema Builder / Insert / Freeform</strong>: Use the structured forms in the Home tab for guided SQL generation.</p>
            <p><strong>Option C — Manual</strong>: Create a folder under your changes_dir (e.g. <code>001_add_email</code>) and add <code>deploy.sql</code>. Optional: <code>revert.sql</code>, <code>verify.sql</code>, <code>meta.json</code>.</p>
            <pre className="wiki-pre">{`-- meta.json
{
  "change_id": "001_add_email",
  "description": "Add email column to users",
  "requires": [],
  "tags": ["users"],
  "author": "your-name"
}`}</pre>
            <p>Then: <code>dmcr plan</code> to preview, <code>dmcr deploy</code> to apply.</p>
          </div>
        </section>

        <section id="wiki-gs-quickref" className="wiki-section">
          <h2 className="wiki-section-h">⚡ Quick Command Reference</h2>
          <div className="wiki-section-copy">
            <table className="wiki-cmd-table">
              <tbody>
                {[
                  ['dmcr init',             'Create the change-log registry table'],
                  ['dmcr status',           'Show applied / pending changes'],
                  ['dmcr plan',             'Preview what will deploy and in what order'],
                  ['dmcr deploy',           'Apply all pending changes'],
                  ['dmcr deploy --dry-run', 'Simulate deploy without touching the DB'],
                  ['dmcr history',          'Timestamped history of every applied change'],
                  ['dmcr verify',           'Detect drift via checksum comparison'],
                  ['dmcr check',            'Validate change file syntax and metadata'],
                  ['dmcr revertLast',       'Roll back the most recent change'],
                  ['dmcr revert to <id>',   'Revert everything after <id>'],
                  ['dmcr repair checksums', 'Re-record checksums after intentional edits'],
                  ['dmcr baseline <id>',    'Mark changes up to <id> as applied without running'],
                  ['dmcr tag <name> <id>',  'Tag a change for easy reference'],
                  ['dmcr info',             'Show aggregate DB statistics'],
                  ['dmcr show config',      'Display resolved configuration'],
                ].map(([cmd, desc]) => (
                  <tr key={cmd}><td><code>{cmd}</code></td><td style={{ color: 'var(--text-secondary, #94a3b8)', paddingLeft: 16 }}>{desc}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ══════════ New Features ══════════ */}
        <section id="wiki-conv-history" className="wiki-section">
          <h2 className="wiki-section-h">🕐 Conversation History Browser</h2>
          <div className="wiki-section-copy">
            <p>Every AI-generated change is stored in the SQLite <code>conversation_sql</code> table, grouped by conversation session.</p>
            <p><strong>Access</strong>: DMCR Copilot tab → clock icon (⏱) in the context bar.</p>
            <ul>
              <li><strong>List view</strong>: Shows all past sessions — first change name, number of changes, timestamp, conversation ID.</li>
              <li><strong>Detail view</strong>: Click "View" → shows each change entry with its deploy SQL preview.</li>
              <li><strong>Delete</strong>: Click "Delete" to remove all SQL entries for a session from the local database.</li>
            </ul>
            <p>The conversation history is stored locally only — it never leaves your machine.</p>
          </div>
        </section>

        <section id="wiki-agent-trace" className="wiki-section">
          <h2 className="wiki-section-h">🕵️ Agent Trace Panel</h2>
          <div className="wiki-section-copy">
            <p>The Agent Trace panel gives full visibility into the DMCR AI pipeline for every conversation.</p>
            <p><strong>Access</strong>: Settings → Developer Tools → Agent Trace.</p>
            <ul>
              <li>Conversations are grouped by session ID.</li>
              <li>Each conversation shows: step count, total duration, error badge if any step failed.</li>
              <li>Expand a conversation to see every pipeline stage: <code>DIALOGUE_INTENT</code>, <code>MASTER_AGENT</code>, <code>FORM_BUILDER</code>, <code>SQL_GENERATOR</code>, <code>RISK_ASSESSOR</code>, etc.</li>
              <li>Expand a stage → user prompt excerpt, AI response excerpt, duration, model used, error if any.</li>
            </ul>
            <p><em>Note</em>: <code>form-*</code>, <code>mcp-*</code>, <code>dmcr-gen-*</code>, and <code>git-autocommit-*</code> sessions are filtered out — only chat conversations appear.</p>
          </div>
        </section>

        <section id="wiki-schema-node-graph" className="wiki-section">
          <h2 className="wiki-section-h">🔀 Schema Node Graph</h2>
          <div className="wiki-section-copy">
            <p>After running an AI schema comparison, the <strong>Node Graph</strong> button appears in the Schema Diff report. It visualises all objects grouped by drift status:</p>
            <ul>
              <li><span style={{ color: '#ef4444' }}>●</span> <strong>Red</strong> — Missing from target</li>
              <li><span style={{ color: '#f97316' }}>●</span> <strong>Orange</strong> — Extra in target (not in source)</li>
              <li><span style={{ color: '#f59e0b' }}>●</span> <strong>Amber</strong> — Present in both but DDL has drifted</li>
              <li><span style={{ color: '#4ade80' }}>●</span> <strong>Green</strong> — In sync</li>
            </ul>
            <p>Click any node to see a side-by-side LCS line diff of the source vs. target DDL. Use the type filter buttons (all / table / view / function / sequence) to focus on a specific object type. Click "Hide graph" to return to the list view.</p>
          </div>
        </section>

        <section id="wiki-multi-env" className="wiki-section">
          <h2 className="wiki-section-h">🌐 Multi-Environment Configuration</h2>
          <div className="wiki-section-copy">
            <p>DMCR supports N environments beyond the default DEV and PROD. Useful for staging (<code>st</code>), UAT, integration, or canary environments.</p>
            <p><strong>To add an environment</strong>: Settings → DMCR Config → Database connections → <em>+ Add environment</em>. Enter a short name (e.g. <code>st</code>, <code>uat</code>) and the full connection URL including password.</p>
            <p>The resulting <code>dmcr.cfg</code> gets a <code>[envs]</code> section listing all environment names, and individual <code>[st]</code> / <code>[uat]</code> sections:</p>
            <pre className="wiki-pre">{`[envs]
names = dev, prod, st, uat

[st]
conn = postgresql://user:pass@st-host:5432/mydb_st

[uat]
conn = postgresql://user:pass@uat-host:5432/mydb_uat`}</pre>
            <p>Switch the active environment from the <em>Active environment</em> dropdown in DMCR Config. The Runner uses the active environment's connection for all commands.</p>
            <p>Custom environment passwords should be embedded in the connection URL (the keychain integration currently only stores DEV and PROD passwords separately).</p>
          </div>
        </section>

        <section id="wiki-runner-limit" className="wiki-section">
          <h2 className="wiki-section-h">⏱️ Recent Runs Limit</h2>
          <div className="wiki-section-copy">
            <p>The Runner tab shows a <em>recent runs</em> panel listing the last N commands and their outcomes (exit code, duration, timestamp).</p>
            <p><strong>Default limit</strong>: 50 runs. To change it: Settings → DMCR Config → <em>Recent runs limit</em> field. Set any value from 5 to 500, then click <em>Save &amp; Write Cfg</em>.</p>
            <p>The limit is stored in SQLite (<code>dmcr_config</code> table, <code>runHistoryLimit</code> field) and applied each time the recent runs panel is opened.</p>
          </div>
        </section>

        {/* ══════════ AI Power Features ══════════ */}
        <section id="wiki-ai-features-overview" className="wiki-section">
          <h2 className="wiki-section-h">🤖 AI Power Features — Sprint D18 Overview</h2>
          <div className="wiki-section-copy">
            <p>DMCR Sprint D18 adds 12 AI-powered features that have no equivalent in Flyway, Liquibase, or Sqitch. All features use the existing MCP + LLM pipeline — no additional API keys or services required beyond your configured LLM provider.</p>
            <table className="wiki-cmd-table">
              <thead><tr><th>ID</th><th>Feature</th><th>Status</th></tr></thead>
              <tbody>
                {[
                  ['D18.1', 'AI Change Explainer', '✓ Available'],
                  ['D18.2', 'AI Migration Risk Scorer', '✓ Available'],
                  ['D18.3', 'AI Schema Documenter', '✓ Available'],
                  ['D18.4', 'AI Rollback Advisor', '✓ Available'],
                  ['D18.5', 'AI Dependency Analyzer', '✓ Available'],
                  ['D18.6', 'AI Changelog Generator', '✓ Available'],
                  ['D18.7', 'AI Dead Column Detector', '✓ Available'],
                  ['D18.8', 'AI SQL Policy Guard', '✓ Available'],
                  ['D18.9', 'AI Semantic Versioning', '✓ Available'],
                  ['D18.10', 'AI Drift Detective (Scheduled)', '✓ Available'],
                  ['D18.11', 'AI Test Data Generator', '✓ Available (via Copilot)'],
                  ['D18.12', 'AI Performance Impact Predictor', '✓ Available'],
                ].map(([id, name, status]) => (
                  <tr key={id}><td style={{ color: '#818cf8' }}>{id}</td><td>{name}</td><td style={{ color: status.startsWith('✓') ? '#4ade80' : '#64748b' }}>{status}</td></tr>
                ))}
              </tbody>
            </table>
            <p>See <em>Settings → AI Features</em> for an interactive showcase of all 12 features with usage details.</p>
          </div>
        </section>

        <section id="wiki-ai-explainer" className="wiki-section">
          <h2 className="wiki-section-h">💬 D18.1 — AI Change Explainer</h2>
          <div className="wiki-section-copy">
            <p>Every command in the Runner recent-runs history has an <strong>✦ Explain</strong> button. Click it and DMCR:</p>
            <ol>
              <li>Reads the corresponding <code>deploy.sql</code> from your changes directory (if found).</li>
              <li>Sends the SQL + command context to your configured LLM.</li>
              <li>Returns a 3-4 bullet explanation: what the change does, tables affected, risk level, reversibility.</li>
            </ol>
            <p>The explanation renders inline below the run row — no modal, no navigation required. Click another run's Explain button to get a second explanation.</p>
            <p><em>Flyway equivalent</em>: none. Flyway and Liquibase apply migrations blindly — they have no AI explanation layer.</p>
          </div>
        </section>

        <section id="wiki-ai-semver" className="wiki-section">
          <h2 className="wiki-section-h">🏷️ D18.9 — AI Semantic Versioning</h2>
          <div className="wiki-section-copy">
            <p>Every change card generated by DMCR Copilot shows a coloured semantic version badge:</p>
            <ul>
              <li><span style={{ color: '#ef4444', fontWeight: 700 }}>MAJOR</span> — DROP TABLE, DROP COLUMN, RENAME COLUMN, DROP SCHEMA</li>
              <li><span style={{ color: '#f59e0b', fontWeight: 700 }}>MINOR</span> — CREATE TABLE, ADD COLUMN, CREATE VIEW, CREATE FUNCTION</li>
              <li><span style={{ color: '#4ade80', fontWeight: 700 }}>PATCH</span> — CREATE INDEX, ADD CONSTRAINT, INSERT/UPDATE seed data, SET DEFAULT</li>
            </ul>
            <p>Classification is instant — pure SQL pattern matching, no LLM round-trip needed. The badge appears next to the change name in the ChangeCard header.</p>
            <p><em>Why it matters</em>: teams can scan generated changes by impact level before saving. A MAJOR badge triggers extra review; a PATCH is safe to auto-approve in CI.</p>
          </div>
        </section>

        <section id="wiki-ai-risk" className="wiki-section">
          <h2 className="wiki-section-h">⚠️ D18.2 — AI Migration Risk Scorer</h2>
          <div className="wiki-section-copy">
            <p>Before deploying, DMCR will evaluate each pending change and assign a risk score with justification:</p>
            <ul>
              <li><span style={{ color: '#4ade80' }}>LOW</span> — index creation, constraint add, seed inserts with no existing row conflicts</li>
              <li><span style={{ color: '#f59e0b' }}>MEDIUM</span> — column addition to large tables, view replacement</li>
              <li><span style={{ color: '#f97316' }}>HIGH</span> — column type change, adding NOT NULL to existing table</li>
              <li><span style={{ color: '#ef4444' }}>CRITICAL</span> — DROP TABLE, DROP COLUMN, data-destructive UPDATE without WHERE</li>
            </ul>
            <p>Critical changes block deploy with an AI-generated explanation of why. HIGH changes require explicit confirmation. LOW/MEDIUM proceed normally.</p>
          </div>
        </section>

      </div>

      {/* ── Back to top FAB ── */}
      {showTop && <button className="wiki-back-to-top" onClick={scrollToTop} title="Back to top">↑ Top</button>}
    </div>
  );
}
