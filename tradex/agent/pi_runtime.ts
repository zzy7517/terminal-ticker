import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager as PiSessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentEvent,
  AgentMessage,
  AgentToolResult,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentConfig } from "../config/index.js";
import { resolveAgentModelFromConfig } from "./models.js";
import {
  normalizeToolReturn,
  type ToolDefinition as TradexToolDefinition,
  type ToolRegistry,
} from "./tools/registry.js";

export interface ActiveAgentRun {
  abort(): void | Promise<void>;
  steer(message: AgentMessage): void | Promise<void>;
}

export interface PiAgentRuntime extends ActiveAgentRun {
  messages: AgentMessage[];
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
}

const PROVIDER_ALIASES: Record<string, string> = {
  codex: "openai-codex",
};

export interface PiModelAccess {
  provider: string;
  model: Model<any>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

export function createPiModelAccess(config: AgentConfig): PiModelAccess {
  const resolved = resolveAgentModelFromConfig(config);
  const provider = PROVIDER_ALIASES[resolved.provider] ?? resolved.provider;
  const authStorage = AuthStorage.inMemory();
  if (resolved.apiKey) authStorage.setRuntimeApiKey(provider, resolved.apiKey);

  const modelRegistry = ModelRegistry.inMemory(authStorage);
  if (resolved.baseUrl) {
    modelRegistry.registerProvider(provider, {
      baseUrl: resolved.baseUrl,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    });
  }

  let model = modelRegistry.find(provider, resolved.id);
  // Catalog-selected and custom models both live in config as free-form ids.
  // Register unknown ids from a same-provider template so Fetch/toggle works
  // without requiring a separate customModels entry.
  if (!model) {
    const template = modelRegistry.getAll().find((candidate) => candidate.provider === provider);
    if (!template) {
      throw new Error(`Pi does not know model ${provider}/${resolved.id}; add it to Pi's model registry before using it`);
    }
    modelRegistry.registerProvider(provider, {
      baseUrl: resolved.baseUrl || template.baseUrl,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      models: [{
        id: resolved.id,
        name: resolved.id,
        api: template.api,
        reasoning: template.reasoning,
        input: template.input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: template.contextWindow,
        maxTokens: template.maxTokens,
        compat: template.compat,
      }],
    });
    model = modelRegistry.find(provider, resolved.id);
  }
  if (!model) {
    throw new Error(`Pi does not know model ${provider}/${resolved.id}; add it to Pi's model registry before using it`);
  }
  return { provider, model, authStorage, modelRegistry };
}

export async function createPiAgentRuntime(input: {
  config: AgentConfig;
  systemPrompt: string;
  tools: ToolRegistry;
  maxTurns?: number;
  /** Called immediately before each provider stream request (e.g. rate-limit reserve). */
  beforeProviderRequest?: () => void;
}): Promise<PiAgentRuntime> {
  const { authStorage, modelRegistry, model } = createPiModelAccess(input.config);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager,
    systemPromptOverride: () => input.systemPrompt,
    extensionFactories: [],
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
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
    sessionManager: PiSessionManager.inMemory(),
    noTools: "all",
    tools: customTools.map((tool) => tool.name),
    customTools,
  });
  session.agent.toolExecution = "sequential";
  if (input.beforeProviderRequest) {
    const baseStreamFn = session.agent.streamFn.bind(session.agent);
    session.agent.streamFn = (modelArg, context, options) => {
      input.beforeProviderRequest!();
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
