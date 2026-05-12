/**
 * Cron session storage.
 *
 * Reuses the same JSONL format as `SessionManager` (agent sessions) but stores
 * files under `~/.cache/tradex/cron_sessions/{job_name}/` so cron history is
 * separated from interactive chat sessions while remaining format-compatible.
 */

import fs from "node:fs";
import path from "node:path";
import { defaultCacheDir } from "../db.js";

const CRON_SESSIONS_SUBDIR = "cron_sessions";

export interface CronRunRecord {
  jobName: string;
  sessionId: string;
  filePath: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "error";
  error: string | null;
  /** First ~200 chars of the assistant response for list views. */
  preview: string;
}

/** Root directory for all cron session files. */
export function cronSessionsDir(): string {
  return path.join(defaultCacheDir(), CRON_SESSIONS_SUBDIR);
}

/** Per-job subdirectory. Created lazily on first write. */
export function jobDir(jobName: string): string {
  // Sanitize job name for filesystem safety
  const safe = jobName.replace(/[^a-zA-Z0-9一-鿿_-]/g, "_").slice(0, 64);
  return path.join(cronSessionsDir(), safe);
}

/** Generates the JSONL file path for a new cron run. */
export function newCronSessionPath(jobName: string, sessionId: string): string {
  const dir = jobDir(jobName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${timestamp}_${sessionId}.jsonl`);
}

/**
 * Lists all cron run records for a specific job, sorted by most recent first.
 * Reads only the header + first assistant message from each file for efficiency.
 */
export function listJobRuns(jobName: string): CronRunRecord[] {
  const dir = jobDir(jobName);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f));

  const records: CronRunRecord[] = [];
  for (const filePath of files) {
    const record = parseRunRecord(jobName, filePath);
    if (record) records.push(record);
  }

  records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return records;
}

/** Lists runs across ALL jobs, sorted by most recent first. */
export function listAllRuns(limit = 50): CronRunRecord[] {
  const root = cronSessionsDir();
  if (!fs.existsSync(root)) return [];

  const jobDirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const all: CronRunRecord[] = [];
  for (const jobDirName of jobDirs) {
    const dir = path.join(root, jobDirName);
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));

    for (const filePath of files) {
      const record = parseRunRecord(jobDirName, filePath);
      if (record) all.push(record);
    }
  }

  all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return all.slice(0, limit);
}

/** Reads a single cron session file by sessionId (searches all job dirs). */
export function findRunBySessionId(sessionId: string): { jobName: string; filePath: string } | null {
  const root = cronSessionsDir();
  if (!fs.existsSync(root)) return null;

  for (const jobDirEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!jobDirEntry.isDirectory()) continue;
    const dir = path.join(root, jobDirEntry.name);
    for (const file of fs.readdirSync(dir)) {
      if (file.includes(sessionId) && file.endsWith(".jsonl")) {
        return { jobName: jobDirEntry.name, filePath: path.join(dir, file) };
      }
    }
  }
  return null;
}

/** Reads a JSONL cron session file and returns all parsed entries. */
export function readSessionEntries(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const entries: Array<Record<string, unknown>> = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseRunRecord(jobName: string, filePath: string): CronRunRecord | null {
  try {
    const entries = readSessionEntries(filePath);
    if (entries.length === 0) return null;

    const header = entries[0];
    if (header.type !== "session") return null;

    let status: CronRunRecord["status"] = "running";
    let error: string | null = null;
    let preview = "";
    let finishedAt: string | null = null;

    for (const entry of entries) {
      if (entry.type === "message" && entry.role === "assistant" && typeof entry.content === "string") {
        if (!preview) preview = entry.content.replace(/[\n\r]/g, " ").slice(0, 200);
      }
      if (entry.type === "custom" && entry.customType === "cron_run_complete") {
        const data = entry.data as Record<string, unknown> | undefined;
        status = data?.status === "error" ? "error" : "ok";
        error = typeof data?.error === "string" ? data.error : null;
        finishedAt = typeof entry.timestamp === "string" ? entry.timestamp : null;
      }
    }

    return {
      jobName,
      sessionId: String(header.id ?? ""),
      filePath,
      startedAt: String(header.timestamp ?? ""),
      finishedAt,
      status,
      error,
      preview,
    };
  } catch {
    return null;
  }
}
