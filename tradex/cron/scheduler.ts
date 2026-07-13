/**
 * Cron job scheduler.
 *
 * Uses `croner` to manage per-job timers. Each CronJobConfig from the JSON
 * file store maps to one Cron instance. The scheduler owns the lifecycle: start/stop/reload.
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
import type { CronJobStore } from "./job_store.js";
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
  useMainPrompt: boolean;
  model: string | null;
  userMessage: string;
  maxIterations: number | null;
  maxCandles: number | null;
  tradingEnabled: boolean;
  timezone: string | null;
}

export class CronScheduler {
  private runtime: AppRuntime;
  private store: CronJobStore;
  private jobs: Map<string, Cron> = new Map();
  private configs: Map<string, CronJobConfig> = new Map();
  private runningJobs: Set<string> = new Set();
  private lastRunAt: Map<string, string> = new Map();
  private lastStatus: Map<string, "ok" | "error"> = new Map();
  private lastError: Map<string, string | null> = new Map();
  private started = false;

  constructor(runtime: AppRuntime, store: CronJobStore) {
    this.runtime = runtime;
    this.store = store;
  }

  /** Starts all enabled cron jobs from the SQLite store. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleAll(this.store.listAll());
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

  /** Tears down and recreates all cron timers from the SQLite store. */
  reload(): void {
    for (const [, cron] of this.jobs) {
      cron.stop();
    }
    this.jobs.clear();
    this.configs.clear();

    if (this.started) {
      this.scheduleAll(this.store.listAll());
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
        useMainPrompt: config.useMainPrompt,
        model: config.model,
        userMessage: config.userMessage,
        maxIterations: config.maxIterations,
        maxCandles: config.maxCandles,
        tradingEnabled: config.tradingEnabled,
        timezone: config.timezone,
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

  /** Enables or disables a job — persists to SQLite and updates timers. */
  setEnabled(jobName: string, enabled: boolean): void {
    this.store.setEnabled(jobName, enabled);

    const config = this.configs.get(jobName);
    if (!config) throw new Error(`Cron job not found: ${jobName}`);

    config.enabled = enabled;
    const existing = this.jobs.get(jobName);

    if (enabled && !existing) {
      this.scheduleOne(config);
    } else if (!enabled && existing) {
      existing.stop();
      this.jobs.delete(jobName);
    }
  }

  /** Adds a new job — persists to SQLite and schedules if enabled. */
  addJob(job: CronJobConfig): void {
    if (this.configs.has(job.name)) throw new Error(`Job "${job.name}" already exists`);
    this.store.upsert(job);
    this.configs.set(job.name, job);
    if (job.enabled && this.started) {
      this.scheduleOne(job);
    }
  }

  /** Updates an existing job — persists to SQLite and reschedules. */
  updateJob(oldName: string, job: CronJobConfig): void {
    const existing = this.configs.get(oldName);
    if (!existing) throw new Error(`Job "${oldName}" not found`);

    if (oldName !== job.name) {
      if (this.configs.has(job.name)) throw new Error(`Job "${job.name}" already exists`);
      this.store.rename(oldName, job.name);
    }
    this.store.upsert(job);

    // Tear down old timer
    const oldCron = this.jobs.get(oldName);
    if (oldCron) {
      oldCron.stop();
      this.jobs.delete(oldName);
    }
    this.configs.delete(oldName);

    // Set up new
    this.configs.set(job.name, job);
    if (job.enabled && this.started) {
      this.scheduleOne(job);
    }
  }

  /** Removes a job — persists to SQLite and stops its timer. */
  removeJob(jobName: string): void {
    const removed = this.store.remove(jobName);
    if (!removed) throw new Error(`Job "${jobName}" not found`);

    const cron = this.jobs.get(jobName);
    if (cron) {
      cron.stop();
      this.jobs.delete(jobName);
    }
    this.configs.delete(jobName);
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
      const cron = new Cron(job.cron, { timezone: job.timezone ?? undefined }, () => {
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
        console.log(`[cron] "${job.name}" completed in ${result.durationMs}ms (${result.iterations} iterations)`);
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
