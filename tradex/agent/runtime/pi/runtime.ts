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
  steer?(message: AgentMessage): void | Promise<void>;
}

export interface PiAgentRuntime extends ActiveAgentRun {
  messages: AgentMessage[];
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
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
          listener(event as AgentEvent);
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
    async steer(message) {
      const content = message.role === "user" ? message.content : "";
      const text = typeof content === "string"
        ? content
        : content.filter((item): item is TextContent => item.type === "text").map((item) => item.text).join("");
      const images = typeof content === "string"
        ? undefined
        : content.filter((item): item is ImageContent => item.type === "image");
      await session.steer(text, images);
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
