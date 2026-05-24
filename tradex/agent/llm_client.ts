/**
 * llm_client.ts — Lightweight LLM chat client interface.
 *
 * Used by code paths that only need a single, non-streaming-aware,
 * non-agentic call (e.g. the memory pipeline). Speaks the same typed
 * `AgentMessage[]` shape as the core Agent so there's only one message
 * representation in the codebase.
 *
 * For multi-turn tool-calling work, use the stateful `Agent` class in
 * `core/` instead — it speaks the same types.
 */

import type { AgentMessage, AssistantMessage } from "./core/types.js";

export type StreamDeltaHandler = (delta: string) => Promise<void> | void;

/**
 * Result of a simple chat call. Mirrors the AssistantMessage produced by
 * a full provider stream, projected to the few fields memory consumers
 * actually need.
 */
export interface ChatResponse {
  /** Concatenated text content from the assistant's TextContent blocks. */
  content: string;
  /** The full assistant message — provided so callers can read usage etc. */
  message: AssistantMessage;
}

export interface LLMChatClient {
  name: string;
  model: string;
  chat(input: {
    /** Optional system prompt; equivalent to AgentContext.systemPrompt. */
    system?: string;
    messages: AgentMessage[];
    onDelta?: StreamDeltaHandler | null;
  }): Promise<ChatResponse>;
}
