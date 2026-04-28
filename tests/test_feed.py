"""Test feed worker event production."""
import asyncio
import queue
import unittest
from unittest.mock import patch

from terminal_ticker.config import AppConfig, DisplayConfig
from terminal_ticker.feed import FeedWorker
from terminal_ticker.longbridge_provider import LongbridgeInstrument


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


if __name__ == "__main__":
    unittest.main()
