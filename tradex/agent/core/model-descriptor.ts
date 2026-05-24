/**
 * core/model-descriptor.ts — Bridges the runtime AgentModel value object
 * (which carries credentials and is resolved per-request from AgentConfig)
 * to the pure-data AgentModelDescriptor consumed by the Agent core.
 *
 * Also owns the capability lookup that decides whether a given model accepts
 * image inputs. Modeled after pi's per-model `Model.input` field, but kept
 * simple here since tradex only ships codex + anthropic today.
 */

import type { AgentModel } from "../models.js";
import type { AgentModelDescriptor } from "./types.js";
import { ANTHROPIC_PROVIDER, CODEX_PROVIDER } from "../../config/agent_models.js";

/**
 * Decide which input modalities a given model accepts.
 *
 * Defaults are conservative: text-only unless the model is known to support
 * images. Add more entries as you onboard new vision-capable models. For
 * unknown models we play it safe and disable image support so the
 * capability transform downgrades images to a placeholder rather than
 * letting the provider reject the request.
 */
export function inputsForModel(provider: string, modelId: string): ("text" | "image")[] {
  if (provider === ANTHROPIC_PROVIDER) {
    // Every shipping Claude 3+ model accepts images.
    return ["text", "image"];
  }

  if (provider === CODEX_PROVIDER) {
    // GPT-4o, GPT-4.1, GPT-5 families accept images. Reasoning-only
    // (o1-mini / o3-mini / o4-mini) do not.
    const id = modelId.toLowerCase();
    const visionPatterns = ["gpt-4o", "gpt-4.1", "gpt-5", "gpt-4-vision", "o1", "o3", "o4"];
    const reasoningOnly = ["o1-mini", "o3-mini", "o4-mini"];
    if (reasoningOnly.some((p) => id.includes(p))) return ["text"];
    if (visionPatterns.some((p) => id.includes(p))) return ["text", "image"];
    return ["text"];
  }

  return ["text"];
}

/** Convert an AgentModel into the pure-data descriptor passed to providers. */
export function agentModelToDescriptor(model: AgentModel): AgentModelDescriptor {
  return {
    id: model.id,
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoningEffort: model.reasoningEffort,
    accountId: model.accountId,
    inputs: inputsForModel(model.provider, model.id),
  };
}
