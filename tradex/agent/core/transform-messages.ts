/**
 * core/transform-messages.ts — Cross-cutting message transforms.
 *
 * Transforms applied before handing context to the provider:
 *   1. downgradeUnsupportedImages — replace ImageContent with a placeholder
 *      when the target model does not list "image" in its inputs.
 *   2. normalizeToolCallIds — shorten/sanitize tool call IDs for cross-provider
 *      compatibility (OpenAI generates 450+ char IDs, Anthropic requires
 *      ^[a-zA-Z0-9_-]+$ max 64 chars).
 *   3. synthesizeOrphanedToolResults — insert synthetic error results for tool
 *      calls that have no corresponding tool result (prevents API errors).
 *   4. dropErroredAssistantMessages — skip errored/aborted assistant messages
 *      that would cause replay issues.
 */

import type {
  AgentMessage,
  AgentModelDescriptor,
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "./types.js";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

/** Max length for normalized tool call IDs. Anthropic limit is 64. */
const MAX_TOOL_CALL_ID_LENGTH = 64;

/** Pattern for valid tool call ID characters across providers. */
const VALID_ID_CHARS = /^[a-zA-Z0-9_-]+$/;

// ============================================================================
// Image Downgrade
// ============================================================================

/**
 * Replace every ImageContent with a TextContent placeholder. Adjacent images
 * collapse into a single placeholder so the prompt does not get spammed with
 * repeated lines.
 */
function replaceImagesWithPlaceholder(
  content: (TextContent | ImageContent)[],
  placeholder: string,
): TextContent[] {
  const result: TextContent[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) {
        result.push({ type: "text", text: placeholder });
      }
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}

/**
 * Returns true when the model declares image input support.
 * Defaults to false when `inputs` is undefined (models opt in explicitly).
 */
export function modelSupportsImages(model: AgentModelDescriptor): boolean {
  return Array.isArray(model.inputs) && model.inputs.includes("image");
}

// ============================================================================
// Tool Call ID Normalization
// ============================================================================

/**
 * Normalize a tool call ID for cross-provider compatibility.
 *
 * OpenAI Responses API can generate IDs that are 450+ chars and may contain
 * characters like `|` that Anthropic rejects. This function:
 * 1. Strips invalid characters (keeps only [a-zA-Z0-9_-])
 * 2. Truncates to MAX_TOOL_CALL_ID_LENGTH
 * 3. Falls back to a hash-based ID if the result would be empty
 */
function normalizeToolCallId(id: string): string {
  // Already valid and short enough — pass through
  if (id.length <= MAX_TOOL_CALL_ID_LENGTH && VALID_ID_CHARS.test(id)) {
    return id;
  }

  // Strip invalid characters
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "");

  if (cleaned.length === 0) {
    // Fallback: generate deterministic short ID from a simple hash
    return `tc_${simpleHash(id)}`;
  }

  if (cleaned.length <= MAX_TOOL_CALL_ID_LENGTH) {
    return cleaned;
  }

  // Truncate but keep a hash suffix for uniqueness
  const hashSuffix = simpleHash(id);
  const prefix = cleaned.slice(0, MAX_TOOL_CALL_ID_LENGTH - hashSuffix.length - 1);
  return `${prefix}_${hashSuffix}`;
}

/**
 * Simple string hash (FNV-1a inspired) that produces a short hex string.
 * Not cryptographic — just for generating deterministic short IDs.
 */
function simpleHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ============================================================================
// Main Transform
// ============================================================================

/**
 * Apply all cross-cutting message transforms before sending to a provider:
 * 1. Image downgrade for non-vision models
 * 2. Tool call ID normalization for cross-provider compatibility
 * 3. Drop errored/aborted assistant messages
 * 4. Synthesize tool results for orphaned tool calls
 */
export function transformMessages(
  messages: AgentMessage[],
  model: AgentModelDescriptor,
): AgentMessage[] {
  // Phase 1: Image downgrade
  let transformed: AgentMessage[] = modelSupportsImages(model)
    ? messages
    : messages.map((msg) => {
        if (msg.role === "user" && Array.isArray(msg.content)) {
          const downgraded = replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER);
          return { ...msg, content: downgraded } as UserMessage;
        }
        if (msg.role === "toolResult") {
          const downgraded = replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER);
          return { ...msg, content: downgraded } as ToolResultMessage;
        }
        return msg;
      });

  // Phase 2: Tool call ID normalization + drop errored messages
  const toolCallIdMap = new Map<string, string>();

  transformed = transformed.map((msg) => {
    if (msg.role === "assistant") {
      const assistant = msg as AssistantMessage;

      // Drop errored/aborted assistant messages — they may have partial/broken content
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        return null as unknown as AgentMessage; // filtered out below
      }

      // Normalize tool call IDs in this assistant message
      const hasToolCalls = assistant.content.some((c) => c.type === "toolCall");
      if (!hasToolCalls) return msg;

      const newContent = assistant.content.map((block) => {
        if (block.type !== "toolCall") return block;
        const tc = block as ToolCallContent;
        const normalizedId = normalizeToolCallId(tc.id);
        if (normalizedId !== tc.id) {
          toolCallIdMap.set(tc.id, normalizedId);
          return { ...tc, id: normalizedId };
        }
        return block;
      });

      return { ...assistant, content: newContent } as AssistantMessage;
    }

    if (msg.role === "toolResult") {
      const result = msg as ToolResultMessage;
      const normalizedId = toolCallIdMap.get(result.toolCallId);
      if (normalizedId) {
        return { ...result, toolCallId: normalizedId } as ToolResultMessage;
      }
      return msg;
    }

    return msg;
  });

  // Filter out null entries (dropped errored assistant messages)
  transformed = transformed.filter((msg) => msg !== null);

  // Phase 3: Synthesize tool results for orphaned tool calls
  const result: AgentMessage[] = [];
  let pendingToolCalls: ToolCallContent[] = [];
  let existingToolResultIds = new Set<string>();

  const insertSyntheticToolResults = () => {
    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (!existingToolResultIds.has(tc.id)) {
          result.push({
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: "text", text: "No result provided" }],
            isError: true,
            timestamp: Date.now(),
          } as ToolResultMessage);
        }
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
  };

  for (const msg of transformed) {
    if (msg.role === "assistant") {
      // If we have pending orphaned tool calls from a previous assistant, insert synthetic results
      insertSyntheticToolResults();

      // Track tool calls from this assistant message
      const assistant = msg as AssistantMessage;
      const toolCalls = assistant.content.filter((c): c is ToolCallContent => c.type === "toolCall");
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }
      result.push(msg);
    } else if (msg.role === "toolResult") {
      existingToolResultIds.add((msg as ToolResultMessage).toolCallId);
      result.push(msg);
    } else if (msg.role === "user") {
      // User message interrupts tool flow — insert synthetic results for orphaned calls
      insertSyntheticToolResults();
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  // If conversation ends with unresolved tool calls, synthesize results
  insertSyntheticToolResults();

  return result;
}
