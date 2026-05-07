"""文件用途：本地持久化 K-line agent 会话和消息历史。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
import sqlite3
import time
import uuid

from ..db import BaseStore, default_cache_dir, json_dumps, json_loads

DEFAULT_AGENT_SESSION_FILENAME = "agent_sessions.sqlite3"
_GLOBAL_SESSION_INSTRUMENT_KEY = ""
_LIST_SESSIONS_SQL = """
    SELECT
        s.*,
        COUNT(m.id) AS message_count,
        COALESCE(
            (
                SELECT SUBSTR(REPLACE(REPLACE(m1.content, X'0A', ' '), X'0D', ' '), 1, 120)
                FROM agent_messages m1
                WHERE m1.session_id = s.id AND m1.role = 'user'
                ORDER BY m1.created_at, m1.id
                LIMIT 1
            ),
            ''
        ) AS preview
    FROM agent_sessions s
    LEFT JOIN agent_messages m ON m.session_id = s.id
    {where}
    GROUP BY s.id
    ORDER BY s.updated_at DESC, s.created_at DESC
    LIMIT ?
"""


@dataclass(frozen=True)
class AgentSession:
    """说明：封装一个本地 Agent 会话元数据。"""

    id: str
    instrument_key: str | None
    title: str
    provider: str
    model: str
    created_at: str
    updated_at: str
    active: bool
    api_mode: str | None = None
    reasoning_effort: str | None = None

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
            "apiMode": self.api_mode,
            "reasoningEffort": self.reasoning_effort,
        }


@dataclass(frozen=True)
class AgentSessionSummary:
    """说明：封装会话历史列表中的一行摘要。"""

    session: AgentSession
    message_count: int
    preview: str

    def to_payload(self) -> dict[str, Any]:
        """说明：转换成前端历史列表载荷。"""
        return {
            **self.session.to_payload(),
            "messageCount": self.message_count,
            "preview": self.preview,
        }


@dataclass(frozen=True)
class AgentMessage:
    """说明：封装一个会话中的 transcript 消息。"""

    id: int
    session_id: str
    role: str
    content: str
    created_at: str
    metadata: dict[str, Any] | None = None
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
            "metadata": self.metadata,
            "error": self.error,
        }
        if include_context:
            payload["context"] = self.context
        return payload


def default_agent_session_path() -> Path:
    """说明：返回本地默认 Agent session SQLite 路径。"""
    return default_cache_dir() / DEFAULT_AGENT_SESSION_FILENAME


class AgentSessionStore(BaseStore):
    """说明：SQLite-backed 的轻量 Agent 会话存储。"""

    def __init__(self, path: str | Path | None = None) -> None:
        """说明：初始化存储路径。"""
        resolved = Path(path).expanduser() if path is not None else default_agent_session_path()
        super().__init__(resolved)

    def _init_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS agent_sessions (
                id TEXT PRIMARY KEY,
                instrument_key TEXT,
                title TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                active INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        _ensure_agent_session_columns(conn)
        conn.execute(
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
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_agent_sessions_active
            ON agent_sessions (instrument_key, active, updated_at)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_agent_messages_session
            ON agent_messages (session_id, created_at, id)
            """
        )

    def get_active_session(self, instrument_key: str) -> AgentSession | None:
        """说明：读取某个标的当前 active 的会话。"""
        stored_key = _stored_instrument_key(instrument_key)
        with self._get_conn() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM agent_sessions
                WHERE instrument_key = ? AND active = 1
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (stored_key,),
            ).fetchone()
        return _session_from_row(row) if row else None

    def get_session(self, session_id: str) -> AgentSession | None:
        """说明：按 id 读取 session 元数据。"""
        with self._get_conn() as connection:
            row = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return _session_from_row(row) if row else None

    def create_session(
        self,
        *,
        instrument_key: str | None = None,
        title: str,
        provider: str,
        model: str,
        api_mode: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AgentSession:
        """说明：创建一个新 active 会话，并停用同作用域旧 active 会话。"""
        session_id = str(uuid.uuid4())
        now = time.time()
        stored_key = _stored_instrument_key(instrument_key)
        clean_title = title.strip() or (instrument_key or "New Agent Session")
        with self._get_conn() as connection:
            connection.execute(
                "UPDATE agent_sessions SET active = 0 WHERE instrument_key = ? AND active = 1",
                (stored_key,),
            )
            connection.execute(
                """
                INSERT INTO agent_sessions (
                    id, instrument_key, title, provider, model, created_at, updated_at, active,
                    api_mode, reasoning_effort
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    session_id,
                    stored_key,
                    clean_title,
                    provider,
                    model,
                    now,
                    now,
                    api_mode,
                    reasoning_effort,
                ),
            )
            row = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return _session_from_row(row)

    def create_global_session(
        self,
        *,
        title: str,
        provider: str,
        model: str,
        api_mode: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AgentSession:
        """说明：创建一个不绑定标的的全局 Agent 会话。"""
        return self.create_session(
            instrument_key=None,
            title=title,
            provider=provider,
            model=model,
            api_mode=api_mode,
            reasoning_effort=reasoning_effort,
        )

    def get_or_create_active_session(
        self,
        *,
        instrument_key: str,
        title: str,
        provider: str,
        model: str,
        api_mode: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AgentSession:
        """说明：返回 active 会话，不存在时创建。"""
        session = self.get_active_session(instrument_key)
        if session is not None:
            if (
                session.title != title
                or session.provider != provider
                or session.model != model
                or session.api_mode != api_mode
                or session.reasoning_effort != reasoning_effort
            ):
                return self.update_session_metadata(
                    session.id,
                    title=title,
                    provider=provider,
                    model=model,
                    api_mode=api_mode,
                    reasoning_effort=reasoning_effort,
                )
            return session
        return self.create_session(
            instrument_key=instrument_key,
            title=title,
            provider=provider,
            model=model,
            api_mode=api_mode,
            reasoning_effort=reasoning_effort,
        )

    def update_session_metadata(
        self,
        session_id: str,
        *,
        title: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        api_mode: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AgentSession:
        """说明：刷新 active 会话当前使用的 provider/model 展示元数据。"""
        with self._get_conn() as connection:
            existing = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if existing is None:
                raise ValueError(f"agent session not found: {session_id}")
            clean_title = (title.strip() if title is not None else str(existing["title"]).strip())
            connection.execute(
                """
                UPDATE agent_sessions
                SET title = ?,
                    provider = ?,
                    model = ?,
                    api_mode = ?,
                    reasoning_effort = ?
                WHERE id = ?
                """,
                (
                    clean_title,
                    provider if provider is not None else str(existing["provider"]),
                    model if model is not None else str(existing["model"]),
                    api_mode if api_mode is not None else _optional_str(existing["api_mode"]),
                    (
                        reasoning_effort
                        if reasoning_effort is not None
                        else _optional_str(existing["reasoning_effort"])
                    ),
                    session_id,
                ),
            )
            row = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return _session_from_row(row)

    def rename_session(self, session_id: str, title: str) -> AgentSession:
        """说明：只更新会话标题。"""
        return self.update_session_metadata(session_id, title=title)

    def append_message(
        self,
        *,
        session_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> AgentMessage:
        """说明：追加一条会话消息并刷新会话更新时间。"""
        role_value = role.strip().lower()
        if role_value == "toolresult":
            role_value = "toolResult"
        if role_value not in {"user", "assistant", "system", "toolResult"}:
            raise ValueError("agent message role must be user, assistant, system, or toolResult")
        now = time.time()
        metadata_json = json_dumps(metadata) if metadata is not None else None
        context_json = json_dumps(context) if context is not None else None
        with self._get_conn() as connection:
            cursor = connection.execute(
                """
                INSERT INTO agent_messages (
                    session_id, role, content, created_at, analysis_json, context_json, error
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (session_id, role_value, content, now, metadata_json, context_json, error),
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
        with self._get_conn() as connection:
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
        with self._get_conn() as connection:
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

    def session_payloads(self, session_ids: tuple[str, ...] | list[str]) -> tuple[dict[str, Any], ...]:
        """说明：批量返回多个会话的完整轻量载荷，并保持输入顺序。"""
        ordered_ids = [str(session_id) for session_id in session_ids if str(session_id)]
        if not ordered_ids:
            return tuple()
        unique_ids = tuple(dict.fromkeys(ordered_ids))
        placeholders = ",".join("?" for _ in unique_ids)
        with self._get_conn() as connection:
            session_rows = connection.execute(
                f"SELECT * FROM agent_sessions WHERE id IN ({placeholders})",
                unique_ids,
            ).fetchall()
            message_rows = connection.execute(
                f"""
                SELECT *
                FROM agent_messages
                WHERE session_id IN ({placeholders})
                ORDER BY session_id, created_at, id
                """,
                unique_ids,
            ).fetchall()
        sessions_by_id = {
            str(row["id"]): _session_from_row(row)
            for row in session_rows
        }
        messages_by_id: dict[str, list[dict[str, Any]]] = {session_id: [] for session_id in unique_ids}
        for row in message_rows:
            messages_by_id.setdefault(str(row["session_id"]), []).append(
                _message_from_row(row).to_payload()
            )
        payloads_by_id = {
            session_id: {
                "session": session.to_payload(),
                "messages": messages_by_id.get(session_id, []),
            }
            for session_id, session in sessions_by_id.items()
        }
        return tuple(
            payloads_by_id[session_id]
            for session_id in ordered_ids
            if session_id in payloads_by_id
        )

    def list_sessions(
        self,
        instrument_key: str | None = None,
        *,
        limit: int = 20,
    ) -> tuple[AgentSessionSummary, ...]:
        """说明：按更新时间倒序列出历史会话摘要；instrument_key 为 None 时列出全局历史。"""
        clean_limit = max(1, min(int(limit), 100))
        with self._get_conn() as connection:
            if instrument_key is None:
                rows = connection.execute(
                    _LIST_SESSIONS_SQL.replace("{where}", ""),
                    (clean_limit,),
                ).fetchall()
            else:
                rows = connection.execute(
                    _LIST_SESSIONS_SQL.replace("{where}", "WHERE s.instrument_key = ?"),
                    (_stored_instrument_key(instrument_key), clean_limit),
                ).fetchall()
        return tuple(
            AgentSessionSummary(
                session=_session_from_row(row),
                message_count=int(row["message_count"]),
                preview=str(row["preview"] or "").strip(),
            )
            for row in rows
        )

    def list_all_sessions(self, *, limit: int = 100) -> tuple[AgentSessionSummary, ...]:
        """说明：列出所有 Agent 会话，供解耦后的历史侧栏使用。"""
        return self.list_sessions(None, limit=limit)

    def activate_session(self, *, instrument_key: str, session_id: str) -> AgentSession:
        """说明：把指定历史会话恢复为某标的的 active 会话。"""
        stored_key = _stored_instrument_key(instrument_key)
        with self._get_conn() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM agent_sessions
                WHERE id = ? AND instrument_key = ?
                """,
                (session_id, stored_key),
            ).fetchone()
            if row is None:
                raise ValueError(f"agent session not found: {session_id}")
            connection.execute(
                "UPDATE agent_sessions SET active = 0 WHERE instrument_key = ? AND active = 1",
                (stored_key,),
            )
            connection.execute(
                "UPDATE agent_sessions SET active = 1 WHERE id = ?",
                (session_id,),
            )
            refreshed = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return _session_from_row(refreshed)

    def activate_session_by_id(self, session_id: str) -> AgentSession:
        """说明：把任意 session 标记为其作用域下的 active 会话。"""
        with self._get_conn() as connection:
            row = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if row is None:
                raise ValueError(f"agent session not found: {session_id}")
            stored_key = _stored_instrument_key(_optional_str(row["instrument_key"]))
            connection.execute(
                "UPDATE agent_sessions SET active = 0 WHERE instrument_key = ? AND active = 1",
                (stored_key,),
            )
            connection.execute(
                "UPDATE agent_sessions SET active = 1 WHERE id = ?",
                (session_id,),
            )
            refreshed = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return _session_from_row(refreshed)

    def delete_session(self, *, instrument_key: str, session_id: str) -> AgentSession | None:
        """说明：删除指定历史会话，并保证此后该标的恰好剩一个 active 会话（若仍有剩余）。"""
        stored_key = _stored_instrument_key(instrument_key)
        with self._get_conn() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM agent_sessions
                WHERE id = ? AND instrument_key = ?
                """,
                (session_id, stored_key),
            ).fetchone()
            if row is None:
                raise ValueError(f"agent session not found: {session_id}")
            connection.execute("DELETE FROM agent_sessions WHERE id = ?", (session_id,))
            next_row = connection.execute(
                """
                SELECT *
                FROM agent_sessions
                WHERE instrument_key = ?
                ORDER BY active DESC, updated_at DESC, created_at DESC
                LIMIT 1
                """,
                (stored_key,),
            ).fetchone()
            if next_row is None:
                return None
            if not bool(next_row["active"]):
                connection.execute(
                    "UPDATE agent_sessions SET active = 1 WHERE id = ?",
                    (next_row["id"],),
                )
                next_row = connection.execute(
                    "SELECT * FROM agent_sessions WHERE id = ?",
                    (next_row["id"],),
                ).fetchone()
        return _session_from_row(next_row)

    def delete_session_by_id(self, session_id: str) -> bool:
        """说明：按 session id 删除会话。"""
        with self._get_conn() as connection:
            row = connection.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if row is None:
                raise ValueError(f"agent session not found: {session_id}")
            connection.execute("DELETE FROM agent_sessions WHERE id = ?", (session_id,))
        return True

    def history_for_context(self, session_id: str, *, limit: int = 8) -> tuple[dict[str, Any], ...]:
        """说明：把最近消息压缩成可发送给 LLM 的会话上下文。"""
        messages = self.list_messages(session_id, limit=limit)
        history: list[dict[str, Any]] = []
        for message in messages:
            if message.role == "toolResult":
                metadata = message.metadata or {}
                history.append({
                    "role": "tool",
                    "tool_call_id": str(metadata.get("toolCallId") or ""),
                    "content": message.content,
                })
                continue
            item: dict[str, Any] = {
                "role": message.role,
                "content": message.content,
                "created_at": message.created_at,
            }
            tool_calls = (message.metadata or {}).get("toolCalls")
            if message.role == "assistant" and isinstance(tool_calls, list) and tool_calls:
                item["tool_calls"] = [
                    {
                        "id": str(call.get("id") or ""),
                        "type": "function",
                        "function": {
                            "name": str(call.get("name") or ""),
                            "arguments": json_dumps(call.get("arguments") or {}),
                        },
                    }
                    for call in tool_calls
                    if isinstance(call, dict)
                ]
            if message.error:
                item["error"] = message.error
            history.append(item)
        return tuple(history)


def _session_from_row(row: sqlite3.Row) -> AgentSession:
    """说明：把 SQLite row 转成 AgentSession。"""
    return AgentSession(
        id=str(row["id"]),
        instrument_key=_optional_str(row["instrument_key"]),
        title=str(row["title"]),
        provider=str(row["provider"]),
        model=str(row["model"]),
        created_at=_iso_from_timestamp(float(row["created_at"])),
        updated_at=_iso_from_timestamp(float(row["updated_at"])),
        active=bool(row["active"]),
        api_mode=_optional_str(row["api_mode"]),
        reasoning_effort=_optional_str(row["reasoning_effort"]),
    )


def _message_from_row(row: sqlite3.Row) -> AgentMessage:
    """说明：把 SQLite row 转成 AgentMessage。"""
    return AgentMessage(
        id=int(row["id"]),
        session_id=str(row["session_id"]),
        role=str(row["role"]),
        content=str(row["content"]),
        created_at=_iso_from_timestamp(float(row["created_at"])),
        metadata=json_loads(row["analysis_json"]),
        context=json_loads(row["context_json"]),
        error=str(row["error"]) if row["error"] is not None else None,
    )



def _iso_from_timestamp(value: float) -> str:
    """说明：返回前端可读的 UTC ISO 字符串。"""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value))


def _ensure_agent_session_columns(connection: sqlite3.Connection) -> None:
    """说明：为旧版本地 SQLite 增补会话配置快照字段。"""
    rows = connection.execute("PRAGMA table_info(agent_sessions)").fetchall()
    columns = {str(row["name"]) for row in rows}
    migrations = {
        "api_mode": "ALTER TABLE agent_sessions ADD COLUMN api_mode TEXT",
        "reasoning_effort": "ALTER TABLE agent_sessions ADD COLUMN reasoning_effort TEXT",
    }
    for column, statement in migrations.items():
        if column not in columns:
            connection.execute(statement)


def _stored_instrument_key(instrument_key: str | None) -> str:
    """说明：SQLite 兼容层；空字符串表示新设计下不绑定标的的全局 session。"""
    return (instrument_key or _GLOBAL_SESSION_INSTRUMENT_KEY).strip()


def _optional_str(value: Any) -> str | None:
    """说明：把可空 SQLite 值转成字符串。"""
    return str(value) if value not in (None, "") else None
