/**
 * runtime.ts — 把 Tradex AgentConfig 桥接到 Pi 的 ModelRegistry。
 *
 * 构建不可变的 ModelRuntimeSnapshot：根据 provider 配置 / 自定义模型
 * 一次性注册 AuthStorage + ModelRegistry，供 agent 运行、memory 流水线
 * 和设置页 DTO 共享使用。
 *
 * 模型元数据来源：
 *  - "pi"     — Pi 内置目录
 *  - "custom" — watchlist.toml 里显式的 CustomModelDefinition
 *  - "legacy" — 只配了 model id、没有元数据（用占位默认值）
 */

import {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentConfig, CustomModelDefinition, ProviderProfile } from "../../../../config/index.js";
import {
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
  fromPiProviderId,
  normalizeApiMode,
  normalizeProvider,
  OPENAI_PROVIDER,
  toPiProviderId,
} from "./constants.js";
import {
  resolveAgentModelFromConfig,
  resolveProviderAccess,
} from "./resolve.js";

/** Pi 能实际流式调用的 wire-format；用于前端 `runnable` 标记。 */
const RUNNABLE_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
]);

/** 单次 LLM 调用拿到的句柄：Pi Model + 共享的鉴权 / registry。 */
export interface ModelRuntimeAccess {
  provider: string;
  model: Model<any>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  requiresAuth: boolean;
}

/** GET /api/agent/model-registry 返回的 provider 行。 */
export interface ModelRegistryProviderDTO {
  providerId: string;
  configProviderId: string;
  name: string;
  enabled: boolean;
  api: string;
  requiresAuth: boolean;
  baseUrlConfigured: boolean;
  authConfigured: boolean;
  discoverable: boolean;
  runnable: boolean;
}

/** GET /api/agent/model-registry 返回的 model 行。 */
export interface ModelRegistryModelDTO {
  providerId: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  selected: boolean;
  source: "pi" | "custom" | "legacy";
  runnable: boolean;
}

export interface ModelRegistryDTO {
  generation: number;
  providers: ModelRegistryProviderDTO[];
  models: ModelRegistryModelDTO[];
}

/** 限定选型：`provider:modelId`（model id 本身也可以含 `:`）。 */
export interface ModelSelection {
  provider: string;
  id: string;
}

/**
 * 解析 `"provider:modelId"` 或纯 model id。
 * 第一个 `:` 分隔 provider，其余整段是 model id（如 `codex:gpt:extra` → id 为 `gpt:extra`）。
 */
export function parseModelSelection(
  value: string | null | undefined,
  fallback: ModelSelection,
): ModelSelection {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const separator = trimmed.indexOf(":");
  if (separator <= 0) return { provider: fallback.provider, id: trimmed };
  return {
    provider: normalizeProvider(trimmed.slice(0, separator)),
    id: trimmed.slice(separator + 1).trim() || fallback.id,
  };
}

/** 把选型覆盖到 AgentConfig 上（cron / memory 阶段选模型用）。 */
export function agentConfigForModelSelection(
  config: AgentConfig,
  value: string | null | undefined,
): AgentConfig {
  const selection = parseModelSelection(value, {
    provider: config.provider,
    id: config.model,
  });
  const profile = config.providerProfiles[selection.provider];
  return {
    ...config,
    provider: selection.provider,
    model: selection.id,
    apiMode: normalizeApiMode(selection.provider, profile?.api),
    reasoningEffort: profile?.modelEfforts.find(([id]) => id === selection.id)?.[1]
      ?? config.reasoningEffort,
  };
}

/**
 * 不可变的运行时句柄。AuthStorage 与 ModelRegistry 构建一次后，
 * 由所有持有该快照的消费者共享。
 * 配置热更新时 `generation` 递增，前端可据此判断 DTO 是否过期。
 */
export class ModelRuntimeSnapshot {
  readonly generation: number;
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  private readonly modelSources: ReadonlyMap<string, ModelRegistryModelDTO["source"]>;
  private readonly selectedModels: ReadonlySet<string>;
  private readonly providerProfiles: ReadonlyMap<string, ProviderProfile>;

  constructor(input: {
    generation: number;
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
    modelSources: ReadonlyMap<string, ModelRegistryModelDTO["source"]>;
    selectedModels: ReadonlySet<string>;
    providerProfiles: ReadonlyMap<string, ProviderProfile>;
  }) {
    this.generation = input.generation;
    this.authStorage = input.authStorage;
    this.modelRegistry = input.modelRegistry;
    this.modelSources = input.modelSources;
    this.selectedModels = input.selectedModels;
    this.providerProfiles = input.providerProfiles;
  }

  /** 按 config 当前选型查找 Pi Model（未注册则抛错）。 */
  resolve(config: AgentConfig): ModelRuntimeAccess {
    const selection = resolveAgentModelFromConfig(config);
    const provider = toPiProviderId(selection.provider);
    const model = this.modelRegistry.find(provider, selection.id);
    if (!model) {
      throw new Error(
        `Pi does not know model ${provider}/${selection.id}; register model metadata before using it`,
      );
    }
    return {
      provider,
      model,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      requiresAuth: this.providerProfiles.get(selection.provider)?.requiresAuth ?? true,
    };
  }

  /** 把 UI/API 选型解析成 model DTO（接受 logical 或 Pi 的 provider id）。 */
  resolveSelection(selection: ModelSelection): ModelRegistryModelDTO {
    const logicalProvider = normalizeProvider(fromPiProviderId(selection.provider.trim().toLowerCase()));
    const providerId = toPiProviderId(logicalProvider);
    const model = this.modelRegistry.find(providerId, selection.id.trim());
    if (!model) throw new Error(`Unknown model selection: ${providerId}/${selection.id}`);
    return this.toModelDTO(model);
  }

  /** 设置页模型选择器用的完整 registry 载荷。 */
  toDTO(): ModelRegistryDTO {
    // 只暴露后端 config.providerProfiles 里声明过的 provider；
    // Pi 内置目录仍留在内存 registry 里供解析，但不进前端列表。
    const allowedProviderIds = new Set(
      [...this.providerProfiles.keys()].map(toPiProviderId),
    );
    const models = this.modelRegistry.getAll()
      .filter((model) => allowedProviderIds.has(model.provider))
      .map((model) => this.toModelDTO(model))
      .sort((a, b) => a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name));
    const providers = [...allowedProviderIds]
      .map((providerId) => ({
        ...this.providerDTO(providerId),
        runnable: models.some((model) => model.providerId === providerId && model.runnable),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { generation: this.generation, providers, models };
  }

  private toModelDTO(model: Model<any>): ModelRegistryModelDTO {
    const logicalProvider = fromPiProviderId(model.provider);
    const profile = this.providerProfiles.get(logicalProvider);
    const key = modelKey(logicalProvider, model.id);
    const authConfigured = profile?.requiresAuth === false
      || this.modelRegistry.hasConfiguredAuth(model);
    return {
      providerId: model.provider,
      id: model.id,
      name: model.name,
      api: String(model.api),
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      selected: this.selectedModels.has(key),
      source: this.modelSources.get(key) ?? "pi",
      // 已启用 + 鉴权就绪 + Pi 能流式调用该 wire-format。
      runnable: Boolean(profile?.enabled && authConfigured && RUNNABLE_APIS.has(String(model.api))),
    };
  }

  private providerDTO(providerId: string): Omit<ModelRegistryProviderDTO, "runnable"> {
    const logicalProvider = fromPiProviderId(providerId);
    const profile = this.providerProfiles.get(logicalProvider);
    const catalogApi = this.modelRegistry.getAll().find((model) => model.provider === providerId)?.api;
    return {
      providerId,
      configProviderId: logicalProvider,
      name: profile?.displayName || this.modelRegistry.getProviderDisplayName(providerId),
      enabled: profile?.enabled ?? false,
      api: profile?.api ?? (catalogApi ? String(catalogApi) : ""),
      requiresAuth: profile?.requiresAuth ?? true,
      baseUrlConfigured: Boolean(profile?.baseUrl),
      authConfigured: profile?.requiresAuth === false || this.modelRegistry.getAll()
        .some((model) => model.provider === providerId && this.modelRegistry.hasConfiguredAuth(model)),
      // 仅这三个 provider 支持拉远端 /models。
      discoverable: [CODEX_PROVIDER, ANTHROPIC_PROVIDER, OPENAI_PROVIDER].includes(logicalProvider),
    };
  }
}

const LEGACY_CONTEXT_WINDOW = 32_768;
const LEGACY_MAX_TOKENS = 4_096;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function modelKey(provider: string, id: string): string {
  return `${provider}\0${id}`;
}

/** 用显式 CustomModelDefinition 构造 Pi Model。 */
function configuredModel(
  definition: CustomModelDefinition,
  baseUrl: string,
): Model<any> {
  return {
    id: definition.id,
    name: definition.name,
    provider: "",
    api: definition.api,
    baseUrl,
    reasoning: definition.reasoning,
    input: [...definition.input],
    cost: ZERO_COST,
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxTokens,
  };
}

/**
 * 占位元数据：配置里有 model id，但既没有 CustomModelDefinition，
 * 也不在 Pi 内置目录中。
 */
function legacyModel(id: string, profile: ProviderProfile, baseUrl: string): Model<any> {
  return configuredModel({
    id,
    name: `${id} [legacy metadata]`,
    api: profile.api,
    reasoning: false,
    input: ["text"],
    contextWindow: LEGACY_CONTEXT_WINDOW,
    maxTokens: LEGACY_MAX_TOKENS,
  }, baseUrl);
}

function registryModelConfig(model: Model<any>) {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: [...model.input],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    compat: model.compat,
  };
}

/**
 * 把所有 provider profile 注册进一份全新的内存 Pi ModelRegistry。
 * 启动时以及 agent 配置热更新时调用（`generation` 递增）。
 */
export function buildModelRuntimeSnapshot(
  config: AgentConfig,
  generation: number,
): ModelRuntimeSnapshot {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const modelSources = new Map<string, ModelRegistryModelDTO["source"]>();
  const selectedModels = new Set<string>();
  const providerProfiles = new Map<string, ProviderProfile>();

  for (const [rawProvider, profile] of Object.entries(config.providerProfiles)) {
    const logicalProvider = normalizeProvider(rawProvider);
    const providerId = toPiProviderId(logicalProvider);
    const access = resolveProviderAccess(config, logicalProvider);
    providerProfiles.set(logicalProvider, profile);
    for (const id of profile.models) selectedModels.add(modelKey(logicalProvider, id));
    if (access.apiKey) authStorage.setRuntimeApiKey(providerId, access.apiKey);

    // 先取 Pi 内置模型，再叠加 custom / legacy。
    const existing = modelRegistry.getAll().filter((model) => model.provider === providerId);
    const providerBaseUrl = access.baseUrl || existing[0]?.baseUrl || "";
    const merged = new Map(existing.map((model) => [model.id, model]));
    for (const definition of profile.customModelDefinitions) {
      const model = configuredModel(definition, providerBaseUrl);
      model.provider = providerId;
      merged.set(model.id, model);
      modelSources.set(modelKey(logicalProvider, model.id), "custom");
    }
    const configuredIds = new Set([...profile.models, ...profile.customModels]);
    for (const id of configuredIds) {
      if (merged.has(id)) continue;
      const model = legacyModel(id, profile, providerBaseUrl);
      model.provider = providerId;
      merged.set(id, model);
      modelSources.set(modelKey(logicalProvider, id), "legacy");
    }

    const requiresModelRegistration = profile.customModelDefinitions.length > 0
      || [...configuredIds].some((id) => !existing.some((model) => model.id === id));
    if (requiresModelRegistration) {
      // 替换/扩展 provider 条目，让 custom + legacy 对 Pi 可见。
      modelRegistry.registerProvider(providerId, {
        name: profile.displayName,
        api: profile.api,
        baseUrl: providerBaseUrl,
        apiKey: profile.requiresAuth
          ? access.apiKey || "$TRADEX_MODEL_API_KEY"
          : "no-auth",
        authHeader: profile.requiresAuth,
        models: [...merged.values()].map(registryModelConfig),
      });
    } else if (access.baseUrl || access.apiKey || !profile.requiresAuth) {
      // 内置 provider 保留 Pi 完整目录；无需额外模型元数据时，只覆盖端点与鉴权。
      modelRegistry.registerProvider(providerId, {
        ...(access.baseUrl ? { baseUrl: access.baseUrl } : {}),
        ...(profile.requiresAuth
          ? access.apiKey ? { apiKey: access.apiKey } : {}
          : {
              apiKey: "no-auth",
              authHeader: false,
            }),
      });
    }
  }

  // 兼容极简 AgentConfig：当前选型的 provider 不在 providerProfiles 里。
  const selected = resolveAgentModelFromConfig(config);
  const selectedProviderId = toPiProviderId(selected.provider);
  if (selected.apiKey) authStorage.setRuntimeApiKey(selectedProviderId, selected.apiKey);
  if (!config.providerProfiles[selected.provider] && selected.baseUrl) {
    modelRegistry.registerProvider(selectedProviderId, {
      baseUrl: selected.baseUrl,
      ...(selected.apiKey ? { apiKey: selected.apiKey } : {}),
    });
  }

  // 发布快照前校验默认模型已注册。
  if (!modelRegistry.find(selectedProviderId, selected.id)) {
    throw new Error(
      `Pi does not know model ${selectedProviderId}/${selected.id}; register model metadata before using it`,
    );
  }

  return new ModelRuntimeSnapshot({
    generation,
    authStorage,
    modelRegistry,
    modelSources,
    selectedModels,
    providerProfiles,
  });
}
