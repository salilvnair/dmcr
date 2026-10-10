import React, { useState, useEffect, useCallback } from 'react';
import { postMsg } from '../../vscode';
import type { ToastData } from '../../App';

import {
  ButtonView, ColumnsIcon, DatabaseIndexIcon, DatabaseTableIcon, IconButtonView, MockDataIcon, PlusIcon, RefreshIcon, SaveIcon,
  SelectInputView, SparkleIcon, TestTubeIcon, TrashIcon,
} from '@salilvnair/dui';

interface Chip { chipText: string; chatText: string; icon?: string; }

const DEFAULT_CHIPS: Chip[] = [
  { chipText: 'Add column',      icon: 'column', chatText: 'Add a nullable email varchar(320) column to the public.users table' },
  { chipText: 'New table',       icon: 'table',  chatText: 'Create a new table public.audit_log with id bigserial, event_type text, created_at timestamptz' },
  { chipText: 'Add index',       icon: 'index',  chatText: 'Add an index on public.orders(customer_id) concurrently' },
  { chipText: 'Seed data',       icon: 'seed',   chatText: 'Seed initial config rows into public.app_config (key text, value text)' },
  { chipText: 'Seed test data',  icon: 'test',   chatText: 'Seed test data for public.users — generate 15 realistic INSERT rows that respect all column types, NOT NULL constraints, and foreign keys' },
];

const CHIP_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  column: ColumnsIcon,
  table: DatabaseTableIcon,
  index: DatabaseIndexIcon,
  seed: MockDataIcon,
  test: TestTubeIcon,
  sparkle: SparkleIcon,
};

const ICON_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Auto icon' },
  { value: 'column', label: 'Column' },
  { value: 'table', label: 'Table' },
  { value: 'index', label: 'Index' },
  { value: 'seed', label: 'Seed' },
  { value: 'test', label: 'Test' },
  { value: 'sparkle', label: 'Sparkle' },
];

/** Saved chips (SQLite) may still carry a leading emoji from older defaults. */
function stripLeadingEmoji(label: string): string {
  return label.replace(/^[\p{Extended_Pictographic}\u2190-\u2BFF\uFE0F\u200D\s]+/u, '');
}

/** Explicit icon key, else a keyword match on the label, else SparkleIcon. */
function chipIconKey(chip: Chip, label: string): string {
  if (chip.icon && CHIP_ICONS[chip.icon]) return chip.icon;
  const l = label.toLowerCase();
  if (l.includes('test')) return 'test';
  if (l.includes('seed')) return 'seed';
  if (l.includes('index')) return 'index';
  if (l.includes('column')) return 'column';
  if (l.includes('table')) return 'table';
  return 'sparkle';
}

export function ConvChipsPanel({ addToast }: { addToast: (m: string, t?: ToastData['type']) => void }) {
  const [chips, setChips] = useState<Chip[]>([]);
  const [addChipText, setAddChipText] = useState('');
  const [addChatText, setAddChatText] = useState('');
  const [addIcon, setAddIcon] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    postMsg({ type: 'getConvChips' });
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'convChips') {
        setChips(msg.payload ?? DEFAULT_CHIPS);
      } else if (msg?.type === 'convChipsSaved') {
        addToast('Chips saved', 'ok');
        setDirty(false);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [addToast]);

  const handleAdd = useCallback(() => {
    const ct = addChipText.trim();
    const cht = addChatText.trim();
    if (!ct || !cht) return;
    setChips(prev => [...prev, addIcon ? { chipText: ct, chatText: cht, icon: addIcon } : { chipText: ct, chatText: cht }]);
    setAddChipText('');
    setAddChatText('');
    setAddIcon('');
    setDirty(true);
  }, [addChipText, addChatText, addIcon]);

  const handleDelete = useCallback((idx: number) => {
    setChips(prev => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  const handleSave = useCallback(() => {
    postMsg({ type: 'saveConvChips', payload: chips });
  }, [chips]);

  const handleReset = useCallback(() => {
    setChips(DEFAULT_CHIPS);
    setDirty(true);
  }, []);

  return (
    <div className="bs-settings-pane" style={{ marginTop: 16 }}>
      <div className="bs-settings-section-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="bs-ico-sm" style={{ color: 'var(--dm-c-818cf8)' }}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span>Conversation Chips</span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary, var(--dm-c-94a3b8))', marginBottom: 16, lineHeight: 1.6 }}>
        Customize the quick-launch prompt chips shown on the Conversation landing page.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        {chips.map((chip, i) => {
          const label = stripLeadingEmoji(chip.chipText ?? '');
          const ChipIcon = CHIP_ICONS[chipIconKey(chip, label)];
          return (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: 'var(--bg-secondary, color-mix(in srgb, var(--dm-c-ffffff) 3%, transparent))', borderRadius: 6, padding: '6px 10px', border: '1px solid color-mix(in srgb, var(--dm-c-ffffff) 7%, transparent)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary, var(--dm-c-e2e8f0))', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}><ChipIcon size={13} />{label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary, var(--dm-c-94a3b8))', wordBreak: 'break-word' }}>{chip.chatText}</div>
            </div>
            <IconButtonView size="md"
              variant="ghost"
              icon={<TrashIcon size={13} />}
              tooltip="Remove chip"
              color="var(--dm-c-f87171)"
              onClick={() => handleDelete(i)}
              style={{ flexShrink: 0 }}
            />
          </div>
          );
        })}
        {chips.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--dm-c-64748b)', textAlign: 'center', padding: '12px 0' }}>No chips — add one below or reset to defaults.</p>
        )}
      </div>

      <div style={{ background: 'var(--bg-secondary, color-mix(in srgb, var(--dm-c-ffffff) 3%, transparent))', borderRadius: 6, padding: 10, border: '1px solid color-mix(in srgb, var(--dm-c-ffffff) 7%, transparent)', marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--dm-c-64748b)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Add chip</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            className="bs-input"
            placeholder="Chip label"
            value={addChipText}
            onChange={e => setAddChipText(e.target.value)}
            style={{ fontSize: 12.5 }}
          />
          <div title="Chip icon (Auto picks one from the label)">
            <SelectInputView size="md"
              value={addIcon}
              onChange={setAddIcon}
              options={ICON_OPTIONS}
              width="100%"
            />
          </div>
          <input
            className="bs-input"
            placeholder="Full chat message sent when clicked"
            value={addChatText}
            onChange={e => setAddChatText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
            style={{ fontSize: 12.5 }}
          />
          <ButtonView
            variant="primary"
            iconLeft={<PlusIcon size={13} />}
            label="Add Chip"
            onClick={handleAdd}
            disabled={!addChipText.trim() || !addChatText.trim()}
            style={{ alignSelf: 'flex-start' }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <ButtonView variant="primary" iconLeft={<SaveIcon size={13} />} label="Save" onClick={handleSave} disabled={!dirty} />
        <ButtonView variant="ghost" iconLeft={<RefreshIcon size={13} />} label="Reset to Defaults" onClick={handleReset} />
      </div>
    </div>
  );
}
