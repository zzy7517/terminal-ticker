/**
 * core/context-usage.ts — Context window utilization and session statistics.
 *
 * Modeled after pi-mono's packages/coding-agent/src/core/compaction/compaction.ts
 * and packages/coding-agent/src/core/agent-session.ts SessionStats.
 *
 * Provides:
 * - ContextUsage: current context window fill percentage
 * - SessionStats: cumulative token/cost statistics for a session
 * - Utility functions for computing context tokens from usage data
 */

import type { AgentMessage, AssistantMessage, Usage } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Context window utilization for the current session.
 * Matches pi's ContextUsage interface.
 */
export interface ContextUsage {
  /** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
  tokens: number | null;
  /** Total context window size for the active model. */
  contextWindow: number;
  /** Context usage as percentage of context window, or null if tokens is unknown. */
  percent: number | null;
}

/**
 * Cumulative session statistics.
 * Matches pi's SessionStats interface.
 */
export interface SessionStats {
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage: ContextUsage | null;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate total context tokens from a Usage object.
 * Uses the native totalTokens field when available, falls back to computing from components.
 *
 * For context window tracking, totalTokens represents the full context size
 * (input + output + cache) at the time of the response.
 */
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || (usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
}

/**
 * Rough token estimate for a message using chars/4 heuristic.
 * Used when no actual usage data is available.
 */
export function estimateMessageTokens(message: AgentMessage): number {
  if (message.role === "user") {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    return Math.ceil(content.length / 4);
  }
  if (message.role === "assistant") {
    const assistant = message as AssistantMessage;
    let chars = 0;
    for (const c of assistant.content) {
      if (c.type === "text") chars += c.text.length;
      else if (c.type === "toolCall") chars += JSON.stringify(c.arguments).length + c.name.length;
      else if (c.type === "thinking") chars += c.thinking.length;
    }
    return Math.ceil(chars / 4);
  }
  if (message.role === "toolResult") {
    const content = message.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    return Math.ceil(content.length / 4);
  }
  return 0;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role === "assistant" && "usage" in msg) {
    const assistant = msg as AssistantMessage;
    if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && assistant.usage) {
      return assistant.usage;
    }
  }
  return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with the chars/4 heuristic.
 *
 * This mirrors pi's estimateContextTokens logic.
 */
export function estimateContextTokens(messages: AgentMessage[]): {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
} {
  // Find last valid assistant usage
  let lastUsageIndex: number | null = null;
  let lastUsage: Usage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) {
      lastUsage = usage;
      lastUsageIndex = i;
      break;
    }
  }

  if (!lastUsage || lastUsageIndex === null) {
    // No usage data at all — estimate everything
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateMessageTokens(message);
    }
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }

  const usageTokens = calculateContextTokens(lastUsage);
  let trailingTokens = 0;
  for (let i = lastUsageIndex + 1; i < messages.length; i++) {
    trailingTokens += estimateMessageTokens(messages[i]);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex,
  };
}

/**
 * Compute ContextUsage for a set of messages and a known context window size.
 * Returns null if contextWindow is 0 or undefined.
 */
export function computeContextUsage(messages: AgentMessage[], contextWindow: number | undefined): ContextUsage | null {
  if (!contextWindow || contextWindow <= 0) return null;

  const estimate = estimateContextTokens(messages);
  const percent = (estimate.tokens / contextWindow) * 100;

  return {
    tokens: estimate.tokens,
    contextWindow,
    percent,
  };
}

/**
 * Compute cumulative SessionStats from an array of messages.
 * Matches pi's getSessionStats() logic.
 */
export function getSessionStats(
  sessionId: string,
  messages: AgentMessage[],
  contextWindow?: number,
): SessionStats {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const message of messages) {
    switch (message.role) {
      case "user":
        userMessages++;
        break;
      case "assistant": {
        assistantMessages++;
        const assistant = message as AssistantMessage;
        toolCalls += assistant.content.filter((c) => c.type === "toolCall").length;
        totalInput += assistant.usage.input;
        totalOutput += assistant.usage.output;
        totalCacheRead += assistant.usage.cacheRead;
        totalCacheWrite += assistant.usage.cacheWrite;
        totalCost += assistant.usage.cost.total;
        break;
      }
      case "toolResult":
        toolResults++;
        break;
    }
  }

  return {
    sessionId,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: messages.length,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
    },
    cost: totalCost,
    contextUsage: computeContextUsage(messages, contextWindow),
  };
}
