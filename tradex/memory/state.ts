import Database from "better-sqlite3";
import crypto from "node:crypto";
import { BaseStore, nowMs } from "../db.js";
import { memoryStatePath } from "./paths.js";
import { SCHEMA_SQL } from "./schema.js";

export const SOURCE_AGENT_SESSION = "agent_session";
export const SOURCE_TRADE_EVENT = "trade_event";
export const SOURCE_MANUAL_NOTE = "manual_note";
const VALID_SOURCE_TYPES = new Set([SOURCE_AGENT_SESSION, SOURCE_TRADE_EVENT, SOURCE_MANUAL_NOTE]);

export const JOB_PENDING = "pending";
export const JOB_CLAIMED = "claimed";
export const JOB_SUCCEEDED = "succeeded";
export const JOB_SUCCEEDED_NO_OUTPUT = "succeeded_no_output";
export const JOB_FAILED = "failed";

export const DEFAULT_LEASE_MS = 3_600_000;
export const DEFAULT_RETRY_DELAY_MS = 3_600_000;
export const DEFAULT_MAX_UNUSED_DAYS = 180;
export const DEFAULT_PRUNE_BATCH_SIZE = 200;

const SOURCE_ID_IN_PATH_RE = /(?:^|[/-])s(?<sourceId>\d+)(?:[-_/]|$)/;

export interface MemorySource {
  id: number;
  sourceType: string;
  sourceRef: string;
  createdAt: number;
  updatedAt: number;
}

export interface Stage1Job {
  sourceId: number;
  status: string;
  ownershipToken: string | null;
  claimedAt: number | null;
  finishedAt: number | null;
  leaseExpires: number | null;
  retryAfter: number | null;
  lastError: string | null;
  source: MemorySource;
}

export interface Stage1Output {
  sourceId: number;
  rawMemory: string;
  rolloutSummary: string;
  rolloutSlug: string | null;
  sourceUpdatedAt: number;
  generatedAt: number;
  usageCount: number;
  lastUsage: number | null;
  selectedForPhase2: boolean;
  source: MemorySource;
}

export interface Phase2Job {
  id: number;
  status: string;
  ownershipToken: string | null;
  claimedAt: number | null;
  finishedAt: number | null;
  leaseExpires: number | null;
  completionWatermark: number | null;
  retryAfter: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface Phase2Claim {
  ownershipToken: string;
}

function validateSourceType(sourceType: string): void {
  if (!VALID_SOURCE_TYPES.has(sourceType)) throw new Error(`unsupported memory source_type: ${sourceType}`);
}

function sourceFromRow(row: Record<string, unknown>): MemorySource {
  return {
    id: Number(row.id),
    sourceType: String(row.source_type),
    sourceRef: String(row.source_ref),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function sourceFromJoinedRow(row: Record<string, unknown>): MemorySource {
  return {
    id: Number(row.src_id),
    sourceType: String(row.source_type),
    sourceRef: String(row.source_ref),
    createdAt: Number(row.src_created_at),
    updatedAt: Number(row.src_updated_at),
  };
}

function stage1JobFromRow(row: Record<string, unknown>): Stage1Job {
  return {
    sourceId: Number(row.source_id),
    status: String(row.status),
    ownershipToken: row.ownership_token != null ? String(row.ownership_token) : null,
    claimedAt: row.claimed_at != null ? Number(row.claimed_at) : null,
    finishedAt: row.finished_at != null ? Number(row.finished_at) : null,
    leaseExpires: row.lease_expires != null ? Number(row.lease_expires) : null,
    retryAfter: row.retry_after != null ? Number(row.retry_after) : null,
    lastError: row.last_error != null ? String(row.last_error) : null,
    source: sourceFromJoinedRow(row),
  };
}

function outputFromRow(row: Record<string, unknown>): Stage1Output {
  return {
    sourceId: Number(row.source_id),
    rawMemory: String(row.raw_memory),
    rolloutSummary: String(row.rollout_summary),
    rolloutSlug: row.rollout_slug != null ? String(row.rollout_slug) : null,
    sourceUpdatedAt: Number(row.source_updated_at),
    generatedAt: Number(row.generated_at),
    usageCount: Number(row.usage_count),
    lastUsage: row.last_usage != null ? Number(row.last_usage) : null,
    selectedForPhase2: Boolean(row.selected_for_phase2),
    source: sourceFromJoinedRow(row),
  };
}

function phase2FromRow(row: Record<string, unknown>): Phase2Job {
  return {
    id: Number(row.id),
    status: String(row.status),
    ownershipToken: row.ownership_token != null ? String(row.ownership_token) : null,
    claimedAt: row.claimed_at != null ? Number(row.claimed_at) : null,
    finishedAt: row.finished_at != null ? Number(row.finished_at) : null,
    leaseExpires: row.lease_expires != null ? Number(row.lease_expires) : null,
    completionWatermark: row.completion_watermark != null ? Number(row.completion_watermark) : null,
    retryAfter: row.retry_after != null ? Number(row.retry_after) : null,
    lastError: row.last_error != null ? String(row.last_error) : null,
    updatedAt: Number(row.updated_at),
  };
}

function cleanSlug(value: string | null | undefined): string | null {
  if (value == null) return null;
  const clean = value
    .trim()
    .split("")
    .map((ch) => (/[a-zA-Z0-9]/.test(ch) ? ch.toLowerCase() : "-"))
    .join("")
    .split("-")
    .filter(Boolean)
    .join("-");
  return clean.slice(0, 80) || null;
}

function sourceIdFromPath(filePath: string): number | null {
  const matched = SOURCE_ID_IN_PATH_RE.exec(filePath);
  if (!matched?.groups?.sourceId) return null;
  return parseInt(matched.groups.sourceId, 10);
}

export class MemoryStateStore extends BaseStore {
  constructor(dbPath: string | null = null) {
    super(dbPath ?? memoryStatePath());
  }

  protected override initSchema(conn: Database.Database): void {
    conn.exec(SCHEMA_SQL);
    const at = nowMs();
    conn.prepare(
      `INSERT OR IGNORE INTO phase2_jobs (id, status, updated_at) VALUES (1, ?, ?)`,
    ).run(JOB_PENDING, at);
  }

  enqueueSource(input: { sourceType: string; sourceRef: string; updatedAt?: number | null }): MemorySource {
    validateSourceType(input.sourceType);
    const cleanRef = input.sourceRef.trim();
    if (!cleanRef) throw new Error("source_ref must not be empty");
    const at = nowMs();
    const sourceUpdatedAt = input.updatedAt ?? at;
    const conn = this.getConn();
    const txn = conn.transaction(() => {
      conn.prepare(
        `INSERT INTO memory_sources (source_type, source_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_type, source_ref) DO UPDATE SET
           updated_at = MAX(memory_sources.updated_at, excluded.updated_at)`,
      ).run(input.sourceType, cleanRef, at, sourceUpdatedAt);

      const row = conn.prepare(
        `SELECT * FROM memory_sources WHERE source_type = ? AND source_ref = ?`,
      ).get(input.sourceType, cleanRef) as Record<string, unknown>;
      const source = sourceFromRow(row);

      const output = conn.prepare(
        `SELECT source_updated_at FROM stage1_outputs WHERE source_id = ?`,
      ).get(source.id) as Record<string, unknown> | undefined;
      const shouldQueue = !output || Number(output.source_updated_at) < source.updatedAt;

      if (shouldQueue) {
        conn.prepare(
          `INSERT INTO stage1_jobs (source_id, status)
           VALUES (?, ?)
           ON CONFLICT(source_id) DO UPDATE SET
             status = excluded.status,
             ownership_token = NULL,
             claimed_at = NULL,
             finished_at = NULL,
             lease_expires = NULL,
             retry_after = NULL,
             last_error = NULL`,
        ).run(source.id, JOB_PENDING);
      }
      return source;
    });
    return txn();
  }

  claimStage1Jobs(input: { limit?: number; ownershipToken?: string; leaseMs?: number } = {}): Stage1Job[] {
    const token = input.ownershipToken ?? crypto.randomUUID();
    const at = nowMs();
    const cappedLimit = Math.max(1, input.limit ?? 8);
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    const conn = this.getConn();

    const txn = conn.transaction(() => {
      const rows = conn.prepare(
        `SELECT
           j.*,
           s.id AS src_id, s.source_type, s.source_ref,
           s.created_at AS src_created_at, s.updated_at AS src_updated_at
         FROM stage1_jobs j
         JOIN memory_sources s ON s.id = j.source_id
         WHERE
           j.status = ?
           OR (j.status = ? AND COALESCE(j.retry_after, 0) <= ?)
           OR (j.status = ? AND COALESCE(j.lease_expires, 0) <= ?)
         ORDER BY s.updated_at ASC, s.id ASC
         LIMIT ?`,
      ).all(JOB_PENDING, JOB_FAILED, at, JOB_CLAIMED, at, cappedLimit) as Record<string, unknown>[];

      const sourceIds = rows.map((row) => Number(row.source_id));
      if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => "?").join(",");
        conn.prepare(
          `UPDATE stage1_jobs
           SET status = ?, ownership_token = ?, claimed_at = ?, finished_at = NULL,
               lease_expires = ?, retry_after = NULL, last_error = NULL
           WHERE source_id IN (${placeholders})`,
        ).run(JOB_CLAIMED, token, at, at + leaseMs, ...sourceIds);
      }

      return sourceIds
        .map((sourceId) => {
          const jobRow = conn.prepare(
            `SELECT j.*, s.id AS src_id, s.source_type, s.source_ref,
                    s.created_at AS src_created_at, s.updated_at AS src_updated_at
             FROM stage1_jobs j JOIN memory_sources s ON s.id = j.source_id
             WHERE j.source_id = ?`,
          ).get(sourceId) as Record<string, unknown> | undefined;
          return jobRow ? stage1JobFromRow(jobRow) : null;
        })
        .filter((job): job is Stage1Job => job !== null);
    });

    return txn();
  }

  markStage1Succeeded(input: {
    sourceId: number;
    rawMemory: string;
    rolloutSummary: string;
    rolloutSlug?: string | null;
  }): void {
    const at = nowMs();
    const conn = this.getConn();
    const txn = conn.transaction(() => {
      const sourceRow = conn.prepare(`SELECT * FROM memory_sources WHERE id = ?`).get(input.sourceId) as Record<string, unknown> | undefined;
      if (!sourceRow) throw new Error(`memory source not found: ${input.sourceId}`);
      const source = sourceFromRow(sourceRow);

      if (!input.rawMemory.trim() && !input.rolloutSummary.trim()) {
        this._markStage1NoOutput(conn, input.sourceId, at);
        return;
      }

      conn.prepare(
        `INSERT INTO stage1_outputs (
           source_id, raw_memory, rollout_summary, rollout_slug,
           source_updated_at, generated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           raw_memory = excluded.raw_memory,
           rollout_summary = excluded.rollout_summary,
           rollout_slug = excluded.rollout_slug,
           source_updated_at = excluded.source_updated_at,
           generated_at = excluded.generated_at,
           selected_for_phase2 = 0`,
      ).run(input.sourceId, input.rawMemory, input.rolloutSummary, cleanSlug(input.rolloutSlug), source.updatedAt, at);

      conn.prepare(
        `UPDATE stage1_jobs
         SET status = ?, ownership_token = NULL, finished_at = ?,
             lease_expires = NULL, retry_after = NULL, last_error = NULL
         WHERE source_id = ?`,
      ).run(JOB_SUCCEEDED, at, input.sourceId);

      this._queuePhase2(conn, at);
    });
    txn();
  }

  markStage1NoOutput(input: { sourceId: number }): void {
    const at = nowMs();
    const conn = this.getConn();
    conn.transaction(() => {
      this._markStage1NoOutput(conn, input.sourceId, at);
    })();
  }

  markStage1Failed(input: { sourceId: number; error: string; retryDelayMs?: number }): void {
    const at = nowMs();
    const retryDelayMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.getConn().prepare(
      `UPDATE stage1_jobs
       SET status = ?, ownership_token = NULL, finished_at = ?,
           lease_expires = NULL, retry_after = ?, last_error = ?
       WHERE source_id = ?`,
    ).run(JOB_FAILED, at, at + retryDelayMs, String(input.error).slice(0, 4000), input.sourceId);
  }

  claimPhase2(input: { leaseMs?: number } = {}): Phase2Claim | null {
    const at = nowMs();
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    const token = crypto.randomUUID();
    const conn = this.getConn();

    const txn = conn.transaction((): Phase2Claim | null => {
      const row = conn.prepare(`SELECT * FROM phase2_jobs WHERE id = 1`).get() as Record<string, unknown>;
      const status = String(row.status);
      const canClaim =
        status === JOB_PENDING ||
        (status === JOB_FAILED && (row.retry_after == null || Number(row.retry_after) <= at)) ||
        (status === JOB_CLAIMED && row.lease_expires != null && Number(row.lease_expires) <= at);

      if (!canClaim) return null;

      conn.prepare(
        `UPDATE phase2_jobs
         SET status = ?, ownership_token = ?, claimed_at = ?,
             finished_at = NULL, lease_expires = ?,
             retry_after = NULL, last_error = NULL, updated_at = ?
         WHERE id = 1`,
      ).run(JOB_CLAIMED, token, at, at + leaseMs, at);

      return { ownershipToken: token };
    });

    return txn();
  }

  heartbeatPhase2(input: { ownershipToken: string; leaseMs?: number }): boolean {
    const at = nowMs();
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    const result = this.getConn().prepare(
      `UPDATE phase2_jobs
       SET lease_expires = ?, updated_at = ?
       WHERE id = 1 AND status = ? AND ownership_token = ?`,
    ).run(at + leaseMs, at, JOB_CLAIMED, input.ownershipToken);
    return result.changes > 0;
  }

  selectPhase2Inputs(input: { limit?: number; maxUnusedDays?: number } = {}): Stage1Output[] {
    const limit = Math.max(1, input.limit ?? 100);
    const maxUnusedDays = input.maxUnusedDays ?? DEFAULT_MAX_UNUSED_DAYS;
    const cutoff = nowMs() - maxUnusedDays * 86_400_000;
    const conn = this.getConn();

    const rows = conn.prepare(
      `SELECT
         o.*,
         s.id AS src_id, s.source_type, s.source_ref,
         s.created_at AS src_created_at, s.updated_at AS src_updated_at
       FROM stage1_outputs o
       JOIN memory_sources s ON s.id = o.source_id
       WHERE COALESCE(o.last_usage, o.generated_at) >= ?
       ORDER BY
         COALESCE(o.usage_count, 0) DESC,
         COALESCE(o.last_usage, o.generated_at) DESC,
         o.generated_at DESC
       LIMIT ?`,
    ).all(cutoff, limit) as Record<string, unknown>[];

    return rows.map(outputFromRow);
  }

  markPhase2Succeeded(input: {
    completionWatermark?: number | null;
    selectedSourceIds?: number[];
  } = {}): void {
    const at = nowMs();
    const conn = this.getConn();
    conn.transaction(() => {
      const sourceIds = input.selectedSourceIds ?? [];
      if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => "?").join(",");
        conn.prepare(
          `UPDATE stage1_outputs SET selected_for_phase2 = 1 WHERE source_id IN (${placeholders})`,
        ).run(...sourceIds);
      }
      conn.prepare(
        `UPDATE phase2_jobs
         SET status = ?, ownership_token = NULL, finished_at = ?,
             lease_expires = NULL, completion_watermark = ?,
             retry_after = NULL, last_error = NULL, updated_at = ?
         WHERE id = 1`,
      ).run(JOB_SUCCEEDED, at, input.completionWatermark ?? at, at);
    })();
  }

  markPhase2Failed(input: { error: string; retryDelayMs?: number }): void {
    const at = nowMs();
    const retryDelayMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.getConn().prepare(
      `UPDATE phase2_jobs
       SET status = ?, ownership_token = NULL, finished_at = ?,
           lease_expires = NULL, retry_after = ?, last_error = ?, updated_at = ?
       WHERE id = 1`,
    ).run(JOB_FAILED, at, at + retryDelayMs, String(input.error).slice(0, 4000), at);
  }

  recordUsage(input: { filePath: string; usageKind: string }): void {
    const cleanPath = input.filePath.trim();
    const cleanKind = input.usageKind.trim();
    if (!cleanPath) throw new Error("file_path must not be empty");
    if (!cleanKind) throw new Error("usage_kind must not be empty");
    const at = nowMs();
    const conn = this.getConn();
    conn.transaction(() => {
      conn.prepare(
        `INSERT INTO memory_usage (file_path, usage_kind, used_at) VALUES (?, ?, ?)`,
      ).run(cleanPath, cleanKind, at);

      const sourceId = sourceIdFromPath(cleanPath);
      if (sourceId != null) {
        conn.prepare(
          `UPDATE stage1_outputs SET usage_count = usage_count + 1, last_usage = ? WHERE source_id = ?`,
        ).run(at, sourceId);
      }
    })();
  }

  pruneStage1OutputsForRetention(input: {
    maxUnusedDays?: number;
    batchSize?: number;
  } = {}): number {
    const maxUnusedDays = input.maxUnusedDays ?? DEFAULT_MAX_UNUSED_DAYS;
    const batchSize = Math.max(1, input.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE);
    const cutoff = nowMs() - Math.max(0, maxUnusedDays) * 86_400_000;
    const conn = this.getConn();

    const pruned = conn.transaction(() => {
      const rows = conn.prepare(
        `SELECT source_id FROM stage1_outputs
         WHERE COALESCE(last_usage, generated_at) < ?
         ORDER BY COALESCE(last_usage, generated_at) ASC, source_id ASC
         LIMIT ?`,
      ).all(cutoff, batchSize) as Record<string, unknown>[];

      const sourceIds = rows.map((row) => Number(row.source_id));
      if (sourceIds.length === 0) return 0;

      const placeholders = sourceIds.map(() => "?").join(",");
      conn.prepare(`DELETE FROM stage1_outputs WHERE source_id IN (${placeholders})`).run(...sourceIds);
      conn.prepare(
        `UPDATE stage1_jobs
         SET status = ?, ownership_token = NULL, finished_at = ?,
             lease_expires = NULL, retry_after = NULL, last_error = NULL
         WHERE source_id IN (${placeholders})`,
      ).run(JOB_SUCCEEDED_NO_OUTPUT, nowMs(), ...sourceIds);

      this._queuePhase2(conn, nowMs());
      return sourceIds.length;
    })();

    return pruned;
  }

  getPhase2Job(): Phase2Job {
    const row = this.getConn().prepare(`SELECT * FROM phase2_jobs WHERE id = 1`).get() as Record<string, unknown>;
    return phase2FromRow(row);
  }

  queuePhase2(): void {
    const conn = this.getConn();
    this._queuePhase2(conn, nowMs());
  }

  private _markStage1NoOutput(conn: Database.Database, sourceId: number, timestampMs: number): void {
    conn.prepare(`DELETE FROM stage1_outputs WHERE source_id = ?`).run(sourceId);
    conn.prepare(
      `UPDATE stage1_jobs
       SET status = ?, ownership_token = NULL, finished_at = ?,
           lease_expires = NULL, retry_after = NULL, last_error = NULL
       WHERE source_id = ?`,
    ).run(JOB_SUCCEEDED_NO_OUTPUT, timestampMs, sourceId);
    this._queuePhase2(conn, timestampMs);
  }

  private _queuePhase2(conn: Database.Database, timestampMs: number): void {
    conn.prepare(
      `INSERT INTO phase2_jobs (id, status, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = ?,
         retry_after = NULL,
         last_error = NULL,
         updated_at = excluded.updated_at
       WHERE phase2_jobs.status != ?`,
    ).run(JOB_PENDING, timestampMs, JOB_PENDING, JOB_CLAIMED);
  }
}
