/**
 * runtime.ts — AgentRuntime with mutable model support.
 *
 * The runtime holds a `currentModel` that can be swapped mid-session.
 * Each `run()` call uses whatever model is current at invocation time.
 */

import { AgentConfig } from "../config/index.js";
import type { AgentModel } from "./models.js";
import { resolveAgentModelFromConfig } from "./models.js";
import { AgentEventHandler, AgentLoop, LoopResult } from "./loop.js";
import { ToolRegistry } from "./tools/registry.js";

// Ensure built-in providers are registered
import "./providers/register.js";

export class AgentRuntime {
  readonly config: AgentConfig;
  private _model: AgentModel;

  constructor(input: { config: AgentConfig; model?: AgentModel }) {
    this.config = input.config;
    this._model = input.model ?? resolveAgentModelFromConfig(input.config);
  }

  /** Current model. Swap this to change provider/model mid-session. */
  get model(): AgentModel {
    return this._model;
  }

  /** Switch to a different model. Takes effect on the next run() call. */
  setModel(model: AgentModel): void {
    this._model = model;
  }

  async run(input: { message: string; tools: ToolRegistry; history?: Array<Record<string, unknown>>; systemPrompt?: string | null; eventHandler?: AgentEventHandler | null; maxIterations?: number }): Promise<LoopResult> {
    return new AgentLoop({ model: this._model, tools: input.tools, systemPrompt: input.systemPrompt, maxIterations: input.maxIterations }).run({
      userMessage: input.message,
      conversationHistory: input.history ?? [],
      eventHandler: input.eventHandler ?? null,
    });
  }
}
