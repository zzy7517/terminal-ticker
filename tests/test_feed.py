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
from terminal_ticker.feed import FeedWorker
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

    def test_price_action_polling_enqueues_unavailable_state_on_fetch_error(self) -> None:
        """Verify price action polling degrades to unavailable on fetch errors."""
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
                task = asyncio.create_task(worker._run_price_action())
                await asyncio.sleep(0.05)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

            event = event_queue.get_nowait()
            self.assertEqual(event.kind, "price_action")
            self.assertEqual(event.payload["id"], instrument.key)
            self.assertEqual(event.payload["state"].label, "unavailable")

        asyncio.run(run_test())

    def test_longbridge_instruments_are_analyzed_with_candles(self) -> None:
        """Verify longbridge instruments enter the price action pipeline."""
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
                task = asyncio.create_task(worker._run_price_action())
                await asyncio.sleep(0.05)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

            event = event_queue.get_nowait()
            self.assertEqual(event.kind, "price_action")
            self.assertEqual(event.payload["id"], "longbridge:AAPL.US")
            self.assertEqual(event.payload["state"].label, "trend")
            self.assertEqual(event.payload["candles"], candles)

        asyncio.run(run_test())

    def test_price_action_uses_per_instrument_interval_override(self) -> None:
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

            def fake_fetch(instrument, *, interval, limit):
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
                task = asyncio.create_task(worker._run_price_action())
                await asyncio.sleep(0.05)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

            self.assertIn(("longbridge:AAPL.US", "15m"), calls)
            self.assertIn(("longbridge:SPY.US", "5m"), calls)

        asyncio.run(run_test())

    def test_fetch_candles_uses_cache_incremental_provider_fetch(self) -> None:
        """Verify feed candle fetches use retained cache before provider calls."""
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
            self.assertEqual(provider.call_args.kwargs["after_open_time_ms"], base_open_ms)

    def test_stale_candles_return_unavailable_state(self) -> None:
        """Verify old candle timestamps do not produce fresh analysis."""
        old_open_ms = int(
            (datetime.now(timezone.utc) - timedelta(minutes=30)).timestamp() * 1000
        )
        candles = tuple(
            Candle(
                symbol_key="USDT-FUTURES:BTCUSDT",
                open_time_ms=old_open_ms + index * 60_000,
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
            instruments=tuple(),
            event_queue=queue.Queue(),
        )

        state = worker._analyze_fresh_candles(candles)

        self.assertEqual(state.label, "unavailable")
        self.assertEqual(state.error, "Candle data is stale.")


if __name__ == "__main__":
    unittest.main()
