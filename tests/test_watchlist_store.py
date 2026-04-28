"""Test persistent watchlist add and remove helpers."""
import tempfile
import textwrap
import unittest
from pathlib import Path

from terminal_ticker.config import load_config
from terminal_ticker.watchlist_store import (
    append_longbridge_symbol_to_watchlist,
    remove_longbridge_symbol_from_watchlist,
)


class WatchlistStoreTests(unittest.TestCase):
    """Group tests for WatchlistStoreTests."""
    def test_append_longbridge_symbol_to_watchlist(self) -> None:
        """Verify append longbridge symbol to watchlist."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC" },
                    ]

                    [display]
                    stale_after_seconds = 15
                    """
                ).strip()
            )

            inserted = append_longbridge_symbol_to_watchlist(
                config_path,
                symbol="aapl.us",
                label="AAPL",
            )
            duplicate = append_longbridge_symbol_to_watchlist(
                config_path,
                symbol="AAPL.US",
                label="AAPL",
            )
            config = load_config(config_path)

        self.assertTrue(inserted)
        self.assertFalse(duplicate)
        self.assertEqual(config.instruments[1].symbol, "AAPL.US")
        self.assertEqual(config.instruments[1].source, "longbridge")
        self.assertEqual(config.instruments[1].group, "stocks")

    def test_remove_longbridge_symbol_from_watchlist_only_removes_exact_source_match(self) -> None:
        """Verify remove longbridge symbol from watchlist only removes exact source match."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "AAP.US", source = "longbridge", label = "AAP", group = "stocks" },
                      { symbol = "AAPL.US", source = "longbridge", label = "AAPL", group = "stocks" },
                      { symbol = "AAPLUSDT", inst_type = "USDT-FUTURES", label = "AAPL" },
                    ]
                    """
                ).strip()
            )

            removed = remove_longbridge_symbol_from_watchlist(config_path, symbol="aapl.us")
            missing = remove_longbridge_symbol_from_watchlist(config_path, symbol="MSFT.US")
            config = load_config(config_path)

        self.assertTrue(removed)
        self.assertFalse(missing)
        self.assertEqual([item.symbol for item in config.instruments], ["AAP.US", "AAPLUSDT"])


if __name__ == "__main__":
    unittest.main()
