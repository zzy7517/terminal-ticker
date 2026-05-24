import { Hono } from "hono";
import { updateMemoryConfigInWatchlist } from "../../config/watchlist_store.js";
import { LocalMemoryBackend } from "../../memory/backend.js";
import type { AppRuntime } from "../runtime.js";
import { requireConfigPath, reloadAndState, mergeMemoryConfig } from "../helpers.js";

export function memoryRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // Persists memory pipeline configuration changes and reloads config.
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

  // Returns memory pipeline status and the full memory config for the settings UI.
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
        disableOnExternalContext: runtime.config.memory.disableOnExternalContext,
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

  // Exposes read / search / list operations on the local memory store for the
  // memory browser UI. Action defaults to list when not specified.
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

  return app;
}
