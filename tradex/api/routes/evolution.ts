/**
 * Evolution API routes.
 */

import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";

function boundedInt(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined || raw === null ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function evolutionRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // GET /api/evolution/scorecard — all module scores + weights
  app.get("/api/evolution/scorecard", (c) => {
    const weights = runtime.evolutionStore?.getDarwinWeights() ?? [];
    return c.json({ modules: weights });
  });

  // GET /api/evolution/weights/history/:moduleId — weight history for charting
  app.get("/api/evolution/weights/history/:moduleId", (c) => {
    const moduleId = c.req.param("moduleId");
    const limit = boundedInt(c.req.query("limit"), 90, 1, 365);
    const history = runtime.evolutionStore?.getWeightHistory(moduleId, limit) ?? [];
    return c.json({ moduleId, history });
  });

  // GET /api/evolution/modifications — prompt modification history
  app.get("/api/evolution/modifications", (c) => {
    const limit = boundedInt(c.req.query("limit"), 50, 1, 100);
    const modifications = runtime.evolutionStore?.listModifications(limit) ?? [];
    return c.json({ modifications });
  });

  // GET /api/evolution/recommendations/:moduleId — recent recommendations
  app.get("/api/evolution/recommendations/:moduleId", (c) => {
    const moduleId = c.req.param("moduleId");
    const days = boundedInt(c.req.query("days"), 30, 1, 365);
    const recs = runtime.evolutionStore?.getModuleRecommendations(moduleId, days) ?? [];
    return c.json({ moduleId, recommendations: recs });
  });

  return app;
}
