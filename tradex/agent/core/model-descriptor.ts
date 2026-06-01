/**
 * core/model-descriptor.ts — Bridges the runtime AgentModel value object
 * (which carries credentials and is resolved per-request from AgentConfig)
 * to the pure-data AgentModelDescriptor consumed by the Agent core.
 *
 * Also owns the capability lookup that decides whether a given model accepts
 * image inputs. Uses the models-metadata registry for accurate contextWindow,
 * maxTokens, and cost data.
 */

import type { AgentModel } from "../models.js";
import type { AgentModelDescriptor } from "./types.js";
import { ANTHROPIC_PROVIDER, CODEX_PROVIDER, OPENAI_PROVIDER } from "../../config/agent_models.js";
import { lookupModelMetadata } from "./models-metadata.js";

/**
 * Decide which input modalities a given model accepts.
 *
 * First checks the models-metadata registry. Falls back to provider-based
 * heuristics for unknown models. Conservative: text-only unless the model
 * is known to support images.
 */
export function inputsForModel(provider: string, modelId: string): ("text" | "image")[] {
  // Check registry first
  const meta = lookupModelMetadata(modelId);
  if (meta) return meta.inputs;

  // Fallback heuristics
  if (provider === ANTHROPIC_PROVIDER) {
    // Every shipping Claude 3+ model accepts images.
    return ["text", "image"];
  }

  if (provider === CODEX_PROVIDER || provider === OPENAI_PROVIDER) {
    const id = modelId.toLowerCase();
    const visionPatterns = ["gpt-4o", "gpt-4.1", "gpt-5", "gpt-4-vision", "o1", "o3", "o4"];
    const reasoningOnly = ["o1-mini", "o3-mini", "o4-mini"];
    if (reasoningOnly.some((p) => id.includes(p))) return ["text"];
    if (visionPatterns.some((p) => id.includes(p))) return ["text", "image"];
    return ["text"];
  }

  return ["text"];
}

/**
 * Convert an AgentModel into the pure-data descriptor passed to providers.
 * Enriches with metadata from the models registry (contextWindow, maxTokens, cost).
 */
export function agentModelToDescriptor(model: AgentModel): AgentModelDescriptor {
  const meta = lookupModelMetadata(model.id);

  return {
    id: model.id,
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoningEffort: model.reasoningEffort,
    accountId: model.accountId,
    inputs: inputsForModel(model.provider, model.id),
    contextWindow: meta?.contextWindow,
    maxTokens: meta?.maxTokens,
    cost: meta?.cost,
  };
}
