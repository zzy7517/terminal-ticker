import { Hono } from "hono";
import crypto from "node:crypto";
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

  app.get("/api/instruments/catalog", (c) =>
    c.json({
      loadedAt: new Date().toISOString(),
      errors: {},
      items: runtime.instruments.map((instrument) => ({
        source: instrument.source,
        symbol: instrument.symbol,
        label: instrument.label,
        instType: "instType" in instrument ? instrument.instType : null,
        group: instrument.group,
        category: "category" in instrument ? instrument.category : null,
        dex: "dex" in instrument ? instrument.dex : null,
        key: instrument.key,
        displayText: `${instrument.label} (${instrument.key})`,
        exists: true,
      })),
    }),
  );

  app.post("/api/watchlist/bitget", async (c) => c.json({ state: await runtime.state() }));
  app.post("/api/watchlist/hyperliquid", async (c) => c.json({ state: await runtime.state() }));
  app.delete("/api/watchlist/instruments/:key", async (c) => c.json({ state: await runtime.state() }));

  app.get("/api/agent/sessions", (c) => c.json({ sessions: [], preloadedSessions: [] }));
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
    const payload = runtime.agentSessionStore.sessionPayload(c.req.param("id"));
    return c.json(payload ?? { session: null, messages: [] });
  });
  app.delete("/api/agent/sessions/:id", async (c) => {
    runtime.agentSessionStore.deleteSessionById(c.req.param("id"));
    return c.json({ session: { session: null, messages: [] }, history: { sessions: runtime.agentSessionStore.listAllSessions().map((item) => ({ ...item, run: idleRun(item.id) })) }, state: await runtime.state() });
  });
  app.post("/api/agent/sessions/:id/messages/stream", async (c) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sessionId: c.req.param("id"), runId: crypto.randomUUID(), seq: 1, event: { type: "agent_start" } })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sessionId: c.req.param("id"), runId: "", seq: 2, event: { type: "agent_end", error: "Agent streaming is not configured in this TS runtime yet.", totalTokens: 0, promptTokens: 0 } })}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  });

  app.get("/api/agent/providers/:provider/models", (c) =>
    c.json({
      provider: c.req.param("provider"),
      apiMode: runtime.config.agent.apiMode,
      activeModel: runtime.config.agent.model,
      models: runtime.config.agent.providerProfiles[c.req.param("provider")]?.models.map((model) => ({
        slug: model,
        displayName: model,
        description: "",
        visibility: "configured",
        supportedInApi: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        contextWindow: null,
        preferWebsockets: false,
      })) ?? [],
    }),
  );

  app.post("/api/agent/providers/:provider", async (c) => c.json({ state: await runtime.state() }));
  app.post("/api/agent/config", async (c) => c.json({ state: await runtime.state() }));
  app.post("/api/news/config", async (c) => c.json({ state: await runtime.state() }));
  app.post("/api/social/config", async (c) => c.json({ state: await runtime.state() }));
  app.post("/api/memory/config", async (c) => c.json({ state: await runtime.state() }));

  app.post("/api/news/refresh", async (c) => {
    const outcome = await runtime.newsService.refreshNow();
    const news = runtime.newsService.recent();
    return c.json({ ...outcome, totalRecent: news.length, stale: false, news: news.map(newsItemToPayload) });
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
    if (body.action === "read") return c.json(backend.read({ path: String(body.params?.path || "") }));
    if (body.action === "search") return c.json({ matches: backend.search({ query: String((body.params?.queries as string[] | undefined)?.join(" ") || "") }) });
    return c.json({ path: body.params?.path ?? null, entries: backend.list({ path: body.params?.path ? String(body.params.path) : null }), nextCursor: null, truncated: false });
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
