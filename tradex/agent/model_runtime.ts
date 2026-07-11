import {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentConfig, CustomModelDefinition, ProviderProfile } from "../config/index.js";
import {
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
  fromPiProviderId,
  normalizeApiMode,
  normalizeProvider,
  OPENAI_PROVIDER,
  toPiProviderId,
} from "../config/agent_models.js";
import {
  resolveAgentModelFromConfig,
  resolveProviderAccess,
} from "./models.js";

const RUNNABLE_APIS = new Set([
  "openai-completions",
  "mistral-conversations",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
]);

export interface ModelRuntimeAccess {
  provider: string;
  model: Model<any>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  requiresAuth: boolean;
}

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

export interface ModelSelection {
  provider: string;
  id: string;
}

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
 * Immutable runtime handle. Its AuthStorage and ModelRegistry are built once,
 * then shared by every consumer that captures this snapshot.
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

  resolveSelection(selection: ModelSelection): ModelRegistryModelDTO {
    const logicalProvider = normalizeProvider(fromPiProviderId(selection.provider.trim().toLowerCase()));
    const providerId = toPiProviderId(logicalProvider);
    const model = this.modelRegistry.find(providerId, selection.id.trim());
    if (!model) throw new Error(`Unknown model selection: ${providerId}/${selection.id}`);
    return this.toModelDTO(model);
  }

  toDTO(): ModelRegistryDTO {
    const models = this.modelRegistry.getAll()
      .map((model) => this.toModelDTO(model))
      .sort((a, b) => a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name));
    const providerIds = new Set([
      ...models.map((model) => model.providerId),
      ...[...this.providerProfiles.keys()].map(toPiProviderId),
    ]);
    const providers = [...providerIds]
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
      // Built-in providers retain Pi's complete catalog; only request endpoint
      // and auth are overridden when no configured model metadata is needed.
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

  // Preserve compatibility with minimal AgentConfig objects whose selected
  // provider is absent from providerProfiles.
  const selected = resolveAgentModelFromConfig(config);
  const selectedProviderId = toPiProviderId(selected.provider);
  if (selected.apiKey) authStorage.setRuntimeApiKey(selectedProviderId, selected.apiKey);
  if (!config.providerProfiles[selected.provider] && selected.baseUrl) {
    modelRegistry.registerProvider(selectedProviderId, {
      baseUrl: selected.baseUrl,
      ...(selected.apiKey ? { apiKey: selected.apiKey } : {}),
    });
  }

  // Validate the configured default before publishing the snapshot.
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
