import type { RuntimeEvent } from "../types.js";

/** 将 Claude Code 的 JSONL 输出转换为 Tradex Runtime 事件和错误码。 */
interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeLine {
  type?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: {
    model?: string;
    content?: ClaudeContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
}

/** 解析单行 Claude JSONL，并转换成一个或多个统一 Runtime 事件。 */
export function parseClaudeLine(line: string): RuntimeEvent[] {
  // Claude 以完整 JSONL 行输出；单行解析失败时转成稳定的运行时错误，避免把异常直接抛到 SSE 层。
  let value: ClaudeLine;
  try {
    value = JSON.parse(line) as ClaudeLine;
  } catch {
    return [{ type: "runtime-error", code: "malformed_stream_json", message: "Claude Code emitted malformed stream-json" }];
  }
  if (value.type === "system") {
    // system 事件是获取 native session ID 的最早可靠机会，调用方会立即持久化它。
    return value.session_id
      ? [{ type: "run-start", nativeSessionId: value.session_id }]
      : [{ type: "runtime-error", code: "invalid_system_event", message: "Claude Code system event is missing session_id" }];
  }
  if (
    value.type === "stream_event"
    && value.event?.type === "content_block_delta"
    && value.event.delta?.type === "text_delta"
  ) {
    // partial message 只负责增量文本；最终 assistant/result 事件由后续分支补齐。
    return typeof value.event.delta.text === "string"
      ? [{ type: "text-delta", delta: value.event.delta.text }]
      : [{ type: "runtime-error", code: "invalid_stream_delta", message: "Claude Code text delta is missing text" }];
  }
  if (value.type === "result") {
    if (typeof value.result !== "string") {
      return [{ type: "runtime-error", code: "invalid_result_event", message: "Claude Code result event is missing result" }];
    }
    return [{
      type: "run-end",
      ...(value.session_id ? { nativeSessionId: value.session_id } : {}),
      result: value.result,
      isError: value.is_error === true,
    }];
  }
  const content = value.message?.content ?? [];
  if (value.type === "assistant") {
    if (!value.message || !Array.isArray(value.message.content)) {
      return [{ type: "runtime-error", code: "invalid_assistant_event", message: "Claude Code assistant event is missing content" }];
    }
    const events: RuntimeEvent[] = [];
    for (const block of content) {
      if (block.type === "text") {
        if (typeof block.text !== "string") {
          events.push({ type: "runtime-error", code: "invalid_text_block", message: "Claude Code text block is missing text" });
        } else if (block.text) events.push({ type: "text-delta", delta: block.text });
      }
      if (block.type === "tool_use") {
        if (!block.id || !block.name) {
          events.push({ type: "runtime-error", code: "invalid_tool_use", message: "Claude Code tool_use block is missing id or name" });
          continue;
        }
        events.push({
          type: "tool-start",
          callId: block.id,
          name: stripTradexMcpPrefix(block.name),
          args: block.input ?? {},
        });
      }
    }
    const usage = value.message.usage;
    if (usage && value.message.model) {
      events.push({
        type: "usage",
        model: value.message.model,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
      });
    }
    return events;
  }
  if (value.type === "user") {
    if (!value.message || !Array.isArray(value.message.content)) {
      return [{ type: "runtime-error", code: "invalid_user_event", message: "Claude Code user event is missing content" }];
    }
    return content.flatMap((block): RuntimeEvent[] => {
      if (block.type !== "tool_result") return [];
      if (!block.tool_use_id) return [{ type: "runtime-error", code: "invalid_tool_result", message: "Claude Code tool_result block is missing tool_use_id" }];
      return [{
        type: "tool-end",
        callId: block.tool_use_id,
        output: contentToText(block.content),
        isError: block.is_error === true,
      }];
    });
  }
  return [];
}

/** 读取原始 JSONL 的事件类型，用于处理 partial 文本去重。 */
export function claudeLineType(line: string): string | null {
  try {
    const value = JSON.parse(line) as { type?: unknown };
    return typeof value.type === "string" ? value.type : null;
  } catch {
    return null;
  }
}

/** 根据受限 stderr 文本映射稳定的用户可处理错误码。 */
export function classifyClaudeError(stderr: string): string {
  if (/auth|login|oauth|credential|token expired/i.test(stderr)) return "auth_required";
  if (/model|entitlement|not available|overloaded/i.test(stderr)) return "model_unavailable";
  if (/mcp|connection refused|unauthorized|401/i.test(stderr)) return "mcp_connection_failed";
  if (/permission|not allowed|denied/i.test(stderr)) return "permission_denied";
  if (/resume|session.*not found|conversation.*not found/i.test(stderr)) return "native_session_resume_failed";
  return "process_exit_failure";
}

function stripTradexMcpPrefix(name: string): string {
  return name.startsWith("mcp__tradex__") ? name.slice("mcp__tradex__".length) : name;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((item) => {
    if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
    return JSON.stringify(item);
  }).join("\n");
}
