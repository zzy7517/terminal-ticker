/** Pi、Claude Code 与 Cursor CLI Runtime 共用的事件、能力和运行句柄类型。 */
import type { AgentRuntimeId } from "../../contracts.js";

export type { AgentRuntimeId } from "../../contracts.js";
export type ExternalAgentRuntimeId = Exclude<AgentRuntimeId, "pi">;

export interface RuntimeCapabilities {
  streaming: boolean;
  abort: boolean;
  resume: boolean;
  imageInput: boolean;
  toolProgress: boolean;
}

export type RuntimeContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface RuntimeUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface RuntimeMessage {
  id: string;
  role: "user" | "assistant" | "toolResult";
  content: RuntimeContent[];
  timestamp: number;
  usage?: RuntimeUsage;
  error?: string | null;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface RuntimeToolResult {
  content: RuntimeContent[];
  details?: unknown;
  terminate?: boolean;
}

export type RuntimeEvent =
  | { type: "run-start"; nativeSessionId?: string }
  | { type: "turn-start"; turnId: string }
  | { type: "message-start"; message: RuntimeMessage }
  | { type: "message-update"; message: RuntimeMessage; delta: string }
  | { type: "message-end"; message: RuntimeMessage }
  | { type: "tool-start"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool-update"; callId: string; name: string; args: Record<string, unknown>; partialResult: RuntimeToolResult }
  | { type: "tool-result"; callId: string; name: string; result: RuntimeToolResult; isError: boolean }
  | { type: "turn-end"; turnId: string; message: RuntimeMessage; toolResults: RuntimeMessage[] }
  | { type: "usage"; model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { type: "runtime-error"; code: string; message: string }
  | { type: "run-end"; nativeSessionId?: string; result: string; status: "completed" | "error" | "aborted" };

export interface RuntimeRunResult {
  output: string;
  nativeSessionId?: string;
  error: string | null;
  errorCode?: string | null;
}

export interface ActiveRuntimeRun {
  readonly runtime: AgentRuntimeId;
  readonly capabilities: RuntimeCapabilities;
  readonly nativeSessionId?: string;
  subscribe(listener: (event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>): () => void;
  readonly result: Promise<RuntimeRunResult>;
  abort(): void | Promise<void>;
}
