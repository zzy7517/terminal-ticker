import unittest
from datetime import datetime, timedelta, timezone

from terminal_ticker.models import QuoteState


class QuoteStateTests(unittest.TestCase):
    def test_apply_payload_updates_quote(self) -> None:
        quote = QuoteState.placeholder("AAPL")
        quote.apply_payload(
            {
                "id": "AAPL",
                "short_name": "Apple",
                "price": 200.12,
                "change": 1.23,
                "change_percent": 0.61,
                "previous_close": 198.89,
                "market_hours": 1,
                "day_volume": "12000",
            }
        )

        self.assertEqual(quote.display_name, "Apple")
        self.assertEqual(quote.price, 200.12)
        self.assertEqual(quote.change, 1.23)
        self.assertEqual(quote.status, "open")
        self.assertEqual(quote.volume, 12000)
        self.assertEqual(quote.update_count, 1)

    def test_stale_detection(self) -> None:
        quote = QuoteState.placeholder("BTC-USD")
        quote.last_update_at = datetime.now(timezone.utc) - timedelta(seconds=25)

        self.assertTrue(quote.is_stale(20))
        self.assertFalse(quote.is_stale(30))

    def test_apply_snapshot_sets_snapshot_status(self) -> None:
        quote = QuoteState.placeholder("GC=F")
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


if __name__ == "__main__":
    unittest.main()
