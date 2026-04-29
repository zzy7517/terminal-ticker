"""Test quote state formatting and updates."""
import unittest
from datetime import datetime, timedelta, timezone

from terminal_ticker.models import QuoteState
from terminal_ticker.price_action import Candle


class QuoteStateTests(unittest.TestCase):
    """Group tests for QuoteStateTests."""
    def test_apply_payload_updates_quote(self) -> None:
        """Verify apply payload updates quote."""
        quote = QuoteState.placeholder("AAPL")
        quote.apply_payload(
            {
                "id": "AAPL",
                "short_name": "Apple",
                "price": 200.12,
                "change": 1.23,
                "change_percent": 0.61,
                "previous_close": 198.89,
                "status": "perp",
                "day_volume": "12000.5",
            }
        )

        self.assertEqual(quote.display_name, "Apple")
        self.assertEqual(quote.price, 200.12)
        self.assertEqual(quote.change, 1.23)
        self.assertEqual(quote.status, "perp")
        self.assertEqual(quote.volume, 12000.5)
        self.assertEqual(quote.update_count, 1)

    def test_stale_detection(self) -> None:
        """Verify stale detection."""
        quote = QuoteState.placeholder("BTCUSDT")
        quote.last_update_at = datetime.now(timezone.utc) - timedelta(seconds=25)

        self.assertTrue(quote.is_stale(20))
        self.assertFalse(quote.is_stale(30))

    def test_apply_snapshot_sets_snapshot_status(self) -> None:
        """Verify apply snapshot sets snapshot status."""
        quote = QuoteState.placeholder("XAUUSDT")
        quote.apply_snapshot(
            {
                "display_name": "Gold",
                "price": 3300.5,
                "previous_close": 3290.0,
                "change": 10.5,
                "change_percent": 0.31,
            }
        )

        self.assertEqual(quote.display_name, "Gold")
        self.assertEqual(quote.price, 3300.5)
        self.assertEqual(quote.status, "snap")

    def test_age_label_shows_milliseconds_for_recent_updates(self) -> None:
        """Verify age label shows milliseconds for recent updates."""
        quote = QuoteState.placeholder("BTCUSDT")
        quote.last_update_at = datetime.now(timezone.utc) - timedelta(milliseconds=420)

        label = quote.age_label()

        self.assertTrue(label.endswith("ms"))

    def test_apply_candles_stores_chart_candles(self) -> None:
        """Verify chart candles are tracked for charting and agent context."""
        quote = QuoteState.placeholder("BTCUSDT")
        candles = (
            Candle(
                symbol_key="USDT-FUTURES:BTCUSDT",
                open_time_ms=1,
                open=100,
                high=101,
                low=99,
                close=100.5,
                volume=1000,
            ),
        )

        quote.apply_candles(candles=candles)

        self.assertEqual(quote.candles, candles)

    def test_apply_candles_stores_thumbnail_candles(self) -> None:
        """Verify thumbnail candles are tracked separately from chart candles."""
        quote = QuoteState.placeholder("BTCUSDT")
        thumbnail_candles = (
            Candle("USDT-FUTURES:BTCUSDT", 1, 100, 101, 99, 100.5, 1000),
        )

        quote.apply_candles(thumbnail_candles=thumbnail_candles)

        self.assertEqual(quote.thumbnail_candles, thumbnail_candles)


if __name__ == "__main__":
    unittest.main()
