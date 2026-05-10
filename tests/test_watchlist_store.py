"""Test persistent watchlist add and remove helpers."""
import tempfile
import textwrap
import unittest
from pathlib import Path

from mytradebot.config import AgentConfig, AnalysisConfig, ProviderProfile, load_config
from mytradebot.config.watchlist_store import (
    append_bitget_symbol_to_watchlist,
    remove_symbol_from_watchlist,
    update_agent_config_in_watchlist,
    update_analysis_config_in_watchlist,
    update_instrument_analysis_interval_in_watchlist,
)


class WatchlistStoreTests(unittest.TestCase):
    """Group tests for WatchlistStoreTests."""
    def test_append_bitget_symbol_to_watchlist(self) -> None:
        """Verify append bitget symbol to watchlist."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "ETHUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "ETH" },
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

    def test_remove_symbol_from_watchlist_removes_bitget_by_inst_type(self) -> None:
        """Verify generic remove handles Bitget source and inst_type."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "BTCPERP", source = "bitget", inst_type = "USDC-FUTURES", label = "BTC USDC" },
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
        self.assertEqual(config.instruments[0].inst_type, "USDC-FUTURES")

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

    def test_update_agent_config_in_watchlist_persists_anthropic_connection(self) -> None:
        """Verify Anthropic API key and optional base URL persist in provider profile."""
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

            update_agent_config_in_watchlist(
                config_path,
                AgentConfig(
                    provider="anthropic",
                    api_mode="anthropic_messages",
                    model="global.anthropic.claude-opus-4-6-v1",
                    provider_profiles={
                        "anthropic": ProviderProfile(
                            enabled=True,
                            models=("global.anthropic.claude-opus-4-6-v1",),
                            api_key="sk-ant-test",
                            base_url="https://example.test/v1",
                        ),
                    },
                ),
            )
            config = load_config(config_path)
            persisted_text = config_path.read_text()

        profile = config.agent.provider_profiles["anthropic"]
        self.assertEqual(profile.api_key, "sk-ant-test")
        self.assertEqual(profile.base_url, "https://example.test/v1")
        self.assertIn('api_key = "sk-ant-test"', persisted_text)
        self.assertIn('base_url = "https://example.test/v1"', persisted_text)

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
                      { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC" },
                      { symbol = "ETHUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "ETH" },
                    ]
                    """
                ).strip()
            )

            changed = update_instrument_analysis_interval_in_watchlist(
                config_path,
                source="bitget",
                symbol="BTCUSDT",
                inst_type="USDT-FUTURES",
                interval="15m",
            )
            config = load_config(config_path)

        self.assertTrue(changed)
        self.assertEqual(config.instruments[0].analysis_interval, "15m")
        self.assertIsNone(config.instruments[1].analysis_interval)


if __name__ == "__main__":
    unittest.main()
