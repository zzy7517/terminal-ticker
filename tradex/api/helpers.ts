/** 提供 Agent、Session 和配置路由共用的投影及校验辅助函数。 */
import { loadConfig, type AgentConfig, type MemoryConfig, type NewsConfig, type ProviderProfile, type ProxyConfig, type ProxyType } from "../config/index.js";
import { defaultProviderApi, normalizeApiMode, normalizeProvider } from "../agent/runtime/pi/models/constants.js";
import {
  listPiSessions,
  openPiSession,
  piSessionPayload,
  piSessionSummary,
} from "../agent/runtime/pi/sessions.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AppRuntime } from "./runtime.js";
import { PI_SDK_CAPABILITIES } from "../agent/runtime/capabilities.js";

// Returns a stable idle run descriptor for sessions that have no active agent loop.
export function idleRun(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    runId: null,
    status: "idle",
    activeFlags: [],
    lastSeq: 0,
    error: null,
  };
}

// Resolves a SessionManager for the given ID, checking the pending map first,
// then the index, then a full disk scan as a last resort.
export async function openSessionManager(sessionId: string, runtime?: AppRuntime): Promise<SessionManager | null> {
  const pending = runtime?.pendingSessionManagers.get(sessionId);
  if (pending) return pending;
  return openPiSession(sessionId);
}

// Builds the session + messages payload returned by the single-session endpoints.
export async function sessionResponse(runtime: AppRuntime, sessionId: string): Promise<Record<string, unknown>> {
  const claude = runtime.claudeSessions.payload(sessionId);
  if (claude) {
    return {
      ...claude,
      run: runtime.lockedAgentSessions.has(sessionId)
        ? { ...idleRun(sessionId), status: "running" }
        : idleRun(sessionId),
    };
  }
  const mgr = await openSessionManager(sessionId, runtime);
  if (!mgr) return { session: null, messages: [], run: idleRun(sessionId) };
  return {
    ...withPiCapabilities(piSessionPayload(mgr)),
    run: runtime.lockedAgentSessions.has(sessionId)
      ? { ...idleRun(sessionId), status: "running" }
      : idleRun(sessionId),
  };
}

// Returns the sidebar session list (max 200) with the first 5 sessions
// pre-loaded so the frontend can render them without extra round-trips.
export async function sessionHistory(runtime: AppRuntime): Promise<Record<string, unknown>> {
  const listed = (await listPiSessions()).filter((row) => row.messageCount > 0).slice(0, 200);
  const managers = await Promise.all(listed.map((row) => openPiSession(row.id)));
  const piSummaries: Array<Record<string, unknown>> = listed.flatMap((row, index) => {
    const manager = managers[index];
    if (!manager) return [];
    return [{
      ...withPiCapabilities(piSessionSummary(row, manager)),
      run: runtime.lockedAgentSessions.has(row.id)
        ? { ...idleRun(row.id), status: "running" }
        : idleRun(row.id),
    }];
  });
  const claudeSummaries: Array<Record<string, unknown>> = runtime.claudeSessions.list().map((item) => ({
    ...item,
    run: runtime.lockedAgentSessions.has(String(item.id))
      ? { ...idleRun(String(item.id)), status: "running" }
      : idleRun(String(item.id)),
  }));
  const summaries = [...piSummaries, ...claudeSummaries]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 200);
  return {
    sessions: summaries,
    preloadedSessions: await Promise.all(
      summaries.slice(0, 5).map((item) => sessionResponse(runtime, String(item.id))),
    ),
  };
}

function withPiCapabilities<T extends Record<string, unknown>>(payload: T): T {
  if (payload.session && typeof payload.session === "object" && !Array.isArray(payload.session)) {
    return { ...payload, session: { ...(payload.session as Record<string, unknown>), capabilities: PI_SDK_CAPABILITIES } };
  }
  return { ...payload, capabilities: PI_SDK_CAPABILITIES };
}

// Shapes an instrument into the catalog item format consumed by the add-instrument UI.
export function catalogItem(instrument: { key: string; source: string; symbol: string; label: string; group: string; analysisInterval?: string | null }, activeKeys: Set<string>): Record<string, unknown> {
  return {
    source: instrument.source,
    symbol: instrument.symbol,
    label: instrument.label,
    instType: "instType" in instrument ? instrument.instType : null,
    group: instrument.group,
    category: "category" in instrument ? instrument.category : null,
    dex: "dex" in instrument ? instrument.dex : null,
    key: instrument.key,
    displayText: `${instrument.label} (${instrument.key})`,
    exists: activeKeys.has(instrument.key),
  };
}

// Merges per-request provider/model overrides from the SSE body into the
// persisted agent config without mutating it.
export function agentConfigForRequest(config: AgentConfig, body: Record<string, unknown>): AgentConfig {
  const provider = normalizeProvider(
    typeof body.provider === "string" && body.provider.trim() ? body.provider : config.provider,
  );
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : config.model;
  const existingProfile = config.providerProfiles[provider];
  return {
    ...config,
    provider,
    apiMode: normalizeApiMode(provider),
    model,
    providerProfiles: {
      ...config.providerProfiles,
      [provider]: {
        ...(existingProfile ?? {
          enabled: true,
          api: defaultProviderApi(provider),
          displayName: provider,
          requiresAuth: true,
          models: [],
          modelEfforts: [],
          apiKey: "",
          apiKeyRaw: "",
          baseUrl: "",
          customModels: [],
          customModelDefinitions: [],
        }),
        enabled: true,
        models: [model],
      },
    },
  };
}

// Throws when the runtime was started without a watchlist file path, which
// makes any TOML mutation impossible.
export function requireConfigPath(runtime: AppRuntime): string {
  if (!runtime.config.sourcePath) throw new Error("watchlist config path is not available");
  return runtime.config.sourcePath;
}

// Reloads the TOML config into the runtime and returns the new serialized state.
export async function reloadAndState(runtime: AppRuntime, watchlistPath: string): Promise<Record<string, unknown>> {
  await runtime.reloadConfig(await loadConfig(watchlistPath));
  return runtime.state();
}

// Applies a partial provider profile update, handling model toggle, effort
// overrides, custom model add/remove, and automatic active-provider promotion.
export function mergeProviderProfile(config: AgentConfig, provider: string, body: Record<string, unknown>): AgentConfig {
  provider = normalizeProvider(provider);
  const current = config.providerProfiles[provider] ?? {
    enabled: false,
    api: defaultProviderApi(provider),
    displayName: provider,
    requiresAuth: true,
    models: [],
    modelEfforts: [],
    apiKey: "",
    apiKeyRaw: "",
    baseUrl: "",
    customModels: [],
    customModelDefinitions: [],
  };
  let models = [...current.models];
  if (Array.isArray(body.models)) models = body.models.map(String).filter(Boolean);
  if (typeof body.toggleModel === "string" && body.toggleModel.trim()) {
    const slug = body.toggleModel.trim();
    models = models.includes(slug) ? models.filter((item) => item !== slug) : [...models, slug];
  }
  const effortUpdate = body.modelEffort && typeof body.modelEffort === "object" && !Array.isArray(body.modelEffort)
    ? body.modelEffort as Record<string, unknown>
    : null;
  let modelEfforts = [...current.modelEfforts];
  if (effortUpdate && typeof effortUpdate.model === "string" && typeof effortUpdate.effort === "string") {
    modelEfforts = modelEfforts.filter(([model]) => model !== effortUpdate.model);
    modelEfforts.push([effortUpdate.model, effortUpdate.effort]);
  }
  let customModels = [...(current.customModels ?? [])];
  let customModelDefinitions = [...current.customModelDefinitions];
  if (typeof body.addCustomModel === "string" && body.addCustomModel.trim()) {
    const slug = body.addCustomModel.trim();
    if (!customModels.includes(slug)) customModels.push(slug);
  }
  if (typeof body.removeCustomModel === "string" && body.removeCustomModel.trim()) {
    const slug = body.removeCustomModel.trim();
    customModels = customModels.filter((item) => item !== slug);
    customModelDefinitions = customModelDefinitions.filter((item) => item.id !== slug);
    models = models.filter((item) => item !== slug);
    modelEfforts = modelEfforts.filter(([item]) => item !== slug);
  }
  if (Array.isArray(body.customModelDefinitions)) {
    customModelDefinitions = body.customModelDefinitions.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`customModelDefinitions[${index}] must be an object`);
      }
      const item = value as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
      const api = typeof item.api === "string" && item.api.trim() ? item.api.trim() : current.api;
      const contextWindow = Number(item.contextWindow);
      const maxTokens = Number(item.maxTokens);
      const input = Array.isArray(item.input)
        ? item.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
        : [];
      if (!id) throw new Error(`customModelDefinitions[${index}].id is required`);
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        throw new Error(`customModelDefinitions[${index}].contextWindow must be a positive integer`);
      }
      if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
        throw new Error(`customModelDefinitions[${index}].maxTokens must be a positive integer`);
      }
      return {
        id,
        name,
        api,
        reasoning: item.reasoning === true,
        input: input.length > 0 ? input : ["text"],
        contextWindow,
        maxTokens,
      };
    });
  }
  const clearApiKey = body.clearApiKey === true;
  const nextApiKey = clearApiKey
    ? ""
    : typeof body.apiKey === "string" && body.apiKey
      ? body.apiKey
      : current.apiKey;
  const nextApiKeyRaw = clearApiKey
    ? ""
    : typeof body.apiKey === "string" && body.apiKey
      ? body.apiKey
      : current.apiKeyRaw;
  const nextProfile: ProviderProfile = {
    ...current,
    enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
    models,
    modelEfforts,
    apiKey: nextApiKey,
    apiKeyRaw: nextApiKeyRaw,
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() : current.baseUrl,
    api: typeof body.api === "string" && body.api.trim() ? body.api.trim() : current.api,
    displayName: typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim()
      : current.displayName,
    requiresAuth: typeof body.requiresAuth === "boolean" ? body.requiresAuth : current.requiresAuth,
    customModels,
    customModelDefinitions,
  };
  const providerProfiles = { ...config.providerProfiles, [provider]: nextProfile };
  const firstEnabled = Object.entries(providerProfiles).find(([, profile]) => profile.enabled && profile.models.length > 0);
  const activeProvider = firstEnabled?.[0] ?? config.provider;
  const activeProfile = providerProfiles[activeProvider] ?? nextProfile;
  return {
    ...config,
    provider: activeProvider,
    apiMode: apiModeForProvider(activeProvider, activeProfile.api),
    model: activeProfile.models[0] ?? config.model,
    reasoningEffort: activeProfile.modelEfforts.find(([model]) => model === activeProfile.models[0])?.[1] ?? config.reasoningEffort,
    providerProfiles,
  };
}

// Applies a partial news config update, enforcing minimum values on numeric fields.
export function mergeNewsConfig(config: NewsConfig, body: Record<string, unknown>): NewsConfig {
  return {
    ...config,
    enabled: typeof body.enabled === "boolean" ? body.enabled : config.enabled,
    pollIntervalSeconds: minNumberField(body.pollIntervalSeconds, config.pollIntervalSeconds, 5),
    maxIntervalSeconds: minNumberField(body.maxIntervalSeconds, config.maxIntervalSeconds, 30),
    reutersUrl: typeof body.reutersUrl === "string" && body.reutersUrl.trim() ? body.reutersUrl.trim() : config.reutersUrl,
    requestTimeoutSeconds: minNumberField(body.requestTimeoutSeconds, config.requestTimeoutSeconds, 0.1),
    retentionDays: minNumberField(body.retentionDays, config.retentionDays, 1),
    recentLimit: minNumberField(body.recentLimit, config.recentLimit, 1),
  };
}

// Applies a partial memory config update, enforcing minimum values on numeric fields.
export function mergeMemoryConfig(config: MemoryConfig, body: Record<string, unknown>): MemoryConfig {
  return {
    ...config,
    enabled: typeof body.enabled === "boolean" ? body.enabled : config.enabled,
    useMemories: typeof body.useMemories === "boolean" ? body.useMemories : config.useMemories,
    generateMemories: typeof body.generateMemories === "boolean" ? body.generateMemories : config.generateMemories,
    disableOnExternalContext: typeof body.disableOnExternalContext === "boolean" ? body.disableOnExternalContext : config.disableOnExternalContext,
    storagePath: typeof body.storagePath === "string" ? body.storagePath || null : config.storagePath,
    extractModel: typeof body.extractModel === "string" ? body.extractModel || null : config.extractModel,
    consolidationModel: typeof body.consolidationModel === "string" ? body.consolidationModel || null : config.consolidationModel,
    maxRawMemoriesForConsolidation: minNumberField(body.maxRawMemories, config.maxRawMemoriesForConsolidation, 1),
    maxUnusedDays: minNumberField(body.maxUnusedDays, config.maxUnusedDays, 1),
    maxSourceAgeDays: minNumberField(body.maxSourceAgeDays, config.maxSourceAgeDays, 1),
    maxRolloutsPerStartup: minNumberField(body.maxRolloutsPerStartup, config.maxRolloutsPerStartup, 1),
    minSessionIdleHours: minNumberField(body.minSessionIdleHours, config.minSessionIdleHours, 0),
    extensionRetentionDays: minNumberField(body.extensionRetentionDays, config.extensionRetentionDays, 1),
  };
}

// Applies a partial proxy config update. Host/credentials are taken verbatim;
// type is validated against the supported set; port is range-checked.
export function mergeProxyConfig(config: ProxyConfig, body: Record<string, unknown>): ProxyConfig {
  let type: ProxyType = config.type;
  if (typeof body.type === "string") {
    const value = body.type.trim().toLowerCase();
    if (value === "http" || value === "https" || value === "socks5") type = value;
    else if (value === "socks" || value === "socks5h") type = "socks5";
    else throw new Error("proxy type must be one of: http, https, socks5");
  }
  let port = config.port;
  if (body.port !== undefined && body.port !== null && body.port !== "") {
    const parsed = Number(body.port);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error("proxy port must be an integer between 1 and 65535");
    }
    port = parsed;
  }
  return {
    ...config,
    enabled: typeof body.enabled === "boolean" ? body.enabled : config.enabled,
    type,
    host: typeof body.host === "string" ? body.host.trim() : config.host,
    port,
    username: typeof body.username === "string" ? body.username : config.username,
    password: body.clearPassword === true ? "" : typeof body.password === "string" && body.password ? body.password : config.password,
  };
}

// Parses a numeric field from an unknown value, falling back to `fallback`
// when the value is absent and throwing when it is below `minimum`.
export function minNumberField(value: unknown, fallback: number, minimum: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`value must be at least ${minimum}`);
  }
  return parsed;
}

// Maps a provider name to the API shape it speaks (Anthropic Messages vs Codex Responses).
export function apiModeForProvider(provider: string, dynamicApi?: string): string {
  if (provider === "anthropic") return "anthropic_messages";
  if (provider === "openai") return "openai_completions";
  if (provider === "codex") return "codex_responses";
  return dynamicApi || "openai-completions";
}

// Normalizes a raw model descriptor from any provider catalog into a
// consistent shape the frontend can render without special-casing providers.
export function normalizeModelOption(raw: Record<string, unknown>): Record<string, unknown> {
  const slug = String(raw.slug || raw.id || raw.name || raw.model || "");
  return {
    slug,
    displayName: String(raw.displayName || raw.label || raw.name || slug),
    description: String(raw.description || ""),
    visibility: String(raw.visibility || "public"),
    supportedInApi: raw.supportedInApi !== false,
    defaultReasoningEffort: String(raw.defaultReasoningEffort || "medium"),
    supportedReasoningEfforts: Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
      : ["low", "medium", "high", "xhigh"],
    contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : null,
    preferWebsockets: Boolean(raw.preferWebsockets),
  };
}
