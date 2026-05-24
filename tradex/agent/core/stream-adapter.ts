/**
 * core/stream-adapter.ts — Wires the typed core Agent to api_registry.
 *
 * Modeled after pi: the Agent owns typed `AgentContext.messages` (Message[]),
 * and providers consume the same shape. There is no Record<string, unknown>
 * conversion in between. This file's only job is:
 *
 *   1. Look up the registered StreamFn for the model's API wire-format.
 *   2. Apply cross-cutting message transforms (capability-aware image
 *      downgrade) before handing the context to the provider.
 *
 * Anything more elaborate (thinking-block transforms, cross-provider tool
 * call ID normalization) lives in `transform-messages.ts`, mirroring pi.
 */

import { getApiStream } from "../api_registry.js";
import { transformMessages } from "./transform-messages.js";
import type { AgentContext, AgentModelDescriptor, StreamFn, StreamOptions, StreamResult } from "./types.js";

/**
 * Create a StreamFn that dispatches by API wire-format and runs message
 * transforms before the provider sees the context.
 */
export function createStreamFnFromRegistry(): StreamFn {
  return async (
    model: AgentModelDescriptor,
    context: AgentContext,
    options: StreamOptions,
  ): Promise<StreamResult> => {
    const providerStream = getApiStream(model.api);
    const transformedContext: AgentContext = {
      ...context,
      messages: transformMessages(context.messages, model),
    };
    return providerStream(model, transformedContext, options);
  };
}
