import React, { useState } from 'react';
import { postMsg } from '../../vscode';
import type { CustomProviderConfig } from '../../types';
import {
  LlmIcon,
  OpenAiProviderIcon, AnthropicProviderIcon, LmStudioProviderIcon, OllamaProviderIcon,
  DeepSeekProviderIcon, GrokProviderIcon, MistralProviderIcon, GeminiProviderIcon, QwenProviderIcon,
} from './icons';
import { StyledSelect } from './shared';
import type { LlmProps } from './types';

const PROVIDER_TYPE_OPTIONS: { id: string; label: string; Icon: React.FC<{ size?: number }> }[] = [
  { id: 'openai',    label: 'OpenAI',    Icon: OpenAiProviderIcon    },
  { id: 'anthropic', label: 'Anthropic', Icon: AnthropicProviderIcon },
  { id: 'gemini',    label: 'Gemini',    Icon: GeminiProviderIcon    },
  { id: 'grok',      label: 'Grok',      Icon: GrokProviderIcon      },
  { id: 'mistral',   label: 'Mistral',   Icon: MistralProviderIcon   },
  { id: 'deepseek',  label: 'DeepSeek',  Icon: DeepSeekProviderIcon  },
  { id: 'qwen',      label: 'Qwen',      Icon: QwenProviderIcon      },
  { id: 'lmstudio',  label: 'LM Studio', Icon: LmStudioProviderIcon  },
  { id: 'ollama',    label: 'Ollama',    Icon: OllamaProviderIcon    },
];

const PROVIDER_PLACEHOLDERS: Record<string, { name: string; chatUrl: string; modelsUrl: string; apiKey: string }> = {
  openai:    { name: 'My OpenAI Provider',     chatUrl: 'https://api.openai.com/v1/chat/completions',                           modelsUrl: 'https://api.openai.com/v1/models',                           apiKey: 'sk-...'                         },
  anthropic: { name: 'My Anthropic Provider',  chatUrl: 'https://api.anthropic.com/v1/messages',                               modelsUrl: 'https://api.anthropic.com/v1/models',                        apiKey: 'sk-ant-...'                     },
  gemini:    { name: 'My Gemini Provider',     chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models', apiKey: 'AIza...'                    },
  grok:      { name: 'My Grok Provider',       chatUrl: 'https://api.x.ai/v1/chat/completions',                                modelsUrl: 'https://api.x.ai/v1/models',                                 apiKey: 'xai-...'                        },
  mistral:   { name: 'My Mistral Provider',    chatUrl: 'https://api.mistral.ai/v1/chat/completions',                          modelsUrl: 'https://api.mistral.ai/v1/models',                           apiKey: 'sk-...'                         },
  deepseek:  { name: 'My DeepSeek Provider',   chatUrl: 'https://api.deepseek.com/v1/chat/completions',                        modelsUrl: 'https://api.deepseek.com/v1/models',                         apiKey: 'sk-...'                         },
  qwen:      { name: 'My Qwen Provider',       chatUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',  modelsUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',  apiKey: 'sk-...'                         },
  lmstudio:  { name: 'My LM Studio Server',    chatUrl: 'http://<your-host>/v1/chat/completions',                              modelsUrl: 'http://<your-host>/v1/models',                               apiKey: 'leave blank if not set'         },
  ollama:    { name: 'My Ollama Server',        chatUrl: 'http://<your-host>/api/chat',                                         modelsUrl: 'http://<your-host>/api/tags',                                apiKey: 'leave blank for local Ollama'   },
};

const HOST_PATHS: Record<string, { chat: string; models: string }> = {
  openai:    { chat: '/v1/chat/completions',                    models: '/v1/models'                    },
  anthropic: { chat: '/v1/messages',                            models: '/v1/models'                    },
  gemini:    { chat: '/v1beta/openai/chat/completions',         models: '/v1beta/openai/models'         },
  grok:      { chat: '/v1/chat/completions',                    models: '/v1/models'                    },
  mistral:   { chat: '/v1/chat/completions',                    models: '/v1/models'                    },
  deepseek:  { chat: '/v1/chat/completions',                    models: '/v1/models'                    },
  qwen:      { chat: '/compatible-mode/v1/chat/completions',    models: '/compatible-mode/v1/models'    },
  lmstudio:  { chat: '/v1/chat/completions',                    models: '/v1/models'                    },
  ollama:    { chat: '/api/chat',                               models: '/api/tags'                     },
};

const PROVIDER_DEFAULT_HOSTS: Record<string, string> = {
  openai:    'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini:    'https://generativelanguage.googleapis.com',
  grok:      'https://api.x.ai',
  mistral:   'https://api.mistral.ai',
  deepseek:  'https://api.deepseek.com',
  qwen:      'https://dashscope.aliyuncs.com',
  lmstudio:  'http://127.0.0.1:1234',
  ollama:    'http://localhost:11434',
};

function deriveUrlsFromHost(host: string, type: string) {
  const h = host.replace(/\/$/, '');
  if (!h) return {};
  const paths = HOST_PATHS[type] ?? HOST_PATHS.openai;
  return { chatUrl: h + paths.chat, modelsUrl: h + paths.models };
}

function extractHostFromUrl(url: string, type: string) {
  if (!url) return '';
  const paths = HOST_PATHS[type] ?? HOST_PATHS.openai;
  for (const p of Object.values(paths)) {
    if (url.endsWith(p)) return url.slice(0, -p.length);
  }
  try { return new URL(url).origin; } catch { return ''; }
}

function defaultsForType(type: string) {
  const host = PROVIDER_DEFAULT_HOSTS[type] ?? '';
  const derived = deriveUrlsFromHost(host, type);
  return { host, chatUrl: derived.chatUrl ?? '', modelsUrl: derived.modelsUrl ?? '' };
}

const BLANK_FORM = { name: '', type: 'openai', host: '', chatUrl: '', modelsUrl: '', apiKey: '', headers: '' };

export function CustomPanel({ snapshot, onSnapshotChange: _onSnapshotChange, addToast: _addToast }: LlmProps) {
  const [form, setForm]               = useState({ ...BLANK_FORM });
  const [showForm, setShowForm]       = useState(false);
  const [editingKey, setEditingKey]   = useState<string | null>(null);
  const [formError, setFormError]     = useState('');
  const [saving, setSaving]           = useState(false);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey]     = useState<string | null>(null);

  const providers = snapshot.customProviders;

  const openAdd = () => {
    setEditingKey(null);
    setForm({ ...BLANK_FORM, ...defaultsForType('openai') });
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (p: CustomProviderConfig) => {
    setEditingKey(p.key);
    const type = p.type;
    setForm({
      name: p.name,
      type,
      host: extractHostFromUrl(p.chatUrl ?? '', type),
      chatUrl: p.chatUrl ?? '',
      modelsUrl: p.modelsUrl ?? '',
      apiKey: '',
      headers: p.headers && Object.keys(p.headers).length ? JSON.stringify(p.headers, null, 2) : '',
    });
    setFormError('');
    setShowForm(true);
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingKey(null);
    setForm({ ...BLANK_FORM });
    setFormError('');
  };

  const handleSave = () => {
    setFormError('');
    if (!form.name.trim()) return setFormError('Provider name is required');
    if (!form.chatUrl.trim()) return setFormError('Chat URL is required');
    if (!form.modelsUrl.trim()) return setFormError('Models URL is required');

    let parsedHeaders: Record<string, string> = {};
    if (form.headers.trim()) {
      try { parsedHeaders = JSON.parse(form.headers); } catch {
        return setFormError('Additional headers must be valid JSON');
      }
    }

    setSaving(true);
    postMsg({
      type: 'addProvider',
      payload: {
        ...(editingKey ? { key: editingKey } : {}),
        name: form.name.trim(),
        type: form.type,
        chatUrl: form.chatUrl.trim(),
        modelsUrl: form.modelsUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        headers: parsedHeaders,
      },
    });
    setShowForm(false);
    setEditingKey(null);
    setForm({ ...BLANK_FORM });
    setSaving(false);
  };

  const handleDelete = (key: string) => {
    setDeletingKey(key);
    postMsg({ type: 'deleteProvider', payload: { key } });
    setTimeout(() => setDeletingKey(null), 1000);
  };

  const handleRefresh = (key: string) => {
    setRefreshingKey(key);
    postMsg({ type: 'fetchModels', payload: { key } });
    setTimeout(() => setRefreshingKey(null), 3000);
  };

  return (
    <div className="bs-settings-pane bs-custom-provider-pane">
      <div className="bs-settings-section-head">
        <LlmIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3">Custom LLM Providers</h3>
        <button
          className="bs-btn-sm bs-btn-secondary bs-custom-provider-add-btn"
          onClick={showForm ? handleCancel : openAdd}
        >
          {showForm ? '✕ Cancel' : '+ Add Provider'}
        </button>
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <div className="bs-custom-provider-form">
          <div className="bs-custom-provider-form-title">
            {editingKey ? 'Edit Provider' : 'Add New Provider'}
          </div>
          <div className="bs-custom-provider-form-grid">
            <label className="bs-custom-provider-label">
              Provider Name
              <input
                className="bs-custom-provider-input"
                placeholder={PROVIDER_PLACEHOLDERS[form.type]?.name ?? 'My Provider'}
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="bs-custom-provider-label">
              Type
              <StyledSelect
                value={form.type}
                options={PROVIDER_TYPE_OPTIONS.map(o => ({ id: o.id, label: o.label, icon: <o.Icon size={15} /> }))}
                onChange={(id: string) => setForm(f => {
                  const oldD = defaultsForType(f.type);
                  const newD = defaultsForType(id);
                  const wasDefault = (val: string, def: string) => !val || val === def;
                  return {
                    ...f,
                    type:      id,
                    host:      wasDefault(f.host,      oldD.host)      ? newD.host      : f.host,
                    chatUrl:   wasDefault(f.chatUrl,   oldD.chatUrl)   ? newD.chatUrl   : f.chatUrl,
                    modelsUrl: wasDefault(f.modelsUrl, oldD.modelsUrl) ? newD.modelsUrl : f.modelsUrl,
                  };
                })}
              />
            </label>
            <label className="bs-custom-provider-label bs-span2">
              Host
              <input
                className="bs-custom-provider-input"
                placeholder={PROVIDER_DEFAULT_HOSTS[form.type] ?? 'https://api.example.com'}
                value={form.host}
                onChange={e => {
                  const host = e.target.value;
                  setForm(f => ({ ...f, host, ...deriveUrlsFromHost(host, f.type) }));
                }}
              />
            </label>
            <label className="bs-custom-provider-label bs-span2">
              Chat URL
              <input
                className="bs-custom-provider-input"
                placeholder={PROVIDER_PLACEHOLDERS[form.type]?.chatUrl}
                value={form.chatUrl}
                onChange={e => setForm(f => ({ ...f, chatUrl: e.target.value }))}
              />
            </label>
            <label className="bs-custom-provider-label bs-span2">
              Models URL
              <input
                className="bs-custom-provider-input"
                placeholder={PROVIDER_PLACEHOLDERS[form.type]?.modelsUrl}
                value={form.modelsUrl}
                onChange={e => setForm(f => ({ ...f, modelsUrl: e.target.value }))}
              />
            </label>
            <label className="bs-custom-provider-label bs-span2">
              API Key
              <input
                className="bs-custom-provider-input"
                type="password"
                placeholder={editingKey ? 'Leave blank to keep existing key' : (PROVIDER_PLACEHOLDERS[form.type]?.apiKey ?? 'sk-...')}
                value={form.apiKey}
                onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                autoComplete="off"
              />
            </label>
            <label className="bs-custom-provider-label bs-span2">
              Additional Headers <span className="bs-optional-hint">(JSON, optional)</span>
              <textarea
                className="bs-custom-provider-textarea"
                placeholder='{ "X-Custom-Header": "value" }'
                rows={2}
                value={form.headers}
                onChange={e => setForm(f => ({ ...f, headers: e.target.value }))}
              />
            </label>
          </div>
          {formError && <div className="bs-custom-provider-form-error">{formError}</div>}
          <div className="bs-custom-provider-form-actions">
            <button className="bs-btn-sm bs-btn-success" onClick={handleSave} disabled={saving}>
              {saving ? (editingKey ? 'Updating...' : 'Saving...') : (editingKey ? 'Update Provider' : 'Save Provider')}
            </button>
          </div>
        </div>
      )}

      {/* Provider list */}
      {providers.length === 0 ? (
        <div className="bs-custom-provider-empty">No custom providers added yet.</div>
      ) : (
        <ul className="bs-custom-provider-list">
          {providers.map(p => (
            <li key={p.key} className="bs-custom-provider-item">
              <div className="bs-custom-provider-item-info">
                <span className="bs-custom-provider-name">{p.name}</span>
                <span className="bs-custom-provider-type-badge">
                  {PROVIDER_TYPE_OPTIONS.find(o => o.id === p.type)?.label ?? p.type}
                </span>
                <span className="bs-custom-provider-model-count">
                  {(p.cachedModels ?? []).length} model{(p.cachedModels ?? []).length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="bs-custom-provider-item-actions">
                <button
                  className="bs-btn-sm bs-btn-secondary"
                  onClick={() => handleRefresh(p.key)}
                  disabled={refreshingKey === p.key}
                  title="Fetch latest model list"
                >
                  {refreshingKey === p.key ? 'Refreshing...' : '↻ Refresh Models'}
                </button>
                <button
                  className="bs-btn-sm bs-btn-secondary"
                  onClick={() => openEdit(p)}
                  disabled={!!refreshingKey || !!deletingKey}
                  title="Edit provider"
                >
                  ✎ Edit
                </button>
                <button
                  className="bs-btn-sm bs-btn-secondary bs-btn-secondary--danger"
                  onClick={() => handleDelete(p.key)}
                  disabled={deletingKey === p.key}
                >
                  {deletingKey === p.key ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
