import { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Loader2, Plus, RefreshCw, Save, Search, X } from 'lucide-react';
import { ProviderIcon } from '../ProviderIcon';
import './ProviderSettingsPanel.css';
import { useMarketStore } from '../../stores/marketStore';
import { useAgentStore } from '../../stores/agentStore';
import { fetchProviderModels, saveProviderProfile } from '../../api';
import { formatContextWindow } from '../../utils';

export function ProviderSettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const registry = useAgentStore((s) => s.modelRegistry);
  const registryLoading = useAgentStore((s) => s.modelRegistryLoading);

  const config = state?.config.agent;
  const profiles = config?.providerProfiles ?? {};
  const providers = registry?.providers ?? [];
  const [activeProvider, setActiveProvider] = useState('');
  const [providerSearch, setProviderSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [requiresAuthInput, setRequiresAuthInput] = useState(true);
  const [showApiKey, setShowApiKey] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [customContextWindow, setCustomContextWindow] = useState('128000');
  const [customMaxTokens, setCustomMaxTokens] = useState('8192');
  const [customReasoning, setCustomReasoning] = useState(false);
  const [customImageInput, setCustomImageInput] = useState(true);

  const models = registry?.models.filter((model) => model.providerId === activeProvider) ?? [];
  const option = providers.find((provider) => provider.providerId === activeProvider) ?? providers[0];
  const configProviderId = option?.configProviderId ?? activeProvider;
  const profile = profiles[configProviderId];
  const enabled = option?.enabled ?? false;
  const selectedModels = new Set(models.filter((model) => model.selected).map((model) => model.id));

  useEffect(() => {
    if (!providers.length) return;
    if (!providers.some((provider) => provider.providerId === activeProvider)) {
      setActiveProvider(providers[0].providerId);
    }
  }, [activeProvider, providers]);

  useEffect(() => {
    setApiKeyInput('');
    setBaseUrlInput(profile?.baseUrl ?? '');
    setRequiresAuthInput(profile?.requiresAuth ?? option?.requiresAuth ?? true);
    setShowApiKey(false);
  }, [activeProvider, option?.requiresAuth, profile?.baseUrl, profile?.apiKeyConfigured, profile?.requiresAuth]);

  function switchProvider(provider: string) {
    setActiveProvider(provider);
    setModelSearch('');
    setStatus('');
  }

  async function toggleEnabled() {
    const next = !enabled;
    setStatus(next ? '启用中...' : '关闭中...');
    try {
      const nextState = await saveProviderProfile(activeProvider, {
        enabled: next,
        api: option?.api,
        displayName: option?.name,
      });
      useMarketStore.getState().setState(nextState);
      await useAgentStore.getState().refreshModelRegistry();
      setStatus(next ? '已启用。' : '已关闭。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Toggle failed.');
    }
  }

  async function loadModels() {
    setLoading(true);
    try {
      const payload = await fetchProviderModels(activeProvider);
      const visible = payload.models.filter((model) => model.supportedInApi && model.visibility !== 'hide');
      setStatus(`发现 ${visible.length} 个远程模型；运行目录以 registry 为准。`);
      await useAgentStore.getState().refreshModelRegistry();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Model refresh failed.');
    } finally {
      setLoading(false);
    }
  }

  async function toggleModel(slug: string) {
    setStatus('保存模型选择...');
    try {
      const nextState = await saveProviderProfile(activeProvider, { toggleModel: slug });
      useMarketStore.getState().setState(nextState);
      await useAgentStore.getState().refreshModelRegistry();
      setStatus('已保存。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
    }
  }

  async function saveConnectionSettings() {
    setStatus('保存连接设置...');
    try {
      const update: { apiKey?: string; baseUrl?: string; requiresAuth?: boolean } = {
        baseUrl: baseUrlInput.trim(),
        requiresAuth: requiresAuthInput,
      };
      const trimmedApiKey = apiKeyInput.trim();
      if (trimmedApiKey) update.apiKey = trimmedApiKey;
      const nextState = await saveProviderProfile(activeProvider, update);
      useMarketStore.getState().setState(nextState);
      setApiKeyInput('');
      setStatus('连接设置已保存。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Connection settings save failed.');
    }
  }

  async function addCustomModel() {
    const slug = customInput.trim();
    if (!slug) return;
    const contextWindow = Number(customContextWindow);
    const maxTokens = Number(customMaxTokens);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0 || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      setStatus('Context window 和 max tokens 必须是正整数。');
      return;
    }
    setStatus('添加自定义模型...');
    try {
      const definitions = (profile?.customModelDefinitions ?? []).filter((definition) => definition.id !== slug);
      definitions.push({
        id: slug,
        name: slug,
        api: option?.api ?? profile?.api ?? '',
        reasoning: customReasoning,
        input: customImageInput ? ['text', 'image'] : ['text'],
        contextWindow,
        maxTokens,
      });
      const nextState = await saveProviderProfile(activeProvider, {
        customModelDefinitions: definitions,
      });
      useMarketStore.getState().setState(nextState);
      if (!selectedModels.has(slug)) {
        const after = await saveProviderProfile(activeProvider, { toggleModel: slug });
        useMarketStore.getState().setState(after);
      }
      await useAgentStore.getState().refreshModelRegistry();
      setCustomInput('');
      setStatus('已添加并启用。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Add failed.');
    }
  }

  async function removeCustomModel(slug: string) {
    setStatus('删除自定义模型...');
    try {
      const nextState = await saveProviderProfile(activeProvider, { removeCustomModel: slug });
      useMarketStore.getState().setState(nextState);
      await useAgentStore.getState().refreshModelRegistry();
      setStatus('已删除。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Remove failed.');
    }
  }

  const filteredProviders = providers.filter((provider) =>
    `${provider.providerId} ${provider.name} ${provider.api}`.toLowerCase().includes(providerSearch.trim().toLowerCase()),
  );
  const visibleModels = models.filter((m) => {
    const kw = modelSearch.trim().toLowerCase();
    if (!kw) return true;
    return `${m.name} ${m.id} ${m.api} ${m.source}`.toLowerCase().includes(kw);
  });

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h2>Providers</h2>
        </div>
      </header>

      <div className="provider-layout">
        {/* ── Left: provider catalog ── */}
        <section className="provider-catalog">
          <div className="provider-toolbar">
            <div className="settings-search">
              <Search size={17} />
              <input
                value={providerSearch}
                onChange={(e) => setProviderSearch(e.target.value)}
                placeholder="Search providers..."
              />
            </div>
          </div>
          <div className="provider-list">
            {filteredProviders.map((o) => {
              const selected = activeProvider === o.providerId;
              const isEnabled = o.enabled;
              return (
                <button
                  className={`provider-item ${selected ? 'selected' : ''}`}
                  key={o.providerId}
                  type="button"
                  onClick={() => switchProvider(o.providerId)}
                >
                  <div className="provider-item-icon">
                    <ProviderIcon provider={o.providerId} size={20} />
                  </div>
                  <div className="provider-item-copy">
                    <strong>{o.name}</strong>
                    <small>{o.api || 'API 未声明'}</small>
                  </div>
                  <label className="switch-row" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={async () => {
                        try {
                          const nextState = await saveProviderProfile(o.providerId, {
                            enabled: !isEnabled,
                            api: o.api,
                            displayName: o.name,
                          });
                          useMarketStore.getState().setState(nextState);
                          await useAgentStore.getState().refreshModelRegistry();
                        } catch (err) {
                          // Silently fail — detail panel will show error if opened
                        }
                      }}
                    />
                    <span className="switch-slider" />
                  </label>
                </button>
              );
            })}
            {filteredProviders.length === 0 && (
              <div className="empty-state lg">No providers match this search.</div>
            )}
          </div>
        </section>

        {/* ── Right: detail panel ── */}
        <section className="provider-detail">
          <div className="provider-hero">
            <div className="provider-hero-title">
              <h3>{option?.name ?? 'Providers'}</h3>
              {enabled && <span className="badge success">Active</span>}
              {option && <span className={`badge${option.runnable ? ' success' : ' warning'}`}>{option.runnable ? 'Runnable' : 'Not runnable'}</span>}
              {option && <span className={`badge${option.authConfigured ? ' success' : ''}`}>{option.authConfigured ? 'Auth ready' : 'Auth required'}</span>}
              <label className="switch-row provider-hero-toggle" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={enabled} onChange={toggleEnabled} />
                <span className="switch-slider" />
              </label>
            </div>
            <p>{option?.api || 'Select a provider to configure it.'}</p>
          </div>

          {enabled && option && (
            <div className="provider-connection-form">
              <label className="provider-field">
                <span className="provider-field-label">API Key</span>
                <div className="provider-secret-row">
                  <input
                    className="input mono"
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={option.authConfigured ? 'Saved. Enter a new key to replace it.' : 'Enter an API key if required.'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    className="shell-button icon muted"
                    type="button"
                    title={showApiKey ? 'Hide API key' : 'Show API key'}
                    onClick={() => setShowApiKey((value) => !value)}
                  >
                    {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                <span className="provider-field-hint">
                  {option.authConfigured
                    ? 'API key or account authentication is configured.'
                    : 'No authentication is currently available for this provider.'}
                </span>
              </label>

              <label className="provider-field">
                <span className="provider-field-label">
                  Base URL <em>Optional</em>
                </span>
                <input
                  className="input mono"
                  type="url"
                  value={baseUrlInput}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  placeholder="Provider endpoint URL"
                  spellCheck={false}
                />
                <span className="provider-field-hint">
                  Leave empty to use the backend-configured default endpoint.
                </span>
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={requiresAuthInput}
                  onChange={(event) => setRequiresAuthInput(event.target.checked)}
                />
                此 endpoint 需要 API 鉴权
              </label>

              <div className="provider-connection-actions">
                <div className="provider-connection-status">
                  <KeyRound size={13} />
                  <span>{option.baseUrlConfigured ? 'Custom endpoint' : 'Default endpoint'}</span>
                </div>
                <button className="shell-button muted" type="button" onClick={saveConnectionSettings}>
                  <Save size={14} />
                  Save
                </button>
              </div>
            </div>
          )}

          {enabled && (
            <>
              <div className="models-panel">
                <div className="models-panel-head">
                  <strong>Models</strong>
                  {option.discoverable && (
                    <button className="shell-button muted" type="button" onClick={loadModels} disabled={loading}>
                      {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                      Fetch
                    </button>
                  )}
                </div>

                <div className="settings-search models-search">
                  <Search size={17} />
                  <input
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Search models..."
                  />
                </div>

                <div className="provider-field custom-model-form">
                    <span className="provider-field-label">自定义模型 ID</span>
                    <div className="provider-secret-row">
                      <input
                        className="input mono"
                        type="text"
                        value={customInput}
                        onChange={(e) => setCustomInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void addCustomModel();
                          }
                        }}
                        placeholder="model-id"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        className="shell-button icon"
                        type="button"
                        title="添加自定义模型"
                        onClick={() => void addCustomModel()}
                        disabled={!customInput.trim()}
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                    <div className="provider-secret-row">
                      <input
                        className="input mono"
                        type="number"
                        min="1"
                        value={customContextWindow}
                        onChange={(e) => setCustomContextWindow(e.target.value)}
                        placeholder="Context window"
                      />
                      <input
                        className="input mono"
                        type="number"
                        min="1"
                        value={customMaxTokens}
                        onChange={(e) => setCustomMaxTokens(e.target.value)}
                        placeholder="Max tokens"
                      />
                    </div>
                    <div className="provider-secret-row">
                      <label className="checkbox-row">
                        <input type="checkbox" checked={customReasoning} onChange={(e) => setCustomReasoning(e.target.checked)} />
                        Reasoning
                      </label>
                      <label className="checkbox-row">
                        <input type="checkbox" checked={customImageInput} onChange={(e) => setCustomImageInput(e.target.checked)} />
                        Image input
                      </label>
                    </div>
                    <span className="provider-field-hint">自定义模型必须提供明确的 Pi 元数据，避免运行时猜测能力。</span>
                  </div>

                <div className="models-showing">
                  Registry generation {registry?.generation ?? '—'} · Showing {visibleModels.length} model{visibleModels.length === 1 ? '' : 's'}
                </div>
                <div className="model-list">
                  {visibleModels.map((model) => {
                    const isSelected = model.selected;
                    return (
                      <div className={`model-row ${isSelected ? 'selected' : ''}`} key={model.id}>
                        <div
                          className="model-copy"
                          onClick={() => void toggleModel(model.id)}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="model-title-row">
                            <strong>{model.name || model.id}</strong>
                            <span className="model-slug">{model.id}</span>
                          </div>
                          <div className="model-meta-row">
                            <span>{formatContextWindow(model.contextWindow)}</span>
                            <span>{model.reasoning ? 'reasoning' : 'standard'}</span>
                            <span>{model.source}</span>
                            <span>{model.runnable ? 'runnable' : 'not runnable'}</span>
                          </div>
                        </div>
                        {model.source !== 'pi' && (
                          <button
                            className="shell-button icon muted"
                            type="button"
                            title="删除自定义模型"
                            onClick={(event) => { event.stopPropagation(); void removeCustomModel(model.id); }}
                          >
                            <X size={14} />
                          </button>
                        )}
                        <label className="switch-row model-toggle" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => void toggleModel(model.id)}
                          />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    );
                  })}
                  {models.length > 0 && visibleModels.length === 0 && (
                    <div className="empty-state">No models match this search.</div>
                  )}
                  {models.length === 0 && !loading && !registryLoading && (
                    <div className="empty-state">Registry 中没有此 provider 的模型。</div>
                  )}
                </div>
              </div>
            </>
          )}

          {!enabled && (
            <div className="empty-state lg provider-disabled-hint">
              启用此 provider 后可以选择模型并在对话中使用。
            </div>
          )}

          <div className="provider-status-bar">{status}</div>
        </section>
      </div>
    </>
  );
}
