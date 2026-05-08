"""文件用途：记忆写入流水线的 SQLite schema。"""
from __future__ import annotations

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS memory_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_type, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_memory_sources_updated_at
    ON memory_sources(updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS stage1_jobs (
    source_id INTEGER PRIMARY KEY REFERENCES memory_sources(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    ownership_token TEXT,
    claimed_at INTEGER,
    finished_at INTEGER,
    lease_expires INTEGER,
    retry_after INTEGER,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_stage1_jobs_status_retry_lease
    ON stage1_jobs(status, retry_after, lease_expires);

CREATE TABLE IF NOT EXISTS stage1_outputs (
    source_id INTEGER PRIMARY KEY REFERENCES memory_sources(id) ON DELETE CASCADE,
    raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL,
    rollout_slug TEXT,
    source_updated_at INTEGER NOT NULL,
    generated_at INTEGER NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_usage INTEGER,
    selected_for_phase2 INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stage1_outputs_usage
    ON stage1_outputs(usage_count DESC, last_usage DESC, generated_at DESC);

CREATE TABLE IF NOT EXISTS phase2_jobs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL,
    ownership_token TEXT,
    claimed_at INTEGER,
    finished_at INTEGER,
    lease_expires INTEGER,
    completion_watermark INTEGER,
    retry_after INTEGER,
    last_error TEXT,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_phase2_jobs_status_retry_lease
    ON phase2_jobs(status, retry_after, lease_expires);

CREATE TABLE IF NOT EXISTS memory_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    usage_kind TEXT NOT NULL,
    used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_usage_used_at
    ON memory_usage(used_at DESC, id DESC);
"""
