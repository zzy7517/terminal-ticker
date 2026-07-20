/**
 * Provider/model 本地偏好持久化与模型目录选择的纯函数。
 * agentStore 负责状态编排；本模块不触碰 store。
 */
import type { AgentModelRegistry, AgentSessionResponse } from '../../types';

const STORAGE_KEY_PROVIDER = 'tradex-agent-provider';
const STORAGE_KEY_MODELS = 'tradex-agent-models-by-provider';

export function loadPersistedProvider(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_PROVIDER);
    if (stored) return stored;
  } catch {}
  return '';
}

export function loadPersistedModels(): Record<string, string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_MODELS);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    }
  } catch {}
  return {};
}

export function persistProviderModel(provider: string, model: string): void {
  try {
    localStorage.setItem(STORAGE_KEY_PROVIDER, provider);
    const models = loadPersistedModels();
    if (provider && model) models[provider] = model;
    localStorage.setItem(STORAGE_KEY_MODELS, JSON.stringify(models));
  } catch {}
}

export function selectableModels(registry: AgentModelRegistry | null, provider?: string) {
  return registry?.models.filter((model) => (
    model.selected && model.runnable && (!provider || model.providerId === provider)
  )) ?? [];
}

/** 在目录内解析 provider/model 选择，优先当前值，其次本地记忆，最后回退第一个可运行模型。 */
export function registrySelection(
  registry: AgentModelRegistry,
  provider: string,
  model: string,
): { provider: string; model: string } {
  const persistedModels = loadPersistedModels();
  const canonicalProvider = registry.providers.find((item) => (
    item.providerId === provider || item.configProviderId === provider
  ))?.providerId ?? provider;
  const providerModels = selectableModels(registry, canonicalProvider);
  const remembered = persistedModels[canonicalProvider] ?? persistedModels[provider];
  const selected = providerModels.find((item) => item.id === model)
    ?? providerModels.find((item) => item.id === remembered)
    ?? providerModels[0]
    ?? selectableModels(registry)[0];
  return selected
    ? { provider: selected.providerId, model: selected.id }
    : { provider: canonicalProvider, model };
}

/** Session 携带的 provider/model 写回本地偏好，并给出 store 补丁。 */
export function sessionProviderModel(
  payload: AgentSessionResponse | null,
): { agentProvider?: string; agentModel?: string } {
  const session = payload?.session;
  if (!session?.provider || !session.model) return {};
  persistProviderModel(session.provider, session.model);
  return { agentProvider: session.provider, agentModel: session.model };
}
