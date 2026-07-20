/** Cron Job 调度与运行记录 DTO。 */

export interface CronJobStatus {
  name: string;
  cron: string;
  enabled: boolean;
  running: boolean;
  nextRun: string | null;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | null;
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

export interface CronRunRecord {
  jobName: string;
  sessionId: string;
  filePath: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'error';
  error: string | null;
  preview: string;
}

export interface CronSessionEntry {
  type: string;
  id?: string;
  timestamp?: string;
  role?: string;
  content?: string;
  metadata?: Record<string, unknown> | null;
  error?: string | null;
  customType?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CronJobCreate {
  name: string;
  cron: string;
  systemPrompt?: string;
  useMainPrompt?: boolean;
  userMessage?: string;
  model?: string | null;
  symbols?: string[];
  enabled?: boolean;
  maxIterations?: number | null;
  maxCandles?: number | null;
  tradingEnabled?: boolean;
  timezone?: string | null;
}

export interface CronJobUpdate {
  name?: string;
  cron?: string;
  systemPrompt?: string;
  useMainPrompt?: boolean;
  userMessage?: string;
  model?: string | null;
  symbols?: string[];
  enabled?: boolean;
  maxIterations?: number | null;
  maxCandles?: number | null;
  tradingEnabled?: boolean;
  timezone?: string | null;
}

export interface CronStoragePaths {
  config: string;
  sessions: string;
}

export interface CronJobsResponse {
  jobs: CronJobStatus[];
  storagePaths: CronStoragePaths;
}
