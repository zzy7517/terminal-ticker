"""Test ticker controller event handling."""
import unittest

from terminal_ticker.bitget import BitgetInstrument
from terminal_ticker.config import AppConfig, DisplayConfig
from terminal_ticker.controller import TickerController
from terminal_ticker.feed import FeedEvent
from terminal_ticker.price_action import Candle, PriceActionState


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

    def test_price_action_event_updates_quote_without_flash(self) -> None:
        """Verify price action event updates quote without price flash."""
        key = self.instruments[0].key
        self.controller.event_queue.put(
            FeedEvent(
                "price_action",
                {
                    "id": key,
                    "state": PriceActionState(
                        label="breakout",
                        bias="bullish",
                        marker="BO+",
                        reason="突破近期区间",
                        strength=82,
                    ),
                },
            )
        )

        result = self.controller.drain_events()

        self.assertTrue(result.dirty)
        self.assertEqual(result.flash_directions, {})
        self.assertEqual(self.controller.quotes[key].price_action.marker, "BO+")

    def test_price_action_event_stores_candles(self) -> None:
        """Verify price action event stores chart candles."""
        key = self.instruments[0].key
        candles = (
            Candle(key, 1, 100, 101, 99, 100.5, 1000),
        )
        self.controller.event_queue.put(
            FeedEvent(
                "price_action",
                {
                    "id": key,
                    "state": PriceActionState(
                        label="range",
                        bias="neutral",
                        marker="RG",
                        reason="K线重叠震荡",
                        strength=42,
                    ),
                    "candles": candles,
                },
            )
        )

        self.controller.drain_events()

        self.assertEqual(self.controller.quotes[key].price_action_candles, candles)

    def test_price_action_event_stores_thumbnail_candles(self) -> None:
        """Verify price action events can update fixed thumbnail candles."""
        key = self.instruments[0].key
        thumbnail_candles = (
            Candle(key, 1, 100, 101, 99, 100.5, 1000),
        )
        self.controller.event_queue.put(
            FeedEvent(
                "price_action",
                {
                    "id": key,
                    "state": PriceActionState(
                        label="range",
                        bias="neutral",
                        marker="RG",
                        reason="K线重叠震荡",
                        strength=42,
                    ),
                    "thumbnail_candles": thumbnail_candles,
                },
            )
        )

        self.controller.drain_events()

        self.assertEqual(self.controller.quotes[key].thumbnail_candles, thumbnail_candles)


if __name__ == "__main__":
    unittest.main()
