"""Test ticker controller event handling."""
import unittest

from tradex.market_data.bitget import BitgetInstrument
from tradex.config import AppConfig, DisplayConfig
from tradex.runtime.controller import TickerController
from tradex.runtime.feed import FeedEvent
from tradex.domain.price_action import Candle


class DummyWorker:
    """Provide a controllable worker double for controller tests."""
    def __init__(self, **_kwargs) -> None:
        """Initialize flags used to assert worker lifecycle calls."""
        self.started = False
        self.stopped = False

    def start(self) -> None:
        """Record that the worker was started."""
        self.started = True

    def stop(self) -> None:
        """Record that the worker was stopped."""
        self.stopped = True

    def join(self, timeout: float | None = None) -> None:
        """Record the join timeout used by the controller."""
        _ = timeout


class ControllerTests(unittest.TestCase):
    """Group tests for ControllerTests."""
    def setUp(self) -> None:
        """Prepare shared test fixtures."""
        self.instruments = (
            BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp"),
        )
        self.controller = TickerController(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=self.instruments,
            worker_factory=DummyWorker,
        )

    def test_start_and_stop_delegate_to_worker(self) -> None:
        """Verify start and stop delegate to worker."""
        worker = self.controller.feed_worker

        self.controller.start()
        self.controller.stop()

        self.assertTrue(worker.started)
        self.assertTrue(worker.stopped)

    def test_drain_events_updates_quote_and_flash_direction(self) -> None:
        """Verify drain events updates quote and flash direction."""
        key = self.instruments[0].key
        self.controller.event_queue.put(FeedEvent("quote", {"id": key, "price": 100}))
        self.controller.event_queue.put(FeedEvent("quote", {"id": key, "price": 105}))

        result = self.controller.drain_events()

        self.assertTrue(result.dirty)
        self.assertEqual(result.flash_directions[key], 1)
        self.assertEqual(self.controller.quotes[key].price, 105)
        self.assertEqual(self.controller.stream_status, "live")
        self.assertIsNotNone(self.controller.last_message_at)

    def test_snapshot_only_applies_before_live_updates(self) -> None:
        """Verify snapshot only applies before live updates."""
        key = self.instruments[0].key
        self.controller.event_queue.put(FeedEvent("quote", {"id": key, "price": 100}))
        self.controller.event_queue.put(
            FeedEvent(
                "snapshot",
                {
                    key: {
                        "display_name": "BTC",
                        "price": 90,
                    }
                },
            )
        )

        self.controller.drain_events()

        self.assertEqual(self.controller.quotes[key].price, 100)

    def test_error_event_switches_to_retrying(self) -> None:
        """Verify error event switches to retrying."""
        self.controller.event_queue.put(FeedEvent("error", "boom"))

        result = self.controller.drain_events()

        self.assertTrue(result.dirty)
        self.assertEqual(self.controller.stream_status, "retrying")

    def test_targeted_error_event_marks_quote_error(self) -> None:
        """Verify provider errors can be attached to affected quote rows."""
        key = self.instruments[0].key
        self.controller.event_queue.put(
            FeedEvent(
                "error",
                {
                    "message": "missing credentials",
                    "ids": [key],
                },
            )
        )

        result = self.controller.drain_events()

        self.assertTrue(result.dirty)
        self.assertEqual(self.controller.stream_status, "retrying")
        self.assertEqual(self.controller.quotes[key].last_error, "missing credentials")

    def test_candle_event_stores_candles_without_flash(self) -> None:
        """Verify candle events update chart data without price flash."""
        key = self.instruments[0].key
        candles = (
            Candle(key, 1, 100, 101, 99, 100.5, 1000),
        )
        self.controller.event_queue.put(
            FeedEvent(
                "candles",
                {
                    "id": key,
                    "candles": candles,
                },
            )
        )

        result = self.controller.drain_events()

        self.assertTrue(result.dirty)
        self.assertEqual(result.flash_directions, {})
        self.assertEqual(self.controller.quotes[key].candles, candles)

    def test_candle_event_merges_with_loaded_history(self) -> None:
        """Verify live refreshes do not discard manually loaded older candles."""
        key = self.instruments[0].key
        older = Candle(key, 1, 90, 91, 89, 90.5, 900)
        stale_current = Candle(key, 2, 100, 101, 99, 100.5, 1000)
        refreshed_current = Candle(key, 2, 100, 102, 99, 101.5, 1200)
        self.controller.quotes[key].apply_candles(candles=(older, stale_current))
        self.controller.event_queue.put(
            FeedEvent(
                "candles",
                {
                    "id": key,
                    "candles": (refreshed_current,),
                },
            )
        )

        self.controller.drain_events()

        self.assertEqual(self.controller.quotes[key].candles, (older, refreshed_current))

    def test_candle_event_stores_thumbnail_candles(self) -> None:
        """Verify candle events can update fixed thumbnail candles."""
        key = self.instruments[0].key
        thumbnail_candles = (
            Candle(key, 1, 100, 101, 99, 100.5, 1000),
        )
        self.controller.event_queue.put(
            FeedEvent(
                "candles",
                {
                    "id": key,
                    "thumbnail_candles": thumbnail_candles,
                },
            )
        )

        self.controller.drain_events()

        self.assertEqual(self.controller.quotes[key].thumbnail_candles, thumbnail_candles)


if __name__ == "__main__":
    unittest.main()
