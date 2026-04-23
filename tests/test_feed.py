import queue
import unittest

from terminal_ticker.config import AppConfig, DisplayConfig
from terminal_ticker.feed import FeedWorker


class FeedWorkerTests(unittest.TestCase):
    def test_handle_message_enqueues_quote_event(self) -> None:
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


if __name__ == "__main__":
    unittest.main()
