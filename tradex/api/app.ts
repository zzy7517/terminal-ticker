import { Hono } from "hono";
import crypto from "node:crypto";
import { AgentRuntime } from "../agent/runtime.js";
import { DEFAULT_AGENT_MODEL_REGISTRY } from "../agent/model_registry.js";
import { buildMarketTools } from "../agent/tools/market.js";
import { buildMemoryTools } from "../memory/tools.js";
import { buildNewsTools } from "../agent/tools/news.js";
import { buildSocialFeedTools } from "../agent/tools/social.js";
import { buildTradingTools } from "../agent/tools/trading.js";
import { buildWebTools } from "../agent/tools/web.js";
import { mergeRegistries } from "../agent/tools/registry.js";
import { loadConfig, type AgentConfig, type MemoryConfig, type NewsConfig, type ProviderProfile, type SocialFeedConfig } from "../config/index.js";
import { loadInstrumentCatalog as loadBitgetInstrumentCatalog } from "../market_data/bitget.js";
import { loadInstrumentCatalog as loadHyperliquidInstrumentCatalog } from "../market_data/hyperliquid.js";
import {
  appendBitgetSymbolToWatchlist,
  appendHyperliquidSymbolToWatchlist,
  removeSymbolFromWatchlist,
  updateAgentConfigInWatchlist,
  updateMemoryConfigInWatchlist,
  updateNewsConfigInWatchlist,
  updateSocialFeedConfigInWatchlist,
} from "../config/watchlist_store.js";
import { LocalMemoryBackend } from "../memory/backend.js";
import { newsItemToPayload } from "../news/types.js";
import { socialItemToPayload } from "../social_feed/types.js";
import { MarketRuntime } from "./runtime.js";

export interface CreateAppOptions {
  runtime: MarketRuntime;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const runtime = options.runtime;

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      backend: "typescript",
      symbols: runtime.instruments.length,
    }),
  );

  app.get("/api/state", async (c) => c.json(await runtime.state()));

  app.get("/api/instruments/catalog", async (c) => {
    const activeKeys = new Set(runtime.instruments.map((instrument) => instrument.key));
    const errors: Record<string, string> = {};
    const items: Array<Record<string, unknown>> = [];
    try {
      for (const instrument of (await loadBitgetInstrumentCatalog()).values()) {
        items.push(catalogItem(instrument, activeKeys));
      }
    } catch (error) {
      errors.bitget = error instanceof Error ? error.message : String(error);
      for (const instrument of runtime.instruments.filter((instrument) => instrument.source === "bitget")) {
        items.push(catalogItem(instrument, activeKeys));
      }
    }
    try {
      for (const instrument of (await loadHyperliquidInstrumentCatalog()).values()) {
        items.push(catalogItem(instrument, activeKeys));
      }
    } catch (error) {
      errors.hyperliquid = error instanceof Error ? error.message : String(error);
      for (const instrument of runtime.instruments.filter((instrument) => instrument.source === "hyperliquid")) {
        items.push(catalogItem(instrument, activeKeys));
      }
    }
    return c.json({
      loadedAt: new Date().toISOString(),
      errors,
      items,
    });
  });

  app.post("/api/watchlist/bitget", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const watchlistPath = requireConfigPath(runtime);
    await appendBitgetSymbolToWatchlist(watchlistPath, {
      symbol: String(body.symbol || ""),
      instType: String(body.instType || body.inst_type || ""),
      label: typeof body.label === "string" ? body.label : null,
      group: typeof body.group === "string" ? body.group : "crypto",
      showCollapsed: typeof body.showCollapsed === "boolean" ? body.showCollapsed : true,
    });
    return c.json({ state: await reloadAndState(runtime, watchlistPath) });
  });
  app.post("/api/watchlist/hyperliquid", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const watchlistPath = requireConfigPath(runtime);
    await appendHyperliquidSymbolToWatchlist(watchlistPath, {
      symbol: String(body.symbol || ""),
      label: typeof body.label === "string" ? body.label : null,
      group: typeof body.group === "string" ? body.group : "crypto",
      showCollapsed: typeof body.showCollapsed === "boolean" ? body.showCollapsed : true,
    });
    return c.json({ state: await reloadAndState(runtime, watchlistPath) });
  });
  app.delete("/api/watchlist/instruments/:key", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const instrument = runtime.instruments.find((item) => item.key === key);
    if (!instrument) return c.json({ detail: `instrument not found: ${key}` }, 404);
    const watchlistPath = requireConfigPath(runtime);
    await removeSymbolFromWatchlist(watchlistPath, {
      source: instrument.source,
      symbol: instrument.symbol,
      instType: "instType" in instrument ? instrument.instType : null,
    });
    return c.json({ state: await reloadAndState(runtime, watchlistPath) });
  });

  app.get("/api/agent/sessions", (c) => c.json(sessionHistory(runtime)));
  app.post("/api/agent/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = runtime.agentSessionStore.createGlobalSession({
      title: String(body.title || "New Agent Session"),
      provider: String(body.provider || runtime.config.agent.provider),
      model: String(body.model || runtime.config.agent.model),
      apiMode: runtime.config.agent.apiMode,
      reasoningEffort: runtime.config.agent.reasoningEffort,
    });
    const sessionResponse = { session, messages: [], run: idleRun(session.id) };
    return c.json({
      ...sessionResponse,
      history: {
        sessions: runtime.agentSessionStore.listAllSessions().map((item) => ({ ...item, run: idleRun(item.id) })),
        preloadedSessions: [sessionResponse],
      },
    });
  });
  app.get("/api/agent/sessions/:id", (c) => {
    return c.json(sessionResponse(runtime, c.req.param("id")));
  });
  app.delete("/api/agent/sessions/:id", async (c) => {
    runtime.agentSessionStore.deleteSessionById(c.req.param("id"));
    return c.json({ session: { session: null, messages: [] }, history: { sessions: runtime.agentSessionStore.listAllSessions().map((item) => ({ ...item, run: idleRun(item.id) })) }, state: await runtime.state() });
  });
  app.post("/api/agent/sessions/:id/messages/stream", async (c) => {
    const sessionId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const message = String(body.message || "").trim();
    const session = runtime.agentSessionStore.getSession(sessionId);
    if (!session) {
      return c.json({ detail: "agent session not found" }, 404);
    }
    if (!message) {
      return c.json({ detail: "message is required" }, 400);
    }
    const encoder = new TextEncoder();
    const runId = crypto.randomUUID();
    const assistantClientId = `assistant:${crypto.randomUUID()}`;
    const toolCallsById = new Map<string, Record<string, unknown>>();
    let seq = 0;
    const sendFrame = (controller: ReadableStreamDefaultController<Uint8Array>, event: Record<string, unknown>) => {
      seq += 1;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sessionId, runId, seq, event })}\n\n`));
    };
    const stream = new ReadableStream({
      async start(controller) {
        sendFrame(controller, { type: "agent_start" });
        try {
          runtime.agentSessionStore.appendMessage({
            sessionId,
            role: "user",
            content: message,
          });
          sendFrame(controller, {
            type: "message_start",
            message: {
              clientId: assistantClientId,
              role: "assistant",
              content: "",
              metadata: null,
              error: null,
            },
          });
          const agentRuntime = new AgentRuntime({
            config: agentConfigForRequest(runtime.config.agent, body),
          });
          const tools = mergeRegistries(
            buildMarketTools({ quotes: runtime.controller.quotes }),
            buildNewsTools({
              recent: (limit, sinceMinutes) => runtime.newsService.recent(limit ?? undefined).filter((item) => {
                if (sinceMinutes == null) return true;
                return item.publishedAtMs >= Date.now() - sinceMinutes * 60_000;
              }),
              refresh: () => runtime.newsService.refreshNow(),
            }),
            buildSocialFeedTools({
              refreshFollowing: (count) => runtime.socialFeedService.refreshXFollowing({ count }),
              recent: async (args) => runtime.socialFeedService.recentItems({
                limit: Number(args.limit) || runtime.config.socialFeed.recentLimit,
              }),
              search: async (args) => (await runtime.socialFeedService.searchXTweets({
                query: String(args.query || ""),
                count: Number(args.count) || 20,
                product: typeof args.product === "string" ? args.product : undefined,
              })).items,
            }),
            buildMemoryTools(runtime.config.memory.storagePath),
            buildTradingTools({
              tradeStore: runtime.tradeStore,
              exchangeRouter: runtime.exchangeRouter,
              resolveSessionId: () => sessionId,
            }),
            buildWebTools(),
          );
          const result = await agentRuntime.run({
            message,
            tools,
            history: runtime.agentSessionStore.historyForContext(sessionId, { limit: 12 }),
            eventHandler: async (event) => {
              const type = String(event.type || "");
              if (type === "message_update") {
                const delta = String(event.delta || "");
                if (!delta) return;
                sendFrame(controller, {
                  type: "message_update",
                  message: {
                    clientId: assistantClientId,
                    role: "assistant",
                    content: "",
                    metadata: null,
                    error: null,
                  },
                  delta,
                });
              } else if (type === "tool_call") {
                const toolCall = event.toolCall && typeof event.toolCall === "object" && !Array.isArray(event.toolCall)
                  ? event.toolCall as Record<string, unknown>
                  : {};
                if (typeof toolCall.id === "string") toolCallsById.set(toolCall.id, toolCall);
                sendFrame(controller, {
                  type: "tool_execution_start",
                  toolCall,
                });
              } else if (type === "tool_result") {
                const toolResult = event.toolResult && typeof event.toolResult === "object" && !Array.isArray(event.toolResult)
                  ? event.toolResult as Record<string, unknown>
                  : {};
                const callId = String(toolResult.callId || "");
                sendFrame(controller, {
                  type: "tool_execution_end",
                  toolCall: toolCallsById.get(callId) ?? { id: callId, name: toolResult.name, arguments: {} },
                  toolResult,
                });
              }
            },
          });
          const metadata = {
            totalTokens: result.totalTokens,
            promptTokens: result.promptTokens,
            toolCalls: result.steps
              .filter((step) => step.stepType === "tool_call" && step.toolCall)
              .map((step) => step.toolCall),
            steps: result.steps.map((step) => ({
              stepType: step.stepType,
              toolCall: step.toolCall ?? null,
              toolResult: step.toolResult ?? null,
              timestamp: step.timestamp,
            })),
          };
          const toolResultMessages = result.steps
            .filter((step) => step.stepType === "tool_result" && step.toolResult)
            .map((step) => step.toolResult!);
          for (const toolResult of toolResultMessages) {
            const toolMessage = runtime.agentSessionStore.appendMessage({
              sessionId,
              role: "toolResult",
              content: toolResult.output,
              metadata: {
                toolCallId: toolResult.callId,
                toolName: toolResult.name,
                error: toolResult.error,
              },
              error: toolResult.error ? toolResult.output : null,
            });
            sendFrame(controller, {
              type: "message_end",
              message: {
                id: toolMessage.id,
                sessionId,
                role: "toolResult",
                content: toolResult.output,
                createdAt: toolMessage.createdAt,
                metadata: toolMessage.metadata,
                error: toolMessage.error,
                entryId: toolMessage.entryId,
                parentId: toolMessage.parentId,
                entryType: toolMessage.entryType,
              },
            });
          }
          const assistantMessage = runtime.agentSessionStore.appendMessage({
            sessionId,
            role: "assistant",
            content: result.content,
            metadata,
            error: result.error,
          });
          sendFrame(controller, {
            type: "message_end",
            message: {
              id: assistantMessage.id,
              clientId: assistantClientId,
              sessionId,
              role: "assistant",
              content: result.content,
              createdAt: assistantMessage.createdAt,
              metadata,
              error: result.error,
              entryId: assistantMessage.entryId,
              parentId: assistantMessage.parentId,
              entryType: assistantMessage.entryType,
            },
          });
          sendFrame(controller, {
            type: "agent_end",
            error: result.error,
            totalTokens: result.totalTokens,
            promptTokens: result.promptTokens,
          });
          sendFrame(controller, {
            type: "session_update",
            session: sessionResponse(runtime, sessionId),
            history: sessionHistory(runtime),
            state: await runtime.state(),
          });
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          sendFrame(controller, { type: "error", error: errorText });
          sendFrame(controller, {
            type: "agent_end",
            error: errorText,
            totalTokens: 0,
            promptTokens: 0,
          });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  });

  app.get("/api/agent/providers/:provider/models", async (c) => {
    const provider = c.req.param("provider");
    const profile = runtime.config.agent.providerProfiles[provider];
    try {
      const models = await DEFAULT_AGENT_MODEL_REGISTRY.listAvailableModels(runtime.config.agent, provider);
      return c.json({
        provider,
        apiMode: apiModeForProvider(provider),
        activeModel: profile?.models[0] ?? runtime.config.agent.model,
        models: models.map(normalizeModelOption),
      });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.post("/api/agent/providers/:provider", async (c) => {
    const provider = c.req.param("provider");
    const body = (await c.req.json()) as Record<string, unknown>;
    const watchlistPath = requireConfigPath(runtime);
    await updateAgentConfigInWatchlist(watchlistPath, mergeProviderProfile(runtime.config.agent, provider, body));
    return c.json({ state: await reloadAndState(runtime, watchlistPath) });
  });
  app.post("/api/agent/config", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const watchlistPath = requireConfigPath(runtime);
    await updateAgentConfigInWatchlist(watchlistPath, {
      ...runtime.config.agent,
      enabled: typeof body.enabled === "boolean" ? body.enabled : runtime.config.agent.enabled,
      maxCandles: Number.isFinite(Number(body.maxCandles)) ? Number(body.maxCandles) : runtime.config.agent.maxCandles,
    });
    return c.json({ state: await reloadAndState(runtime, watchlistPath) });
  });
  app.post("/api/news/config", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const watchlistPath = requireConfigPath(runtime);
      await updateNewsConfigInWatchlist(watchlistPath, mergeNewsConfig(runtime.config.news, body));
      return c.json({ state: await reloadAndState(runtime, watchlistPath) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post("/api/social/config", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const watchlistPath = requireConfigPath(runtime);
      await updateSocialFeedConfigInWatchlist(watchlistPath, mergeSocialFeedConfig(runtime.config.socialFeed, body));
      return c.json({ state: await reloadAndState(runtime, watchlistPath) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post("/api/memory/config", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const watchlistPath = requireConfigPath(runtime);
      await updateMemoryConfigInWatchlist(watchlistPath, mergeMemoryConfig(runtime.config.memory, body));
      return c.json({ state: await reloadAndState(runtime, watchlistPath) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/news/refresh", async (c) => {
    const outcome = await runtime.newsService.refreshNow();
    const news = runtime.newsService.recent();
    return c.json({ ...outcome, totalRecent: news.length, stale: outcome.status !== "ok", news: news.map(newsItemToPayload) });
  });

  app.get("/api/social/auth", (c) => c.json(runtime.xAuthStore.status()));
  app.post("/api/social/auth", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    return c.json(runtime.xAuthStore.save({ authToken: String(body.authToken || ""), ct0: String(body.ct0 || "") }));
  });
  app.delete("/api/social/auth", (c) => c.json(runtime.xAuthStore.clear()));
  app.post("/api/social/x/refresh", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const outcome = await runtime.socialFeedService.refreshXFollowing({ count: Number(body.count) || 3 });
    return c.json({ ...outcome, totalRecent: runtime.socialFeedService.recentItems().length });
  });
  app.get("/api/social/feed", (c) => {
    const limit = Number(c.req.query("limit") || 3);
    return c.json({ items: runtime.socialFeedService.recentItems({ limit }).map((item) => socialItemToPayload(item)) });
  });

  app.get("/api/memory/status", (c) =>
    c.json({
      enabled: runtime.config.memory.enabled,
      pipelineAvailable: true,
      pipelineRunning: false,
      sourceCount: 0,
      outputCount: 0,
      phase2Status: "idle",
      config: {
        enabled: runtime.config.memory.enabled,
        useMemories: runtime.config.memory.useMemories,
        generateMemories: runtime.config.memory.generateMemories,
        storagePath: runtime.config.memory.storagePath,
        extractModel: runtime.config.memory.extractModel,
        consolidationModel: runtime.config.memory.consolidationModel,
        maxRawMemories: runtime.config.memory.maxRawMemoriesForConsolidation,
        maxUnusedDays: runtime.config.memory.maxUnusedDays,
        maxSourceAgeDays: runtime.config.memory.maxSourceAgeDays,
        maxRolloutsPerStartup: runtime.config.memory.maxRolloutsPerStartup,
        minSessionIdleHours: runtime.config.memory.minSessionIdleHours,
        extensionRetentionDays: runtime.config.memory.extensionRetentionDays,
      },
    }),
  );
  app.post("/api/memory/browse", async (c) => {
    const body = (await c.req.json()) as { action?: string; params?: Record<string, unknown> };
    const backend = new LocalMemoryBackend(runtime.config.memory.storagePath);
    if (body.action === "read") {
      const result = backend.read({ path: String(body.params?.path || "") });
      return c.json({ startLineNumber: 1, ...result });
    }
    if (body.action === "search") {
      const queries = Array.isArray(body.params?.queries) ? body.params.queries.map(String) : [];
      const matches = backend.search({ query: queries.join(" "), path: body.params?.path ? String(body.params.path) : null }).map((item) => ({
        path: item.path,
        matchLineNumber: 1,
        contentStartLineNumber: 1,
        content: item.preview,
        matchedQueries: queries,
      }));
      return c.json({ queries, matches, nextCursor: null, truncated: false });
    }
    return c.json({
      path: body.params?.path ?? null,
      entries: backend.list({ path: body.params?.path ? String(body.params.path) : null }).map((item) => ({
        path: item.path,
        entryType: item.type,
      })),
      nextCursor: null,
      truncated: false,
    });
  });

  app.get("/api/lessons", (c) => c.json({ lessons: runtime.tradeStore.listLessons({ instrumentKey: c.req.query("instrument_key") || null, limit: Number(c.req.query("limit") || 50) }) }));
  app.delete("/api/exchange/orders/:exchange/:orderId", async (c) => c.json({ ok: await runtime.exchangeRouter.cancelOrder({ exchange: c.req.param("exchange"), orderId: c.req.param("orderId"), symbol: c.req.query("symbol") || "" }) }));

  return app;
}

function idleRun(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    runId: null,
    status: "idle",
    activeFlags: [],
    lastSeq: 0,
    error: null,
  };
}

function sessionResponse(runtime: MarketRuntime, sessionId: string): Record<string, unknown> {
  const payload = runtime.agentSessionStore.sessionPayload(sessionId) ?? { session: null, messages: [] };
  return { ...payload, run: idleRun(sessionId) };
}

function sessionHistory(runtime: MarketRuntime): Record<string, unknown> {
  const sessions = runtime.agentSessionStore.listAllSessions().map((item) => ({ ...item, run: idleRun(item.id) }));
  return { sessions, preloadedSessions: sessions.slice(0, 5).map((item) => sessionResponse(runtime, String(item.id))) };
}

function catalogItem(instrument: { key: string; source: string; symbol: string; label: string; group: string; analysisInterval?: string | null }, activeKeys: Set<string>): Record<string, unknown> {
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

function agentConfigForRequest(config: AgentConfig, body: Record<string, unknown>): AgentConfig {
  const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : config.provider;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : config.model;
  return {
    ...config,
    provider,
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

function requireConfigPath(runtime: MarketRuntime): string {
  if (!runtime.config.sourcePath) throw new Error("watchlist config path is not available");
  return runtime.config.sourcePath;
}

async function reloadAndState(runtime: MarketRuntime, watchlistPath: string): Promise<Record<string, unknown>> {
  await runtime.reloadConfig(await loadConfig(watchlistPath));
  return runtime.state();
}

function mergeProviderProfile(config: AgentConfig, provider: string, body: Record<string, unknown>): AgentConfig {
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

function mergeNewsConfig(config: NewsConfig, body: Record<string, unknown>): NewsConfig {
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

function mergeSocialFeedConfig(config: SocialFeedConfig, body: Record<string, unknown>): SocialFeedConfig {
  return {
    ...config,
    enabled: typeof body.enabled === "boolean" ? body.enabled : config.enabled,
    recentLimit: minNumberField(body.recentLimit, config.recentLimit, 1),
    retentionDays: minNumberField(body.retentionDays, config.retentionDays, 1),
    maxItems: minNumberField(body.maxItems, config.maxItems, 100),
  };
}

function mergeMemoryConfig(config: MemoryConfig, body: Record<string, unknown>): MemoryConfig {
  return {
    ...config,
    enabled: typeof body.enabled === "boolean" ? body.enabled : config.enabled,
    useMemories: typeof body.useMemories === "boolean" ? body.useMemories : config.useMemories,
    generateMemories: typeof body.generateMemories === "boolean" ? body.generateMemories : config.generateMemories,
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

function minNumberField(value: unknown, fallback: number, minimum: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`value must be at least ${minimum}`);
  }
  return parsed;
}

function apiModeForProvider(provider: string): string {
  if (provider === "anthropic") return "anthropic_messages";
  return "codex_responses";
}

function normalizeModelOption(raw: Record<string, unknown>): Record<string, unknown> {
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
