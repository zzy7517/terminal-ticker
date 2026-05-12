import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";
import { findRunBySessionId, readSessionEntries } from "../../cron/store.js";

export function cronRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // Lists all configured cron jobs with their current status, next fire time, etc.
  app.get("/api/cron/jobs", (c) => {
    const scheduler = runtime.cronScheduler;
    return c.json({ jobs: scheduler.listJobs() });
  });

  // Returns run history for a specific job.
  app.get("/api/cron/jobs/:name/sessions", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const scheduler = runtime.cronScheduler;
    const runs = scheduler.jobHistory(name);
    return c.json({ jobName: name, runs });
  });

  // Returns the full session entries for a single cron run.
  app.get("/api/cron/sessions/:id", (c) => {
    const sessionId = c.req.param("id");
    const found = findRunBySessionId(sessionId);
    if (!found) return c.json({ detail: "cron session not found" }, 404);
    const entries = readSessionEntries(found.filePath);
    return c.json({ jobName: found.jobName, sessionId, entries });
  });

  // Manually triggers a cron job. Returns the run result.
  app.post("/api/cron/jobs/:name/trigger", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    try {
      const result = await runtime.cronScheduler.triggerJob(name);
      return c.json({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, detail: message }, 400);
    }
  });

  // Enables or disables a cron job at runtime (does not persist to TOML).
  app.patch("/api/cron/jobs/:name", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    if (typeof body.enabled === "boolean") {
      try {
        runtime.cronScheduler.setEnabled(name, body.enabled);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ ok: false, detail: message }, 400);
      }
    }

    return c.json({ ok: true, jobs: runtime.cronScheduler.listJobs() });
  });

  // Lists recent runs across ALL jobs, sorted by most recent first.
  app.get("/api/cron/runs", (c) => {
    const limit = Number(c.req.query("limit")) || 50;
    const runs = runtime.cronScheduler.recentRuns(limit);
    return c.json({ runs });
  });

  return app;
}
