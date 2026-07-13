/**
 * JSON-file-backed cron job store.
 *
 * All cron job configurations live in a single JSON file (default: project
 * root `cron_jobs.json`). The file is read on startup and written on every
 * mutation. No SQLite dependency.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { CronJobConfig } from "../config/index.js";

export const DEFAULT_CRON_JOBS_FILENAME = "cron_jobs.json";

/**
 * Persistent on-disk representation — matches CronJobConfig but uses
 * snake_case keys for consistency with the rest of the config surface.
 */
interface CronJobJson {
  name: string;
  cron: string;
  system_prompt: string;
  use_main_prompt: boolean;
  enabled: boolean;
  symbols: string[];
  model: string | null;
  user_message: string;
  max_iterations: number | null;
  max_candles: number | null;
  trading_enabled: boolean;
  timezone: string | null;
}

function toJson(job: CronJobConfig): CronJobJson {
  return {
    name: job.name,
    cron: job.cron,
    system_prompt: job.systemPrompt,
    use_main_prompt: job.useMainPrompt,
    enabled: job.enabled,
    symbols: job.symbols,
    model: job.model,
    user_message: job.userMessage,
    max_iterations: job.maxIterations,
    max_candles: job.maxCandles,
    trading_enabled: job.tradingEnabled,
    timezone: job.timezone,
  };
}

function fromJson(raw: CronJobJson): CronJobConfig {
  return {
    name: raw.name,
    cron: raw.cron,
    systemPrompt: raw.system_prompt ?? "",
    useMainPrompt: raw.use_main_prompt === true,
    enabled: raw.enabled !== false,
    symbols: Array.isArray(raw.symbols) ? raw.symbols : [],
    model: raw.model ?? null,
    userMessage: raw.user_message ?? "开始定时看盘分析",
    maxIterations: raw.max_iterations ?? null,
    maxCandles: raw.max_candles ?? null,
    tradingEnabled: raw.trading_enabled === true,
    timezone: raw.timezone ?? null,
  };
}

export class CronJobStore {
  readonly filePath: string;
  private jobs: Map<string, CronJobConfig> = new Map();

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.resolve(process.cwd(), DEFAULT_CRON_JOBS_FILENAME);
    this.load();
  }

  // ---- Read ----

  listAll(): CronJobConfig[] {
    return Array.from(this.jobs.values());
  }

  get(name: string): CronJobConfig | null {
    return this.jobs.get(name) ?? null;
  }

  isEmpty(): boolean {
    return this.jobs.size === 0;
  }

  // ---- Write ----

  upsert(job: CronJobConfig): void {
    this.jobs.set(job.name, job);
    this.persist();
  }

  remove(name: string): boolean {
    const existed = this.jobs.delete(name);
    if (existed) this.persist();
    return existed;
  }

  setEnabled(name: string, enabled: boolean): void {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Cron job not found: ${name}`);
    job.enabled = enabled;
    this.persist();
  }

  rename(oldName: string, newName: string): void {
    const job = this.jobs.get(oldName);
    if (!job) throw new Error(`Cron job not found: ${oldName}`);
    this.jobs.delete(oldName);
    job.name = newName;
    this.jobs.set(newName, job);
    this.persist();
  }

  // ---- Internal ----

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const text = readFileSync(this.filePath, "utf8");
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) return;
      for (const raw of arr) {
        if (typeof raw !== "object" || raw === null || !raw.name) continue;
        const job = fromJson(raw as CronJobJson);
        this.jobs.set(job.name, job);
      }
    } catch {
      // Corrupted or empty file — start fresh
      console.warn(`[cron] Failed to parse ${this.filePath}, starting with empty job list`);
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const arr = Array.from(this.jobs.values()).map(toJson);
    writeFileSync(this.filePath, JSON.stringify(arr, null, 2) + "\n", "utf8");
  }
}
