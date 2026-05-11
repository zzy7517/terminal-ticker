import { AgentConfig } from "../config/index.js";
import { AgentEventHandler, AgentLoop, LoopResult } from "./loop.js";
import { DEFAULT_AGENT_MODEL_REGISTRY, AgentModelRegistry } from "./model_registry.js";
import { ToolRegistry } from "./tools/registry.js";

export class AgentRuntime {
  readonly config: AgentConfig;
  readonly registry: AgentModelRegistry;

  constructor(input: { config: AgentConfig; registry?: AgentModelRegistry }) {
    this.config = input.config;
    this.registry = input.registry ?? DEFAULT_AGENT_MODEL_REGISTRY;
  }

  async run(input: { message: string; tools: ToolRegistry; history?: Array<Record<string, unknown>>; systemPrompt?: string | null; eventHandler?: AgentEventHandler | null }): Promise<LoopResult> {
    const provider = this.registry.createProvider(this.config);
    return new AgentLoop({ provider, tools: input.tools, systemPrompt: input.systemPrompt }).run({
      userMessage: input.message,
      conversationHistory: input.history ?? [],
      eventHandler: input.eventHandler ?? null,
    });
  }
}
