/**
 * Pipeline API routes.
 */

import { Hono } from "hono";

interface PipelineRuntimeLike {
  pipelineOrchestrator?: { currentRegime: unknown; isRunning: boolean } | null;
  pipelineStore?: {
    listRuns(opts: { instrumentKey?: string; limit?: number; offset?: number }): unknown[];
    getRun(id: string): unknown | null;
  };
  runPipeline(instrumentKey: string, trigger: "manual"): Promise<unknown>;
}

function boundedInt(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined || raw === null ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function pipelineRoutes(runtime: PipelineRuntimeLike): Hono {
  const app = new Hono();

  // GET /api/pipeline/regime — current regime
  app.get("/api/pipeline/regime", (c) => {
    const regime = runtime.pipelineOrchestrator?.currentRegime ?? null;
    return c.json({ regime });
  });

  // GET /api/pipeline/runs — list recent runs
  app.get("/api/pipeline/runs", (c) => {
    const instrumentKey = c.req.query("instrument") ?? undefined;
    const limit = boundedInt(c.req.query("limit"), 50, 1, 100);
    const offset = boundedInt(c.req.query("offset"), 0, 0, 10_000);
    const runs = runtime.pipelineStore?.listRuns({ instrumentKey, limit, offset }) ?? [];
    return c.json({ runs });
  });

  // GET /api/pipeline/runs/:id — single run detail
  app.get("/api/pipeline/runs/:id", (c) => {
    const id = c.req.param("id");
    const run = runtime.pipelineStore?.getRun(id) ?? null;
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ run });
  });

  // POST /api/pipeline/trigger — manually trigger a pipeline run
  app.post("/api/pipeline/trigger", async (c) => {
    const body = await c.req.json<{ instrumentKey?: string }>().catch(() => ({ instrumentKey: undefined }));
    const instrumentKey = body.instrumentKey;
    if (!instrumentKey) {
      return c.json({ error: "instrumentKey required" }, 400);
    }
    if (!runtime.pipelineOrchestrator) {
      return c.json({ error: "pipeline not configured" }, 503);
    }
    if (runtime.pipelineOrchestrator.isRunning) {
      return c.json({ error: "pipeline already running" }, 409);
    }
    try {
      const run = await runtime.runPipeline(instrumentKey, "manual");
      return c.json({ run });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("cooldown")) return c.json({ error: message }, 429);
      if (message.includes("budget exceeded")) return c.json({ error: message }, 429);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
