import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";
import type { CronJobConfig } from "../../config/index.js";
import { findRunBySessionId, readSessionEntries, cronSessionsDir } from "../../cron/store.js";

export function cronRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // Lists all configured cron jobs with their current status, next fire time, etc.
  app.get("/api/cron/jobs", (c) => {
    return c.json({
      jobs: runtime.cronScheduler.listJobs(),
      storagePaths: {
        config: runtime.cronJobStore.filePath,
        sessions: cronSessionsDir(),
      },
    });
  });

  // Returns run history for a specific job.
  app.get("/api/cron/jobs/:name/sessions", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const runs = runtime.cronScheduler.jobHistory(name);
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

  // Enables or disables a cron job (persisted to SQLite).
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

  // Creates a new cron job. Persisted to SQLite.
  app.post("/api/cron/jobs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const cron = typeof body.cron === "string" ? body.cron.trim() : "";
    if (!name) return c.json({ ok: false, detail: "name is required" }, 400);
    if (!cron) return c.json({ ok: false, detail: "cron expression is required" }, 400);

    const job: CronJobConfig = {
      name,
      cron,
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : "",
      useMainPrompt: body.useMainPrompt === true,
      enabled: body.enabled !== false,
      symbols: Array.isArray(body.symbols) ? body.symbols.filter((s): s is string => typeof s === "string") : [],
      model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : null,
      userMessage: typeof body.userMessage === "string" ? body.userMessage : "开始定时看盘分析",
      maxIterations: typeof body.maxIterations === "number" && body.maxIterations > 0 ? body.maxIterations : null,
      maxCandles: typeof body.maxCandles === "number" && body.maxCandles > 0 ? body.maxCandles : null,
      tradingEnabled: body.tradingEnabled === true,
      socialEnabled: body.socialEnabled === true,
      timezone: typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : null,
    };

    try {
      runtime.cronScheduler.addJob(job);
      return c.json({ ok: true, jobs: runtime.cronScheduler.listJobs() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("already exists") ? 409 : 500;
      return c.json({ ok: false, detail: message }, status);
    }
  });

  // Updates an existing cron job by name. Persisted to SQLite.
  app.put("/api/cron/jobs/:name", async (c) => {
    const jobName = decodeURIComponent(c.req.param("name"));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const current = runtime.cronJobStore.get(jobName);
    if (!current) return c.json({ ok: false, detail: `job "${jobName}" not found` }, 404);

    const updated: CronJobConfig = {
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : current.name,
      cron: typeof body.cron === "string" && body.cron.trim() ? body.cron.trim() : current.cron,
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : current.systemPrompt,
      useMainPrompt: typeof body.useMainPrompt === "boolean" ? body.useMainPrompt : current.useMainPrompt,
      enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      symbols: Array.isArray(body.symbols) ? body.symbols.filter((s): s is string => typeof s === "string") : current.symbols,
      model: body.model === null ? null : typeof body.model === "string" ? (body.model.trim() || null) : current.model,
      userMessage: typeof body.userMessage === "string" ? body.userMessage : current.userMessage,
      maxIterations: body.maxIterations === null ? null : typeof body.maxIterations === "number" && body.maxIterations > 0 ? body.maxIterations : current.maxIterations,
      maxCandles: body.maxCandles === null ? null : typeof body.maxCandles === "number" && body.maxCandles > 0 ? body.maxCandles : current.maxCandles,
      tradingEnabled: typeof body.tradingEnabled === "boolean" ? body.tradingEnabled : current.tradingEnabled,
      socialEnabled: typeof body.socialEnabled === "boolean" ? body.socialEnabled : current.socialEnabled,
      timezone: body.timezone === null ? null : typeof body.timezone === "string" ? (body.timezone.trim() || null) : current.timezone,
    };

    try {
      runtime.cronScheduler.updateJob(jobName, updated);
      return c.json({ ok: true, jobs: runtime.cronScheduler.listJobs() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("already exists") ? 409 : 500;
      return c.json({ ok: false, detail: message }, status);
    }
  });

  // Deletes a cron job by name. Persisted to SQLite.
  app.delete("/api/cron/jobs/:name", async (c) => {
    const jobName = decodeURIComponent(c.req.param("name"));
    try {
      runtime.cronScheduler.removeJob(jobName);
      return c.json({ ok: true, jobs: runtime.cronScheduler.listJobs() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, detail: message }, 404);
    }
  });

  return app;
}
