"""文件用途：新闻条目的本地 SQLite 存储。"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from ..db import BaseStore, default_cache_dir, now_ms

from .types import NewsItem

DEFAULT_NEWS_FILENAME = "news.sqlite3"


def default_news_store_path() -> Path:
    """说明：返回默认的 news SQLite 路径。"""
    return default_cache_dir() / DEFAULT_NEWS_FILENAME


@dataclass(frozen=True)
class FetchCursor:
    """说明：一个新闻源的增量抓取游标。"""

    source: str
    etag: str | None
    last_modified: str | None


class NewsStore(BaseStore):
    """说明：SQLite 支撑的新闻条目与抓取游标存储。"""

    def __init__(self, path: str | Path | None = None) -> None:
        """说明：初始化存储路径。"""
        resolved = Path(path).expanduser() if path is not None else default_news_store_path()
        super().__init__(resolved)

    def _init_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS news_items (
                url TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                published_at_ms INTEGER NOT NULL,
                fetched_at_ms INTEGER NOT NULL,
                keywords_json TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_news_published ON news_items(published_at_ms DESC)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fetch_cursor (
                source TEXT PRIMARY KEY,
                etag TEXT,
                last_modified TEXT,
                updated_at_ms INTEGER NOT NULL
            )
            """
        )

    def upsert_items(self, items: Iterable[NewsItem]) -> list[NewsItem]:
        """说明：插入或更新条目，返回本次真正新增（URL 之前不存在）的条目。"""
        items_list = list(items)
        if not items_list:
            return []
        inserted: list[NewsItem] = []
        with self._get_conn() as connection:
            for item in items_list:
                row = connection.execute(
                    "SELECT url FROM news_items WHERE url = ?",
                    (item.url,),
                ).fetchone()
                keywords_json = json.dumps(list(item.keywords), ensure_ascii=False, separators=(",", ":"))
                if row is None:
                    connection.execute(
                        """
                        INSERT INTO news_items(url, source, title, summary, published_at_ms, fetched_at_ms, keywords_json)
                        VALUES(?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            item.url,
                            item.source,
                            item.title,
                            item.summary,
                            item.published_at_ms,
                            item.fetched_at_ms,
                            keywords_json,
                        ),
                    )
                    inserted.append(item)
                else:
                    connection.execute(
                        """
                        UPDATE news_items
                        SET source = ?, title = ?, summary = ?, published_at_ms = ?, keywords_json = ?
                        WHERE url = ?
                        """,
                        (
                            item.source,
                            item.title,
                            item.summary,
                            item.published_at_ms,
                            keywords_json,
                            item.url,
                        ),
                    )
            connection.commit()
        return inserted

    def recent(self, limit: int = 50, since_ms: int | None = None) -> list[NewsItem]:
        """说明：按发布时间倒序返回最近的新闻。"""
        limit = max(1, int(limit))
        with self._get_conn() as connection:
            if since_ms is None:
                rows = connection.execute(
                    """
                    SELECT url, source, title, summary, published_at_ms, fetched_at_ms, keywords_json
                    FROM news_items
                    ORDER BY published_at_ms DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT url, source, title, summary, published_at_ms, fetched_at_ms, keywords_json
                    FROM news_items
                    WHERE published_at_ms >= ?
                    ORDER BY published_at_ms DESC
                    LIMIT ?
                    """,
                    (int(since_ms), limit),
                ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def get_cursor(self, source: str) -> FetchCursor | None:
        """说明：读取某个源的抓取游标。"""
        with self._get_conn() as connection:
            row = connection.execute(
                "SELECT source, etag, last_modified FROM fetch_cursor WHERE source = ?",
                (source,),
            ).fetchone()
        if row is None:
            return None
        return FetchCursor(
            source=row["source"],
            etag=row["etag"],
            last_modified=row["last_modified"],
        )

    def set_cursor(self, source: str, etag: str | None, last_modified: str | None) -> None:
        """说明：写入或更新某个源的抓取游标。"""
        with self._get_conn() as connection:
            connection.execute(
                """
                INSERT INTO fetch_cursor(source, etag, last_modified, updated_at_ms)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(source) DO UPDATE SET
                    etag = excluded.etag,
                    last_modified = excluded.last_modified,
                    updated_at_ms = excluded.updated_at_ms
                """,
                (source, etag, last_modified, now_ms()),
            )
            connection.commit()

    def prune_older_than(self, cutoff_ms: int) -> int:
        """说明：清除早于 cutoff 的旧条目，返回删除数量。"""
        with self._get_conn() as connection:
            cursor = connection.execute(
                "DELETE FROM news_items WHERE published_at_ms < ?",
                (int(cutoff_ms),),
            )
            connection.commit()
            return cursor.rowcount or 0

    @staticmethod
    def _row_to_item(row: sqlite3.Row) -> NewsItem:
        """说明：把一行数据库记录还原成 NewsItem。"""
        try:
            keywords = tuple(json.loads(row["keywords_json"]) or ())
        except (TypeError, ValueError, json.JSONDecodeError):
            keywords = ()
        return NewsItem(
            url=row["url"],
            source=row["source"],
            title=row["title"],
            summary=row["summary"],
            published_at_ms=int(row["published_at_ms"]),
            fetched_at_ms=int(row["fetched_at_ms"]),
            keywords=keywords,
        )
