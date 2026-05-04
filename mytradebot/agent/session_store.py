"""文件用途：本地持久化 K-line agent 会话和消息历史。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
import json
import os
import sqlite3
import time
import uuid

DEFAULT_AGENT_SESSION_FILENAME = "agent_sessions.sqlite3"
DEFAULT_CACHE_SUBDIR = "mytradebot"


@dataclass(frozen=True)
class AgentSession:
    """说明：封装一个标的下的 Agent 会话元数据。"""

    id: str
    instrument_key: str
    title: str
    provider: str
    model: str
    created_at: str
    updated_at: str
    active: bool

    def to_payload(self) -> dict[str, Any]:
        """说明：转换成前端可消费的载荷。"""
        return {
            "id": self.id,
            "instrumentKey": self.instrument_key,
            "title": self.title,
            "provider": self.provider,
            "model": self.model,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "active": self.active,
        }


@dataclass(frozen=True)
class AgentMessage:
    """说明：封装一个会话中的用户或 assistant 消息。"""

    id: int
    session_id: str
    role: str
    content: str
    created_at: str
    analysis: dict[str, Any] | None = None
    context: dict[str, Any] | None = None
    error: str | None = None

    def to_payload(self, *, include_context: bool = False) -> dict[str, Any]:
        """说明：转换成前端可消费的载荷。"""
        payload = {
            "id": self.id,
            "sessionId": self.session_id,
            "role": self.role,
            "content": self.content,
            "createdAt": self.created_at,
            "analysis": self.analysis,
            "error": self.error,
        }
        if include_context:
            payload["context"] = self.context
        return payload


def default_agent_session_path() -> Path:
    """说明：返回本地默认 Agent session SQLite 路径。"""
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / DEFAULT_CACHE_SUBDIR / DEFAULT_AGENT_SESSION_FILENAME


class AgentSessionStore:
    """说明：SQLite-backed 的轻量 Agent 会话存储。"""

    def __init__(self, path: str | Path | None = None) -> None:
        """说明：初始化存储路径。"""
        self.path = Path(path).expanduser() if path is not None else default_agent_session_path()

    def _connect(self) -> sqlite3.Connection:
        """说明：打开 SQLite 连接并确保 schema 存在。"""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS agent_sessions (
                id TEXT PRIMARY KEY,
                instrument_key TEXT NOT NULL,
                title TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                active INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at REAL NOT NULL,
                analysis_json TEXT,
                context_json TEXT,
                error TEXT
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_agent_sessions_active
            ON agent_sessions (instrument_key, active, updated_at)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_agent_messages_session
            ON agent_messages (session_id, created_at, id)
            """
        )
        return connection

    def get_active_session(self, instrument_key: str) -> AgentSession | None:
        """说明：读取某个标的当前 active 的会话。"""
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM agent_sessions
                WHERE instrument_key = ? AND active = 1
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (instrument_key,),
            ).fetchone()
        return _session_from_row(row) if row else None

    def create_session(
        self,
        *,
        instrument_key: str,
        title: str,
        provider: str,
        model: str,
    ) -> AgentSession:
        """说明：创建一个新 active 会话，并停用同标的旧 active 会话。"""
        session_id = str(uuid.uuid4())
        now = time.time()
        clean_title = title.strip() or instrument_key
        with self._connect() as connection:
            connection.execute(
                "UPDATE agent_sessions SET active = 0 WHERE instrument_key = ? AND active = 1",
                (instrument_key,),
            )
            connection.execute(
                """
                INSERT INTO agent_sessions (
                    id, instrument_key, title, provider, model, created_at, updated_at, active
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (session_id, instrument_key, clean_title, provider, model, now, now),
            )
            row = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return _session_from_row(row)

    def get_or_create_active_session(
        self,
        *,
        instrument_key: str,
        title: str,
        provider: str,
        model: str,
    ) -> AgentSession:
        """说明：返回 active 会话，不存在时创建。"""
        session = self.get_active_session(instrument_key)
        if session is not None:
            if session.title != title or session.provider != provider or session.model != model:
                return self.update_session_metadata(
                    session.id,
                    title=title,
                    provider=provider,
                    model=model,
                )
            return session
        return self.create_session(
            instrument_key=instrument_key,
            title=title,
            provider=provider,
            model=model,
        )

    def update_session_metadata(
        self,
        session_id: str,
        *,
        title: str,
        provider: str,
        model: str,
    ) -> AgentSession:
        """说明：刷新 active 会话当前使用的 provider/model 展示元数据。"""
        clean_title = title.strip()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE agent_sessions
                SET title = ?, provider = ?, model = ?
                WHERE id = ?
                """,
                (clean_title, provider, model, session_id),
            )
            row = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            raise ValueError(f"agent session not found: {session_id}")
        return _session_from_row(row)

    def append_message(
        self,
        *,
        session_id: str,
        role: str,
        content: str,
        analysis: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> AgentMessage:
        """说明：追加一条会话消息并刷新会话更新时间。"""
        role_value = role.strip().lower()
        if role_value not in {"user", "assistant", "system"}:
            raise ValueError("agent message role must be user, assistant, or system")
        now = time.time()
        analysis_json = _json_dumps(analysis) if analysis is not None else None
        context_json = _json_dumps(context) if context is not None else None
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO agent_messages (
                    session_id, role, content, created_at, analysis_json, context_json, error
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (session_id, role_value, content, now, analysis_json, context_json, error),
            )
            connection.execute(
                "UPDATE agent_sessions SET updated_at = ? WHERE id = ?",
                (now, session_id),
            )
            row = connection.execute(
                "SELECT * FROM agent_messages WHERE id = ?",
                (cursor.lastrowid,),
            ).fetchone()
        return _message_from_row(row)

    def list_messages(self, session_id: str, *, limit: int | None = None) -> tuple[AgentMessage, ...]:
        """说明：按时间顺序读取某个会话的消息。"""
        with self._connect() as connection:
            if limit is None:
                rows = connection.execute(
                    """
                    SELECT *
                    FROM agent_messages
                    WHERE session_id = ?
                    ORDER BY created_at, id
                    """,
                    (session_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT *
                    FROM (
                        SELECT *
                        FROM agent_messages
                        WHERE session_id = ?
                        ORDER BY created_at DESC, id DESC
                        LIMIT ?
                    )
                    ORDER BY created_at, id
                    """,
                    (session_id, limit),
                ).fetchall()
        return tuple(_message_from_row(row) for row in rows)

    def active_session_payload(self, instrument_key: str) -> dict[str, Any] | None:
        """说明：返回某个标的 active 会话及其消息载荷。"""
        session = self.get_active_session(instrument_key)
        if session is None:
            return None
        return self.session_payload(session.id)

    def session_payload(self, session_id: str) -> dict[str, Any] | None:
        """说明：返回一个会话的完整轻量载荷。"""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            return None
        session = _session_from_row(row)
        messages = self.list_messages(session_id)
        return {
            "session": session.to_payload(),
            "messages": [message.to_payload() for message in messages],
        }

    def history_for_context(self, session_id: str, *, limit: int = 8) -> tuple[dict[str, Any], ...]:
        """说明：把最近消息压缩成可发送给 LLM 的会话上下文。"""
        messages = self.list_messages(session_id, limit=limit)
        history: list[dict[str, Any]] = []
        for message in messages:
            item: dict[str, Any] = {
                "role": message.role,
                "content": message.content,
                "created_at": message.created_at,
            }
            if message.analysis:
                item["analysis"] = {
                    "summary": message.analysis.get("summary"),
                    "bias": message.analysis.get("bias"),
                    "confidence": message.analysis.get("confidence"),
                    "invalidation": message.analysis.get("invalidation"),
                    "watch_plan": message.analysis.get("watchPlan") or message.analysis.get("watch_plan"),
                }
            if message.error:
                item["error"] = message.error
            history.append(item)
        return tuple(history)


def _session_from_row(row: sqlite3.Row) -> AgentSession:
    """说明：把 SQLite row 转成 AgentSession。"""
    return AgentSession(
        id=str(row["id"]),
        instrument_key=str(row["instrument_key"]),
        title=str(row["title"]),
        provider=str(row["provider"]),
        model=str(row["model"]),
        created_at=_iso_from_timestamp(float(row["created_at"])),
        updated_at=_iso_from_timestamp(float(row["updated_at"])),
        active=bool(row["active"]),
    )


def _message_from_row(row: sqlite3.Row) -> AgentMessage:
    """说明：把 SQLite row 转成 AgentMessage。"""
    return AgentMessage(
        id=int(row["id"]),
        session_id=str(row["session_id"]),
        role=str(row["role"]),
        content=str(row["content"]),
        created_at=_iso_from_timestamp(float(row["created_at"])),
        analysis=_json_loads(row["analysis_json"]),
        context=_json_loads(row["context_json"]),
        error=str(row["error"]) if row["error"] is not None else None,
    )


def _json_dumps(value: dict[str, Any]) -> str:
    """说明：稳定地序列化结构化字段。"""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_loads(value: Any) -> dict[str, Any] | None:
    """说明：读取结构化 JSON 字段，失败时返回 None。"""
    if not isinstance(value, str) or not value:
        return None
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _iso_from_timestamp(value: float) -> str:
    """说明：返回前端可读的 UTC ISO 字符串。"""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value))
