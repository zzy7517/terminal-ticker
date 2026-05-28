import { Cron } from "croner";
import type { PipelineRun } from "./types.js";

interface PipelineSchedulerRuntime {
  config: {
    pipeline: { enabled: boolean; instruments: string[]; cronExpression: string };
    evolution: { enabled: boolean; weightUpdateCron: string; returnTrackingCron: string };
  };
  pipelineOrchestrator: unknown | null;
  runPipeline(instrumentKey: string, trigger: "cron"): Promise<PipelineRun>;
  updateDarwinWeights(): Array<unknown>;
  backfillRecommendationReturns(): Promise<number>;
}

/**
 * Lightweight scheduler for the structured ATLAS-style pipeline.
 *
 * This is separate from the user-facing Cron subsystem: Cron jobs create Agent
 * sessions, while this scheduler runs deterministic pipeline/evolution jobs.
 */
export class PipelineScheduler {
  private runtime: PipelineSchedulerRuntime;
  private jobs = new Map<string, Cron>();
  private runningTasks = new Map<string, Promise<void>>();
  private started = false;

  constructor(runtime: PipelineSchedulerRuntime) {
    this.runtime = runtime;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleAll();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopTimers();
    await this.awaitRunningTasks();
  }

  async reload(): Promise<void> {
    const shouldRestart = this.started;
    this.started = false;
    this.stopTimers();
    await this.awaitRunningTasks();
    this.started = shouldRestart;
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
    if (this.runningTasks.has(name)) {
      console.warn(`[pipeline] skipping ${name} — previous run still in progress`);
      return;
    }
    const run = (async () => {
      try {
        await task();
      } catch (error) {
        console.error(`[pipeline] ${name} failed:`, error);
      } finally {
        this.runningTasks.delete(name);
      }
    })();
    this.runningTasks.set(name, run);
    await run;
  }

  private stopTimers(): void {
    for (const [, cron] of this.jobs) cron.stop();
    this.jobs.clear();
  }

  private async awaitRunningTasks(): Promise<void> {
    const tasks = [...this.runningTasks.values()];
    if (tasks.length === 0) return;
    await Promise.allSettled(tasks);
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
