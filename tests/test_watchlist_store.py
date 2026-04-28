"""Test persistent watchlist add and remove helpers."""
import tempfile
import textwrap
import unittest
from pathlib import Path

from terminal_ticker.config import AgentConfig, AnalysisConfig, load_config
from terminal_ticker.watchlist_store import (
    append_longbridge_symbol_to_watchlist,
    remove_longbridge_symbol_from_watchlist,
    update_agent_config_in_watchlist,
    update_analysis_config_in_watchlist,
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

    def test_update_agent_config_in_watchlist_inserts_and_replaces_table(self) -> None:
        """Verify agent provider settings persist in TOML."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC" },
                    ]
                    """
                ).strip()
            )

            inserted = update_agent_config_in_watchlist(
                config_path,
                AgentConfig(
                    enabled=False,
                    model="gpt-5.4",
                    base_url="https://example.test/codex",
                    max_candles=25,
                    reasoning_effort="high",
                ),
            )
            replaced = update_agent_config_in_watchlist(
                config_path,
                AgentConfig(enabled=True, model="gpt-5.4-mini", max_candles=40),
            )
            config = load_config(config_path)

        self.assertTrue(inserted)
        self.assertTrue(replaced)
        self.assertTrue(config.agent.enabled)
        self.assertEqual(config.agent.model, "gpt-5.4-mini")
        self.assertIsNone(config.agent.base_url)

    def test_update_analysis_config_in_watchlist_inserts_and_replaces_table(self) -> None:
        """Verify K-line analysis settings persist in TOML."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC" },
                    ]
                    """
                ).strip()
            )

            inserted = update_analysis_config_in_watchlist(
                config_path,
                AnalysisConfig(interval="15m", lookback=60, poll_interval_seconds=20),
            )
            replaced = update_analysis_config_in_watchlist(
                config_path,
                AnalysisConfig(interval="1H", lookback=40, poll_interval_seconds=30),
            )
            config = load_config(config_path)

        self.assertTrue(inserted)
        self.assertTrue(replaced)
        self.assertEqual(config.analysis.interval, "1H")
        self.assertEqual(config.analysis.lookback, 40)


if __name__ == "__main__":
    unittest.main()
