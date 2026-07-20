/** Cron Job 调度客户端。 */
import type {
  CronJobCreate,
  CronJobsResponse,
  CronJobStatus,
  CronJobUpdate,
  CronRunRecord,
  CronSessionEntry,
} from '../types';
import { responseError } from './http';

// Lists all configured cron jobs with their runtime status.
export async function fetchCronJobs(): Promise<CronJobsResponse> {
  const response = await fetch('/api/cron/jobs');
  if (!response.ok) throw await responseError(response, 'cron jobs fetch failed');
  return await response.json();
}

// Lists run history for a specific job.
export async function fetchCronJobRuns(jobName: string): Promise<CronRunRecord[]> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(jobName)}/sessions`);
  if (!response.ok) throw await responseError(response, 'cron job runs fetch failed');
  const payload = await response.json();
  return payload.runs;
}

// Returns the full session entries for a single cron run.
export async function fetchCronSession(sessionId: string): Promise<{ jobName: string; entries: CronSessionEntry[] }> {
  const response = await fetch(`/api/cron/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw await responseError(response, 'cron session fetch failed');
  return response.json();
}

export async function deleteCronRun(sessionId: string): Promise<void> {
  const response = await fetch(`/api/cron/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, 'cron run delete failed');
}

export async function clearCronJobRuns(jobName: string): Promise<{ deleted: number }> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(jobName)}/sessions`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, 'cron job runs clear failed');
  return response.json();
}

// Manually triggers a cron job.
export async function triggerCronJob(jobName: string): Promise<{ ok: boolean; result?: unknown; detail?: string }> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(jobName)}/trigger`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'cron trigger failed');
  return response.json();
}

// Enables or disables a cron job at runtime.
export async function setCronJobEnabled(jobName: string, enabled: boolean): Promise<CronJobStatus[]> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(jobName)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw await responseError(response, 'cron job toggle failed');
  const payload = await response.json();
  return payload.jobs;
}

// Creates a new cron job. Persists to TOML and reloads the scheduler.
export async function createCronJob(job: CronJobCreate): Promise<CronJobStatus[]> {
  const response = await fetch('/api/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });
  if (!response.ok) throw await responseError(response, 'cron job create failed');
  const payload = await response.json();
  return payload.jobs;
}

// Updates an existing cron job. Persists to TOML and reloads the scheduler.
export async function updateCronJob(name: string, job: CronJobUpdate): Promise<CronJobStatus[]> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });
  if (!response.ok) throw await responseError(response, 'cron job update failed');
  const payload = await response.json();
  return payload.jobs;
}

// Deletes a cron job. Persists to TOML and reloads the scheduler.
export async function deleteCronJob(name: string): Promise<CronJobStatus[]> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await responseError(response, 'cron job delete failed');
  const payload = await response.json();
  return payload.jobs;
}
