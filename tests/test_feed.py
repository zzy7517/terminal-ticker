"""Test feed worker event production."""
import asyncio
import queue
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from terminal_ticker.candle_cache import CandleCache
from terminal_ticker.config import AnalysisConfig, AppConfig, DisplayConfig
from terminal_ticker.feed import FeedWorker, THUMBNAIL_CANDLE_LIMIT, THUMBNAIL_INTERVAL
from terminal_ticker.bitget import BitgetInstrument
from terminal_ticker.longbridge_provider import LongbridgeInstrument
from terminal_ticker.price_action import Candle


class FeedWorkerTests(unittest.TestCase):
    """Group tests for FeedWorkerTests."""
    def test_handle_message_enqueues_quote_event(self) -> None:
        """Verify handle message enqueues quote event."""
        event_queue = queue.Queue()
        worker = FeedWorker(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=tuple(),
            event_queue=event_queue,
        )

        worker._handle_message({"id": "USDT-FUTURES:BTCUSDT", "price": 78000})

        event = event_queue.get_nowait()
        self.assertEqual(event.kind, "quote")
        self.assertEqual(event.payload["price"], 78000)

    def test_longbridge_polling_enqueues_quote_events(self) -> None:
        """Verify longbridge polling enqueues quote events."""
        async def run_test() -> None:
            """Exercise run test behavior."""
            event_queue = queue.Queue()
            instrument = LongbridgeInstrument("AAPL.US", "AAPL")
            worker = FeedWorker(
                config=AppConfig(
                    instruments=tuple(),
                    display=DisplayConfig(longbridge_poll_interval_seconds=60),
                ),
                instruments=(instrument,),
                event_queue=event_queue,
            )

            with patch(
                "terminal_ticker.feed.fetch_quote_payloads",
                return_value={"longbridge:AAPL.US": {"id": "longbridge:AAPL.US", "price": 201.5}},
            ):
                task = asyncio.create_task(worker._run_longbridge())
                await asyncio.sleep(0.05)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

            event = event_queue.get_nowait()
            self.assertEqual(event.kind, "quote")
            self.assertEqual(event.payload["price"], 201.5)

        asyncio.run(run_test())

    def test_candle_polling_enqueues_error_on_fetch_error(self) -> None:
        """Verify candle polling reports provider errors without generating labels."""
        async def run_test() -> None:
            """Exercise run test behavior."""
            event_queue = queue.Queue()
            instrument = BitgetInstrument(
                "BTCUSDT",
                "USDT-FUTURES",
                "BTC",
                "BTC",
                "USDT",
                "perp",
            )
            worker = FeedWorker(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=(instrument,),
                event_queue=event_queue,
            )

            with patch.object(FeedWorker, "_fetch_candles", side_effect=RuntimeError("boom")):
                task = asyncio.create_task(worker._run_candles())
                await asyncio.sleep(0.05)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

            event = event_queue.get_nowait()
            self.assertEqual(event.kind, "candles")
            self.assertEqual(event.payload["id"], instrument.key)
            self.assertEqual(event.payload["error"], "boom")

        asyncio.run(run_test())

    def test_longbridge_instruments_are_polled_for_candles(self) -> None:
        """Verify longbridge instruments enter the candle pipeline."""
        async def run_test() -> None:
            """Exercise run test behavior."""
            event_queue = queue.Queue()
            instrument = LongbridgeInstrument("AAPL.US", "AAPL")
            base_open_ms = int(
                (datetime.now(timezone.utc) - timedelta(minutes=11)).timestamp() * 1000
            )
            candles = tuple(
                Candle(
                    symbol_key=instrument.key,
                    open_time_ms=base_open_ms + index * 60_000,
                    open=100 + index,
                    high=102 + index,
                    low=99 + index,
                    close=101 + index,
                    volume=1000,
                )
                for index in range(12)
            )
            worker = FeedWorker(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=(instrument,),
                event_queue=event_queue,
            )

            with patch.object(FeedWorker, "_fetch_candles", return_value=candles):
                task = asyncio.create_task(worker._run_candles())
                await asyncio.sleep(0.05)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

            event = event_queue.get_nowait()
            self.assertEqual(event.kind, "candles")
            self.assertEqual(event.payload["id"], "longbridge:AAPL.US")
            self.assertEqual(event.payload["candles"], candles)

        asyncio.run(run_test())

    def test_candle_polling_uses_per_instrument_interval_override(self) -> None:
        """Verify one symbol interval override does not affect other symbols."""
        async def run_test() -> None:
            """Exercise run test behavior."""
            event_queue = queue.Queue()
            aapl = LongbridgeInstrument("AAPL.US", "AAPL", analysis_interval="15m")
            spy = LongbridgeInstrument("SPY.US", "SPY")
            base_open_ms = int(
                (datetime.now(timezone.utc) - timedelta(minutes=11)).timestamp() * 1000
            )
            calls: list[tuple[str, str]] = []

            def fake_fetch(instrument, *, interval, limit, **_kwargs):
                calls.append((instrument.key, interval))
                return tuple(
                    Candle(
                        symbol_key=instrument.key,
                        open_time_ms=base_open_ms + index * 60_000,
                        open=100 + index,
                        high=102 + index,
                        low=99 + index,
                        close=101 + index,
                        volume=1000,
                    )
                    for index in range(12)
                )

            worker = FeedWorker(
                config=AppConfig(
                    instruments=tuple(),
                    display=DisplayConfig(),
                    analysis=AnalysisConfig(interval="5m"),
                ),
                instruments=(aapl, spy),
                event_queue=event_queue,
            )

            with patch.object(FeedWorker, "_fetch_candles", side_effect=fake_fetch):
                task = asyncio.create_task(worker._run_candles())
                await asyncio.sleep(0.05)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

            self.assertIn(("longbridge:AAPL.US", "15m"), calls)
            self.assertIn(("longbridge:SPY.US", "5m"), calls)

        asyncio.run(run_test())

    def test_candle_polling_fetches_fixed_hourly_thumbnail_candles(self) -> None:
        """Verify watchlist thumbnails always use one-hour candles."""
        async def run_test() -> None:
            """Exercise run test behavior."""
            event_queue = queue.Queue()
            instrument = LongbridgeInstrument("AAPL.US", "AAPL", analysis_interval="15m")
            base_open_ms = int(
                (datetime.now(timezone.utc) - timedelta(minutes=11)).timestamp() * 1000
            )
            thumbnail_base_ms = int(
                (datetime.now(timezone.utc) - timedelta(hours=THUMBNAIL_CANDLE_LIMIT - 1)).timestamp()
                * 1000
            )
            calls: list[tuple[str, int]] = []

            analysis_candles = tuple(
                Candle(
                    symbol_key=instrument.key,
                    open_time_ms=base_open_ms + index * 60_000,
                    open=100 + index,
                    high=102 + index,
                    low=99 + index,
                    close=101 + index,
                    volume=1000,
                )
                for index in range(12)
            )
            thumbnail_candles = tuple(
                Candle(
                    symbol_key=instrument.key,
                    open_time_ms=thumbnail_base_ms + index * 3_600_000,
                    open=200 + index,
                    high=202 + index,
                    low=199 + index,
                    close=201 + index,
                    volume=2000,
                )
                for index in range(THUMBNAIL_CANDLE_LIMIT)
            )

            def fake_fetch(_instrument, *, interval, limit, **_kwargs):
                calls.append((interval, limit))
                if interval == THUMBNAIL_INTERVAL:
                    return thumbnail_candles
                return analysis_candles

            worker = FeedWorker(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=(instrument,),
                event_queue=event_queue,
            )

            with patch.object(FeedWorker, "_fetch_candles", side_effect=fake_fetch):
                task = asyncio.create_task(worker._run_candles())
                await asyncio.sleep(0.05)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

            event = event_queue.get_nowait()
            self.assertIn((THUMBNAIL_INTERVAL, THUMBNAIL_CANDLE_LIMIT), calls)
            self.assertEqual(event.payload["candles"], analysis_candles)
            self.assertEqual(event.payload["thumbnail_candles"], thumbnail_candles)

        asyncio.run(run_test())

    def test_fetch_candles_uses_cache_incremental_provider_fetch(self) -> None:
        """Verify feed candle fetches overlap the latest cached bar."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            cache = CandleCache(Path(tmp_dir) / "candles.sqlite3")
            instrument = BitgetInstrument(
                "BTCUSDT",
                "USDT-FUTURES",
                "BTC",
                "BTC",
                "USDT",
                "perp",
            )
            base_open_ms = int((datetime.now(timezone.utc) - timedelta(minutes=5)).timestamp() * 1000)
            cached = Candle(
                symbol_key=instrument.key,
                open_time_ms=base_open_ms,
                open=100,
                high=102,
                low=99,
                close=101,
                volume=1000,
            )
            fetched = Candle(
                symbol_key=instrument.key,
                open_time_ms=base_open_ms + 300_000,
                open=101,
                high=103,
                low=100,
                close=102,
                volume=1200,
            )
            cache.upsert((cached,), interval="5m", fetched_at_ms=base_open_ms)
            worker = FeedWorker(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=(instrument,),
                event_queue=queue.Queue(),
                candle_cache=cache,
            )

            with patch.object(
                FeedWorker,
                "_fetch_provider_candles",
                return_value=(fetched,),
            ) as provider:
                candles = worker._fetch_candles(instrument, interval="5m", limit=2)

            self.assertEqual(candles, (cached, fetched))
            self.assertEqual(provider.call_args.kwargs["after_open_time_ms"], base_open_ms - 300_000)

    def test_longbridge_quote_polling_reuses_context(self) -> None:
        """Verify longbridge quote polling does not rebuild the SDK context every request."""
        event_queue = queue.Queue()
        instrument = LongbridgeInstrument("AAPL.US", "AAPL")
        worker = FeedWorker(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            event_queue=event_queue,
        )
        context = object()

        with patch("terminal_ticker.feed.build_longbridge_quote_context", return_value=context) as build:
            with patch("terminal_ticker.feed.fetch_quote_payloads", return_value={}) as fetch:
                worker._fetch_longbridge_quote_payloads()
                worker._fetch_longbridge_quote_payloads()

        self.assertEqual(build.call_count, 1)
        self.assertEqual(fetch.call_count, 2)
        self.assertIs(fetch.call_args.kwargs["quote_context"], context)

    def test_longbridge_candle_fetch_reuses_context(self) -> None:
        """Verify longbridge candle refreshes reuse their SDK context."""
        event_queue = queue.Queue()
        instrument = LongbridgeInstrument("AAPL.US", "AAPL")
        worker = FeedWorker(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            event_queue=event_queue,
        )
        context = object()

        with patch("terminal_ticker.feed.build_longbridge_quote_context", return_value=context) as build:
            with patch("terminal_ticker.feed.fetch_longbridge_candles", return_value=tuple()) as fetch:
                worker._fetch_provider_candles(instrument, interval="5m", limit=40)
                worker._fetch_provider_candles(instrument, interval="1H", limit=60)

        self.assertEqual(build.call_count, 1)
        self.assertEqual(fetch.call_count, 2)
        self.assertIs(fetch.call_args.kwargs["quote_context"], context)

if __name__ == "__main__":
    unittest.main()
