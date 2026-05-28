/**
 * model_registry.ts — Convenience wrapper around AgentModel resolution + the
 * api_registry.
 *
 * Used by:
 *  - api/routes/agent.ts for listAvailableModels()
 *  - memory pipeline (via LLMProviderFactory)
 *
 * Internally delegates to resolveAgentModelFromConfig + getApiStream /
 * getApiListModels. memory's LLMChatClient.chat() shape is implemented here so
 * memory consumers don't have to know about the provider stream contract.
 */

import { AgentConfig } from "../config/index.js";
import {
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
  normalizeApiMode,
  normalizeModel,
  normalizeProvider,
  normalizeReasoningEffort,
} from "../config/agent_models.js";
import type { LLMChatClient, ChatResponse } from "./llm_client.js";
import type { AgentModel } from "./models.js";
import { resolveAgentModelFromConfig } from "./models.js";
import { getApiStream, getApiListModels } from "./api_registry.js";
import type { AgentContext, AgentModelDescriptor, TextContent } from "./core/types.js";
import { transformMessages } from "./core/transform-messages.js";
import { agentModelToDescriptor } from "./core/model-descriptor.js";

// Ensure built-in providers are registered
import "./providers/register.js";

export class LLMProviderUnavailable extends Error {}

/**
 * AgentModelRegistry — resolves config into AgentModel and provides
 * a simple chat client for the memory pipeline.
 */
export class AgentModelRegistry {
  /** Resolve config into an AgentModel value object. */
  resolve(config: AgentConfig): AgentModel {
    return resolveAgentModelFromConfig(config);
  }

  /**
   * Create an LLMChatClient from config. Wraps the provider stream into the
   * lightweight chat interface used by non-agentic consumers like the memory
   * pipeline.
   */
  createProvider(config: AgentConfig): LLMChatClient {
    const model = this.resolve(config);
    const descriptor = agentModelToDescriptor(model);
    const streamFn = getApiStream(descriptor.api);
    const apiKey = model.apiKey;
    return {
      name: descriptor.provider,
      model: descriptor.id,
      async chat({ system, messages, onDelta, signal }): Promise<ChatResponse> {
        const context: AgentContext = {
          systemPrompt: system ?? "",
          messages: transformMessages(messages, descriptor),
          tools: [],
        };
        const stream = streamFn(descriptor, context, {
          apiKey,
          signal,
        });
        // Forward text deltas to legacy onDelta callback while awaiting final result
        if (onDelta) {
          for await (const evt of stream) {
            if (evt.type === "text_delta" && evt.delta) {
              onDelta(evt.delta);
            }
          }
        }
        const message = await stream.result();
        const content = message.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
        return { content, message };
      },
    };
  }

  /** List available models for a provider. */
  async listAvailableModels(
    config: AgentConfig,
    providerOverride?: string | null,
  ): Promise<Array<Record<string, unknown>>> {
    let model: AgentModel;
    if (providerOverride) {
      const provider = normalizeProvider(providerOverride);
      const apiMode = normalizeApiMode(provider);
      const stub: AgentConfig = {
        ...config,
        provider,
        apiMode,
        model: normalizeModel(provider, null),
        reasoningEffort: normalizeReasoningEffort(null),
      };
      model = resolveAgentModelFromConfig(stub);
    } else {
      model = this.resolve(config);
    }
    const descriptor = agentModelToDescriptor(model);
    const listFn = getApiListModels(descriptor.api);
    return listFn(descriptor, { apiKey: model.apiKey });
  }
}

export const DEFAULT_AGENT_MODEL_REGISTRY = new AgentModelRegistry();

// Re-export the supported provider constants so callers don't have to import
// from config to know what's registered.
export { ANTHROPIC_PROVIDER, CODEX_PROVIDER };
