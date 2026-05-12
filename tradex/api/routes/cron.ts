import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";
import { findRunBySessionId, readSessionEntries } from "../../cron/store.js";
import { loadConfig, type CronJobConfig } from "../../config/index.js";
import { updateCronJobsInWatchlist } from "../../config/watchlist_store.js";
import { requireConfigPath } from "../helpers.js";

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

  // Creates a new cron job. Persists to TOML and reloads the scheduler.
  app.post("/api/cron/jobs", async (c) => {
    const watchlistPath = requireConfigPath(runtime);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const cron = typeof body.cron === "string" ? body.cron.trim() : "";
    if (!name) return c.json({ ok: false, detail: "name is required" }, 400);
    if (!cron) return c.json({ ok: false, detail: "cron expression is required" }, 400);
    const existing = runtime.config.cronJobs;
    if (existing.some((j) => j.name === name)) {
      return c.json({ ok: false, detail: `job "${name}" already exists` }, 409);
    }
    const job: CronJobConfig = {
      name,
      cron,
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : "",
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
    const nextJobs = [...existing, job];
    try {
      await updateCronJobsInWatchlist(watchlistPath, nextJobs);
      await runtime.reloadConfig(await loadConfig(watchlistPath));
      return c.json({ ok: true, jobs: runtime.cronScheduler.listJobs() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, detail: message }, 500);
    }
  });

  // Updates an existing cron job by name. Persists to TOML and reloads.
  app.put("/api/cron/jobs/:name", async (c) => {
    const watchlistPath = requireConfigPath(runtime);
    const jobName = decodeURIComponent(c.req.param("name"));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const existing = runtime.config.cronJobs;
    const index = existing.findIndex((j) => j.name === jobName);
    if (index < 0) return c.json({ ok: false, detail: `job "${jobName}" not found` }, 404);
    const current = existing[index];
    const updated: CronJobConfig = {
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : current.name,
      cron: typeof body.cron === "string" && body.cron.trim() ? body.cron.trim() : current.cron,
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : current.systemPrompt,
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
    if (updated.name !== jobName && existing.some((j) => j.name === updated.name)) {
      return c.json({ ok: false, detail: `job "${updated.name}" already exists` }, 409);
    }
    const nextJobs = [...existing];
    nextJobs[index] = updated;
    try {
      await updateCronJobsInWatchlist(watchlistPath, nextJobs);
      await runtime.reloadConfig(await loadConfig(watchlistPath));
      return c.json({ ok: true, jobs: runtime.cronScheduler.listJobs() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, detail: message }, 500);
    }
  });

  // Deletes a cron job by name. Persists to TOML and reloads.
  app.delete("/api/cron/jobs/:name", async (c) => {
    const watchlistPath = requireConfigPath(runtime);
    const jobName = decodeURIComponent(c.req.param("name"));
    const existing = runtime.config.cronJobs;
    const nextJobs = existing.filter((j) => j.name !== jobName);
    if (nextJobs.length === existing.length) {
      return c.json({ ok: false, detail: `job "${jobName}" not found` }, 404);
    }
    try {
      await updateCronJobsInWatchlist(watchlistPath, nextJobs);
      await runtime.reloadConfig(await loadConfig(watchlistPath));
      return c.json({ ok: true, jobs: runtime.cronScheduler.listJobs() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, detail: message }, 500);
    }
  });

  return app;
}
