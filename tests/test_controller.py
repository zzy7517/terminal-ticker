import unittest

from terminal_ticker.bitget import BitgetInstrument
from terminal_ticker.config import AppConfig, DisplayConfig
from terminal_ticker.controller import TickerController
from terminal_ticker.feed import FeedEvent


class DummyWorker:
    def __init__(self, **_kwargs) -> None:
        self.started = False
        self.stopped = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def join(self, timeout: float | None = None) -> None:
        _ = timeout


class ControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.instruments = (
            BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp"),
        )
        self.controller = TickerController(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=self.instruments,
            worker_factory=DummyWorker,
        )

    def test_start_and_stop_delegate_to_worker(self) -> None:
        worker = self.controller.feed_worker

        self.controller.start()
        self.controller.stop()

        self.assertTrue(worker.started)
        self.assertTrue(worker.stopped)

    def test_drain_events_updates_quote_and_flash_direction(self) -> None:
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
        self.controller.event_queue.put(FeedEvent("error", "boom"))

        result = self.controller.drain_events()

        self.assertTrue(result.dirty)
        self.assertEqual(self.controller.stream_status, "retrying")


if __name__ == "__main__":
    unittest.main()
