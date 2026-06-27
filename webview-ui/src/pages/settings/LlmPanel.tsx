import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { postMsg } from '../../vscode';
import type { SettingsSnapshot } from '../../types';
import type { ToastData } from '../../App';
import { LlmIcon, CopilotProviderIcon, OpenAiProviderIcon, AnthropicProviderIcon, LmStudioProviderIcon, OllamaProviderIcon, DeepSeekProviderIcon, GrokProviderIcon, MistralProviderIcon, GeminiProviderIcon, QwenProviderIcon } from './icons';
import { SqliteBanner } from './shared';
import type { LlmProps } from './types';

export const PROVIDER_META: Record<string, { label: string; color: string; Icon: React.FC<{ size?: number }> }> = {
  copilot:   { label: 'GitHub Copilot', color: '#6e7bf9', Icon: CopilotProviderIcon   },
  openai:    { label: 'OpenAI',         color: '#10a37f', Icon: OpenAiProviderIcon    },
  anthropic: { label: 'Anthropic',      color: '#d97706', Icon: AnthropicProviderIcon },
  lmstudio:  { label: 'LM Studio',      color: '#8b5cf6', Icon: LmStudioProviderIcon  },
  ollama:    { label: 'Ollama',         color: '#64748b', Icon: OllamaProviderIcon    },
  deepseek:  { label: 'DeepSeek',       color: '#4D6BFE', Icon: DeepSeekProviderIcon  },
  grok:      { label: 'Grok',           color: '#a1a1aa', Icon: GrokProviderIcon      },
  mistral:   { label: 'Mistral',        color: '#FF8205', Icon: MistralProviderIcon   },
  gemini:    { label: 'Gemini',         color: '#3186FF', Icon: GeminiProviderIcon    },
  qwen:      { label: 'Qwen',           color: '#9333ea', Icon: QwenProviderIcon      },
};

export function LlmPanel({ snapshot, onSnapshotChange, addToast }: LlmProps) {
  const providers = useMemo(() => {
    const list: { key: string; label: string; providerType: string }[] = [
      { key: 'copilot', label: 'GitHub Copilot', providerType: 'copilot' },
      ...snapshot.customProviders.map(p => ({ key: p.key, label: p.name, providerType: p.type })),
    ];
    return list;
  }, [snapshot.customProviders]);

  const [selectedProvider, setSelectedProvider] = useState<string>(snapshot.activeProvider || 'copilot');
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const activeProvider = snapshot.activeProvider;
  const activeFamily   = snapshot.activeFamily;

  useEffect(() => {
    setSelectedProvider(snapshot.activeProvider || 'copilot');
    setPendingModel(null);
  }, [snapshot.activeProvider, snapshot.activeFamily]);

  const providerModels = useMemo(() => {
    if (selectedProvider === 'copilot') return snapshot.copilot.models;
    const cp = snapshot.customProviders.find(p => p.key === selectedProvider);
    return (cp?.cachedModels ?? []).map(m => ({ id: m.id, label: m.label, group: m.group, family: m.family }));
  }, [selectedProvider, snapshot]);

  const currentModel = pendingModel ?? activeFamily;

  const hasChanges = useMemo(() => {
    if (selectedProvider !== activeProvider) return true;
    if (pendingModel && pendingModel !== activeFamily) return true;
    return false;
  }, [selectedProvider, activeProvider, pendingModel, activeFamily]);

  const handleSave = useCallback(() => {
    setSaving(true);
    if (selectedProvider === 'copilot') {
      postMsg({ type: 'saveSettings', payload: { activeProvider: 'copilot', copilotModel: pendingModel ?? activeFamily } });
    } else {
      postMsg({ type: 'activateProvider', payload: { key: selectedProvider, model: pendingModel ?? undefined } });
    }
    setTimeout(() => setSaving(false), 1500);
  }, [selectedProvider, pendingModel, activeFamily]);

  const handleCancel = () => { setSelectedProvider(activeProvider); setPendingModel(null); };

  // Keep selectedProvider in sync when a provider is deleted
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'providerDeleted') {
        const { key } = e.data.payload as { key: string };
        if (selectedProvider === key) setSelectedProvider('copilot');
      }
      if (e.data?.type === 'providerAdded') {
        const { key } = e.data.payload as { key: string };
        setSelectedProvider(key);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [selectedProvider]);

  return (
    <div className="bs-llm-config">
      <div className="bs-settings-section-head">
        <LlmIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3">LLM Provider Configuration</h3>
      </div>

      {snapshot.sqliteStatus === 'error' && <SqliteBanner error={snapshot.sqliteError} />}

      <div className="bs-llm-config-status">
        {/* Provider picker row */}
        <div className="bs-llm-config-status-row">
          <span className="bs-llm-status-label">Available Providers</span>
          <div className="bs-llm-provider-picker">
            {providers.map(p => {
              const meta = PROVIDER_META[p.providerType] ?? PROVIDER_META[p.key] ?? { label: p.label, color: '#6366f1', Icon: () => null };
              const isSelected = selectedProvider === p.key;
              const isActive   = activeProvider === p.key;
              return (
                <button
                  key={p.key}
                  className={`bs-llm-provider-btn${isSelected ? ' is-selected' : ''}${isActive ? ' is-active-provider' : ''}`}
                  style={{ '--provider-color': meta.color } as React.CSSProperties}
                  onClick={() => { setSelectedProvider(p.key); setPendingModel(null); }}
                  title={meta.label}
                >
                  <span className="bs-llm-provider-icon-wrap"><meta.Icon size={18} /></span>
                  <span className="bs-llm-provider-name">{p.label}</span>
                  <span className="bs-llm-provider-active-dot" />
                </button>
              );
            })}
          </div>
        </div>

        {/* Active Provider */}
        <div className="bs-llm-config-status-row">
          <span className="bs-llm-status-label">Active Provider</span>
          <span className="bs-llm-status-badge bs-llm-status-model">
            {PROVIDER_META[activeProvider]?.label ?? activeProvider}
          </span>
        </div>

        {/* Default Model */}
        <div className="bs-llm-config-status-row">
          <span className="bs-llm-status-label">Default Model</span>
          <span className="bs-llm-status-badge bs-llm-status-model">{currentModel || '--'}</span>
        </div>

        {/* Available Models chips */}
        <div className="bs-llm-config-status-row bs-llm-models-row">
          <span className="bs-llm-status-label">
            Available Models
            {providerModels.length > 0 && <span className="bs-llm-models-count">{providerModels.length}</span>}
          </span>
          <div className="bs-llm-model-chips">
            {providerModels.length === 0 ? (
              <span className="bs-llm-no-models">No models available for this provider.</span>
            ) : (
              providerModels.map(m => {
                const isSaved   = m.id === activeFamily && activeProvider === selectedProvider;
                const isPending = m.id === pendingModel && pendingModel !== activeFamily;
                return (
                  <span
                    key={m.id}
                    className={`bs-llm-model-chip bs-llm-model-chip-btn${isSaved ? ' bs-llm-model-chip-active' : ''}${isPending ? ' bs-llm-model-chip-pending' : ''}`}
                    title={`${m.group} -- ${m.id}`}
                    onClick={() => setPendingModel(isSaved ? null : m.id)}
                  >
                    {m.label}
                  </span>
                );
              })
            )}
          </div>
        </div>

        {/* Save / Cancel */}
        {hasChanges && (
          <div className="bs-llm-config-actions">
            <button className="bs-btn-sm bs-btn-success" onClick={handleSave} disabled={saving}>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3.5 8.5 6.5 11.5 12.5 4.5" /></svg>
              {saving ? 'Saving...' : 'Save as Default'}
            </button>
            <button className="bs-btn-sm bs-btn-secondary" onClick={handleCancel} disabled={saving}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
