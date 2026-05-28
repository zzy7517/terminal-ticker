/**
 * Evolution API routes.
 */

import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";

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
    const limit = Number(c.req.query("limit") ?? 90);
    const history = runtime.evolutionStore?.getWeightHistory(moduleId, limit) ?? [];
    return c.json({ moduleId, history });
  });

  // GET /api/evolution/modifications — prompt modification history
  app.get("/api/evolution/modifications", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const modifications = runtime.evolutionStore?.listModifications(limit) ?? [];
    return c.json({ modifications });
  });

  // GET /api/evolution/recommendations/:moduleId — recent recommendations
  app.get("/api/evolution/recommendations/:moduleId", (c) => {
    const moduleId = c.req.param("moduleId");
    const days = Number(c.req.query("days") ?? 30);
    const recs = runtime.evolutionStore?.getModuleRecommendations(moduleId, days) ?? [];
    return c.json({ moduleId, recommendations: recs });
  });

  return app;
}
