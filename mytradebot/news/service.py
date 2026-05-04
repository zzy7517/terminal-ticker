"""文件用途：新闻抓取服务，封装轮询、退避、手动刷新。"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Protocol

from .providers.reuters import FetchResult, ReutersSitemapProvider
from .store import NewsStore
from .types import NewsItem

LOGGER = logging.getLogger(__name__)


class NewsProvider(Protocol):
    """说明：抓取器协议。"""

    @property
    def source_name(self) -> str: ...

    async def fetch(
        self,
        *,
        etag: str | None = None,
        last_modified: str | None = None,
    ) -> FetchResult: ...


@dataclass(frozen=True)
class RefreshOutcome:
    """说明：一次 refresh 的结果摘要。"""

    status: str
    inserted: int
    total_recent: int
    error: str | None = None


class NewsService:
    """说明：驱动路透 sitemap 轮询、持久化并对外暴露查询接口。"""

    def __init__(
        self,
        *,
        store: NewsStore,
        provider: NewsProvider | None = None,
        poll_interval_seconds: int = 30,
        max_interval_seconds: int = 600,
        retention_days: int = 30,
        recent_limit: int = 50,
    ) -> None:
        """说明：组装存储、provider 与轮询参数。"""
        self.store = store
        self.provider = provider or ReutersSitemapProvider()
        self.base_interval = max(5, int(poll_interval_seconds))
        self.max_interval = max(self.base_interval, int(max_interval_seconds))
        self.retention_days = max(1, int(retention_days))
        self.recent_limit = max(1, int(recent_limit))
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._refresh_lock = asyncio.Lock()
        self._current_interval = float(self.base_interval)
        self._consecutive_failures = 0
        self.last_status: str = "idle"
        self.last_error: str | None = None
        self.last_fetched_at_ms: int | None = None

    async def start(self) -> None:
        """说明：启动后台轮询任务，并做一次启动清理。"""
        if self._task is not None:
            return
        self._stop_event.clear()
        self._prune_old_items()
        self._task = asyncio.create_task(self._run_loop(), name="news-poll")
        LOGGER.info(
            "NewsService started, polling %s every %ss",
            self.provider.source_name,
            self.base_interval,
        )

    async def stop(self) -> None:
        """说明：停止后台轮询任务。"""
        if self._task is None:
            return
        self._stop_event.set()
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        self._task = None

    async def refresh_now(self, timeout_seconds: float = 10.0) -> RefreshOutcome:
        """说明：阻塞式手动刷新，带锁防并发、带超时降级。"""
        async with self._refresh_lock:
            try:
                return await asyncio.wait_for(self._refresh_once(), timeout=timeout_seconds)
            except asyncio.TimeoutError:
                items = self.store.recent(limit=self.recent_limit)
                return RefreshOutcome(
                    status="timeout",
                    inserted=0,
                    total_recent=len(items),
                    error=f"refresh timed out after {timeout_seconds:.1f}s",
                )

    def recent(self, limit: int | None = None) -> list[NewsItem]:
        """说明：读取最近的新闻（按发布时间倒序）。"""
        resolved = self.recent_limit if limit is None else max(1, int(limit))
        return self.store.recent(limit=resolved)

    async def _run_loop(self) -> None:
        """说明：后台循环。"""
        try:
            while not self._stop_event.is_set():
                async with self._refresh_lock:
                    await self._refresh_once()
                try:
                    await asyncio.wait_for(
                        self._stop_event.wait(),
                        timeout=self._current_interval,
                    )
                except asyncio.TimeoutError:
                    continue
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            LOGGER.exception("news poll loop crashed")

    async def _refresh_once(self) -> RefreshOutcome:
        """说明：向 provider 请求一次并根据返回状态更新游标、退避。"""
        source = self.provider.source_name
        cursor = self.store.get_cursor(source)
        etag = cursor.etag if cursor else None
        last_modified = cursor.last_modified if cursor else None
        result = await self.provider.fetch(etag=etag, last_modified=last_modified)
        self.last_fetched_at_ms = int(time.time() * 1000)
        if result.status == "ok":
            inserted = self.store.upsert_items(result.items)
            self.store.set_cursor(source, result.etag, result.last_modified)
            self._reset_backoff()
            self.last_status = "ok"
            self.last_error = None
            if inserted:
                LOGGER.info("news: fetched %d new items from %s", len(inserted), source)
            return RefreshOutcome(
                status="ok",
                inserted=len(inserted),
                total_recent=len(self.store.recent(limit=self.recent_limit)),
            )
        if result.status == "not_modified":
            if result.etag or result.last_modified:
                self.store.set_cursor(source, result.etag or etag, result.last_modified or last_modified)
            self._reset_backoff()
            self.last_status = "not_modified"
            self.last_error = None
            return RefreshOutcome(
                status="not_modified",
                inserted=0,
                total_recent=len(self.store.recent(limit=self.recent_limit)),
            )
        if result.status == "rate_limited":
            self._apply_backoff()
            self.last_status = "rate_limited"
            self.last_error = result.error
            LOGGER.warning("news: rate limited (%s), next interval %ss", result.error, self._current_interval)
            return RefreshOutcome(
                status="rate_limited",
                inserted=0,
                total_recent=len(self.store.recent(limit=self.recent_limit)),
                error=result.error,
            )
        self._apply_backoff()
        self.last_status = "error"
        self.last_error = result.error
        LOGGER.warning("news: fetch error (%s), next interval %ss", result.error, self._current_interval)
        return RefreshOutcome(
            status="error",
            inserted=0,
            total_recent=len(self.store.recent(limit=self.recent_limit)),
            error=result.error,
        )

    def _reset_backoff(self) -> None:
        """说明：成功后重置轮询间隔。"""
        self._current_interval = float(self.base_interval)
        self._consecutive_failures = 0

    def _apply_backoff(self) -> None:
        """说明：失败后指数拉长轮询间隔。"""
        self._consecutive_failures += 1
        self._current_interval = min(
            self._current_interval * 2 if self._current_interval else float(self.base_interval),
            float(self.max_interval),
        )

    def _prune_old_items(self) -> None:
        """说明：启动时清理超出保留期的旧条目。"""
        cutoff_ms = int(time.time() * 1000) - self.retention_days * 86_400_000
        try:
            removed = self.store.prune_older_than(cutoff_ms)
        except Exception:  # noqa: BLE001
            LOGGER.exception("news: prune failed")
            return
        if removed:
            LOGGER.info("news: pruned %d old items", removed)
