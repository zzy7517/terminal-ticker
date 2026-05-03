"""Test persistent watchlist add and remove helpers."""
import tempfile
import textwrap
import unittest
from pathlib import Path

from terminal_ticker.config import AgentConfig, AnalysisConfig, load_config
from terminal_ticker.watchlist_store import (
    append_alpaca_symbol_to_watchlist,
    append_bitget_symbol_to_watchlist,
    append_longbridge_symbol_to_watchlist,
    remove_alpaca_symbol_from_watchlist,
    remove_longbridge_symbol_from_watchlist,
    remove_symbol_from_watchlist,
    update_agent_config_in_watchlist,
    update_analysis_config_in_watchlist,
    update_instrument_analysis_interval_in_watchlist,
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

    def test_append_bitget_symbol_to_watchlist(self) -> None:
        """Verify append bitget symbol to watchlist."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "AAPL.US", source = "longbridge", label = "AAPL" },
                    ]
                    """
                ).strip()
            )

            inserted = append_bitget_symbol_to_watchlist(
                config_path,
                symbol="btcusdt",
                inst_type="usdt-futures",
                label="BTC",
            )
            duplicate = append_bitget_symbol_to_watchlist(
                config_path,
                symbol="BTCUSDT",
                inst_type="USDT-FUTURES",
                label="BTC",
            )
            config = load_config(config_path)

        self.assertTrue(inserted)
        self.assertFalse(duplicate)
        self.assertEqual(config.instruments[1].symbol, "BTCUSDT")
        self.assertEqual(config.instruments[1].source, "bitget")
        self.assertEqual(config.instruments[1].inst_type, "USDT-FUTURES")
        self.assertEqual(config.instruments[1].group, "crypto")

    def test_append_alpaca_symbol_to_watchlist(self) -> None:
        """Verify append alpaca symbol to watchlist."""
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

            inserted = append_alpaca_symbol_to_watchlist(
                config_path,
                symbol="aapl.us",
                label="AAPL",
            )
            duplicate = append_alpaca_symbol_to_watchlist(
                config_path,
                symbol="AAPL",
                label="AAPL",
            )
            config = load_config(config_path)

        self.assertTrue(inserted)
        self.assertFalse(duplicate)
        self.assertEqual(config.instruments[1].symbol, "AAPL")
        self.assertEqual(config.instruments[1].source, "alpaca")
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

    def test_remove_alpaca_symbol_from_watchlist_only_removes_exact_source_match(self) -> None:
        """Verify remove alpaca symbol from watchlist only removes exact source match."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "AAPL", source = "alpaca", label = "AAPL", group = "stocks" },
                      { symbol = "AAPL.US", source = "longbridge", label = "AAPL", group = "stocks" },
                      { symbol = "AAPLUSDT", inst_type = "USDT-FUTURES", label = "AAPL" },
                    ]
                    """
                ).strip()
            )

            removed = remove_alpaca_symbol_from_watchlist(config_path, symbol="aapl.us")
            missing = remove_alpaca_symbol_from_watchlist(config_path, symbol="MSFT")
            config = load_config(config_path)

        self.assertTrue(removed)
        self.assertFalse(missing)
        self.assertEqual([item.source for item in config.instruments], ["longbridge", "bitget"])

    def test_remove_symbol_from_watchlist_removes_bitget_by_inst_type(self) -> None:
        """Verify generic remove handles Bitget source and inst_type."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "BTCUSDT", source = "bitget", inst_type = "SPOT", label = "BTC Spot" },
                      { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC Perp" },
                    ]
                    """
                ).strip()
            )

            removed = remove_symbol_from_watchlist(
                config_path,
                source="bitget",
                symbol="BTCUSDT",
                inst_type="USDT-FUTURES",
            )
            config = load_config(config_path)

        self.assertTrue(removed)
        self.assertEqual(len(config.instruments), 1)
        self.assertEqual(config.instruments[0].inst_type, "SPOT")

    def test_remove_symbol_from_watchlist_rejects_last_symbol(self) -> None:
        """Verify generic remove keeps at least one watchlist symbol."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC" },
                    ]
                    """
                ).strip()
            )

            with self.assertRaisesRegex(ValueError, "cannot remove the last watchlist symbol"):
                remove_symbol_from_watchlist(
                    config_path,
                    source="bitget",
                    symbol="BTCUSDT",
                    inst_type="USDT-FUTURES",
                )
            config = load_config(config_path)

        self.assertEqual(len(config.instruments), 1)
        self.assertEqual(config.instruments[0].symbol, "BTCUSDT")

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
                    max_candles=25,
                    reasoning_effort="high",
                ),
            )
            replaced = update_agent_config_in_watchlist(
                config_path,
                AgentConfig(enabled=True, model="gpt-5.4-mini", max_candles=40),
            )
            config = load_config(config_path)
            persisted_text = config_path.read_text()

        self.assertTrue(inserted)
        self.assertTrue(replaced)
        self.assertTrue(config.agent.enabled)
        self.assertEqual(config.agent.model, "gpt-5.4-mini")
        self.assertNotIn("base_url", persisted_text)

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

    def test_update_instrument_analysis_interval_only_changes_matching_symbol(self) -> None:
        """Verify per-symbol K-line interval persistence."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "AAPL.US", source = "longbridge", label = "AAPL", group = "stocks" },
                      { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC" },
                    ]
                    """
                ).strip()
            )

            changed = update_instrument_analysis_interval_in_watchlist(
                config_path,
                source="longbridge",
                symbol="AAPL.US",
                inst_type=None,
                interval="15m",
            )
            config = load_config(config_path)

        self.assertTrue(changed)
        self.assertEqual(config.instruments[0].analysis_interval, "15m")
        self.assertIsNone(config.instruments[1].analysis_interval)


if __name__ == "__main__":
    unittest.main()
