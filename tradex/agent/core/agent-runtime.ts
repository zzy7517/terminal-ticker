/**
 * core/agent-runtime.ts — Factory for creating Agent instances.
 *
 * Replaces the old AgentRuntime that created a fresh AgentLoop per request.
 * Now creates a long-lived Agent that persists state across prompts.
 */

import type { AgentConfig } from "../../config/index.js";
import { resolveAgentModelFromConfig } from "../models.js";
import type { ToolRegistry } from "../tools/registry.js";
import { Agent, type AgentOptions } from "./agent.js";
import { createStreamFnFromRegistry } from "./stream-adapter.js";
import { registryToAgentTools } from "./tool-adapter.js";
import type { AgentModelDescriptor, AgentTool, ThinkingLevel } from "./types.js";

// Ensure providers are registered
import "../providers/register.js";

export interface CreateAgentOptions {
  config: AgentConfig;
  tools: ToolRegistry;
  systemPrompt?: string;
  /** Override model descriptor. If not provided, resolved from config. */
  model?: AgentModelDescriptor;
  /** Initial messages (e.g., restored from session). */
  history?: Array<Record<string, unknown>>;
}

/**
 * Create a new long-lived Agent from application config.
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const resolved = resolveAgentModelFromConfig(options.config);

  const model: AgentModelDescriptor = options.model ?? {
    id: resolved.id,
    provider: resolved.provider,
    api: resolved.api,
    baseUrl: resolved.baseUrl,
    reasoningEffort: resolved.reasoningEffort,
    accountId: resolved.accountId,
  };

  const agentTools = registryToAgentTools(options.tools);
  const streamFn = createStreamFnFromRegistry();

  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt: options.systemPrompt ?? "",
      model,
      thinkingLevel: (resolved.reasoningEffort as ThinkingLevel) || "off",
      tools: agentTools,
      messages: [],
    },
    streamFn,
    apiKey: resolved.apiKey,
    getApiKey: async (provider: string) => {
      // Re-resolve from config each time to support key rotation
      const fresh = resolveAgentModelFromConfig(options.config);
      return fresh.apiKey;
    },
    toolExecution: "sequential", // Match current behavior; switch to "parallel" when ready
  };

  return new Agent(agentOptions);
}
