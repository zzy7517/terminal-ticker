/**
 * Cron job scheduler.
 *
 * Uses `croner` to manage per-job timers. Each CronJobConfig from watchlist.toml
 * maps to one Cron instance. The scheduler owns the lifecycle: start/stop/reload.
 *
 * Concurrency: a running job is tracked in `runningJobs`. If a job's cron fires
 * while a previous run is still in progress, the new fire is skipped with a warning.
 *
 * At-most-once: croner advances the next fire internally before invoking the
 * callback, so a crash mid-execution will not re-fire on restart.
 */

import { Cron } from "croner";
import type { CronJobConfig } from "../config/index.js";
import { executeCronJob, type CronRunResult } from "./runner.js";
import { listJobRuns, listAllRuns, type CronRunRecord } from "./store.js";
import type { AppRuntime } from "../api/runtime.js";

export interface CronJobStatus {
  name: string;
  cron: string;
  enabled: boolean;
  running: boolean;
  nextRun: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  systemPrompt: string;
  model: string | null;
  userMessage: string;
}

export class CronScheduler {
  private runtime: AppRuntime;
  private jobs: Map<string, Cron> = new Map();
  private configs: Map<string, CronJobConfig> = new Map();
  private runningJobs: Set<string> = new Set();
  private lastRunAt: Map<string, string> = new Map();
  private lastStatus: Map<string, "ok" | "error"> = new Map();
  private lastError: Map<string, string | null> = new Map();
  private started = false;

  constructor(runtime: AppRuntime) {
    this.runtime = runtime;
  }

  /** Starts all enabled cron jobs from the current config. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleAll(this.runtime.config.cronJobs);
  }

  /** Stops all running cron timers. Does NOT abort in-flight job executions. */
  async stop(): Promise<void> {
    this.started = false;
    for (const [, cron] of this.jobs) {
      cron.stop();
    }
    this.jobs.clear();
    this.configs.clear();
  }

  /** Tears down and recreates all cron timers. Called on config hot-reload. */
  reload(cronJobs: CronJobConfig[]): void {
    // Stop existing timers
    for (const [, cron] of this.jobs) {
      cron.stop();
    }
    this.jobs.clear();
    this.configs.clear();

    if (this.started) {
      this.scheduleAll(cronJobs);
    }
  }

  /** Returns the status of all configured jobs. */
  listJobs(): CronJobStatus[] {
    const statuses: CronJobStatus[] = [];
    for (const [name, config] of this.configs) {
      const cron = this.jobs.get(name);
      const nextDate = cron?.nextRun() ?? null;
      statuses.push({
        name: config.name,
        cron: config.cron,
        enabled: config.enabled,
        running: this.runningJobs.has(name),
        nextRun: nextDate ? nextDate.toISOString() : null,
        lastRunAt: this.lastRunAt.get(name) ?? null,
        lastStatus: this.lastStatus.get(name) ?? null,
        lastError: this.lastError.get(name) ?? null,
        systemPrompt: config.systemPrompt,
        model: config.model,
        userMessage: config.userMessage,
      });
    }
    return statuses;
  }

  /** Returns run history for a specific job. */
  jobHistory(jobName: string): CronRunRecord[] {
    return listJobRuns(jobName);
  }

  /** Returns recent runs across all jobs. */
  recentRuns(limit = 50): CronRunRecord[] {
    return listAllRuns(limit);
  }

  /** Manually triggers a job by name. Returns the run result. */
  async triggerJob(jobName: string): Promise<CronRunResult> {
    const config = this.configs.get(jobName);
    if (!config) throw new Error(`Cron job not found: ${jobName}`);
    return this.executeJob(config);
  }

  /** Enables or disables a job at runtime (does not persist to TOML). */
  setEnabled(jobName: string, enabled: boolean): void {
    const config = this.configs.get(jobName);
    if (!config) throw new Error(`Cron job not found: ${jobName}`);

    config.enabled = enabled;
    const existing = this.jobs.get(jobName);

    if (enabled && !existing) {
      // Schedule the job
      this.scheduleOne(config);
    } else if (!enabled && existing) {
      // Stop the timer
      existing.stop();
      this.jobs.delete(jobName);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private scheduleAll(cronJobs: CronJobConfig[]): void {
    for (const job of cronJobs) {
      this.configs.set(job.name, job);
      if (job.enabled) {
        this.scheduleOne(job);
      }
    }
    if (cronJobs.length > 0) {
      console.log(`[cron] Scheduled ${cronJobs.filter((j) => j.enabled).length}/${cronJobs.length} cron jobs`);
    }
  }

  private scheduleOne(job: CronJobConfig): void {
    try {
      const cron = new Cron(job.cron, () => {
        void this.onTick(job);
      });
      this.jobs.set(job.name, cron);
      const next = cron.nextRun();
      console.log(`[cron] "${job.name}" scheduled: ${job.cron} → next: ${next ? next.toISOString() : "none"}`);
    } catch (error) {
      console.error(`[cron] Failed to schedule "${job.name}" with expression "${job.cron}":`, error);
    }
  }

  private async onTick(job: CronJobConfig): Promise<void> {
    if (this.runningJobs.has(job.name)) {
      console.warn(`[cron] Skipping "${job.name}" — previous run still in progress`);
      return;
    }

    console.log(`[cron] Firing "${job.name}" at ${new Date().toISOString()}`);
    try {
      const result = await this.executeJob(job);
      if (result.error) {
        console.error(`[cron] "${job.name}" completed with error: ${result.error}`);
      } else {
        console.log(`[cron] "${job.name}" completed in ${result.durationMs}ms (${result.iterations} iterations, ${result.totalTokens} tokens)`);
      }
    } catch (error) {
      console.error(`[cron] "${job.name}" threw:`, error);
    }
  }

  private async executeJob(job: CronJobConfig): Promise<CronRunResult> {
    this.runningJobs.add(job.name);
    try {
      const result = await executeCronJob({ job, runtime: this.runtime });
      this.lastRunAt.set(job.name, new Date().toISOString());
      this.lastStatus.set(job.name, result.error ? "error" : "ok");
      this.lastError.set(job.name, result.error);
      return result;
    } finally {
      this.runningJobs.delete(job.name);
    }
  }
}
