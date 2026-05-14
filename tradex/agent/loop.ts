import { ToolCall, ToolRegistry, ToolResult } from "./tools/registry.js";
import type { AgentModel } from "./models.js";
import { getApiStream } from "./api_registry.js";

export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_SYSTEM_PROMPT = `你是一名做加密货币永续合约的职业 trader，擅长 price action 与 Smart Money Concepts，习惯用衍生品数据交叉验证判断。默认中文，结论先于论据；涉及行情、K 线、持仓、成交、新闻的事实判断必须先调工具。`;

// ---- Loop-level hooks ----

/**
 * Context passed to all loop hooks after a turn completes.
 */
export interface TurnContext {
  /** Current iteration (1-based) */
  iteration: number;
  /** Accumulated token usage */
  totalTokens: number;
  promptTokens: number;
  /** The full messages array (system + history + tool results so far) */
  messages: Array<Record<string, unknown>>;
  /** The model's response from this turn */
  lastResponse: ChatResponse;
  /** All steps executed so far */
  steps: LoopStep[];
}

/**
 * Partial update returned from prepareNextTurn.
 * Only provided fields take effect; omitted fields keep their current value.
 */
export interface NextTurnUpdate {
  /** Replace the model for subsequent turns (enables mid-conversation model switching) */
  model?: AgentModel;
  /** Replace the system prompt */
  systemPrompt?: string;
  /** Replace the tool registry */
  tools?: ToolRegistry;
  /** Replace the messages array (e.g. for context compression) */
  messages?: Array<Record<string, unknown>>;
}

/**
 * Loop-level lifecycle hooks.
 * All hooks are optional. When not provided, the loop behaves exactly as before.
 */
export interface LoopHooks {
  /**
   * Called after prepareNextTurn. Return true to gracefully stop the loop.
   * Use for: token budget limits, external stop signals, business-logic gates.
   */
  shouldStop?: (ctx: TurnContext) => boolean | Promise<boolean>;

  /**
   * Called after tool execution completes, before shouldStop.
   * Return a partial update to adjust the next turn's configuration.
   * Use for: model escalation, context compression, dynamic tool exposure.
   */
  prepareNextTurn?: (ctx: TurnContext) => NextTurnUpdate | void | Promise<NextTurnUpdate | void>;

  /**
   * Called after shouldStop (if not stopping). Returned messages are appended
   * to the conversation before the next LLM call.
   * Use for: user mid-conversation steering via WebSocket, injecting system notes.
   */
  getSteeringMessages?: (ctx: TurnContext) => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;
}

export type StreamDeltaHandler = (delta: string) => Promise<void> | void;
export type AgentEventHandler = (event: Record<string, unknown>) => Promise<void> | void;

/**
 * Legacy interface kept for backward compatibility with memory pipeline.
 * New code should use AgentModel + api_registry directly.
 */
export interface AgentLLMProvider {
  name: string;
  model: string;
  chat(input: { messages: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> | null; onDelta?: StreamDeltaHandler | null }): Promise<ChatResponse>;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Record<string, number>;
}

export interface LoopStep {
  stepType: "tool_call" | "tool_result";
  toolCall?: ToolCall | null;
  toolResult?: ToolResult | null;
  timestamp: number;
}

export interface TranscriptMessage {
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  error?: string | null;
}

export interface LoopResult {
  content: string;
  steps: LoopStep[];
  messages: TranscriptMessage[];
  iterations: number;
  totalTokens: number;
  promptTokens: number;
  finished: boolean;
  error: string | null;
}

/**
 * AgentLoop — drives multi-turn tool-calling conversations.
 *
 * Now takes an AgentModel value object instead of a provider instance.
 * Each LLM call dispatches through the global API registry based on model.api.
 *
 * Alternatively, a legacy AgentLLMProvider can still be passed for backward compat.
 */
export class AgentLoop {
  private currentModel: AgentModel | null;
  readonly legacyProvider: AgentLLMProvider | null;
  private currentTools: ToolRegistry;
  private currentSystemPrompt: string;
  readonly maxIterations: number;
  readonly hooks: LoopHooks;

  constructor(input: { model?: AgentModel | null; provider?: AgentLLMProvider | null; tools: ToolRegistry; systemPrompt?: string | null; maxIterations?: number; hooks?: LoopHooks }) {
    this.currentModel = input.model ?? null;
    this.legacyProvider = input.provider ?? null;
    if (!this.currentModel && !this.legacyProvider) {
      throw new Error("AgentLoop requires either a model or a provider");
    }
    this.currentTools = input.tools;
    this.currentSystemPrompt = input.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.hooks = input.hooks ?? {};
  }

  get model(): AgentModel | null { return this.currentModel; }
  get tools(): ToolRegistry { return this.currentTools; }
  get systemPrompt(): string { return this.currentSystemPrompt; }

  private async chat(input: { messages: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> | null; onDelta?: StreamDeltaHandler | null }): Promise<ChatResponse> {
    if (this.currentModel) {
      const streamFn = getApiStream(this.currentModel.api);
      return streamFn(this.currentModel, input);
    }
    return this.legacyProvider!.chat(input);
  }

  async run(input: { userMessage: string; conversationHistory?: Array<Record<string, unknown>> | null; eventHandler?: AgentEventHandler | null }): Promise<LoopResult> {
    const messages = this.buildMessages(input.userMessage, input.conversationHistory ?? []);
    const steps: LoopStep[] = [];
    const transcript: TranscriptMessage[] = [];
    let totalTokens = 0;
    let promptTokens = 0;
    await emit(input.eventHandler, { type: "agent_start" });
    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      await emit(input.eventHandler, { type: "turn_start", iteration });
      try {
        // Resolve tool schemas each iteration (hooks may swap the registry)
        const toolSchemas = this.currentTools.openaiToolSchemas();
        const response = await this.chat({
          messages,
          tools: toolSchemas.length ? toolSchemas : null,
          onDelta: async (delta) => emit(input.eventHandler, { type: "message_update", delta }),
        });
        totalTokens += response.usage.total_tokens ?? response.usage.totalTokens ?? 0;
        promptTokens += response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0;
        if (response.content && response.toolCalls.length === 0) {
          messages.push({ role: "assistant", content: response.content });
          transcript.push({ role: "assistant", content: response.content, metadata: usageMetadata(response.usage) });
        }
        if (response.toolCalls.length === 0) {
          await emit(input.eventHandler, agentEndEvent(response.content || "", totalTokens, promptTokens, null));
          return { content: response.content || "", steps, messages: transcript, iterations: iteration, totalTokens, promptTokens, finished: true, error: null };
        }
        messages.push({ role: "assistant", content: response.content || "", tool_calls: openaiToolCallPayloads(response.toolCalls) });
        for (const call of response.toolCalls) {
          steps.push({ stepType: "tool_call", toolCall: call, timestamp: Date.now() / 1000 });
          await emit(input.eventHandler, { type: "tool_call", toolCall: toolCallPayload(call) });
          const result = await this.currentTools.execute(call);
          steps.push({ stepType: "tool_result", toolResult: result, timestamp: Date.now() / 1000 });
          await emit(input.eventHandler, { type: "tool_result", toolResult: toolResultPayload(result) });
          messages.push({ role: "tool", tool_call_id: result.callId, name: result.name, content: result.output });
        }

        // ---- Loop hooks (fire after tool execution, before next iteration) ----
        const turnCtx: TurnContext = { iteration, totalTokens, promptTokens, messages, lastResponse: response, steps };

        // ② prepareNextTurn — adjust configuration for the next turn
        if (this.hooks.prepareNextTurn) {
          const update = await this.hooks.prepareNextTurn(turnCtx);
          if (update) {
            if (update.model) this.currentModel = update.model;
            if (update.systemPrompt) {
              this.currentSystemPrompt = update.systemPrompt;
              messages[0] = { role: "system", content: update.systemPrompt };
            }
            if (update.tools) this.currentTools = update.tools;
            if (update.messages) messages.splice(0, messages.length, ...update.messages);
          }
        }

        // ① shouldStop — graceful early termination
        if (this.hooks.shouldStop) {
          if (await this.hooks.shouldStop(turnCtx)) {
            const content = response.content || "Stopped by loop hook";
            await emit(input.eventHandler, agentEndEvent(content, totalTokens, promptTokens, null));
            return { content, steps, messages: transcript, iterations: iteration, totalTokens, promptTokens, finished: true, error: null };
          }
        }

        // ③ getSteeringMessages — inject external messages before next turn
        if (this.hooks.getSteeringMessages) {
          const steering = await this.hooks.getSteeringMessages(turnCtx);
          for (const msg of steering) messages.push(msg);
        }

      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await emit(input.eventHandler, { type: "error", error: text });
        await emit(input.eventHandler, agentEndEvent(text, totalTokens, promptTokens, text));
        return { content: text, steps, messages: transcript, iterations: iteration, totalTokens, promptTokens, finished: false, error: text };
      }
    }
    const error = "Agent loop reached max iterations";
    await emit(input.eventHandler, agentEndEvent(error, totalTokens, promptTokens, error));
    return { content: error, steps, messages: transcript, iterations: this.maxIterations, totalTokens, promptTokens, finished: false, error };
  }

  private buildMessages(userMessage: string, history: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return [{ role: "system", content: this.currentSystemPrompt }, ...history, { role: "user", content: userMessage }];
  }
}

function toolCallPayload(call: ToolCall): Record<string, unknown> {
  return { id: call.id, name: call.name, arguments: call.arguments };
}

function toolResultPayload(result: ToolResult): Record<string, unknown> {
  return { callId: result.callId, name: result.name, output: result.output.slice(0, 2000), error: result.error };
}

function openaiToolCallPayloads(toolCalls: ToolCall[]): Array<Record<string, unknown>> {
  return toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
}

function usageMetadata(usage: Record<string, number>): Record<string, unknown> {
  return { usage };
}

function agentEndEvent(content: string, totalTokens: number, promptTokens: number, error: string | null): Record<string, unknown> {
  return { type: "agent_end", content, totalTokens, promptTokens, error };
}

async function emit(handler: AgentEventHandler | null | undefined, event: Record<string, unknown>): Promise<void> {
  if (!handler) return;
  await handler(event);
}
