"""Test local SQLite candle caching."""
import tempfile
import unittest
from pathlib import Path

from terminal_ticker.candle_cache import CandleCache, cached_fetch_candles
from terminal_ticker.price_action import Candle


def _candle(symbol_key: str, open_time_ms: int, close: float = 101.0) -> Candle:
    """Build one valid candle for cache tests."""
    return Candle(
        symbol_key=symbol_key,
        open_time_ms=open_time_ms,
        open=100.0,
        high=max(102.0, close),
        low=99.0,
        close=close,
        volume=1000.0,
    )


class CandleCacheTests(unittest.TestCase):
    """Group tests for the local candle cache."""

    def test_upsert_recent_and_prune_obey_retention(self) -> None:
        """Verify retained candles are keyed by symbol and interval."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache = CandleCache(Path(tmp_dir) / "candles.sqlite3", retention_seconds=86_400)
            now_ms = 200_000_000
            fresh = _candle("longbridge:AAPL.US", now_ms - 60_000, close=101)
            old = _candle("longbridge:AAPL.US", now_ms - 90_000_000, close=99)
            other_interval = _candle("longbridge:AAPL.US", now_ms - 30_000, close=105)

            cache.upsert((fresh, old), interval="5m", fetched_at_ms=now_ms)
            cache.upsert((other_interval,), interval="15m", fetched_at_ms=now_ms)
            recent = cache.recent("longbridge:AAPL.US", "5m", limit=10, now_ms=now_ms)
            removed = cache.prune(now_ms=now_ms)

            self.assertEqual(recent, (fresh,))
            self.assertEqual(removed, 1)
            self.assertEqual(
                cache.recent("longbridge:AAPL.US", "15m", limit=10, now_ms=now_ms),
                (other_interval,),
            )

    def test_upsert_overwrites_unfinished_candle(self) -> None:
        """Verify the same open time can update close and volume values."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache = CandleCache(Path(tmp_dir) / "candles.sqlite3")
            first = _candle("USDT-FUTURES:BTCUSDT", 100_000, close=101)
            updated = _candle("USDT-FUTURES:BTCUSDT", 100_000, close=103)

            cache.upsert((first,), interval="5m", fetched_at_ms=100_000)
            cache.upsert((updated,), interval="5m", fetched_at_ms=101_000)

            self.assertEqual(
                cache.recent("USDT-FUTURES:BTCUSDT", "5m", limit=1, now_ms=101_000),
                (updated,),
            )

    def test_cached_fetch_prunes_only_requested_symbol_interval(self) -> None:
        """Verify short-interval refreshes do not delete retained thumbnail candles."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache = CandleCache(Path(tmp_dir) / "candles.sqlite3", retention_seconds=86_400)
            symbol_key = "USDT-FUTURES:BTCUSDT"
            now_ms = 200_000_000
            old_5m = _candle(symbol_key, now_ms - 40 * 60 * 60 * 1000, close=100)
            old_1h = _candle(symbol_key, now_ms - 40 * 60 * 60 * 1000, close=101)
            cache.upsert((old_5m,), interval="5m", fetched_at_ms=now_ms)
            cache.upsert((old_1h,), interval="1H", fetched_at_ms=now_ms)

            cached_fetch_candles(
                cache=cache,
                symbol_key=symbol_key,
                interval="5m",
                limit=40,
                fetcher=lambda **kwargs: tuple(),
                now_ms=now_ms,
            )

            self.assertEqual(
                cache.recent(
                    symbol_key,
                    "1H",
                    limit=60,
                    now_ms=now_ms,
                    retention_seconds=60 * 60 * 60,
                ),
                (old_1h,),
            )

    def test_cached_fetch_requests_with_one_candle_overlap(self) -> None:
        """Verify provider fetches re-request the latest cached candle."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache = CandleCache(Path(tmp_dir) / "candles.sqlite3")
            symbol_key = "longbridge:AAPL.US"
            latest = _candle(symbol_key, 1_000_000)
            fetched = _candle(symbol_key, 1_300_000, close=104)
            calls = []

            cache.upsert((latest,), interval="5m", fetched_at_ms=1_000_000)

            def fetcher(*, interval, limit, after_open_time_ms):
                calls.append((interval, limit, after_open_time_ms))
                return (fetched,)

            candles = cached_fetch_candles(
                cache=cache,
                symbol_key=symbol_key,
                interval="5m",
                limit=2,
                fetcher=fetcher,
                now_ms=1_300_000,
            )

            self.assertEqual(calls[0][2], 700_000)
            self.assertEqual(candles, (latest, fetched))

    def test_cached_fetch_requests_only_missing_window(self) -> None:
        """Verify hot cache refreshes do not request the full lookback again."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache = CandleCache(Path(tmp_dir) / "candles.sqlite3")
            symbol_key = "USDT-FUTURES:BTCUSDT"
            start_ms = 1_000_000
            cached = tuple(
                _candle(symbol_key, start_ms + index * 300_000, close=100 + index)
                for index in range(40)
            )
            fetched = _candle(symbol_key, cached[-1].open_time_ms, close=140)
            calls = []

            cache.upsert(cached, interval="5m", fetched_at_ms=start_ms)

            def fetcher(*, interval, limit, after_open_time_ms):
                calls.append((interval, limit, after_open_time_ms))
                return (fetched,)

            candles = cached_fetch_candles(
                cache=cache,
                symbol_key=symbol_key,
                interval="5m",
                limit=40,
                fetcher=fetcher,
                now_ms=cached[-1].open_time_ms + 60_000,
            )

            self.assertEqual(calls[0][1], 2)
            self.assertEqual(len(candles), 40)
            self.assertEqual(candles[-1], fetched)

    def test_cached_fetch_can_return_fresh_cache_without_provider(self) -> None:
        """Verify callers can skip provider refreshes for recently fetched candles."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache = CandleCache(Path(tmp_dir) / "candles.sqlite3")
            symbol_key = "longbridge:AAPL.US"
            now_ms = 2_000_000
            cached = (
                _candle(symbol_key, now_ms - 3_600_000, close=101),
                _candle(symbol_key, now_ms, close=102),
            )
            cache.upsert(cached, interval="1H", fetched_at_ms=now_ms - 60_000)

            def fetcher(*, interval, limit, after_open_time_ms):
                raise AssertionError("provider should not be called")

            candles = cached_fetch_candles(
                cache=cache,
                symbol_key=symbol_key,
                interval="1H",
                limit=60,
                fetcher=fetcher,
                now_ms=now_ms,
                max_cache_age_seconds=900,
            )

            self.assertEqual(candles, cached)

    def test_cached_fetch_refreshes_latest_cached_candle(self) -> None:
        """Verify unfinished cached candles can be overwritten by provider data."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache = CandleCache(Path(tmp_dir) / "candles.sqlite3")
            symbol_key = "USDT-FUTURES:BTCUSDT"
            cached = _candle(symbol_key, 1_000_000, close=101)
            refreshed = _candle(symbol_key, 1_000_000, close=103)
            next_candle = _candle(symbol_key, 1_300_000, close=104)

            cache.upsert((cached,), interval="5m", fetched_at_ms=1_000_000)

            candles = cached_fetch_candles(
                cache=cache,
                symbol_key=symbol_key,
                interval="5m",
                limit=2,
                fetcher=lambda **kwargs: (refreshed, next_candle),
                now_ms=1_300_000,
            )

            self.assertEqual(candles, (refreshed, next_candle))

    def test_cached_fetch_falls_back_to_cache_when_provider_fails(self) -> None:
        """Verify stale provider failures can still return retained candles."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache = CandleCache(Path(tmp_dir) / "candles.sqlite3")
            symbol_key = "USDT-FUTURES:BTCUSDT"
            cached = _candle(symbol_key, 2_000_000)
            cache.upsert((cached,), interval="5m", fetched_at_ms=2_000_000)

            def fetcher(*, interval, limit, after_open_time_ms):
                raise RuntimeError("provider unavailable")

            candles = cached_fetch_candles(
                cache=cache,
                symbol_key=symbol_key,
                interval="5m",
                limit=2,
                fetcher=fetcher,
                now_ms=2_100_000,
            )

            self.assertEqual(candles, (cached,))


if __name__ == "__main__":
    unittest.main()
