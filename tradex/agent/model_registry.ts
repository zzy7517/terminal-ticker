/**
 * model_registry.ts — Backward-compatible registry that bridges the old
 * factory-based interface with the new AgentModel + API Registry pattern.
 *
 * The AgentModelRegistry is still used by:
 *  - api/routes/agent.ts for listAvailableModels()
 *  - memory pipeline (via LLMProviderFactory)
 *
 * Internally it now delegates to resolveAgentModelFromConfig + getApiStream/getApiListModels.
 */

import { AgentConfig } from "../config/index.js";
import { ANTHROPIC_PROVIDER, CODEX_PROVIDER, normalizeApiMode, normalizeModel, normalizeProvider, normalizeReasoningEffort } from "../config/agent_models.js";
import type { LLMChatClient } from "./llm_client.js";
import type { AgentModel } from "./models.js";
import { resolveAgentModelFromConfig } from "./models.js";
import { getApiStream, getApiListModels } from "./api_registry.js";

// Ensure built-in providers are registered
import "./providers/register.js";

export class LLMProviderUnavailable extends Error {}

/**
 * AgentModelRegistry — resolves config into AgentModel and provides
 * backward-compatible createProvider() for the memory pipeline.
 */
export class AgentModelRegistry {
  /**
   * Resolve config into an AgentModel value object.
   */
  resolve(config: AgentConfig): AgentModel {
    return resolveAgentModelFromConfig(config);
  }

  /**
   * Create an LLMChatClient from config.
   * Wraps the registry-based dispatch into the lightweight chat interface
   * used by non-agentic consumers like the memory pipeline.
   */
  createProvider(config: AgentConfig): LLMChatClient {
    const model = this.resolve(config);
    const streamFn = getApiStream(model.api);
    return {
      name: model.provider,
      model: model.id,
      async chat(input) {
        return streamFn(model, input);
      },
    };
  }

  /**
   * List available models for a provider.
   */
  async listAvailableModels(config: AgentConfig, providerOverride?: string | null): Promise<Array<Record<string, unknown>>> {
    let model: AgentModel;
    if (providerOverride) {
      const provider = normalizeProvider(providerOverride);
      const apiMode = normalizeApiMode(provider);
      model = {
        id: normalizeModel(provider, null),
        provider,
        api: apiMode,
        baseUrl: "",
        reasoningEffort: normalizeReasoningEffort(null),
        apiKey: "",
      };
      // Fill in credentials from the config profiles
      const fullConfig: AgentConfig = { ...config, provider, apiMode, model: model.id };
      model = resolveAgentModelFromConfig(fullConfig);
    } else {
      model = this.resolve(config);
    }
    const listFn = getApiListModels(model.api);
    return listFn(model);
  }
}

export const DEFAULT_AGENT_MODEL_REGISTRY = new AgentModelRegistry();
