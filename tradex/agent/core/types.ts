/**
 * core/types.ts — Agent core type definitions.
 *
 * Modeled after pi-mono's packages/agent/src/types.ts.
 * These types define the contract between the stateful Agent, the pure agentLoop,
 * and the tool/provider layers.
 */

// ============================================================================
// Message Types
// ============================================================================

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

/**
 * Custom message type for app-specific messages that are stored in the
 * conversation but not sent to the LLM.
 */
export interface CustomMessage {
  role: "custom";
  customType: string;
  content: unknown;
  display?: string;
  timestamp: number;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: UsageCost;
}

/**
 * AgentMessage — union of all message types the Agent can hold.
 * The LLM only sees User, Assistant, and ToolResult.
 * Custom messages are filtered out before sending to the provider.
 */
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

// ============================================================================
// Tool Types
// ============================================================================

/** Result returned from a tool execution. */
export interface AgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details: TDetails;
  /**
   * When every tool in a batch sets terminate: true, the loop stops
   * without making another LLM call.
   */
  terminate?: boolean;
}

/** Callback for streaming partial tool execution updates. */
export type AgentToolUpdateCallback<TDetails = unknown> = (partialResult: AgentToolResult<TDetails>) => void;

/**
 * Tool execution mode.
 * - "sequential": tool calls execute one by one.
 * - "parallel": tool calls execute concurrently (default).
 */
export type ToolExecutionMode = "sequential" | "parallel";

/** Tool definition used by the agent runtime. */
export interface AgentTool<TDetails = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  /** Execute the tool. Throw on failure. */
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /** Per-tool execution mode override. */
  executionMode?: ToolExecutionMode;
}

// ============================================================================
// Agent Context & Config
// ============================================================================

/** Snapshot of state passed into the pure agent loop. */
export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

/**
 * Thinking/reasoning level.
 *
 * NOTE: Currently not wired through to providers. Reasoning effort is controlled
 * at the model layer via `AgentModelDescriptor.reasoningEffort`, which providers
 * read directly. This field is retained for future dynamic per-turn override support.
 */
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

/**
 * Model descriptor — pure data, no credentials baked in.
 * Credentials are resolved at call time via getApiKey.
 */
/**
 * Cost rates per million tokens for a model.
 */
export interface ModelCostRates {
  input: number;       // $/million input tokens
  output: number;      // $/million output tokens
  cacheRead: number;   // $/million cache-read tokens
  cacheWrite: number;  // $/million cache-write tokens
}

export interface AgentModelDescriptor {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoningEffort: string;
  contextWindow?: number;
  maxTokens?: number;
  accountId?: string | null;
  /** Cost rates per million tokens. Used to compute cumulative session cost. */
  cost?: ModelCostRates;
  /**
   * Input modalities the model accepts. Mirrors pi's Model.input.
   * If "image" is absent, transformMessages() downgrades image content to a
   * placeholder before the request is sent to the provider.
   * Defaults to ["text"] when unspecified.
   */
  inputs?: ("text" | "image")[];
}

/**
 * StreamFn — the provider-level function that makes LLM calls.
 * Returns an AssistantMessage (the final result after streaming completes).
 *
 * This is injected into the Agent so the loop doesn't import providers directly.
 */
export type StreamFn = (
  model: AgentModelDescriptor,
  context: AgentContext,
  options: StreamOptions,
) => Promise<StreamResult>;

export interface StreamOptions {
  apiKey: string;
  signal?: AbortSignal;
  reasoning?: ThinkingLevel;
  onDelta?: (delta: string) => void | Promise<void>;
}

export interface StreamResult {
  message: AssistantMessage;
}

// ============================================================================
// Loop Config
// ============================================================================

/** Result returned from beforeToolCall. */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

/** Partial override returned from afterToolCall. */
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

/** Context for shouldStopAfterTurn. */
export interface ShouldStopContext {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContext;
  newMessages: AgentMessage[];
}

/** Replacement state for the next turn. */
export interface AgentLoopTurnUpdate {
  context?: AgentContext;
  model?: AgentModelDescriptor;
  thinkingLevel?: ThinkingLevel;
}

/** Full configuration for a single agent loop run. */
export interface AgentLoopConfig {
  model: AgentModelDescriptor;
  reasoning?: ThinkingLevel;
  apiKey: string;

  /** Resolve API key dynamically (for OAuth/expiring tokens). */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

  /** Convert AgentMessage[] to the subset the LLM should see. */
  convertToLlm: (messages: AgentMessage[]) => AgentMessage[];

  /** Optional context transform before convertToLlm. */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

  /** Tool execution mode. Default: "parallel". */
  toolExecution?: ToolExecutionMode;

  /** Called before a tool executes. Return { block: true } to prevent. */
  beforeToolCall?: (context: {
    assistantMessage: AssistantMessage;
    toolCall: ToolCallContent;
    args: Record<string, unknown>;
    context: AgentContext;
  }, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

  /** Called after a tool executes. Return partial override. */
  afterToolCall?: (context: {
    assistantMessage: AssistantMessage;
    toolCall: ToolCallContent;
    args: Record<string, unknown>;
    result: AgentToolResult;
    isError: boolean;
    context: AgentContext;
  }, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

  /** Return true to stop the loop after this turn. */
  shouldStopAfterTurn?: (context: ShouldStopContext) => boolean | Promise<boolean>;

  /** Return updated context/model/thinking for the next turn. */
  prepareNextTurn?: (context: ShouldStopContext) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

  /** Steering messages injected mid-run (after current turn's tools finish). */
  getSteeringMessages?: () => Promise<AgentMessage[]>;

  /** Follow-up messages processed after agent would otherwise stop. */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;

  /** Stream function for making LLM calls. */
  streamFn: StreamFn;

  /** Delta callback for streaming text to the UI. */
  onDelta?: (delta: string) => void | Promise<void>;
}

// ============================================================================
// Agent Events
// ============================================================================

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; delta?: string }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: AgentToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult; isError: boolean };

/** Event sink function used by the pure agent loop. */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

// ============================================================================
// Agent State (public interface)
// ============================================================================

export interface AgentState {
  systemPrompt: string;
  model: AgentModelDescriptor;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
