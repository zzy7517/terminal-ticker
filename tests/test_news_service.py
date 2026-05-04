"""Test NewsService polling and refresh orchestration."""
import asyncio
import tempfile
import unittest
from pathlib import Path
from typing import Iterable

from mytradebot.news import NewsItem, NewsService, NewsStore
from mytradebot.news.providers.reuters import FetchResult


class FakeProvider:
    source_name = "reuters"

    def __init__(self, responses: Iterable[FetchResult]) -> None:
        self._responses = list(responses)
        self.calls: list[tuple[str | None, str | None]] = []

    async def fetch(self, *, etag: str | None = None, last_modified: str | None = None) -> FetchResult:
        self.calls.append((etag, last_modified))
        if self._responses:
            return self._responses.pop(0)
        return FetchResult(status="not_modified")


def _item(url: str, ts: int) -> NewsItem:
    return NewsItem(
        url=url,
        source="reuters",
        title=f"title {url}",
        summary="",
        published_at_ms=ts,
        fetched_at_ms=ts + 1000,
        keywords=("k",),
    )


class NewsServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = NewsStore(Path(self._tmp.name) / "news.sqlite3")
        self._loop = asyncio.new_event_loop()
        self.addCleanup(self._loop.close)

    def _run(self, coro):
        return self._loop.run_until_complete(coro)

    def test_refresh_now_persists_items_and_sets_cursor(self) -> None:
        provider = FakeProvider([
            FetchResult(
                status="ok",
                items=(_item("https://r/a", 1000), _item("https://r/b", 2000)),
                etag='"e1"',
                last_modified="lm1",
            ),
        ])
        service = NewsService(store=self.store, provider=provider)
        outcome = self._run(service.refresh_now())
        self.assertEqual(outcome.status, "ok")
        self.assertEqual(outcome.inserted, 2)
        self.assertEqual(len(service.recent()), 2)
        cursor = self.store.get_cursor("reuters")
        assert cursor is not None
        self.assertEqual(cursor.etag, '"e1"')
        self.assertEqual(cursor.last_modified, "lm1")

    def test_refresh_now_not_modified_keeps_cache(self) -> None:
        self.store.upsert_items([_item("https://r/a", 1000)])
        self.store.set_cursor("reuters", '"e0"', "lm0")
        provider = FakeProvider([FetchResult(status="not_modified", etag='"e0"', last_modified="lm0")])
        service = NewsService(store=self.store, provider=provider)
        outcome = self._run(service.refresh_now())
        self.assertEqual(outcome.status, "not_modified")
        self.assertEqual(outcome.inserted, 0)
        self.assertEqual(provider.calls, [('"e0"', "lm0")])

    def test_refresh_now_rate_limited_triggers_backoff(self) -> None:
        provider = FakeProvider([FetchResult(status="rate_limited", error="429")])
        service = NewsService(store=self.store, provider=provider, poll_interval_seconds=30, max_interval_seconds=600)
        self._run(service.refresh_now())
        self.assertEqual(service.last_status, "rate_limited")
        self.assertGreater(service._current_interval, 30.0)

    def test_refresh_success_resets_backoff(self) -> None:
        provider = FakeProvider([
            FetchResult(status="rate_limited", error="429"),
            FetchResult(status="ok", items=(_item("https://r/a", 1000),), etag='"e"', last_modified="lm"),
        ])
        service = NewsService(store=self.store, provider=provider, poll_interval_seconds=30)
        self._run(service.refresh_now())
        self.assertGreater(service._current_interval, 30.0)
        self._run(service.refresh_now())
        self.assertEqual(service._current_interval, 30.0)
        self.assertEqual(service.last_status, "ok")


if __name__ == "__main__":
    unittest.main()
