/**
 * core/agent.ts — Stateful Agent class.
 *
 * Modeled after pi-mono's packages/agent/src/agent.ts.
 *
 * The Agent owns the conversation transcript, emits lifecycle events, executes
 * tools, and exposes queueing APIs for steering and follow-up messages.
 *
 * Key differences from the old AgentLoop:
 * - Agent is long-lived (survives across multiple prompt() calls)
 * - Messages persist in state.messages across turns
 * - Steering and follow-up queues are built-in
 * - AbortSignal is fully integrated
 * - Event subscription via subscribe()
 */

import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import type {
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentModelDescriptor,
  AgentState,
  AgentTool,
  AssistantMessage,
  BeforeToolCallResult,
  ImageContent,
  ShouldStopContext,
  StreamFn,
  TextContent,
  ThinkingLevel,
  ToolCallContent,
  ToolExecutionMode,
  AgentToolResult,
  Usage,
} from "./types.js";

// ============================================================================
// Queue Mode
// ============================================================================

export type QueueMode = "all" | "one-at-a-time";

class PendingMessageQueue {
  private messages: AgentMessage[] = [];

  constructor(public mode: QueueMode) {}

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  hasItems(): boolean {
    return this.messages.length > 0;
  }

  drain(): AgentMessage[] {
    if (this.mode === "all") {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }
    const first = this.messages[0];
    if (!first) return [];
    this.messages = this.messages.slice(1);
    return [first];
  }

  clear(): void {
    this.messages = [];
  }
}

// ============================================================================
// Internal State
// ============================================================================

const EMPTY_USAGE: Usage = { input: 0, output: 0, totalTokens: 0 };

interface ActiveRun {
  promise: Promise<void>;
  resolve: () => void;
  abortController: AbortController;
}

// ============================================================================
// Agent Options
// ============================================================================

export interface AgentOptions {
  initialState?: {
    systemPrompt?: string;
    model?: AgentModelDescriptor;
    thinkingLevel?: ThinkingLevel;
    tools?: AgentTool[];
    messages?: AgentMessage[];
  };

  /** The stream function that makes LLM calls. Required. */
  streamFn: StreamFn;

  /** Convert AgentMessage[] to the subset the LLM should see. */
  convertToLlm?: (messages: AgentMessage[]) => AgentMessage[];

  /** Optional context transform before convertToLlm. */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

  /** Resolve API key dynamically. */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

  /** Static API key fallback. */
  apiKey?: string;

  /** Called before a tool executes. */
  beforeToolCall?: (context: {
    assistantMessage: AssistantMessage;
    toolCall: ToolCallContent;
    args: Record<string, unknown>;
    context: AgentContext;
  }, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

  /** Called after a tool executes. */
  afterToolCall?: (context: {
    assistantMessage: AssistantMessage;
    toolCall: ToolCallContent;
    args: Record<string, unknown>;
    result: AgentToolResult;
    isError: boolean;
    context: AgentContext;
  }, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

  /** Called after each turn. Return updated config for the next turn. */
  prepareNextTurn?: (context: ShouldStopContext) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

  /** Return true to stop the loop after this turn. */
  shouldStopAfterTurn?: (context: ShouldStopContext) => boolean | Promise<boolean>;

  /** Steering queue mode. Default: "one-at-a-time". */
  steeringMode?: QueueMode;

  /** Follow-up queue mode. Default: "one-at-a-time". */
  followUpMode?: QueueMode;

  /** Tool execution mode. Default: "parallel". */
  toolExecution?: ToolExecutionMode;

  /** Delta callback for streaming text. */
  onDelta?: (delta: string) => void | Promise<void>;
}

// ============================================================================
// Agent Class
// ============================================================================

export class Agent {
  // ---- State ----
  private _systemPrompt: string;
  private _model: AgentModelDescriptor;
  private _thinkingLevel: ThinkingLevel;
  private _tools: AgentTool[];
  private _messages: AgentMessage[];
  private _isStreaming = false;
  private _streamingMessage?: AgentMessage;
  private _pendingToolCalls = new Set<string>();
  private _errorMessage?: string;

  // ---- Configuration ----
  readonly streamFn: StreamFn;
  convertToLlm: (messages: AgentMessage[]) => AgentMessage[];
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  apiKey: string;
  beforeToolCall?: AgentOptions["beforeToolCall"];
  afterToolCall?: AgentOptions["afterToolCall"];
  prepareNextTurn?: AgentOptions["prepareNextTurn"];
  shouldStopAfterTurn?: AgentOptions["shouldStopAfterTurn"];
  toolExecution: ToolExecutionMode;
  onDelta?: (delta: string) => void | Promise<void>;

  // ---- Queues ----
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;

  // ---- Lifecycle ----
  private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
  private activeRun?: ActiveRun;

  constructor(options: AgentOptions) {
    const init = options.initialState ?? {};
    this._systemPrompt = init.systemPrompt ?? "";
    this._model = init.model ?? { id: "unknown", provider: "unknown", api: "unknown", baseUrl: "", reasoningEffort: "medium" };
    this._thinkingLevel = init.thinkingLevel ?? "off";
    this._tools = init.tools?.slice() ?? [];
    this._messages = init.messages?.slice() ?? [];

    this.streamFn = options.streamFn;
    this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = options.transformContext;
    this.getApiKey = options.getApiKey;
    this.apiKey = options.apiKey ?? "";
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.prepareNextTurn = options.prepareNextTurn;
    this.shouldStopAfterTurn = options.shouldStopAfterTurn;
    this.toolExecution = options.toolExecution ?? "parallel";
    this.onDelta = options.onDelta;

    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
  }

  // ==========================================================================
  // Public State (AgentState interface)
  // ==========================================================================

  get state(): AgentState {
    return {
      systemPrompt: this._systemPrompt,
      model: this._model,
      thinkingLevel: this._thinkingLevel,
      tools: this._tools,
      messages: this._messages,
      isStreaming: this._isStreaming,
      streamingMessage: this._streamingMessage,
      pendingToolCalls: this._pendingToolCalls,
      errorMessage: this._errorMessage,
    };
  }

  // Mutable state access for external layers (session management, etc.)
  get systemPrompt(): string { return this._systemPrompt; }
  set systemPrompt(value: string) { this._systemPrompt = value; }

  get model(): AgentModelDescriptor { return this._model; }
  set model(value: AgentModelDescriptor) { this._model = value; }

  get thinkingLevel(): ThinkingLevel { return this._thinkingLevel; }
  set thinkingLevel(value: ThinkingLevel) { this._thinkingLevel = value; }

  get tools(): AgentTool[] { return this._tools; }
  set tools(value: AgentTool[]) { this._tools = value.slice(); }

  get messages(): AgentMessage[] { return this._messages; }
  set messages(value: AgentMessage[]) { this._messages = value.slice(); }

  get isStreaming(): boolean { return this._isStreaming; }

  // ==========================================================================
  // Event Subscription
  // ==========================================================================

  /**
   * Subscribe to agent lifecycle events.
   * Listeners are awaited in order and are part of run settlement.
   * Returns unsubscribe function.
   */
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ==========================================================================
  // Queue APIs
  // ==========================================================================

  /** Queue a message to be injected after the current assistant turn finishes. */
  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  /** Queue a message to run only after the agent would otherwise stop. */
  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  /** Steering queue mode. */
  get steeringMode(): QueueMode { return this.steeringQueue.mode; }
  set steeringMode(mode: QueueMode) { this.steeringQueue.mode = mode; }

  /** Follow-up queue mode. */
  get followUpMode(): QueueMode { return this.followUpQueue.mode; }
  set followUpMode(mode: QueueMode) { this.followUpQueue.mode = mode; }

  clearSteeringQueue(): void { this.steeringQueue.clear(); }
  clearFollowUpQueue(): void { this.followUpQueue.clear(); }
  clearAllQueues(): void { this.steeringQueue.clear(); this.followUpQueue.clear(); }
  hasQueuedMessages(): boolean { return this.steeringQueue.hasItems() || this.followUpQueue.hasItems(); }

  // ==========================================================================
  // Lifecycle Control
  // ==========================================================================

  /** Active abort signal for the current run. */
  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  /** Abort the current run. */
  abort(): void {
    this.activeRun?.abortController.abort();
  }

  /** Resolve when the current run settles (including all listener callbacks). */
  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  /** Clear all state. */
  reset(): void {
    this._messages = [];
    this._isStreaming = false;
    this._streamingMessage = undefined;
    this._pendingToolCalls = new Set();
    this._errorMessage = undefined;
    this.clearAllQueues();
  }

  // ==========================================================================
  // Prompt / Continue
  // ==========================================================================

  /**
   * Start a new prompt. Accepts a string, single message, or array of messages.
   * Throws if already streaming.
   */
  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    if (this.activeRun) {
      throw new Error(
        "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    const messages = this.normalizeInput(input, images);
    await this.runPrompt(messages);
  }

  /**
   * Continue from the current transcript.
   * The last message must be a user or tool-result message.
   */
  async continue(): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }

    const lastMessage = this._messages[this._messages.length - 1];
    if (!lastMessage) {
      throw new Error("No messages to continue from");
    }

    if (lastMessage.role === "assistant") {
      // Try to drain queued messages instead
      const queuedSteering = this.steeringQueue.drain();
      if (queuedSteering.length > 0) {
        await this.runPrompt(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }
      const queuedFollowUps = this.followUpQueue.drain();
      if (queuedFollowUps.length > 0) {
        await this.runPrompt(queuedFollowUps);
        return;
      }
      throw new Error("Cannot continue from message role: assistant");
    }

    await this.runContinuation();
  }

  // ==========================================================================
  // Internal — Run Lifecycle
  // ==========================================================================

  private normalizeInput(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
    if (Array.isArray(input)) return input;
    if (typeof input !== "string") return [input];

    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
    if (images && images.length > 0) content.push(...images);
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  private async runPrompt(messages: AgentMessage[], options?: { skipInitialSteeringPoll?: boolean }): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,
        this.createContextSnapshot(),
        this.createLoopConfig(options),
        (event) => this.processEvent(event),
        signal,
      );
    });
  }

  private async runContinuation(): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(
        this.createContextSnapshot(),
        this.createLoopConfig(),
        (event) => this.processEvent(event),
        signal,
      );
    });
  }

  private createContextSnapshot(): AgentContext {
    return {
      systemPrompt: this._systemPrompt,
      messages: this._messages,  // Mutable reference — loop mutates in place
      tools: this._tools.slice(),
    };
  }

  private createLoopConfig(options?: { skipInitialSteeringPoll?: boolean }): AgentLoopConfig {
    let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;

    return {
      model: this._model,
      reasoning: this._thinkingLevel === "off" ? undefined : this._thinkingLevel,
      apiKey: this.apiKey,
      getApiKey: this.getApiKey,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      toolExecution: this.toolExecution,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
      prepareNextTurn: this.prepareNextTurn,
      shouldStopAfterTurn: this.shouldStopAfterTurn,
      streamFn: this.streamFn,
      onDelta: this.onDelta,
      getSteeringMessages: async () => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this.steeringQueue.drain();
      },
      getFollowUpMessages: async () => this.followUpQueue.drain(),
    };
  }

  private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing.");
    }

    const abortController = new AbortController();
    let resolvePromise = () => {};
    const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
    this.activeRun = { promise, resolve: resolvePromise, abortController };

    this._isStreaming = true;
    this._streamingMessage = undefined;
    this._errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }

  private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const failureMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      provider: this._model.provider,
      model: this._model.id,
      usage: EMPTY_USAGE,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    await this.processEvent({ type: "message_start", message: failureMessage });
    await this.processEvent({ type: "message_end", message: failureMessage });
    await this.processEvent({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.processEvent({ type: "agent_end", messages: [failureMessage] });
  }

  private finishRun(): void {
    this._isStreaming = false;
    this._streamingMessage = undefined;
    this._pendingToolCalls = new Set();
    this.activeRun?.resolve();
    this.activeRun = undefined;
  }

  // ==========================================================================
  // Internal — Event Processing (State Reduce + Broadcast)
  // ==========================================================================

  /**
   * Process an event from the agent loop:
   * 1. Update internal state (reduce)
   * 2. Broadcast to all subscribers
   */
  private async processEvent(event: AgentEvent): Promise<void> {
    // ---- State reduce ----
    switch (event.type) {
      case "message_start":
        this._streamingMessage = event.message;
        break;

      case "message_update":
        this._streamingMessage = event.message;
        break;

      case "message_end":
        this._streamingMessage = undefined;
        // Only push to messages if the loop didn't already (for tool results and prompts,
        // the loop pushes to context.messages which IS this._messages)
        // The loop already pushes assistant messages and tool results to context.messages.
        // We don't double-push here because context.messages IS this._messages (same reference).
        break;

      case "tool_execution_start": {
        const next = new Set(this._pendingToolCalls);
        next.add(event.toolCallId);
        this._pendingToolCalls = next;
        break;
      }

      case "tool_execution_end": {
        const next = new Set(this._pendingToolCalls);
        next.delete(event.toolCallId);
        this._pendingToolCalls = next;
        break;
      }

      case "turn_end":
        if (event.message.errorMessage) {
          this._errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        this._streamingMessage = undefined;
        break;
    }

    // ---- Broadcast to listeners ----
    const signal = this.activeRun?.abortController.signal;
    if (!signal) {
      // Can happen if event is emitted during failure handling after finishRun
      const dummySignal = new AbortController().signal;
      for (const listener of this.listeners) {
        await listener(event, dummySignal);
      }
      return;
    }
    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }
}

// ============================================================================
// Default convertToLlm
// ============================================================================

function defaultConvertToLlm(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(
    (msg) => msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult",
  );
}