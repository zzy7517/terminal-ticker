/**
 * core/agent.ts — Stateful Agent class.
 *
 * Modeled after pi-mono's packages/agent/src/agent.ts.
 *
 * The Agent owns the conversation transcript, emits lifecycle events, executes
 * tools, and exposes queueing APIs for steering and follow-up messages.
 *
 * Key design:
 * - Agent is long-lived (survives across multiple prompt() calls)
 * - Messages persist in state across turns
 * - Steering and follow-up queues are built-in with configurable drain modes
 * - createContextSnapshot() copies messages — the loop works on its own copy
 * - processEvents() is the ONLY path that mutates authoritative state
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
    if (!first) {
      return [];
    }
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

type ActiveRun = {
  promise: Promise<void>;
  resolve: () => void;
  abortController: AbortController;
};

type MutableAgentState = {
  systemPrompt: string;
  model: AgentModelDescriptor;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
};

function createMutableAgentState(
  initialState?: Partial<Pick<AgentState, "systemPrompt" | "model" | "thinkingLevel" | "tools" | "messages">>,
): MutableAgentState {
  return {
    systemPrompt: initialState?.systemPrompt ?? "",
    model: initialState?.model ?? { id: "unknown", provider: "unknown", api: "unknown", baseUrl: "", reasoningEffort: "medium" },
    thinkingLevel: initialState?.thinkingLevel ?? "off",
    tools: initialState?.tools?.slice() ?? [],
    messages: initialState?.messages?.slice() ?? [],
    isStreaming: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined,
  };
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

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
  private _state: MutableAgentState;
  private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;

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

  // ---- Lifecycle ----
  private activeRun?: ActiveRun;

  constructor(options: AgentOptions) {
    this._state = createMutableAgentState(options.initialState);

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
    return this._state;
  }

  get systemPrompt(): string { return this._state.systemPrompt; }
  set systemPrompt(value: string) { this._state.systemPrompt = value; }

  get model(): AgentModelDescriptor { return this._state.model; }
  set model(value: AgentModelDescriptor) { this._state.model = value; }

  get thinkingLevel(): ThinkingLevel { return this._state.thinkingLevel; }
  set thinkingLevel(value: ThinkingLevel) { this._state.thinkingLevel = value; }

  get tools(): AgentTool[] { return this._state.tools; }
  set tools(value: AgentTool[]) { this._state.tools = value.slice(); }

  get messages(): AgentMessage[] { return this._state.messages; }
  set messages(value: AgentMessage[]) { this._state.messages = value.slice(); }

  get isStreaming(): boolean { return this._state.isStreaming; }

  // ==========================================================================
  // Event Subscription
  // ==========================================================================

  /**
   * Subscribe to agent lifecycle events.
   *
   * Listener promises are awaited in subscription order and are included in
   * the current run's settlement. Listeners also receive the active abort
   * signal for the current run.
   *
   * `agent_end` is the final emitted event for a run, but the agent does not
   * become idle until all awaited listeners for that event have settled.
   */
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ==========================================================================
  // Queue APIs
  // ==========================================================================

  /** Controls how queued steering messages are drained. */
  set steeringMode(mode: QueueMode) {
    this.steeringQueue.mode = mode;
  }

  get steeringMode(): QueueMode {
    return this.steeringQueue.mode;
  }

  /** Controls how queued follow-up messages are drained. */
  set followUpMode(mode: QueueMode) {
    this.followUpQueue.mode = mode;
  }

  get followUpMode(): QueueMode {
    return this.followUpQueue.mode;
  }

  /** Queue a message to be injected after the current assistant turn finishes. */
  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  /** Queue a message to run only after the agent would otherwise stop. */
  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  /** Remove all queued steering messages. */
  clearSteeringQueue(): void {
    this.steeringQueue.clear();
  }

  /** Remove all queued follow-up messages. */
  clearFollowUpQueue(): void {
    this.followUpQueue.clear();
  }

  /** Remove all queued steering and follow-up messages. */
  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  /** Returns true when either queue still contains pending messages. */
  hasQueuedMessages(): boolean {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  // ==========================================================================
  // Lifecycle Control
  // ==========================================================================

  /** Active abort signal for the current run, if any. */
  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  /** Abort the current run, if one is active. */
  abort(): void {
    this.activeRun?.abortController.abort();
  }

  /**
   * Resolve when the current run and all awaited event listeners have finished.
   * This resolves after `agent_end` listeners settle.
   */
  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  /** Clear transcript state, runtime state, and queued messages. */
  reset(): void {
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this._state.errorMessage = undefined;
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  // ==========================================================================
  // Prompt / Continue
  // ==========================================================================

  /** Start a new prompt from text, a single message, or a batch of messages. */
  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    if (this.activeRun) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    const messages = this.normalizePromptInput(input, images);
    await this.runPromptMessages(messages);
  }

  /** Continue from the current transcript. The last message must be a user or tool-result message. */
  async continue(): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }

    const lastMessage = this._state.messages[this._state.messages.length - 1];
    if (!lastMessage) {
      throw new Error("No messages to continue from");
    }

    if (lastMessage.role === "assistant") {
      const queuedSteering = this.steeringQueue.drain();
      if (queuedSteering.length > 0) {
        await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }

      const queuedFollowUps = this.followUpQueue.drain();
      if (queuedFollowUps.length > 0) {
        await this.runPromptMessages(queuedFollowUps);
        return;
      }

      throw new Error("Cannot continue from message role: assistant");
    }

    await this.runContinuation();
  }

  // ==========================================================================
  // Internal — Input Normalization
  // ==========================================================================

  private normalizePromptInput(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): AgentMessage[] {
    if (Array.isArray(input)) {
      return input;
    }

    if (typeof input !== "string") {
      return [input];
    }

    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
    if (images && images.length > 0) {
      content.push(...images);
    }
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  // ==========================================================================
  // Internal — Run Orchestration
  // ==========================================================================

  private async runPromptMessages(
    messages: AgentMessage[],
    options: { skipInitialSteeringPoll?: boolean } = {},
  ): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,
        this.createContextSnapshot(),
        this.createLoopConfig(options),
        (event) => this.processEvents(event),
        signal,
      );
    });
  }

  private async runContinuation(): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(
        this.createContextSnapshot(),
        this.createLoopConfig(),
        (event) => this.processEvents(event),
        signal,
      );
    });
  }

  /**
   * Create a context snapshot for the loop.
   *
   * IMPORTANT: messages are COPIED (slice). The loop works on its own copy.
   * State is only updated through processEvents() when events come back.
   */
  private createContextSnapshot(): AgentContext {
    return {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools.slice(),
    };
  }

  private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
    let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
    return {
      model: this._state.model,
      reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
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
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.activeRun = { promise, resolve: resolvePromise, abortController };

    this._state.isStreaming = true;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }

  private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const failureMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      provider: this._state.model.provider,
      model: this._state.model.id,
      usage: EMPTY_USAGE,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    } satisfies AgentMessage;
    await this.processEvents({ type: "message_start", message: failureMessage });
    await this.processEvents({ type: "message_end", message: failureMessage });
    await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }

  private finishRun(): void {
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this.activeRun?.resolve();
    this.activeRun = undefined;
  }

  // ==========================================================================
  // Internal — Event Processing (State Reduce + Broadcast)
  // ==========================================================================

  /**
   * Reduce internal state for a loop event, then await listeners.
   *
   * `agent_end` only means no further loop events will be emitted. The run is
   * considered idle later, after all awaited listeners for that event have
   * settled and `finishRun()` clears runtime-owned state.
   */
  private async processEvents(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        this._state.streamingMessage = event.message;
        break;

      case "message_update":
        this._state.streamingMessage = event.message;
        break;

      case "message_end":
        this._state.streamingMessage = undefined;
        // Push to authoritative state. The loop works on its own copy
        // (createContextSnapshot copies messages), so this is the only place
        // where the Agent's state.messages grows.
        this._state.messages.push(event.message);
        break;

      case "tool_execution_start": {
        const pendingToolCalls = new Set(this._state.pendingToolCalls);
        pendingToolCalls.add(event.toolCallId);
        this._state.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "tool_execution_end": {
        const pendingToolCalls = new Set(this._state.pendingToolCalls);
        pendingToolCalls.delete(event.toolCallId);
        this._state.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this._state.errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        this._state.streamingMessage = undefined;
        break;
    }

    // Broadcast to listeners
    const signal = this.activeRun?.abortController.signal;
    if (!signal) {
      throw new Error("Agent listener invoked outside active run");
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
