import { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Loader2, Plus, RefreshCw, Save, Search, X } from 'lucide-react';
import { ProviderIcon } from '../ProviderIcon';
import './ProviderSettingsPanel.css';
import { AGENT_PROVIDER_OPTIONS } from '../../constants';
import { useMarketStore } from '../../stores/marketStore';
import { useAgentStore } from '../../stores/agentStore';
import { fetchProviderModels, saveProviderProfile } from '../../api';
import { formatContextWindow } from '../../utils';

export function ProviderSettingsPanel() {
  const state = useMarketStore((s) => s.state);
  const modelCache = useAgentStore((s) => s.modelCache);

  const config = state?.config.agent;
  const profiles = config?.providerProfiles ?? {};
  const [activeProvider, setActiveProvider] = useState<string>(AGENT_PROVIDER_OPTIONS[0].provider);
  const [providerSearch, setProviderSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [customInput, setCustomInput] = useState('');

  const models = modelCache[activeProvider] ?? [];

  const option = AGENT_PROVIDER_OPTIONS.find((o) => o.provider === activeProvider) ?? AGENT_PROVIDER_OPTIONS[0];
  const profile = profiles[activeProvider];
  const enabled = profile?.enabled ?? false;
  const selectedModels = new Set(profile?.models ?? []);
  const isAnthropic = activeProvider === 'anthropic';

  useEffect(() => {
    setApiKeyInput('');
    setBaseUrlInput(profile?.baseUrl ?? '');
    setShowApiKey(false);
  }, [activeProvider, profile?.baseUrl, profile?.apiKeyConfigured]);

  function switchProvider(provider: string) {
    setActiveProvider(provider);
    setModelSearch('');
    setStatus('');
  }

  async function toggleEnabled() {
    const next = !enabled;
    setStatus(next ? '启用中...' : '关闭中...');
    try {
      const nextState = await saveProviderProfile(activeProvider, { enabled: next });
      useMarketStore.getState().setState(nextState);
      if (next) {
        setStatus('已启用，正在拉取模型列表...');
        await loadModels();
      } else {
        useAgentStore.getState().setModelCache((prev) => { const n = { ...prev }; delete n[activeProvider]; return n; });
        setStatus('已关闭。');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Toggle failed.');
    }
  }

  async function loadModels() {
    setLoading(true);
    try {
      const payload = await fetchProviderModels(activeProvider);
      const visible = payload.models.filter((m) => m.supportedInApi && m.visibility !== 'hide');
      useAgentStore.getState().setModelCache((prev) => ({ ...prev, [activeProvider]: visible }));
      setStatus(`${visible.length} 个模型可用。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Model refresh failed.');
    } finally {
      setLoading(false);
    }
  }

  async function toggleModel(slug: string, defaultEffort?: string) {
    setStatus('保存模型选择...');
    try {
      const payload = selectedModels.has(slug) || !defaultEffort
        ? { toggleModel: slug }
        : { toggleModel: slug, modelEffort: { model: slug, effort: defaultEffort } };
      const nextState = await saveProviderProfile(activeProvider, payload);
      useMarketStore.getState().setState(nextState);
      setStatus('已保存。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
    }
  }

  async function saveConnectionSettings() {
    setStatus('保存连接设置...');
    try {
      const update: { apiKey?: string; baseUrl?: string } = {
        baseUrl: baseUrlInput.trim(),
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
    setStatus('添加自定义模型...');
    try {
      const nextState = await saveProviderProfile(activeProvider, { addCustomModel: slug });
      useMarketStore.getState().setState(nextState);
      useAgentStore.getState().setModelCache((prev) => {
        const list = prev[activeProvider] ?? [];
        if (list.some((m) => m.slug === slug)) return prev;
        const option = {
          slug,
          displayName: slug,
          description: 'Custom model',
          visibility: 'public',
          supportedInApi: true,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          contextWindow: null,
          preferWebsockets: false,
          custom: true,
        };
        return { ...prev, [activeProvider]: [option, ...list] };
      });
      if (!selectedModels.has(slug)) {
        const after = await saveProviderProfile(activeProvider, { toggleModel: slug });
        useMarketStore.getState().setState(after);
      }
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
      useAgentStore.getState().setModelCache((prev) => {
        const list = prev[activeProvider];
        if (!list) return prev;
        return { ...prev, [activeProvider]: list.filter((m) => m.slug !== slug) };
      });
      setStatus('已删除。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Remove failed.');
    }
  }

  const filteredProviders = AGENT_PROVIDER_OPTIONS.filter((o) =>
    `${o.provider} ${o.label} ${o.description}`.toLowerCase().includes(providerSearch.trim().toLowerCase()),
  );
  const visibleModels = models.filter((m) => {
    const kw = modelSearch.trim().toLowerCase();
    if (!kw) return true;
    return `${m.displayName} ${m.slug} ${m.description}`.toLowerCase().includes(kw);
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
              const selected = activeProvider === o.provider;
              const isEnabled = profiles[o.provider]?.enabled ?? false;
              return (
                <button
                  className={`provider-item ${selected ? 'selected' : ''}`}
                  key={o.provider}
                  type="button"
                  onClick={() => switchProvider(o.provider)}
                >
                  <div className="provider-item-icon">
                    <ProviderIcon provider={o.provider} size={20} />
                  </div>
                  <div className="provider-item-copy">
                    <strong>{o.label}</strong>
                    <small>{o.description}</small>
                  </div>
                  <span className={`provider-item-dot ${isEnabled ? '' : 'inactive'}`} />
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
              <h3>{option.label}</h3>
              {enabled && <span className="badge success">Active</span>}
              <label className="switch-row provider-hero-toggle" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={enabled} onChange={toggleEnabled} />
                <span className="switch-slider" />
              </label>
            </div>
            <p>{option.detail}</p>
          </div>

          {enabled && isAnthropic && (
            <div className="provider-connection-form">
              <label className="provider-field">
                <span className="provider-field-label">API Key</span>
                <div className="provider-secret-row">
                  <input
                    className="input mono"
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={
                      profile?.apiKeyConfigured
                        ? 'Saved. Enter a new key to replace it.'
                        : profile?.apiKeyFromEnv
                          ? 'Using ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY environment variable.'
                          : 'Enter your API key'
                    }
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
                  {profile?.apiKeyConfigured ? (
                    'API key saved locally.'
                  ) : profile?.apiKeyFromEnv ? (
                    'Using shell env (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY). Saving a key here overrides it.'
                  ) : (
                    <>
                      Get your API key from{' '}
                      <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                        Anthropic Console
                      </a>
                    </>
                  )}
                </span>
              </label>

              <label className="provider-field">
                <span className="provider-field-label">Base URL <em>Optional</em></span>
                <input
                  className="input mono"
                  type="url"
                  value={baseUrlInput}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  placeholder="https://api.anthropic.com/v1"
                  spellCheck={false}
                />
                <span className="provider-field-hint">
                  Leave empty to use https://api.anthropic.com/v1.
                </span>
              </label>

              <div className="provider-connection-actions">
                <div className="provider-connection-status">
                  <KeyRound size={13} />
                  <span>{profile?.baseUrl ? 'Custom endpoint' : 'Default endpoint'}</span>
                </div>
                <button className="shell-button muted" type="button" onClick={saveConnectionSettings}>
                  <Save size={14} />
                  Save
                </button>
              </div>
            </div>
          )}

          {enabled && (() => {
            const efforts = profile?.modelEfforts ?? {};
            async function setModelEffort(model: string, effort: string) {
              try {
                const nextState = await saveProviderProfile(activeProvider, {
                  modelEffort: { model, effort },
                });
                useMarketStore.getState().setState(nextState);
              } catch { /* ignore */ }
            }
            return (
            <>
              <div className="models-panel">
                <div className="models-panel-head">
                  <strong>Models</strong>
                  <button className="shell-button muted" type="button" onClick={loadModels} disabled={loading}>
                    {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                    Fetch
                  </button>
                </div>

                <div className="settings-search models-search">
                  <Search size={17} />
                  <input
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Search models..."
                  />
                </div>

                {isAnthropic && (
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
                        placeholder="global.anthropic.claude-opus-4-6-v1"
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
                    <span className="provider-field-hint">
                      支持任意 Anthropic Messages API 兼容的 model ID（含 Bedrock inference profile）。
                    </span>
                  </div>
                )}

                {(() => {
                  const customSlugs = new Set(profile?.customModels ?? []);
                  const cachedSlugs = new Set(models.map((m) => m.slug));
                  const orphanCustomOptions = (profile?.customModels ?? [])
                    .filter((slug) => !cachedSlugs.has(slug))
                    .map((slug) => ({
                      slug,
                      displayName: slug,
                      description: 'Custom model',
                      visibility: 'public',
                      supportedInApi: true,
                      defaultReasoningEffort: 'medium',
                      supportedReasoningEfforts: ['medium'],
                      contextWindow: null,
                      preferWebsockets: false,
                      custom: true,
                    }));
                  const allVisible = [...orphanCustomOptions, ...visibleModels].filter((m) => {
                    const kw = modelSearch.trim().toLowerCase();
                    if (!kw) return true;
                    return `${m.displayName} ${m.slug} ${m.description}`.toLowerCase().includes(kw);
                  });
                  const customGroup = allVisible.filter((m) => m.custom || customSlugs.has(m.slug));
                  const officialGroup = allVisible.filter((m) => !(m.custom || customSlugs.has(m.slug)));

                  const renderRow = (m: (typeof allVisible)[number]) => {
                    const isSelected = selectedModels.has(m.slug);
                    const isCustom = Boolean(m.custom) || customSlugs.has(m.slug);
                    const modelEffortOptions = m.supportedReasoningEfforts?.length
                      ? m.supportedReasoningEfforts
                      : [];
                    const currentEffort = efforts[m.slug] ?? m.defaultReasoningEffort ?? 'medium';
                    return (
                      <div className={`model-row ${isSelected ? 'selected' : ''}`} key={m.slug}>
                        <div
                          className="model-copy"
                          onClick={() => toggleModel(m.slug, m.defaultReasoningEffort)}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="model-title-row">
                            <strong>{m.displayName || m.slug}</strong>
                            <span className="model-slug">{m.slug}</span>
                          </div>
                          <div className="model-meta-row">
                            <span>{formatContextWindow(m.contextWindow)}</span>
                          </div>
                          {isSelected && modelEffortOptions.length > 0 && (
                            <div className="effort-pills model-effort-pills" onClick={(e) => e.stopPropagation()}>
                              {modelEffortOptions.map((o) => (
                                <button
                                  key={o}
                                  type="button"
                                  className={`effort-pill ${currentEffort === o ? 'active' : ''}`}
                                  onClick={() => setModelEffort(m.slug, o)}
                                >
                                  {o}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {isCustom && (
                          <button
                            className="shell-button icon muted"
                            type="button"
                            title="删除自定义模型"
                            onClick={(e) => { e.stopPropagation(); void removeCustomModel(m.slug); }}
                          >
                            <X size={14} />
                          </button>
                        )}
                        <label className="switch-row model-toggle" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleModel(m.slug, m.defaultReasoningEffort)}
                          />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    );
                  };

                  return (
                    <>
                      {(models.length > 0 || customGroup.length > 0) && (
                        <div className="models-showing">
                          Showing {customGroup.length + officialGroup.length} model{customGroup.length + officialGroup.length !== 1 ? 's' : ''}
                        </div>
                      )}
                      <div className="model-list">
                        {customGroup.length > 0 && (
                          <>
                            <div className="model-group-label">自定义</div>
                            {customGroup.map(renderRow)}
                          </>
                        )}
                        {officialGroup.length > 0 && (
                          <>
                            <div className="model-group-label">来自 /v1/models</div>
                            {officialGroup.map(renderRow)}
                          </>
                        )}
                        {models.length > 0 && customGroup.length + officialGroup.length === 0 && (
                          <div className="empty-state">No models match this search.</div>
                        )}
                        {models.length === 0 && customGroup.length === 0 && !loading && (
                          <div className="empty-state">点击 Fetch 拉取模型列表。</div>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            </>
            );
          })()}

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
