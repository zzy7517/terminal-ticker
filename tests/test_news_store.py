"""Test the news SQLite store."""
import tempfile
import unittest
from pathlib import Path

from tradex.news import NewsItem, NewsStore


def _item(url: str, published_at_ms: int, title: str = "t") -> NewsItem:
    return NewsItem(
        url=url,
        source="reuters",
        title=title,
        summary="",
        published_at_ms=published_at_ms,
        fetched_at_ms=published_at_ms + 1000,
        keywords=("a", "b"),
    )


class NewsStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = NewsStore(Path(self._tmp.name) / "news.sqlite3")

    def test_upsert_returns_only_new_items(self) -> None:
        first = [_item("https://r.com/a", 1000), _item("https://r.com/b", 2000)]
        inserted = self.store.upsert_items(first)
        self.assertEqual(len(inserted), 2)

        second = [_item("https://r.com/a", 1000, title="updated"), _item("https://r.com/c", 3000)]
        inserted2 = self.store.upsert_items(second)
        self.assertEqual([it.url for it in inserted2], ["https://r.com/c"])

    def test_recent_orders_by_published_desc(self) -> None:
        self.store.upsert_items([
            _item("https://r.com/a", 1000),
            _item("https://r.com/b", 3000),
            _item("https://r.com/c", 2000),
        ])
        rows = self.store.recent(limit=10)
        self.assertEqual([r.url for r in rows], ["https://r.com/b", "https://r.com/c", "https://r.com/a"])

    def test_recent_respects_since_filter(self) -> None:
        self.store.upsert_items([
            _item("https://r.com/a", 1000),
            _item("https://r.com/b", 3000),
        ])
        rows = self.store.recent(limit=10, since_ms=2000)
        self.assertEqual([r.url for r in rows], ["https://r.com/b"])

    def test_cursor_roundtrip(self) -> None:
        self.assertIsNone(self.store.get_cursor("reuters"))
        self.store.set_cursor("reuters", etag='"abc"', last_modified="Tue, 05 May 2026 15:00:00 GMT")
        cursor = self.store.get_cursor("reuters")
        assert cursor is not None
        self.assertEqual(cursor.etag, '"abc"')
        self.assertEqual(cursor.last_modified, "Tue, 05 May 2026 15:00:00 GMT")

    def test_prune_older_than(self) -> None:
        self.store.upsert_items([
            _item("https://r.com/a", 1000),
            _item("https://r.com/b", 3000),
        ])
        removed = self.store.prune_older_than(2000)
        self.assertEqual(removed, 1)
        remaining = self.store.recent(limit=10)
        self.assertEqual([r.url for r in remaining], ["https://r.com/b"])


if __name__ == "__main__":
    unittest.main()
