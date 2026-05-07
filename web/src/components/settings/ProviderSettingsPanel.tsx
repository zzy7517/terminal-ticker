import { useState } from 'react';
import { Bot, Loader2, RefreshCw, Search, Sparkles } from 'lucide-react';
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

  const models = modelCache[activeProvider] ?? [];

  const option = AGENT_PROVIDER_OPTIONS.find((o) => o.provider === activeProvider) ?? AGENT_PROVIDER_OPTIONS[0];
  const profile = profiles[activeProvider];
  const enabled = profile?.enabled ?? false;
  const selectedModels = new Set(profile?.models ?? []);

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
                    {o.provider === 'anthropic' ? <Sparkles size={18} /> : <Bot size={18} />}
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
              <div className="provider-empty">No providers match this search.</div>
            )}
          </div>
        </section>

        {/* ── Right: detail panel ── */}
        <section className="provider-detail">
          <div className="provider-hero">
            <div className="provider-hero-title">
              <h3>{option.label}</h3>
              {enabled && <span className="provider-state-badge active">Active</span>}
              <label className="switch-row provider-hero-toggle" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={enabled} onChange={toggleEnabled} />
                <span className="switch-slider" />
              </label>
            </div>
            <p>{option.detail}</p>
          </div>

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

                {models.length > 0 && (
                  <div className="models-showing">
                    Showing {visibleModels.length} model{visibleModels.length !== 1 ? 's' : ''}
                  </div>
                )}

                <div className="model-list">
                  {visibleModels.map((m) => {
                    const isSelected = selectedModels.has(m.slug);
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
                  })}
                  {models.length > 0 && visibleModels.length === 0 && (
                    <div className="provider-empty">No models match this search.</div>
                  )}
                  {models.length === 0 && !loading && (
                    <div className="provider-empty">点击 Fetch 拉取模型列表。</div>
                  )}
                </div>
              </div>
            </>
            );
          })()}

          {!enabled && (
            <div className="provider-empty provider-disabled-hint">
              启用此 provider 后可以选择模型并在对话中使用。
            </div>
          )}

          <div className="provider-status-bar">{status}</div>
        </section>
      </div>
    </>
  );
}
