/** 将现有 Pi SDK Agent loop 适配到 Runtime-neutral 接口。 */
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager as PiSessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  ActiveRuntimeRun,
  RuntimeEvent,
  RuntimeRunResult,
} from "../types.js";
import { PI_SDK_CAPABILITIES } from "../capabilities.js";
import { piEventToRuntimeEvents } from "./events.js";
import type {
  AgentEvent,
  AgentMessage,
  AgentToolResult,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../../config/index.js";
import type { ModelRuntimeSnapshot } from "./models/runtime.js";
import {
  normalizeToolReturn,
  type ToolDefinition as TradexToolDefinition,
  type ToolRegistry,
} from "../../tools/registry.js";

export interface ActiveAgentRun {
  abort(): void | Promise<void>;
}

export interface PiAgentRuntime extends ActiveAgentRun {
  messages: AgentMessage[];
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
}

export type PiRuntimeRunInput = Parameters<typeof createPiAgentRuntime>[0] & {
  prompt: string;
  images?: ImageContent[];
};

// 将进程内 Pi SDK Agent 适配为统一 Runtime 入口。
export class PiSdkRuntime {
  readonly id = "pi" as const;
  readonly capabilities = PI_SDK_CAPABILITIES;

  // 创建一次延迟启动且可订阅的 Pi Runtime run。
  async start(input: PiRuntimeRunInput): Promise<ActiveRuntimeRun> {
    const agent = await createPiAgentRuntime(input);
    return new PiActiveRuntimeRun(agent, input.prompt, input.images);
  }
}

// 管理单次 Pi run 的事件订阅、取消和异步结算。
class PiActiveRuntimeRun implements ActiveRuntimeRun {
  readonly runtime = "pi" as const;
  readonly capabilities = PI_SDK_CAPABILITIES;
  readonly result: Promise<RuntimeRunResult>;
  private readonly listeners = new Set<(event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>>();
  private readonly abortController = new AbortController();
  private readonly pendingEvents: RuntimeEvent[] = [];
  private hasSubscribed = false;
  private delivery = Promise.resolve();
  private listenerError: Error | null = null;
  private turnIndex = 0;

  // 绑定 Pi Agent、缓存早期事件并安排 prompt 执行。
  constructor(agent: PiAgentRuntime, prompt: string, images?: ImageContent[]) {
    let output = "";
    let error: string | null = null;
    let sawRunEnd = false;
    agent.subscribe(async (event) => {
      if (event.type === "turn_start") this.turnIndex += 1;
      for (const convertedEvent of piEventToRuntimeEvents(event, `turn:${this.turnIndex}`)) {
        const runtimeEvent = convertedEvent.type === "run-end" && this.abortController.signal.aborted
          ? { ...convertedEvent, status: "aborted" as const }
          : convertedEvent;
        if (runtimeEvent.type === "run-end") sawRunEnd = true;
        if (runtimeEvent.type === "message-end" && runtimeEvent.message.role === "assistant") {
          output = runtimeEvent.message.content
            .filter((item): item is TextContent => item.type === "text")
            .map((item) => item.text)
            .join("");
          error = runtimeEvent.message.error ?? null;
        }
        if (!this.hasSubscribed) this.pendingEvents.push(runtimeEvent);
        else for (const listener of this.listeners) this.deliver(runtimeEvent, listener);
      }
    });
    this.result = new Promise((resolve) => {
      queueMicrotask(() => {
        void agent.prompt(prompt, images).then(
          async () => {
            if (!sawRunEnd) this.emit({
              type: "run-end",
              result: output,
              status: this.abortController.signal.aborted ? "aborted" : error ? "error" : "completed",
            });
            await this.delivery;
            resolve(this.listenerError
              ? { output, error: this.listenerError.message, errorCode: "runtime_listener_failed" }
              : this.abortController.signal.aborted
                ? { output, error: "Pi run was aborted", errorCode: "aborted" }
                : { output, error });
          },
          async (cause) => {
            const aborted = this.abortController.signal.aborted;
            const detail = aborted ? "Pi run was aborted" : cause instanceof Error ? cause.message : String(cause);
            if (!sawRunEnd) this.emit({ type: "run-end", result: output, status: aborted ? "aborted" : "error" });
            await this.delivery;
            resolve({ output, error: detail, errorCode: aborted ? "aborted" : "runtime_failure" });
          },
        );
      });
    });
    this.abort = () => {
      this.abortController.abort();
      return agent.abort();
    };
  }

  // 注册有序异步事件 listener，并回放订阅前事件。
  subscribe(listener: (event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    if (!this.hasSubscribed) {
      this.hasSubscribed = true;
      const pending = this.pendingEvents.splice(0);
      for (const event of pending) this.deliver(event, listener);
    }
    return () => this.listeners.delete(listener);
  }

  // 中止底层 Pi Agent，并向 listener 传播取消信号。
  abort: () => void | Promise<void>;

  // 向当前 listener 发送事件，或在订阅前暂存事件。
  private emit(event: RuntimeEvent): void {
    if (!this.hasSubscribed) this.pendingEvents.push(event);
    else for (const listener of this.listeners) this.deliver(event, listener);
  }

  // 串行执行 listener，并将监听异常纳入 run 结算。
  private deliver(event: RuntimeEvent, listener: (event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>): void {
    this.delivery = this.delivery.then(() => listener(event, this.abortController.signal)).catch((cause) => {
      this.listenerError ??= cause instanceof Error ? cause : new Error(String(cause));
    });
  }
}

export async function createPiAgentRuntime(input: {
  config: AgentConfig;
  modelRuntime: ModelRuntimeSnapshot;
  systemPrompt: string;
  tools: ToolRegistry;
  sessionManager?: PiSessionManager;
  maxTurns?: number;
  /** Called immediately before each provider stream request (e.g. rate-limit reserve). */
  beforeProviderRequest?: () => void;
}): Promise<PiAgentRuntime> {
  const {
    authStorage,
    modelRegistry,
    model,
  } = input.modelRuntime.resolve(input.config);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => input.systemPrompt,
    extensionFactories: [],
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
  });
  await resourceLoader.reload();

  const customTools = input.tools.listTools().map(toPiTool);
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    thinkingLevel: toThinkingLevel(input.config.reasoningEffort),
    authStorage,
    modelRegistry,
    resourceLoader,
    settingsManager,
    sessionManager: input.sessionManager ?? PiSessionManager.inMemory(),
    tools: ["read", ...customTools.map((tool) => tool.name)],
    customTools,
  });
  session.agent.toolExecution = "sequential";
  // Single wrapper for cross-cutting concerns on the provider stream. Auth for
  // no-auth providers is handled at registration time (authHeader:false +
  // apiKey:"no-auth" in buildModelRuntimeSnapshot), so it is not repeated here.
  if (input.beforeProviderRequest) {
    const beforeProviderRequest = input.beforeProviderRequest;
    const baseStreamFn = session.agent.streamFn.bind(session.agent);
    session.agent.streamFn = (modelArg, context, options) => {
      beforeProviderRequest();
      return baseStreamFn(modelArg, context, options);
    };
  }
  if (input.maxTurns !== undefined) {
    let turns = 0;
    session.subscribe((event) => {
      if (event.type !== "turn_end") return;
      turns += 1;
      if (turns >= input.maxTurns!) session.agent.abort();
    });
  }

  return {
    get messages() {
      return session.agent.state.messages;
    },
    set messages(messages) {
      session.agent.state.messages = messages;
    },
    subscribe(listener) {
      return session.subscribe((event) => {
        if (
          event.type === "message_start" ||
          event.type === "message_update" ||
          event.type === "message_end" ||
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_update" ||
          event.type === "tool_execution_end" ||
          event.type === "turn_start" ||
          event.type === "turn_end" ||
          event.type === "agent_start" ||
          event.type === "agent_end"
        ) {
          return listener(event as AgentEvent);
        }
      });
    },
    prompt(text, images) {
      return session.prompt(text, {
        images,
        expandPromptTemplates: false,
        source: "rpc",
      });
    },
    abort() {
      void session.abort();
    },
  };
}

function toPiTool(tool: TradexToolDefinition): ToolDefinition {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    executionMode: tool.executionMode,
    async execute(_toolCallId, params, signal, onUpdate): Promise<AgentToolResult<unknown>> {
      const raw = await tool.execute(
        params as Record<string, unknown>,
        signal,
        (update) => {
          onUpdate?.({
            content: update.content,
            details: update.details,
          } as AgentToolResult<unknown>);
        },
      );
      const normalized = normalizeToolReturn(raw);
      return {
        content: normalized.content,
        details: normalized.details,
        terminate: normalized.terminate,
      };
    },
  });
}

function toThinkingLevel(value: string): ThinkingLevel {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return "medium";
  }
}
