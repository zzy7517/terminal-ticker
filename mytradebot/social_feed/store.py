"""文件用途：社交信息流与记忆的本地 SQLite 存储。"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .types import SocialAuthor, SocialFeedItem, SocialMetrics

DEFAULT_CACHE_SUBDIR = "mytradebot"
DEFAULT_SOCIAL_FEED_FILENAME = "social_feed.sqlite3"


def default_social_feed_store_path() -> Path:
    """说明：返回默认 social feed SQLite 路径。"""
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / DEFAULT_CACHE_SUBDIR / DEFAULT_SOCIAL_FEED_FILENAME


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class SocialFeedMemory:
    """说明：由 agent 或用户沉淀的一条社交流记忆。"""

    id: int
    text: str
    source: str | None
    external_id: str | None
    tags: tuple[str, ...]
    importance: int
    created_at_ms: int

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "source": self.source,
            "externalId": self.external_id,
            "tags": list(self.tags),
            "importance": self.importance,
            "createdAtMs": self.created_at_ms,
        }


class SocialFeedStore:
    """说明：SQLite 支撑的社交流缓存与记忆存储。"""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path).expanduser() if path is not None else default_social_feed_store_path()

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        self._ensure_schema(connection)
        return connection

    def _ensure_schema(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS social_feed_items (
                source TEXT NOT NULL,
                external_id TEXT NOT NULL,
                url TEXT NOT NULL,
                author_id TEXT NOT NULL,
                author_name TEXT NOT NULL,
                author_handle TEXT NOT NULL,
                author_profile_image_url TEXT NOT NULL,
                author_verified INTEGER NOT NULL,
                text TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                fetched_at_ms INTEGER NOT NULL,
                metrics_json TEXT NOT NULL,
                urls_json TEXT NOT NULL,
                lang TEXT NOT NULL,
                is_repost INTEGER NOT NULL,
                reposted_by TEXT,
                quoted_json TEXT,
                raw_json TEXT NOT NULL,
                PRIMARY KEY(source, external_id)
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_social_feed_created
            ON social_feed_items(created_at_ms DESC)
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS social_memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT,
                external_id TEXT,
                text TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                importance INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_social_memories_created
            ON social_memories(created_at_ms DESC)
            """
        )
        connection.commit()

    def upsert_items(self, items: Iterable[SocialFeedItem]) -> list[SocialFeedItem]:
        """插入或更新条目，返回本次真正新增的内容。"""
        items_list = [item for item in items if item.external_id]
        if not items_list:
            return []
        inserted: list[SocialFeedItem] = []
        with self._connect() as connection:
            for item in items_list:
                exists = connection.execute(
                    """
                    SELECT 1 FROM social_feed_items
                    WHERE source = ? AND external_id = ?
                    """,
                    (item.source, item.external_id),
                ).fetchone()
                payload = self._item_db_values(item)
                if exists is None:
                    connection.execute(
                        """
                        INSERT INTO social_feed_items(
                            source, external_id, url,
                            author_id, author_name, author_handle,
                            author_profile_image_url, author_verified,
                            text, created_at_ms, fetched_at_ms,
                            metrics_json, urls_json, lang,
                            is_repost, reposted_by, quoted_json, raw_json
                        )
                        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        payload,
                    )
                    inserted.append(item)
                else:
                    connection.execute(
                        """
                        UPDATE social_feed_items
                        SET url = ?, author_id = ?, author_name = ?, author_handle = ?,
                            author_profile_image_url = ?, author_verified = ?, text = ?,
                            created_at_ms = ?, fetched_at_ms = ?, metrics_json = ?,
                            urls_json = ?, lang = ?, is_repost = ?, reposted_by = ?,
                            quoted_json = ?, raw_json = ?
                        WHERE source = ? AND external_id = ?
                        """,
                        (
                            payload[2],
                            payload[3],
                            payload[4],
                            payload[5],
                            payload[6],
                            payload[7],
                            payload[8],
                            payload[9],
                            payload[10],
                            payload[11],
                            payload[12],
                            payload[13],
                            payload[14],
                            payload[15],
                            payload[16],
                            payload[17],
                            item.source,
                            item.external_id,
                        ),
                    )
            connection.commit()
        return inserted

    def recent_items(
        self,
        *,
        limit: int = 50,
        since_ms: int | None = None,
        query: str | None = None,
    ) -> list[SocialFeedItem]:
        """按发布时间倒序读取本地缓存。"""
        resolved_limit = max(1, min(int(limit), 200))
        where_parts: list[str] = []
        params: list[Any] = []
        if since_ms is not None:
            where_parts.append("created_at_ms >= ?")
            params.append(int(since_ms))
        text_query = (query or "").strip()
        if text_query:
            # FTS MATCH 不支持任意未转义输入，这里用 LIKE 保守过滤。
            where_parts.append("(text LIKE ? OR author_handle LIKE ? OR author_name LIKE ?)")
            like = f"%{text_query}%"
            params.extend([like, like, like])
        where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT *
                FROM social_feed_items
                {where_sql}
                ORDER BY created_at_ms DESC
                LIMIT ?
                """,
                (*params, resolved_limit),
            ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def get_item(self, *, source: str, external_id: str) -> SocialFeedItem | None:
        """按来源和外部 ID 读取单条社交内容。"""
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM social_feed_items
                WHERE source = ? AND external_id = ?
                """,
                (source, external_id),
            ).fetchone()
        return self._row_to_item(row) if row is not None else None

    def prune_items_older_than(self, cutoff_ms: int) -> int:
        """清理早于 cutoff 的社交流条目。"""
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM social_feed_items WHERE created_at_ms < ?",
                (int(cutoff_ms),),
            )
            connection.commit()
            return cursor.rowcount or 0

    def trim_items(self, *, max_items: int) -> int:
        """只保留最新 max_items 条社交流缓存。"""
        resolved_max = max(1, int(max_items))
        with self._connect() as connection:
            cursor = connection.execute(
                """
                DELETE FROM social_feed_items
                WHERE (source, external_id) NOT IN (
                    SELECT source, external_id
                    FROM social_feed_items
                    ORDER BY created_at_ms DESC
                    LIMIT ?
                )
                """,
                (resolved_max,),
            )
            connection.commit()
            return cursor.rowcount or 0

    def recent_memories(
        self,
        *,
        limit: int = 50,
        tag: str | None = None,
    ) -> list[SocialFeedMemory]:
        """按创建时间倒序读取记忆。"""
        resolved_limit = max(1, min(int(limit), 200))
        with self._connect() as connection:
            if tag:
                rows = connection.execute(
                    """
                    SELECT *
                    FROM social_memories
                    WHERE tags_json LIKE ?
                    ORDER BY created_at_ms DESC
                    LIMIT ?
                    """,
                    (f"%{tag}%", resolved_limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT *
                    FROM social_memories
                    ORDER BY created_at_ms DESC
                    LIMIT ?
                    """,
                    (resolved_limit,),
                ).fetchall()
        return [self._row_to_memory(row) for row in rows]

    @staticmethod
    def _item_db_values(item: SocialFeedItem) -> tuple[Any, ...]:
        return (
            item.source,
            item.external_id,
            item.url,
            item.author.id,
            item.author.name,
            item.author.handle,
            item.author.profile_image_url,
            1 if item.author.verified else 0,
            item.text,
            int(item.created_at_ms),
            int(item.fetched_at_ms),
            json.dumps(item.metrics.to_payload(), ensure_ascii=False, separators=(",", ":")),
            json.dumps(list(item.urls), ensure_ascii=False, separators=(",", ":")),
            item.lang,
            1 if item.is_repost else 0,
            item.reposted_by,
            json.dumps(
                item.quoted_item.to_payload(include_raw=False) if item.quoted_item else None,
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            json.dumps(item.raw, ensure_ascii=False, separators=(",", ":")),
        )

    @staticmethod
    def _row_to_item(row: sqlite3.Row) -> SocialFeedItem:
        try:
            metrics_raw = json.loads(row["metrics_json"])
        except (TypeError, ValueError, json.JSONDecodeError):
            metrics_raw = {}
        try:
            urls = tuple(json.loads(row["urls_json"]) or ())
        except (TypeError, ValueError, json.JSONDecodeError):
            urls = ()
        try:
            raw = json.loads(row["raw_json"]) or {}
        except (TypeError, ValueError, json.JSONDecodeError):
            raw = {}
        return SocialFeedItem(
            source=row["source"],
            external_id=row["external_id"],
            url=row["url"],
            author=SocialAuthor(
                id=row["author_id"],
                name=row["author_name"],
                handle=row["author_handle"],
                profile_image_url=row["author_profile_image_url"],
                verified=bool(row["author_verified"]),
            ),
            text=row["text"],
            created_at_ms=int(row["created_at_ms"]),
            fetched_at_ms=int(row["fetched_at_ms"]),
            metrics=SocialMetrics(
                likes=int(metrics_raw.get("likes") or 0),
                reposts=int(metrics_raw.get("reposts") or 0),
                replies=int(metrics_raw.get("replies") or 0),
                quotes=int(metrics_raw.get("quotes") or 0),
                views=int(metrics_raw.get("views") or 0),
                bookmarks=int(metrics_raw.get("bookmarks") or 0),
            ),
            urls=urls,
            lang=row["lang"],
            is_repost=bool(row["is_repost"]),
            reposted_by=row["reposted_by"],
            raw=raw,
        )

    @staticmethod
    def _row_to_memory(row: sqlite3.Row) -> SocialFeedMemory:
        try:
            tags = tuple(json.loads(row["tags_json"]) or ())
        except (TypeError, ValueError, json.JSONDecodeError):
            tags = ()
        return SocialFeedMemory(
            id=int(row["id"]),
            text=row["text"],
            source=row["source"],
            external_id=row["external_id"],
            tags=tags,
            importance=int(row["importance"]),
            created_at_ms=int(row["created_at_ms"]),
        )
