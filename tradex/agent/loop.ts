import { ToolCall, ToolRegistry, ToolResult } from "./tools/registry.js";

export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_SYSTEM_PROMPT = `你是一名做加密货币永续合约的职业 trader，擅长 price action 与 Smart Money Concepts，习惯用衍生品数据交叉验证判断。默认中文，结论先于论据；涉及行情、K 线、持仓、成交、新闻的事实判断必须先调工具。`;

export type StreamDeltaHandler = (delta: string) => Promise<void> | void;
export type AgentEventHandler = (event: Record<string, unknown>) => Promise<void> | void;

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

export class AgentLoop {
  readonly provider: AgentLLMProvider;
  readonly tools: ToolRegistry;
  readonly systemPrompt: string;
  readonly maxIterations: number;

  constructor(input: { provider: AgentLLMProvider; tools: ToolRegistry; systemPrompt?: string | null; maxIterations?: number }) {
    this.provider = input.provider;
    this.tools = input.tools;
    this.systemPrompt = input.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  async run(input: { userMessage: string; conversationHistory?: Array<Record<string, unknown>> | null; eventHandler?: AgentEventHandler | null }): Promise<LoopResult> {
    const messages = this.buildMessages(input.userMessage, input.conversationHistory ?? []);
    const toolSchemas = this.tools.openaiToolSchemas();
    const steps: LoopStep[] = [];
    const transcript: TranscriptMessage[] = [];
    let totalTokens = 0;
    let promptTokens = 0;
    await emit(input.eventHandler, { type: "agent_start" });
    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      await emit(input.eventHandler, { type: "turn_start", iteration });
      try {
        const response = await this.provider.chat({
          messages,
          tools: toolSchemas.length ? toolSchemas : null,
          onDelta: async (delta) => emit(input.eventHandler, { type: "message_update", delta }),
        });
        totalTokens += response.usage.total_tokens ?? response.usage.totalTokens ?? 0;
        promptTokens += response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0;
        if (response.content) {
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
          const result = await this.tools.execute(call);
          steps.push({ stepType: "tool_result", toolResult: result, timestamp: Date.now() / 1000 });
          await emit(input.eventHandler, { type: "tool_result", toolResult: toolResultPayload(result) });
          messages.push({ role: "tool", tool_call_id: result.callId, name: result.name, content: result.output });
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
    return [{ role: "system", content: this.systemPrompt }, ...history, { role: "user", content: userMessage }];
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
