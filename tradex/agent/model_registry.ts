import { AgentConfig } from "../config/index.js";
import { ANTHROPIC_PROVIDER, CODEX_PROVIDER, AgentModelProfile, normalizeApiMode, normalizeModel, normalizeProvider, normalizeReasoningEffort, resolveAgentModel } from "../config/agent_models.js";
import { AgentLLMProvider } from "./loop.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { CodexProvider } from "./providers/codex.js";

export class LLMProviderUnavailable extends Error {}

export type ProviderFactory = (config: AgentConfig, profile: AgentModelProfile) => AgentLLMProvider;
export type ModelLister = (config: AgentConfig, profile: AgentModelProfile) => Promise<Array<Record<string, unknown>>>;

export interface AgentModelProvider {
  name: string;
  factory: ProviderFactory;
  listModels: ModelLister;
}

export class AgentModelRegistry {
  private readonly providers = new Map<string, AgentModelProvider>();

  register(provider: AgentModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  resolve(config: AgentConfig): AgentModelProfile {
    return resolveAgentModel(config);
  }

  createProvider(config: AgentConfig): AgentLLMProvider {
    const profile = this.resolve(config);
    const provider = this.providers.get(profile.provider);
    if (!provider) throw new LLMProviderUnavailable(`Unsupported agent provider: ${profile.provider}`);
    return provider.factory(config, profile);
  }

  async listAvailableModels(config: AgentConfig, providerOverride?: string | null): Promise<Array<Record<string, unknown>>> {
    const profile = providerOverride
      ? {
          provider: normalizeProvider(providerOverride),
          apiMode: normalizeApiMode(providerOverride),
          model: normalizeModel(providerOverride, null),
          reasoningEffort: normalizeReasoningEffort(null),
          supportsReasoning: true,
          requiresAccountId: providerOverride === CODEX_PROVIDER,
        }
      : this.resolve(config);
    const provider = this.providers.get(profile.provider);
    if (!provider) throw new LLMProviderUnavailable(`Unsupported agent provider: ${profile.provider}`);
    return provider.listModels(config, profile);
  }
}

export function defaultAgentModelRegistry(): AgentModelRegistry {
  const registry = new AgentModelRegistry();
  registry.register({
    name: CODEX_PROVIDER,
    factory: (config, profile) => new CodexProvider(config, profile),
    listModels: (config, profile) => new CodexProvider(config, profile).listModels(),
  });
  registry.register({
    name: ANTHROPIC_PROVIDER,
    factory: (config, profile) => new AnthropicProvider(config, profile),
    listModels: (config, profile) => new AnthropicProvider(config, profile).listModels(),
  });
  return registry;
}

export const DEFAULT_AGENT_MODEL_REGISTRY = defaultAgentModelRegistry();
