"""文件用途：社交信息流刷新服务，封装 X Following 拉取与本地缓存。"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Callable

from .providers import XInternalClient
from .store import SocialFeedStore
from .types import SocialFeedItem

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class SocialFeedRefreshOutcome:
    """说明：一次社交流刷新结果摘要。"""

    status: str
    inserted: int
    total_recent: int
    error: str | None = None


class SocialFeedService:
    """说明：低频读取 X Following，并把结果写入本地 SQLite。"""

    def __init__(
        self,
        *,
        store: SocialFeedStore,
        client_factory: Callable[[], XInternalClient] | None = None,
        recent_limit: int = 100,
        retention_days: int = 30,
        max_items: int = 2000,
    ) -> None:
        self.store = store
        self.client_factory = client_factory or XInternalClient.from_env
        self.recent_limit = max(1, int(recent_limit))
        self.retention_days = max(1, int(retention_days))
        self.max_items = max(100, int(max_items))
        self._refresh_lock = asyncio.Lock()
        self.last_status: str = "idle"
        self.last_error: str | None = None
        self.last_fetched_at_ms: int | None = None

    async def refresh_x_following(self, *, count: int = 20) -> SocialFeedRefreshOutcome:
        """手动触发一次 X Following 刷新。"""
        async with self._refresh_lock:
            return await asyncio.to_thread(self._refresh_x_following_sync, count)

    def recent_items(
        self,
        *,
        limit: int | None = None,
        since_ms: int | None = None,
        query: str | None = None,
    ) -> list[SocialFeedItem]:
        resolved = self.recent_limit if limit is None else max(1, int(limit))
        return self.store.recent_items(limit=resolved, since_ms=since_ms, query=query)

    def _refresh_x_following_sync(self, count: int) -> SocialFeedRefreshOutcome:
        resolved_count = max(1, min(int(count), 200))
        try:
            client = self.client_factory()
            items = client.fetch_following_feed(count=resolved_count)
            if isinstance(items, tuple):
                items = items[0]
            inserted = self.store.upsert_items(items)
            cutoff_ms = int(time.time() * 1000) - self.retention_days * 86_400_000
            self.store.prune_items_older_than(cutoff_ms)
            self.store.trim_items(max_items=self.max_items)
            self.last_status = "ok"
            self.last_error = None
            self.last_fetched_at_ms = max(
                (item.fetched_at_ms for item in items),
                default=self.last_fetched_at_ms or 0,
            )
            if inserted:
                LOGGER.info("social feed: fetched %d new X items", len(inserted))
            return SocialFeedRefreshOutcome(
                status="ok",
                inserted=len(inserted),
                total_recent=len(self.store.recent_items(limit=self.recent_limit)),
            )
        except Exception as exc:  # noqa: BLE001
            self.last_status = "error"
            self.last_error = str(exc) or exc.__class__.__name__
            LOGGER.warning("social feed: X following refresh failed: %s", self.last_error)
            return SocialFeedRefreshOutcome(
                status="error",
                inserted=0,
                total_recent=len(self.store.recent_items(limit=self.recent_limit)),
                error=self.last_error,
            )
