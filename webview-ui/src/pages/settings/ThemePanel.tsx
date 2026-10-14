import { useRef, useState } from 'react';
import {
  RadioCardView, ButtonView, IconButtonView, ModalView, SegmentedControlView, TextInputView, ColorPickerView, CheckboxView,
  CopyIcon, DownloadIcon, UploadIcon, EyeIcon, EyeOffIcon, TrashIcon, PlusIcon, CheckIcon, PaletteIcon, TerminalIcon, DuplicateIcon, SparkleIcon,
  TERMINAL_ANSI_KEYS, type TerminalPalette, type TerminalAnsi,
} from '@salilvnair/dui';
import type { AppTheme } from '../../types';
import { ThemeIcon } from './icons';
import { SEED_KEYS, SEED_META, deriveLightSeeds, type AppPalette, type AppSeeds } from '../../services/theme/palette';
import { IDENTITY_FAMILIES, type Family } from '../../services/theme/tokens';
import { parseThemeFile, serializeThemeFile, downloadText } from '../../services/theme/palette-file';
import { useThemeState, themeActions, allPalettes, allTerminals, paint, currentMode, terminalColours, DMCR_TERMINAL } from '../../services/theme/apply';
import { postMsg } from '../../vscode';

function PencilIcon({ size = 13 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
}

/** A small picture of a palette half: ground, a surface card with text lines, accent and status dots. */
function Swatch({ s, small }: { s: AppSeeds; small?: boolean }) {
  return (
    <span className={`theme-swatch${small ? ' theme-swatch--small' : ''}`} style={{ background: s.ground, borderColor: s.border }}>
      <span className="theme-swatch-card" style={{ background: s.surface, borderColor: s.border }}>
        <span style={{ background: s.text, width: '70%' }} />
        <span style={{ background: s.muted, width: '45%' }} />
        <span className="theme-swatch-dots">{[s.accent, s.success, s.warning, s.error, s.info].map((c, i) => <i key={i} style={{ background: c }} />)}</span>
      </span>
    </span>
  );
}

/** The 16 ANSI colours of a terminal theme half, on its own ground. */
function AnsiStrip({ a, ground }: { a: TerminalAnsi; ground: string }) {
  const keys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
  return (
    <span className="theme-ansi" style={{ background: ground }}>
      <span className="theme-ansi-text" style={{ color: a.foreground }}>$ dmcr deploy</span>
      <span className="theme-ansi-dots">{keys.map(k => <i key={k} style={{ background: a[k] }} />)}</span>
    </span>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme';
const uniqueId = (base: string, taken: string[]) => { let id = slug(base); let i = 2; while (taken.includes(id)) id = `${slug(base)}-${i++}`; return id; };

/** A palette half as a tiny app: top bar with the accent tab, a surface card with text, a field, a button and the status colours. */
function MiniApp({ s }: { s: AppSeeds }) {
  return (
    <span className="theme-mini" style={{ background: s.ground, borderColor: s.border }}>
      <span className="theme-mini-bar"><i style={{ background: s.accent }} /><i style={{ background: s.muted }} /><i style={{ background: s.muted }} /></span>
      <span className="theme-mini-card" style={{ background: s.surface, borderColor: s.border }}>
        <span className="theme-mini-line" style={{ background: s.text, width: '62%' }} />
        <span className="theme-mini-line" style={{ background: s.muted, width: '40%' }} />
        <span className="theme-mini-row">
          <span className="theme-mini-field" style={{ background: s.inputBg, borderColor: s.inputBorder }} />
          <span className="theme-mini-btn" style={{ background: s.accent }} />
        </span>
        <span className="theme-mini-dots">{[s.success, s.warning, s.error, s.info].map((c, i) => <i key={i} style={{ background: c }} />)}</span>
      </span>
    </span>
  );
}

const ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

/** A terminal theme half as a tiny terminal: a runner line and its 16 colours, on the ground the Runner uses. */
function MiniTerm({ c, ground }: { c: Record<string, string>; ground: string }) {
  return (
    <span className="theme-mini theme-mini--term" style={{ background: ground }}>
      <span className="theme-mini-prompt"><b style={{ color: c.brightGreen }}>{'✓'}</b> <span style={{ color: c.foreground }}>dmcr</span> <span style={{ color: c.cyan }}>deploy</span></span>
      <span className="theme-mini-ansi">{ANSI_KEYS.map(k => <i key={k} style={{ background: c[k] }} />)}</span>
    </span>
  );
}

/**
 * The Runner's own log lines (scripts/runner/dmcr.sh: log_info, log_apply, log_verify, log_done, log_skip,
 * log_warn, log_error; the same symbols, ANSI colours and messages), coloured by a terminal theme.
 */
type Seg = [string, string?];
const RUNNER_SAMPLE: Seg[][] = [
  [['$ ', 'brightBlue'], ['dmcr deploy --env test', 'foreground']],
  [['  '], ['›', 'cyan'], ['  Starting DMCR deploy']],
  [['  '], ['●', 'brightGreen'], ['  '], ['010_a_zap_score_v2', 'brightWhite']],
  [['  '], ['›', 'cyan'], ['  Executing deploy.sql + recording change (single transaction)']],
  [['  '], ['◌', 'brightMagenta'], ['  010_a_zap_score_v2 (inside the deploy transaction)']],
  [['  '], ['✓', 'brightGreen'], ['  '], ['010_a_zap_score_v2 applied successfully (0.4s)', 'brightGreen']],
  [['  '], ['○', 'brightBlack'], ['  '], ['R__zap_run_daily_counts — unchanged', 'brightBlack']],
  [['  '], ['▲', 'brightYellow'], ['  '], ["deploy.sql for '009_a_add_zap_score' has changed since applied (checksum mismatch). Proceeding.", 'brightYellow']],
  [['  '], ['✗', 'brightRed'], ['  '], ['deploy.sql or verify.sql failed for 011_b_insert_typed_zap_runs — the whole change was rolled back, nothing was applied', 'brightRed']],
];

export function ThemePanel({ theme = 'dark', effectiveDark = true, onThemeChange }: { theme?: AppTheme; effectiveDark?: boolean; onThemeChange?: (t: AppTheme) => void }) {
  const st = useThemeState();
  const mode = effectiveDark ? 'dark' : 'light';
  const [half, setHalf] = useState<'dark' | 'light'>(mode);
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState<{ palette: AppPalette; isNew: boolean } | null>(null);
  const [editingTerm, setEditingTerm] = useState<{ theme: TerminalPalette; isNew: boolean } | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // what the preview shows: the hovered palette / terminal theme, else the ones in use
  const [hoverPal, setHoverPal] = useState<AppPalette | null>(null);
  const [hoverTerm, setHoverTerm] = useState<TerminalPalette | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const palettes = allPalettes(st);
  const shown = palettes.filter(p => showHidden || !st.hidden.includes(p.id) || p.id === st.selected);
  const terminals = allTerminals(st).filter(t => showHidden || !st.terminalHidden.includes(t.id) || t.id === st.terminalSelected);
  const ids = palettes.map(p => p.id);
  const termIds = allTerminals(st).map(t => t.id);
  const palInUse = palettes.find(p => p.id === st.selected) ?? palettes[0];
  const termInUse = allTerminals(st).find(t => t.id === st.terminalSelected) ?? DMCR_TERMINAL;
  const prevPal = hoverPal ?? palInUse;
  const prevTerm = hoverTerm ?? termInUse;
  const term = terminalColours(prevTerm, prevPal, half);

  const flash = (ok: boolean, text: string) => { setNotice({ ok, text }); setTimeout(() => setNotice(null), 4000); };
  const exportFile = (app: AppPalette[], term: TerminalPalette[], name: string) => downloadText(`${slug(name)}.dmcr-theme.json`, serializeThemeFile(app, term), postMsg);
  const copyFile = (app: AppPalette[], term: TerminalPalette[]) => { void navigator.clipboard?.writeText(serializeThemeFile(app, term)); flash(true, 'Copied the theme file to the clipboard.'); };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const r = parseThemeFile(await f.text());
    if (!r.ok) { flash(false, r.error); return; }
    // ids already used by a built-in get a fresh id; same-id custom themes are replaced
    const builtApp = palettes.filter(p => p.builtIn).map(p => p.id);
    const app = r.app.map(p => (builtApp.includes(p.id) ? { ...p, id: uniqueId(p.label, ids) } : p));
    const builtTerm = allTerminals(st).filter(t => !st.terminalCustom.some(c => c.id === t.id)).map(t => t.id);
    const term = r.terminal.map(t => (builtTerm.includes(t.id) ? { ...t, id: uniqueId(t.label, termIds) } : t));
    if (app.length) themeActions.importApp(app);
    if (term.length) themeActions.importTerminal(term);
    flash(true, `Imported ${app.length} app palette${app.length === 1 ? '' : 's'} and ${term.length} terminal theme${term.length === 1 ? '' : 's'}.`);
  };

  const newFrom = (base: AppPalette) => setEditing({ isNew: true, palette: { ...base, id: uniqueId(`${base.label} copy`, ids), label: `${base.label} copy`, builtIn: undefined } });

  return (
    <div className="bs-settings-pane theme-pane">
      <div className="bs-settings-section-head">
        <ThemeIcon className="bs-ico-sm" style={{ color: 'var(--bs-accent-muted)' }} />
        <span>Theme</span>
      </div>
      <p className="theme-note">
        <strong>Mode</strong> picks dark or light. A <strong>palette</strong> recolours everything (text, backgrounds, fields, accent, status, every shade) from 13 colours per half; a <strong>terminal theme</strong> colours the Runner. Hover one to preview it, click to use it. Create, edit, import and export them; files are compatible with Daakia&rsquo;s.
      </p>

      <div className="theme-section-label">Mode</div>
      <RadioCardView size="md" columns={3} accentColor="var(--bs-accent)" value={theme} onChange={v => onThemeChange?.(v as AppTheme)}
        options={[
          { value: 'system', label: 'System', description: 'Follow your OS / VS Code preference', icon: <ThemeIcon className="bs-ico-sm" /> },
          { value: 'dark', label: 'Dark', description: 'Dark mode (default)' },
          { value: 'light', label: 'Light', description: 'Light mode' },
        ]} />

      {/* ── App palettes ── */}
      <div className="theme-head">
        <span className="theme-section-label"><PaletteIcon size={13} /> Palettes <span>{shown.length}</span></span>
        <span className="theme-head-actions">
          <SegmentedControlView size="md" variant="rounded" accentColor="var(--bs-accent)" value={half} onChange={v => setHalf(v as 'dark' | 'light')} options={[{ value: 'dark', label: 'Dark half' }, { value: 'light', label: 'Light half' }]} />
          <ButtonView variant="secondary" iconLeft={<PlusIcon size={13} />} label="New" onClick={() => newFrom(palInUse)} />
          <ButtonView variant="secondary" iconLeft={<UploadIcon size={13} />} label="Import" onClick={() => fileRef.current?.click()} />
          <ButtonView variant="secondary" iconLeft={<DownloadIcon size={13} />} label="Export all" disabled={!st.custom.length && !st.terminalCustom.length}
            title="Your own palettes and terminal themes, in one file" onClick={() => exportFile(st.custom, st.terminalCustom, 'dmcr-themes')} />
          <ButtonView variant="ghost" iconLeft={showHidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />} label={showHidden ? 'Hide hidden' : `Show hidden (${st.hidden.length + st.terminalHidden.length})`} onClick={() => setShowHidden(!showHidden)} />
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={e => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </span>
      </div>
      {notice && <div className={`theme-notice${notice.ok ? '' : ' is-bad'}`}>{notice.text}</div>}
      <div className="theme-grid">
        {shown.map(p => {
          const active = p.id === st.selected;
          const hidden = st.hidden.includes(p.id);
          const about = [p.builtIn ? 'built-in' : 'yours', p.lightDerived ? 'light half derived' : '', p.identity ? 'identity colours' : '', hidden ? 'hidden' : ''].filter(Boolean).join(' · ');
          return (
            <div key={p.id} className={`theme-card${active ? ' is-active' : ''}${hidden ? ' is-hidden' : ''}`} title={`${p.label} (${about})`}
              onClick={() => themeActions.select(p.id)}
              onMouseEnter={() => { setHoverPal(p); if (!active) paint(p); }} onMouseLeave={() => { setHoverPal(null); paint(); }}>
              <MiniApp s={half === 'dark' ? p.dark : p.light} />
              <span className="theme-card-foot">
                <span className="theme-card-name">{p.label}</span>
                {!p.builtIn && <span className="theme-card-own" title="Yours" />}
                {active && <span className="theme-card-check"><CheckIcon size={12} /></span>}
              </span>
              <span className="theme-card-actions" onClick={e => e.stopPropagation()}>
                {p.builtIn
                  ? <IconButtonView size="sm" variant="ghost" icon={<DuplicateIcon size={12} />} title="Duplicate to edit" onClick={() => newFrom(p)} />
                  : <IconButtonView size="sm" variant="ghost" icon={<PencilIcon size={12} />} title="Edit" onClick={() => setEditing({ isNew: false, palette: p })} />}
                <IconButtonView size="sm" variant="ghost" icon={<DownloadIcon size={12} />} title="Export this palette" onClick={() => exportFile([p], [], p.label)} />
                <IconButtonView size="sm" variant="ghost" icon={<CopyIcon size={12} />} title="Copy as a theme file" onClick={() => copyFile([p], [])} />
                {p.id !== 'dmcr' && <IconButtonView size="sm" variant="ghost" icon={hidden ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />} title={hidden ? 'Show in the list' : 'Hide from the list'} onClick={() => themeActions.setHidden(p.id, !hidden)} />}
                {!p.builtIn && <IconButtonView size="sm" variant="ghost" color="var(--bs-status-error)" icon={<TrashIcon size={12} />} title="Remove" onClick={() => themeActions.remove(p.id)} />}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Terminal themes ── */}
      <div className="theme-head" style={{ marginTop: 22 }}>
        <span className="theme-section-label"><TerminalIcon size={13} /> Terminal themes <span>{terminals.length} · the Runner output</span></span>
        <span className="theme-head-actions">
          <ButtonView variant="secondary" iconLeft={<PlusIcon size={13} />} label="New"
            onClick={() => setEditingTerm({ isNew: true, theme: { ...termInUse, id: uniqueId(`${termInUse.label} copy`, termIds), label: `${termInUse.label} copy` } })} />
          <ButtonView variant="secondary" iconLeft={<UploadIcon size={13} />} label="Import" onClick={() => fileRef.current?.click()} />
        </span>
      </div>
      <div className="theme-grid">
        {terminals.map(t => {
          const active = t.id === st.terminalSelected;
          const own = st.terminalCustom.some(c => c.id === t.id);
          const hidden = st.terminalHidden.includes(t.id);
          const tc = terminalColours(t, palInUse, half);
          return (
            <div key={t.id} className={`theme-card${active ? ' is-active' : ''}${hidden ? ' is-hidden' : ''}`} title={`${t.label} (${own ? 'yours' : 'built-in'}${t.lightDerived ? ' · light half derived' : ''})`}
              onClick={() => themeActions.selectTerminal(t.id)} onMouseEnter={() => setHoverTerm(t)} onMouseLeave={() => setHoverTerm(null)}>
              <MiniTerm c={tc.colours} ground={tc.ground} />
              <span className="theme-card-foot">
                <span className="theme-card-name">{t.label}</span>
                {own && <span className="theme-card-own" title="Yours" />}
                {active && <span className="theme-card-check"><CheckIcon size={12} /></span>}
              </span>
              <span className="theme-card-actions" onClick={e => e.stopPropagation()}>
                {own
                  ? <IconButtonView size="sm" variant="ghost" icon={<PencilIcon size={12} />} title="Edit" onClick={() => setEditingTerm({ isNew: false, theme: t })} />
                  : <IconButtonView size="sm" variant="ghost" icon={<DuplicateIcon size={12} />} title="Duplicate to edit" onClick={() => setEditingTerm({ isNew: true, theme: { ...t, id: uniqueId(`${t.label} copy`, termIds), label: `${t.label} copy` } })} />}
                <IconButtonView size="sm" variant="ghost" icon={<DownloadIcon size={12} />} title="Export this terminal theme" onClick={() => exportFile([], [t], `${t.label}-terminal`)} />
                <IconButtonView size="sm" variant="ghost" icon={<CopyIcon size={12} />} title="Copy as a theme file" onClick={() => copyFile([], [t])} />
                {t.id !== 'dmcr' && <IconButtonView size="sm" variant="ghost" icon={hidden ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />} title={hidden ? 'Show in the list' : 'Hide from the list'} onClick={() => themeActions.setTerminalHidden(t.id, !hidden)} />}
                {own && <IconButtonView size="sm" variant="ghost" color="var(--bs-status-error)" icon={<TrashIcon size={12} />} title="Remove" onClick={() => themeActions.removeTerminal(t.id)} />}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Live preview: the palette (the whole app repaints on hover too) and the Runner terminal ── */}
      <div className="theme-head" style={{ marginTop: 22 }}>
        <span className="theme-section-label"><EyeIcon size={13} /> Preview <span>{half} half · hover a palette or a terminal theme</span></span>
      </div>
      <div className="theme-preview">
        <div className="theme-preview-pane">
          <div className="theme-preview-label"><PaletteIcon size={12} /> {prevPal.label}{!hoverPal && <em>in use</em>}</div>
          <PalettePreview s={half === 'dark' ? prevPal.dark : prevPal.light} />
        </div>
        <div className="theme-preview-pane">
          <div className="theme-preview-label"><TerminalIcon size={12} /> {prevTerm.label}{!hoverTerm && <em>in use</em>}<span className="theme-preview-on">on {prevPal.label}</span></div>
          <div className="theme-term" style={{ background: term.ground, color: term.colours.foreground }}>
            {RUNNER_SAMPLE.map((line, i) => (
              <div key={i} className="theme-term-line">{line.map(([text, key], j) => <span key={j} style={key ? { color: term.colours[key] } : undefined}>{text}</span>)}</div>
            ))}
            <div className="theme-term-line"><span style={{ color: term.colours.brightBlue }}>$ </span><span className="theme-term-cursor" style={{ background: term.colours.cursor }} /></div>
            <div className="theme-term-ansi">
              {(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const).map(k => (
                <span key={k} className="theme-term-pair" title={`${k} / bright ${k}`}>
                  <i style={{ background: term.colours[k] }} /><i style={{ background: term.colours['bright' + k[0].toUpperCase() + k.slice(1)] }} />
                </span>
              ))}
              <span className="theme-term-sel" style={{ background: term.colours.selectionBackground, color: term.colours.foreground }}>selected text</span>
            </div>
          </div>
        </div>
      </div>

      {editing && <PaletteBuilder initial={editing.palette} isNew={editing.isNew} onClose={() => { setEditing(null); paint(); }}
        onSave={p => { if (editing.isNew) themeActions.add(p); else themeActions.update(p); setEditing(null); }} />}
      {editingTerm && <TerminalBuilder initial={editingTerm.theme} onClose={() => setEditingTerm(null)}
        onSave={t => { themeActions.addTerminal(t); setEditingTerm(null); }} />}
    </div>
  );
}

/** A palette half drawn as a small DMCR screen: top bar and tabs, a card with text, a field, buttons and status chips. */
function PalettePreview({ s }: { s: AppSeeds }) {
  const chip = (c: string, label: string) => <span className="theme-pv-chip" style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, borderColor: `color-mix(in srgb, ${c} 38%, transparent)` }}>{label}</span>;
  return (
    <div className="theme-pv" style={{ background: s.ground, borderColor: s.border, color: s.text }}>
      <div className="theme-pv-bar" style={{ borderColor: s.border }}>
        <b style={{ color: s.accent }}>DMCR</b>
        <span className="theme-pv-tab" style={{ background: `color-mix(in srgb, ${s.accent} 16%, transparent)`, color: s.accent }}>Releases</span>
        <span style={{ color: s.muted }}>Runner</span><span style={{ color: s.muted }}>Settings</span>
      </div>
      <div className="theme-pv-card" style={{ background: s.surface, borderColor: s.border }}>
        <div className="theme-pv-title">010_a_zap_score_v2</div>
        <div style={{ color: s.muted }}>Project A {'·'} priya.nair {'·'} 2026-11-17</div>
        <div className="theme-pv-row">
          <span className="theme-pv-field" style={{ background: s.inputBg, borderColor: s.inputBorder, color: s.inputText }}>zap_score_v2</span>
          <span className="theme-pv-btn" style={{ background: s.accent, color: s.ground }}>Save to workspace</span>
          <span className="theme-pv-btn theme-pv-btn--ghost" style={{ borderColor: s.border, color: s.text }}>Cancel</span>
        </div>
        <div className="theme-pv-row">{chip(s.success, 'applied')}{chip(s.warning, 'pending')}{chip(s.error, 'failed')}{chip(s.info, 'info')}</div>
      </div>
    </div>
  );
}

/* ── Theme builder: name, 13 seeds per half, optional identity colours; previews live ── */
function PaletteBuilder({ initial, isNew, onClose, onSave }: { initial: AppPalette; isNew: boolean; onClose: () => void; onSave: (p: AppPalette) => void }) {
  const [p, setP] = useState<AppPalette>(initial);
  const [half, setHalf] = useState<'dark' | 'light'>(currentMode());
  const seeds = half === 'dark' ? p.dark : p.light;
  const update = (next: AppPalette) => { setP(next); paint(next); };
  const setSeed = (k: keyof AppSeeds, v: string) => update({ ...p, [half]: { ...seeds, [k]: v }, ...(half === 'light' ? { lightDerived: false } : {}) });
  const setIdentity = (f: Family, v: string | null) => {
    const id = { ...(p.identity ?? {}) };
    if (v) id[f] = v; else delete id[f];
    update({ ...p, identity: Object.keys(id).length ? id : undefined });
  };
  return (
    <ModalView open size="xl" height="88vh" onClose={onClose} headerColor="var(--bs-accent)" headerIcon={<PaletteIcon size={16} />}
      title={isNew ? 'New palette' : `Edit ${initial.label}`} subtitle="Every change previews live on the whole app"
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}
      footerLeft={<ButtonView variant="ghost" iconLeft={<SparkleIcon size={13} />} label="Derive the light half from the dark one" onClick={() => update({ ...p, light: deriveLightSeeds(p.dark), lightDerived: true })} />}
      footerRight={<>
        <ButtonView variant="ghost" label="Cancel" onClick={onClose} />
        <ButtonView variant="primary" accentColor="var(--bs-accent)" iconLeft={<CheckIcon size={13} />} label="Save palette" disabled={!p.label.trim()} onClick={() => onSave({ ...p, label: p.label.trim(), swatch: p.dark.accent })} />
      </>}>
      <div className="theme-builder-top">
        <span style={{ flex: 1 }}><TextInputView value={p.label} placeholder="Palette name" onChange={e => setP({ ...p, label: e.target.value })} /></span>
        <SegmentedControlView size="md" variant="rounded" accentColor="var(--bs-accent)" value={half} onChange={v => setHalf(v as 'dark' | 'light')} options={[{ value: 'dark', label: 'Dark half' }, { value: 'light', label: `Light half${p.lightDerived ? ' (derived)' : ''}` }]} />
        <Swatch s={seeds} small />
      </div>
      <div className="theme-seeds">
        {SEED_KEYS.map(k => (
          <div key={k} className="theme-seed">
            <span className="theme-seed-name">{SEED_META[k].label}<em>{SEED_META[k].reaches}</em></span>
            <span className="theme-seed-pick"><ColorPickerView value={seeds[k]} onChange={v => setSeed(k, v)} /></span>
          </div>
        ))}
      </div>
      <div className="theme-section-label" style={{ marginTop: 6 }}>Identity colours <span>optional: chips and tags that keep their own hue unless you set one</span></div>
      <div className="theme-seeds">
        {IDENTITY_FAMILIES.map(f => (
          <div key={f} className="theme-seed">
            <span className="theme-seed-name"><label className="theme-check"><CheckboxView size="sm" checked={!!p.identity?.[f]} onChange={on => setIdentity(f, on ? ({ violet: '#8b5cf6', pink: '#ec4899', orange: '#f97316', teal: '#14b8a6', lime: '#84cc16' } as Record<Family, string>)[f] : null)} />{f[0].toUpperCase() + f.slice(1)}</label></span>
            <span className="theme-seed-pick">{p.identity?.[f] ? <ColorPickerView value={p.identity[f]!} onChange={v => setIdentity(f, v)} /> : <em className="theme-seed-off">DMCR&rsquo;s own</em>}</span>
          </div>
        ))}
      </div>
    </ModalView>
  );
}

/* ── Terminal theme builder: the 19 ANSI keys per half ── */
function TerminalBuilder({ initial, onClose, onSave }: { initial: TerminalPalette; onClose: () => void; onSave: (t: TerminalPalette) => void }) {
  const [t, setT] = useState<TerminalPalette>(initial);
  const [half, setHalf] = useState<'dark' | 'light'>(currentMode());
  const a = half === 'dark' ? t.dark : t.light;
  return (
    <ModalView open size="xl" height="88vh" onClose={onClose} headerColor="var(--bs-accent)" headerIcon={<TerminalIcon size={16} />}
      title={`Terminal theme: ${t.label}`} bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}
      footerRight={<>
        <ButtonView variant="ghost" label="Cancel" onClick={onClose} />
        <ButtonView variant="primary" accentColor="var(--bs-accent)" iconLeft={<CheckIcon size={13} />} label="Save terminal theme" disabled={!t.label.trim()} onClick={() => onSave({ ...t, label: t.label.trim(), swatch: t.dark.blue })} />
      </>}>
      <div className="theme-builder-top">
        <span style={{ flex: 1 }}><TextInputView value={t.label} placeholder="Theme name" onChange={e => setT({ ...t, label: e.target.value })} /></span>
        <SegmentedControlView size="md" variant="rounded" accentColor="var(--bs-accent)" value={half} onChange={v => setHalf(v as 'dark' | 'light')} options={[{ value: 'dark', label: 'Dark half' }, { value: 'light', label: 'Light half' }]} />
      </div>
      <AnsiStrip a={a} ground={half === 'dark' ? '#0d1117' : '#f8fafc'} />
      <div className="theme-seeds">
        {TERMINAL_ANSI_KEYS.map(k => (
          <div key={k} className="theme-seed">
            <span className="theme-seed-name">{k}</span>
            <span className="theme-seed-pick"><ColorPickerView value={a[k]} onChange={v => setT({ ...t, [half]: { ...a, [k]: v } })} /></span>
          </div>
        ))}
      </div>
    </ModalView>
  );
}
