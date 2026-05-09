"""文件用途：本地记忆写入流水线的 SQLite 状态存储。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import sqlite3
import uuid

from ..db import BaseStore, now_ms
from .paths import ensure_memory_layout, memory_state_path
from .schema import SCHEMA_SQL

SOURCE_AGENT_SESSION = "agent_session"
SOURCE_TRADE_EVENT = "trade_event"
SOURCE_MANUAL_NOTE = "manual_note"
VALID_SOURCE_TYPES = {SOURCE_AGENT_SESSION, SOURCE_TRADE_EVENT, SOURCE_MANUAL_NOTE}

JOB_PENDING = "pending"
JOB_CLAIMED = "claimed"
JOB_SUCCEEDED = "succeeded"
JOB_SUCCEEDED_NO_OUTPUT = "succeeded_no_output"
JOB_FAILED = "failed"

DEFAULT_LEASE_MS = 3_600_000
DEFAULT_RETRY_DELAY_MS = 3_600_000
DEFAULT_MAX_UNUSED_DAYS = 180
DEFAULT_PRUNE_BATCH_SIZE = 200
_SOURCE_ID_IN_PATH_RE = re.compile(r"(?:^|[/-])s(?P<source_id>\d+)(?:[-_/]|$)")


@dataclass(frozen=True)
class MemorySource:
    """说明：可被第一阶段抽取成记忆的输入源。"""

    id: int
    source_type: str
    source_ref: str
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class Stage1Job:
    """说明：等待或已领取的第一阶段抽取任务。"""

    source_id: int
    status: str
    ownership_token: str | None
    claimed_at: int | None
    finished_at: int | None
    lease_expires: int | None
    retry_after: int | None
    last_error: str | None
    source: MemorySource


@dataclass(frozen=True)
class Stage1Output:
    """说明：已持久化的第一阶段抽取结果。"""

    source_id: int
    raw_memory: str
    rollout_summary: str
    rollout_slug: str | None
    source_updated_at: int
    generated_at: int
    usage_count: int
    last_usage: int | None
    selected_for_phase2: bool
    source: MemorySource


@dataclass(frozen=True)
class Phase2Job:
    """说明：全局第二阶段聚合任务锁。"""

    id: int
    status: str
    ownership_token: str | None
    claimed_at: int | None
    finished_at: int | None
    lease_expires: int | None
    completion_watermark: int | None
    retry_after: int | None
    last_error: str | None
    updated_at: int


class MemoryStateStore(BaseStore):
    """说明：存储记忆源、任务、抽取结果和使用记录。"""

    def __init__(self, path: str | Path | None = None) -> None:
        if path is None:
            # 默认 store 负责标准记忆目录布局；显式传入的测试路径只需要父目录。
            ensure_memory_layout()
            resolved = memory_state_path()
        else:
            resolved = Path(path).expanduser()
            resolved.parent.mkdir(parents=True, exist_ok=True)
        super().__init__(resolved)

    def _init_schema(self, conn: sqlite3.Connection) -> None:
        conn.executescript(SCHEMA_SQL)
        now = now_ms()
        # 第二阶段是全局锁行；预先创建可以减少聚合任务的首次启动分支。
        conn.execute(
            """
            INSERT OR IGNORE INTO phase2_jobs (id, status, updated_at)
            VALUES (1, ?, ?)
            """,
            (JOB_PENDING, now),
        )

    def enqueue_source(
        self,
        *,
        source_type: str,
        source_ref: str,
        updated_at: int | None = None,
    ) -> MemorySource:
        """说明：写入或更新记忆源，并确保有待处理的第一阶段任务。"""
        _validate_source_type(source_type)
        clean_ref = source_ref.strip()
        if not clean_ref:
            raise ValueError("source_ref must not be empty")
        now = now_ms()
        source_updated_at = updated_at or now
        with self._get_conn() as conn:
            # `updated_at` 是源数据水位；只有源比上次抽取更新时才重新入队。
            conn.execute(
                """
                INSERT INTO memory_sources (source_type, source_ref, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(source_type, source_ref) DO UPDATE SET
                    updated_at = MAX(memory_sources.updated_at, excluded.updated_at)
                """,
                (source_type, clean_ref, now, source_updated_at),
            )
            row = conn.execute(
                """
                SELECT * FROM memory_sources
                WHERE source_type = ? AND source_ref = ?
                """,
                (source_type, clean_ref),
            ).fetchone()
            source = _source_from_row(row)
            output = conn.execute(
                "SELECT source_updated_at FROM stage1_outputs WHERE source_id = ?",
                (source.id,),
            ).fetchone()
            should_queue = output is None or int(output["source_updated_at"]) < source.updated_at
            if should_queue:
                # 新版本源到达时清空持有者字段，避免遗留失败/弃用任务阻塞新任务。
                conn.execute(
                    """
                    INSERT INTO stage1_jobs (source_id, status)
                    VALUES (?, ?)
                    ON CONFLICT(source_id) DO UPDATE SET
                        status = excluded.status,
                        ownership_token = NULL,
                        claimed_at = NULL,
                        finished_at = NULL,
                        lease_expires = NULL,
                        retry_after = NULL,
                        last_error = NULL
                    """,
                    (source.id, JOB_PENDING),
                )
        return source

    def claim_stage1_jobs(
        self,
        *,
        limit: int = 8,
        ownership_token: str | None = None,
        lease_ms: int = DEFAULT_LEASE_MS,
    ) -> list[Stage1Job]:
        """说明：领取待处理、可重试或租约过期的第一阶段任务。"""
        token = ownership_token or str(uuid.uuid4())
        now = now_ms()
        capped_limit = max(1, int(limit))
        with self._get_conn() as conn:
            # 领取时把可重试失败任务和租约过期任务视为待处理，避免额外恢复流程。
            rows = conn.execute(
                """
                SELECT
                    j.*,
                    s.id AS src_id,
                    s.source_type,
                    s.source_ref,
                    s.created_at AS src_created_at,
                    s.updated_at AS src_updated_at
                FROM stage1_jobs j
                JOIN memory_sources s ON s.id = j.source_id
                WHERE
                    j.status = ?
                    OR (j.status = ? AND COALESCE(j.retry_after, 0) <= ?)
                    OR (j.status = ? AND COALESCE(j.lease_expires, 0) <= ?)
                ORDER BY s.updated_at ASC, s.id ASC
                LIMIT ?
                """,
                (JOB_PENDING, JOB_FAILED, now, JOB_CLAIMED, now, capped_limit),
            ).fetchall()
            source_ids = [int(row["source_id"]) for row in rows]
            if source_ids:
                placeholders = ",".join("?" for _ in source_ids)
                # 本地 SQLite 主要是单机协作状态；同事务更新已选 id 可避免重复领取。
                conn.execute(
                    f"""
                    UPDATE stage1_jobs
                    SET status = ?,
                        ownership_token = ?,
                        claimed_at = ?,
                        finished_at = NULL,
                        lease_expires = ?,
                        retry_after = NULL,
                        last_error = NULL
                    WHERE source_id IN ({placeholders})
                    """,
                    (JOB_CLAIMED, token, now, now + lease_ms, *source_ids),
                )
            claimed = [
                self._stage1_job_for_source_id(conn, source_id)
                for source_id in source_ids
            ]
        return [job for job in claimed if job is not None]

    def mark_stage1_succeeded(
        self,
        *,
        source_id: int,
        raw_memory: str,
        rollout_summary: str,
        rollout_slug: str | None = None,
    ) -> None:
        """说明：保存第一阶段成功输出，并标记任务完成。"""
        now = now_ms()
        with self._get_conn() as conn:
            source = self._source_for_id(conn, source_id)
            if source is None:
                raise ValueError(f"memory source not found: {source_id}")
            if not raw_memory.strip() and not rollout_summary.strip():
                # 空抽取是成功的无输出结果，必须清掉旧输出，避免第二阶段聚合过期内容。
                self._mark_stage1_no_output(conn, source_id, now)
                return
            conn.execute(
                """
                INSERT INTO stage1_outputs (
                    source_id, raw_memory, rollout_summary, rollout_slug,
                    source_updated_at, generated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_id) DO UPDATE SET
                    raw_memory = excluded.raw_memory,
                    rollout_summary = excluded.rollout_summary,
                    rollout_slug = excluded.rollout_slug,
                    source_updated_at = excluded.source_updated_at,
                    generated_at = excluded.generated_at,
                    selected_for_phase2 = 0
                """,
                (
                    source_id,
                    raw_memory,
                    rollout_summary,
                    _clean_slug(rollout_slug),
                    source.updated_at,
                    now,
                ),
            )
            # 真实第一阶段输出只负责唤醒第二阶段；实际文件写入仍由全局聚合阶段完成。
            conn.execute(
                """
                UPDATE stage1_jobs
                SET status = ?, ownership_token = NULL, finished_at = ?,
                    lease_expires = NULL, retry_after = NULL, last_error = NULL
                WHERE source_id = ?
                """,
                (JOB_SUCCEEDED, now, source_id),
            )
            self._queue_phase2(conn, now)

    def mark_stage1_no_output(self, *, source_id: int) -> None:
        """说明：标记第一阶段成功执行但没有可持久化记忆。"""
        now = now_ms()
        with self._get_conn() as conn:
            self._mark_stage1_no_output(conn, source_id, now)

    def mark_stage1_failed(
        self,
        *,
        source_id: int,
        error: str,
        retry_delay_ms: int = DEFAULT_RETRY_DELAY_MS,
    ) -> None:
        """说明：标记第一阶段失败，并设置重试退避。"""
        now = now_ms()
        with self._get_conn() as conn:
            conn.execute(
                """
                UPDATE stage1_jobs
                SET status = ?, ownership_token = NULL, finished_at = ?,
                    lease_expires = NULL, retry_after = ?, last_error = ?
                WHERE source_id = ?
                """,
                (JOB_FAILED, now, now + retry_delay_ms, error[:4000], source_id),
            )

    def select_phase2_inputs(
        self,
        *,
        limit: int = 100,
        max_unused_days: int | None = DEFAULT_MAX_UNUSED_DAYS,
    ) -> list[Stage1Output]:
        """说明：按使用频率和新鲜度选择第二阶段聚合输入。"""
        capped_limit = max(1, int(limit))
        cutoff = None
        if max_unused_days is not None:
            cutoff = now_ms() - max(0, int(max_unused_days)) * 86_400_000
        with self._get_conn() as conn:
            # 优先聚合近期被复用的记忆；新产物即使未使用也能通过 generated_at 进入。
            where = ""
            params: list[int] = []
            if cutoff is not None:
                where = "WHERE COALESCE(o.last_usage, o.generated_at) >= ?"
                params.append(cutoff)
            rows = conn.execute(
                f"""
                SELECT
                    o.*,
                    s.id AS src_id,
                    s.source_type,
                    s.source_ref,
                    s.created_at AS src_created_at,
                    s.updated_at AS src_updated_at
                FROM stage1_outputs o
                JOIN memory_sources s ON s.id = o.source_id
                {where}
                ORDER BY
                    o.usage_count DESC,
                    COALESCE(o.last_usage, o.generated_at) DESC,
                    o.generated_at DESC,
                    o.source_id DESC
                LIMIT ?
                """,
                (*params, capped_limit),
            ).fetchall()
        return [_output_from_row(row) for row in rows]

    def claim_phase2(
        self,
        *,
        ownership_token: str | None = None,
        lease_ms: int = DEFAULT_LEASE_MS,
    ) -> Phase2Job | None:
        """说明：在可运行时领取全局第二阶段聚合任务。"""
        token = ownership_token or str(uuid.uuid4())
        now = now_ms()
        with self._get_conn() as conn:
            row = conn.execute("SELECT * FROM phase2_jobs WHERE id = 1").fetchone()
            if row is None:
                self._queue_phase2(conn, now)
                row = conn.execute("SELECT * FROM phase2_jobs WHERE id = 1").fetchone()
            if not _job_runnable(row, now):
                return None
            # 第二阶段会改共享文件，因此同一时间只能有一个持有者；任务异常退出靠租约过期恢复。
            conn.execute(
                """
                UPDATE phase2_jobs
                SET status = ?, ownership_token = ?, claimed_at = ?,
                    finished_at = NULL, lease_expires = ?, retry_after = NULL,
                    last_error = NULL, updated_at = ?
                WHERE id = 1
                """,
                (JOB_CLAIMED, token, now, now + lease_ms, now),
            )
            updated = conn.execute("SELECT * FROM phase2_jobs WHERE id = 1").fetchone()
        return _phase2_from_row(updated)

    def heartbeat_phase2(
        self,
        *,
        ownership_token: str,
        lease_ms: int = DEFAULT_LEASE_MS,
    ) -> bool:
        """说明：当前持有者仍有效时续约第二阶段租约。"""
        now = now_ms()
        with self._get_conn() as conn:
            # 所有权 token 能防止旧任务在锁被别人接管后继续续约。
            cursor = conn.execute(
                """
                UPDATE phase2_jobs
                SET lease_expires = ?, updated_at = ?
                WHERE id = 1 AND status = ? AND ownership_token = ?
                """,
                (now + lease_ms, now, JOB_CLAIMED, ownership_token),
            )
        return cursor.rowcount == 1

    def mark_phase2_succeeded(
        self,
        *,
        completion_watermark: int | None = None,
        selected_source_ids: list[int] | tuple[int, ...] | None = None,
    ) -> None:
        """说明：标记全局第二阶段任务完成。"""
        now = now_ms()
        with self._get_conn() as conn:
            if selected_source_ids:
                placeholders = ",".join("?" for _ in selected_source_ids)
                conn.execute(
                    f"""
                    UPDATE stage1_outputs
                    SET selected_for_phase2 = 1
                    WHERE source_id IN ({placeholders})
                    """,
                    tuple(int(source_id) for source_id in selected_source_ids),
                )
            # 完成水位表示文件系统基线已覆盖到哪个第一阶段生成点。
            conn.execute(
                """
                UPDATE phase2_jobs
                SET status = ?, ownership_token = NULL, finished_at = ?,
                    lease_expires = NULL, completion_watermark = ?,
                    retry_after = NULL, last_error = NULL, updated_at = ?
                WHERE id = 1
                """,
                (JOB_SUCCEEDED, now, completion_watermark or now, now),
            )

    def mark_phase2_failed(
        self,
        *,
        error: str,
        retry_delay_ms: int = DEFAULT_RETRY_DELAY_MS,
    ) -> None:
        """说明：标记第二阶段失败，并设置重试退避。"""
        now = now_ms()
        with self._get_conn() as conn:
            conn.execute(
                """
                UPDATE phase2_jobs
                SET status = ?, ownership_token = NULL, finished_at = ?,
                    lease_expires = NULL, retry_after = ?, last_error = ?,
                    updated_at = ?
                WHERE id = 1
                """,
                (JOB_FAILED, now, now + retry_delay_ms, error[:4000], now),
            )

    def record_usage(self, *, file_path: str, usage_kind: str) -> None:
        """说明：记录 agent 使用了某个记忆文件。"""
        clean_path = file_path.strip()
        clean_kind = usage_kind.strip()
        if not clean_path:
            raise ValueError("file_path must not be empty")
        if not clean_kind:
            raise ValueError("usage_kind must not be empty")
        now = now_ms()
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO memory_usage (file_path, usage_kind, used_at)
                VALUES (?, ?, ?)
                """,
                (clean_path, clean_kind, now),
            )
            source_id = _source_id_from_path(clean_path)
            if source_id is not None:
                # rollout/fact/review 文件名携带 source_id，便于把真实读取反馈到聚合排序。
                conn.execute(
                    """
                    UPDATE stage1_outputs
                    SET usage_count = usage_count + 1,
                        last_usage = ?
                    WHERE source_id = ?
                    """,
                    (now, source_id),
                )

    def prune_stage1_outputs_for_retention(
        self,
        *,
        max_unused_days: int = DEFAULT_MAX_UNUSED_DAYS,
        batch_size: int = DEFAULT_PRUNE_BATCH_SIZE,
    ) -> int:
        """说明：删除长期未使用的第一阶段输出，并唤醒第二阶段清理文件索引。"""
        cutoff = now_ms() - max(0, int(max_unused_days)) * 86_400_000
        capped_batch = max(1, int(batch_size))
        with self._get_conn() as conn:
            rows = conn.execute(
                """
                SELECT source_id
                FROM stage1_outputs
                WHERE COALESCE(last_usage, generated_at) < ?
                ORDER BY COALESCE(last_usage, generated_at) ASC, source_id ASC
                LIMIT ?
                """,
                (cutoff, capped_batch),
            ).fetchall()
            source_ids = [int(row["source_id"]) for row in rows]
            if not source_ids:
                return 0
            placeholders = ",".join("?" for _ in source_ids)
            conn.execute(
                f"DELETE FROM stage1_outputs WHERE source_id IN ({placeholders})",
                tuple(source_ids),
            )
            conn.execute(
                f"""
                UPDATE stage1_jobs
                SET status = ?, ownership_token = NULL, finished_at = ?,
                    lease_expires = NULL, retry_after = NULL, last_error = NULL
                WHERE source_id IN ({placeholders})
                """,
                (JOB_SUCCEEDED_NO_OUTPUT, now_ms(), *source_ids),
            )
            self._queue_phase2(conn, now_ms())
        return len(source_ids)

    def get_phase2_job(self) -> Phase2Job:
        """说明：读取全局第二阶段任务行。"""
        with self._get_conn() as conn:
            row = conn.execute("SELECT * FROM phase2_jobs WHERE id = 1").fetchone()
        return _phase2_from_row(row)

    def queue_phase2(self) -> None:
        """说明：显式请求下一次第二阶段聚合，用于文件层变更后的重新整理。"""
        now = now_ms()
        with self._get_conn() as conn:
            self._queue_phase2(conn, now)

    def _stage1_job_for_source_id(self, conn: sqlite3.Connection, source_id: int) -> Stage1Job | None:
        row = conn.execute(
            """
            SELECT
                j.*,
                s.id AS src_id,
                s.source_type,
                s.source_ref,
                s.created_at AS src_created_at,
                s.updated_at AS src_updated_at
            FROM stage1_jobs j
            JOIN memory_sources s ON s.id = j.source_id
            WHERE j.source_id = ?
            """,
            (source_id,),
        ).fetchone()
        return _stage1_job_from_row(row) if row else None

    def _source_for_id(self, conn: sqlite3.Connection, source_id: int) -> MemorySource | None:
        row = conn.execute(
            "SELECT * FROM memory_sources WHERE id = ?",
            (source_id,),
        ).fetchone()
        return _source_from_row(row) if row else None

    def _mark_stage1_no_output(self, conn: sqlite3.Connection, source_id: int, timestamp_ms: int) -> None:
        # 显式删除旧输出；否则后续无输出抽取会让过期记忆继续存在。
        conn.execute("DELETE FROM stage1_outputs WHERE source_id = ?", (source_id,))
        conn.execute(
            """
            UPDATE stage1_jobs
            SET status = ?, ownership_token = NULL, finished_at = ?,
                lease_expires = NULL, retry_after = NULL, last_error = NULL
            WHERE source_id = ?
            """,
            (JOB_SUCCEEDED_NO_OUTPUT, timestamp_ms, source_id),
        )
        self._queue_phase2(conn, timestamp_ms)

    def _queue_phase2(self, conn: sqlite3.Connection, timestamp_ms: int) -> None:
        # 不抢正在运行的第二阶段持有者；如果聚合已在跑，要么会读到新输出，要么租约过期后重试。
        conn.execute(
            """
            INSERT INTO phase2_jobs (id, status, updated_at)
            VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                status = ?,
                retry_after = NULL,
                last_error = NULL,
                updated_at = excluded.updated_at
            WHERE phase2_jobs.status != ?
            """,
            (JOB_PENDING, timestamp_ms, JOB_PENDING, JOB_CLAIMED),
        )


def _validate_source_type(source_type: str) -> None:
    if source_type not in VALID_SOURCE_TYPES:
        raise ValueError(f"unsupported memory source_type: {source_type}")


def _source_from_row(row: sqlite3.Row) -> MemorySource:
    return MemorySource(
        id=int(row["id"]),
        source_type=str(row["source_type"]),
        source_ref=str(row["source_ref"]),
        created_at=int(row["created_at"]),
        updated_at=int(row["updated_at"]),
    )


def _source_from_joined_row(row: sqlite3.Row) -> MemorySource:
    return MemorySource(
        id=int(row["src_id"]),
        source_type=str(row["source_type"]),
        source_ref=str(row["source_ref"]),
        created_at=int(row["src_created_at"]),
        updated_at=int(row["src_updated_at"]),
    )


def _stage1_job_from_row(row: sqlite3.Row) -> Stage1Job:
    return Stage1Job(
        source_id=int(row["source_id"]),
        status=str(row["status"]),
        ownership_token=row["ownership_token"],
        claimed_at=_optional_int(row["claimed_at"]),
        finished_at=_optional_int(row["finished_at"]),
        lease_expires=_optional_int(row["lease_expires"]),
        retry_after=_optional_int(row["retry_after"]),
        last_error=row["last_error"],
        source=_source_from_joined_row(row),
    )


def _output_from_row(row: sqlite3.Row) -> Stage1Output:
    return Stage1Output(
        source_id=int(row["source_id"]),
        raw_memory=str(row["raw_memory"]),
        rollout_summary=str(row["rollout_summary"]),
        rollout_slug=row["rollout_slug"],
        source_updated_at=int(row["source_updated_at"]),
        generated_at=int(row["generated_at"]),
        usage_count=int(row["usage_count"]),
        last_usage=_optional_int(row["last_usage"]),
        selected_for_phase2=bool(row["selected_for_phase2"]),
        source=_source_from_joined_row(row),
    )


def _phase2_from_row(row: sqlite3.Row) -> Phase2Job:
    return Phase2Job(
        id=int(row["id"]),
        status=str(row["status"]),
        ownership_token=row["ownership_token"],
        claimed_at=_optional_int(row["claimed_at"]),
        finished_at=_optional_int(row["finished_at"]),
        lease_expires=_optional_int(row["lease_expires"]),
        completion_watermark=_optional_int(row["completion_watermark"]),
        retry_after=_optional_int(row["retry_after"]),
        last_error=row["last_error"],
        updated_at=int(row["updated_at"]),
    )


def _optional_int(value: object) -> int | None:
    return None if value is None else int(value)


def _job_runnable(row: sqlite3.Row, timestamp_ms: int) -> bool:
    status = str(row["status"])
    if status == JOB_PENDING:
        return True
    if status == JOB_FAILED and (row["retry_after"] is None or int(row["retry_after"]) <= timestamp_ms):
        return True
    if status == JOB_CLAIMED and row["lease_expires"] is not None and int(row["lease_expires"]) <= timestamp_ms:
        return True
    return False


def _clean_slug(value: str | None) -> str | None:
    if value is None:
        return None
    clean = "".join(char.lower() if char.isalnum() else "-" for char in value.strip())
    clean = "-".join(part for part in clean.split("-") if part)
    return clean[:80] or None


def _source_id_from_path(file_path: str) -> int | None:
    matched = _SOURCE_ID_IN_PATH_RE.search(file_path)
    if not matched:
        return None
    return int(matched.group("source_id"))
