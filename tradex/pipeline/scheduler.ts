import { Cron } from "croner";
import type { AppRuntime } from "../api/runtime.js";
import type { PipelineRun } from "./types.js";

/**
 * Lightweight scheduler for the structured ATLAS-style pipeline.
 *
 * This is separate from the user-facing Cron subsystem: Cron jobs create Agent
 * sessions, while this scheduler runs deterministic pipeline/evolution jobs.
 */
export class PipelineScheduler {
  private runtime: AppRuntime;
  private jobs = new Map<string, Cron>();
  private runningJobs = new Set<string>();
  private started = false;

  constructor(runtime: AppRuntime) {
    this.runtime = runtime;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleAll();
  }

  stop(): void {
    this.started = false;
    for (const [, cron] of this.jobs) cron.stop();
    this.jobs.clear();
    this.runningJobs.clear();
  }

  reload(): void {
    for (const [, cron] of this.jobs) cron.stop();
    this.jobs.clear();
    this.runningJobs.clear();
    if (this.started) this.scheduleAll();
  }

  async runConfiguredInstruments(): Promise<PipelineRun[]> {
    const instruments = this.runtime.config.pipeline.instruments;
    if (!this.runtime.config.pipeline.enabled || instruments.length === 0) return [];
    const runs: PipelineRun[] = [];
    for (const instrumentKey of instruments) {
      runs.push(await this.runtime.runPipeline(instrumentKey, "cron"));
    }
    return runs;
  }

  private scheduleAll(): void {
    const { pipeline, evolution } = this.runtime.config;

    if (pipeline.enabled && pipeline.instruments.length > 0 && this.runtime.pipelineOrchestrator) {
      this.scheduleOne("pipeline", pipeline.cronExpression, () => this.runPipelineTick());
    }

    if (evolution.enabled) {
      this.scheduleOne("evolution:weights", evolution.weightUpdateCron, () => this.runWeightUpdateTick());
      this.scheduleOne("evolution:returns", evolution.returnTrackingCron, () => this.runReturnTrackingTick());
    }
  }

  private scheduleOne(name: string, expression: string, task: () => Promise<unknown>): void {
    try {
      const cron = new Cron(expression, {}, () => {
        void this.runExclusive(name, task);
      });
      this.jobs.set(name, cron);
      const next = cron.nextRun();
      console.log(`[pipeline] scheduled ${name}: ${expression} → next: ${next ? next.toISOString() : "none"}`);
    } catch (error) {
      console.error(`[pipeline] failed to schedule ${name} (${expression}):`, error);
    }
  }

  private async runExclusive(name: string, task: () => Promise<unknown>): Promise<void> {
    if (this.runningJobs.has(name)) {
      console.warn(`[pipeline] skipping ${name} — previous run still in progress`);
      return;
    }
    this.runningJobs.add(name);
    try {
      await task();
    } catch (error) {
      console.error(`[pipeline] ${name} failed:`, error);
    } finally {
      this.runningJobs.delete(name);
    }
  }

  private async runPipelineTick(): Promise<void> {
    await this.runConfiguredInstruments();
  }

  private async runWeightUpdateTick(): Promise<void> {
    const changes = this.runtime.updateDarwinWeights();
    if (changes.length > 0) {
      console.log(`[pipeline] Darwin weight update changed ${changes.length} module weights`);
    }
  }

  private async runReturnTrackingTick(): Promise<void> {
    const filled = await this.runtime.backfillRecommendationReturns();
    if (filled > 0) {
      console.log(`[pipeline] backfilled ${filled} recommendation returns`);
    }
  }
}
