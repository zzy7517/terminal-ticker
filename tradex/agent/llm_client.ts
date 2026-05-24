/**
 * llm_client.ts — Lightweight LLM chat client interface.
 *
 * Used by code paths that only need a single, non-streaming, non-agentic
 * `chat({ messages, tools? })` call (e.g. the memory pipeline). For multi-turn
 * tool-calling work, use the stateful `Agent` class in `core/` instead.
 */

import type { ToolCall } from "./tools/registry.js";

export type StreamDeltaHandler = (delta: string) => Promise<void> | void;

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Record<string, number>;
}

export interface LLMChatClient {
  name: string;
  model: string;
  chat(input: {
    messages: Array<Record<string, unknown>>;
    tools?: Array<Record<string, unknown>> | null;
    onDelta?: StreamDeltaHandler | null;
  }): Promise<ChatResponse>;
}
