import type { RuntimeEvent } from "../types.js";

/** 将 Cursor Agent CLI 的 stream-json 输出转换为 Tradex Runtime 事件。 */

interface CursorContentBlock {
  type?: string;
  text?: string;
}

interface CursorToolPayload {
  [key: string]: {
    args?: Record<string, unknown>;
    name?: string;
    arguments?: string | Record<string, unknown>;
    result?: unknown;
  } | undefined;
}

interface CursorLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  error?: string;
  duration_ms?: number;
  message?: {
    role?: string;
    content?: CursorContentBlock[];
  };
  tool_call?: CursorToolPayload;
  call_id?: string;
  model_call_id?: string;
  timestamp_ms?: number;
  text?: string;
}

/** 解析单行 Cursor JSONL，并转换成一个或多个统一 Runtime 事件。 */
export function parseCursorLine(line: string): RuntimeEvent[] {
  let value: CursorLine;
  try {
    value = JSON.parse(line) as CursorLine;
  } catch {
    return [{ type: "runtime-error", code: "malformed_stream_json", message: "Cursor CLI emitted malformed stream-json" }];
  }

  if (value.type === "system" && value.subtype === "init") {
    return value.session_id
      ? [{ type: "run-start", nativeSessionId: value.session_id }]
      : [{ type: "runtime-error", code: "invalid_system_event", message: "Cursor CLI system init is missing session_id" }];
  }

  if (value.type === "assistant") {
    if (!value.message || !Array.isArray(value.message.content)) {
      return [{ type: "runtime-error", code: "invalid_assistant_event", message: "Cursor CLI assistant event is missing content" }];
    }
    // --stream-partial-output 会额外发送 pre-tool/final flush；只有这一种形态含新文本。
    if (value.timestamp_ms == null || value.model_call_id) return [];
    const events: RuntimeEvent[] = [];
    for (const block of value.message.content) {
      if (block.type !== "text") continue;
      if (typeof block.text !== "string") {
        events.push({ type: "runtime-error", code: "invalid_text_block", message: "Cursor CLI text block is missing text" });
        continue;
      }
      if (!block.text) continue;
      events.push({
        type: "message-update",
        message: cursorAssistantMessage(block.text),
        delta: block.text,
      });
    }
    return events;
  }

  if (value.type === "tool_call") {
    const parsed = parseCursorToolCall(value);
    if (!parsed) return [];
    if (value.subtype === "started") {
      return [{ type: "tool-start", callId: parsed.callId, name: parsed.name, args: parsed.args }];
    }
    if (value.subtype === "completed") {
      const output = contentToText(parsed.result);
      return [{
        type: "tool-result",
        callId: parsed.callId,
        name: parsed.name,
        result: { content: output ? [{ type: "text", text: output }] : [] },
        isError: parsed.isError,
      }];
    }
    return [];
  }

  if (value.type === "result") {
    const result = typeof value.result === "string"
      ? value.result
      : typeof value.error === "string"
        ? value.error
        : value.is_error === true
          ? "Cursor CLI run failed"
          : "";
    if (value.is_error === true && !result) {
      return [{ type: "runtime-error", code: "invalid_result_event", message: "Cursor CLI result event is missing error detail" }];
    }
    return [{
      type: "run-end",
      ...(value.session_id ? { nativeSessionId: value.session_id } : {}),
      result,
      status: value.is_error === true ? "error" : "completed",
    }];
  }

  // thinking / connection / retry / user / text — 忽略或由 ActiveRun 处理去重。
  return [];
}

export function cursorLineType(line: string): string | null {
  try {
    const value = JSON.parse(line) as { type?: unknown };
    return typeof value.type === "string" ? value.type : null;
  } catch {
    return null;
  }
}

export function classifyCursorError(stderr: string): string {
  if (/auth|login|api.?key|unauthorized|401/i.test(stderr)) return "auth_required";
  if (/model|not available|entitlement|overloaded/i.test(stderr)) return "model_unavailable";
  if (/tradex cli|connection refused|econnrefused/i.test(stderr)) return "cli_connection_failed";
  if (/permission|not allowed|denied|trust/i.test(stderr)) return "permission_denied";
  if (/resume|session.*not found|chat.*not found|conversation.*not found/i.test(stderr)) {
    return "native_session_resume_failed";
  }
  return "process_exit_failure";
}

function cursorAssistantMessage(content: string): Extract<RuntimeEvent, { type: "message-update" }>["message"] {
  return {
    id: "cursor:assistant",
    role: "assistant",
    content: content ? [{ type: "text", text: content }] : [],
    timestamp: Date.now(),
  };
}

function parseCursorToolCall(value: CursorLine): {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
} | null {
  const toolCall = value.tool_call;
  if (!toolCall || typeof toolCall !== "object") return null;
  const entry = Object.entries(toolCall).find(([, payload]) => payload && typeof payload === "object");
  if (!entry) return null;
  const [rawName, payload] = entry;
  const functionPayload = rawName === "function" ? payload : undefined;
  const name = normalizeCursorToolName(
    typeof functionPayload?.name === "string" && functionPayload.name
      ? functionPayload.name
      : rawName,
  );
  const callId = typeof value.call_id === "string" && value.call_id
    ? value.call_id
    : `cursor-tool:${rawName}:${value.timestamp_ms ?? Date.now()}`;
  const result = payload?.result;
  const isError = Boolean(
    result
    && typeof result === "object"
    && ("error" in (result as object) || "failure" in (result as object)),
  );
  return {
    callId,
    name,
    args: functionPayload
      ? parseFunctionArguments(functionPayload.arguments)
      : payload?.args && typeof payload.args === "object" ? payload.args : {},
    result,
    isError,
  };
}

function parseFunctionArguments(value: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeCursorToolName(rawName: string): string {
  return rawName.replace(/ToolCall$/i, "");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>;
    if (typeof record.success === "object" && record.success) return JSON.stringify(record.success);
    if (typeof record.error === "object" || typeof record.error === "string") return JSON.stringify(record.error ?? record);
    if (typeof record.failure === "object") return JSON.stringify(record.failure);
  }
  const items = Array.isArray(content) ? content : [content];
  return items.map((item) => {
    if (item && typeof item === "object" && "text" in item && typeof (item as { text?: unknown }).text === "string") {
      return (item as { text: string }).text;
    }
    return typeof item === "object" ? JSON.stringify(item) : String(item);
  }).join("\n");
}
