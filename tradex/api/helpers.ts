import { loadConfig, type AgentConfig, type MemoryConfig, type NewsConfig, type ProviderProfile, type SocialFeedConfig } from "../config/index.js";
import { normalizeApiMode } from "../config/agent_models.js";
import { SessionManager } from "../agent/session_manager.js";
import type { AppRuntime } from "./runtime.js";

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
export function openSessionManager(sessionId: string, runtime?: AppRuntime): SessionManager | null {
  const pending = runtime?.pendingSessionManagers.get(sessionId);
  if (pending) return pending;
  const indexed = runtime?.sessionIndex.get(sessionId);
  if (indexed) return SessionManager.open(indexed.filePath, runtime?.sessionIndex);
  const allSessions = SessionManager.listAll();
  const info = allSessions.find((s) => s.id === sessionId);
  if (!info) return null;
  return SessionManager.open(info.path, runtime?.sessionIndex);
}

// Builds the session + messages payload returned by the single-session endpoints.
export function sessionResponse(runtime: AppRuntime, sessionId: string): Record<string, unknown> {
  const mgr = openSessionManager(sessionId, runtime);
  if (!mgr) return { session: null, messages: [], run: idleRun(sessionId) };
  const payload = mgr.sessionPayload();
  return { ...payload, run: idleRun(sessionId) };
}

// Returns the sidebar session list (max 200) with the first 5 sessions
// pre-loaded so the frontend can render them without extra round-trips.
export function sessionHistory(runtime: AppRuntime): Record<string, unknown> {
  const indexed = runtime.sessionIndex.listAllSessions({ limit: 200 }).filter((row) => row.messageCount > 0);
  const summaries = indexed.map((row) => ({
    id: row.id,
    title: row.title || row.firstMessage.slice(0, 60),
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    active: false,
    apiMode: null,
    reasoningEffort: null,
    leafId: null,
    messageCount: row.messageCount,
    preview: row.firstMessage,
    contextUsage: null,
    run: idleRun(row.id),
  }));
  return { sessions: summaries, preloadedSessions: summaries.slice(0, 5).map((item) => sessionResponse(runtime, String(item.id))) };
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
  const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : config.provider;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : config.model;
  return {
    ...config,
    provider,
    apiMode: normalizeApiMode(provider),
    model,
    providerProfiles: {
      ...config.providerProfiles,
      [provider]: {
        ...(config.providerProfiles[provider] ?? {
          enabled: true,
          models: [],
          modelEfforts: [],
          apiKey: "",
          baseUrl: "",
          customModels: [],
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
  const current = config.providerProfiles[provider] ?? {
    enabled: false,
    models: [],
    modelEfforts: [],
    apiKey: "",
    baseUrl: "",
    customModels: [],
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
  if (typeof body.addCustomModel === "string" && body.addCustomModel.trim()) {
    const slug = body.addCustomModel.trim();
    if (!customModels.includes(slug)) customModels.push(slug);
  }
  if (typeof body.removeCustomModel === "string" && body.removeCustomModel.trim()) {
    const slug = body.removeCustomModel.trim();
    customModels = customModels.filter((item) => item !== slug);
    models = models.filter((item) => item !== slug);
    modelEfforts = modelEfforts.filter(([item]) => item !== slug);
  }
  const nextProfile: ProviderProfile = {
    ...current,
    enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
    models,
    modelEfforts,
    apiKey: body.clearApiKey === true ? "" : typeof body.apiKey === "string" && body.apiKey ? body.apiKey : current.apiKey,
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() : current.baseUrl,
    customModels,
  };
  const providerProfiles = { ...config.providerProfiles, [provider]: nextProfile };
  const firstEnabled = Object.entries(providerProfiles).find(([, profile]) => profile.enabled && profile.models.length > 0);
  const activeProvider = firstEnabled?.[0] ?? config.provider;
  const activeProfile = providerProfiles[activeProvider] ?? nextProfile;
  return {
    ...config,
    provider: activeProvider,
    apiMode: apiModeForProvider(activeProvider),
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

// Applies a partial social feed config update, enforcing minimum values on numeric fields.
export function mergeSocialFeedConfig(config: SocialFeedConfig, body: Record<string, unknown>): SocialFeedConfig {
  return {
    ...config,
    enabled: typeof body.enabled === "boolean" ? body.enabled : config.enabled,
    recentLimit: minNumberField(body.recentLimit, config.recentLimit, 1),
    retentionDays: minNumberField(body.retentionDays, config.retentionDays, 1),
    maxItems: minNumberField(body.maxItems, config.maxItems, 100),
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
export function apiModeForProvider(provider: string): string {
  if (provider === "anthropic") return "anthropic_messages";
  return "codex_responses";
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
