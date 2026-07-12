/**
 * registry.ts — Convenience wrapper around AgentModel resolution +
 * remote model catalog fetch.
 *
 * Used by:
 *  - api/routes/agent.ts for listAvailableModels()
 *  - memory pipeline (via LLMProviderFactory)
 */

import { AgentConfig } from "../../config/index.js";
import {
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
} from "./constants.js";
import type { LLMChatClient, ChatResponse } from "../llm_client.js";
import type { AgentModel } from "./resolve.js";
import { resolveAgentModelFromConfig } from "./resolve.js";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ModelRuntimeSnapshot } from "./runtime.js";
import { fetchProviderModelCatalog } from "./model_fetch.js";

export class LLMProviderUnavailable extends Error {}

/**
 * AgentModelRegistry — resolves config into AgentModel and provides
 * a simple chat client for the memory pipeline.
 */
export class AgentModelRegistry {
  constructor(private readonly modelRuntime: ModelRuntimeSnapshot) {}

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
    const { model, modelRegistry, requiresAuth } = this.modelRuntime.resolve(config);
    return {
      name: model.provider,
      model: model.id,
      async chat({ system, messages, onDelta }): Promise<ChatResponse> {
        const auth = await modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new LLMProviderUnavailable(auth.error);
        const stream = streamSimple(model, {
          systemPrompt: system ?? "",
          messages: convertToLlm(messages),
          tools: [],
        }, {
          apiKey: auth.apiKey,
          headers: requiresAuth
            ? auth.headers
            : {
                ...auth.headers,
                Authorization: null as unknown as string,
              },
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

  /** Fetch available models from the provider's remote catalog. */
  async listAvailableModels(
    config: AgentConfig,
    providerOverride?: string | null,
  ): Promise<Array<Record<string, unknown>>> {
    return fetchProviderModelCatalog(config, providerOverride);
  }
}

// Re-export the supported provider constants so callers don't have to import
// from config to know what's registered.
export { ANTHROPIC_PROVIDER, CODEX_PROVIDER };
