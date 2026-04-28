"""Test watchlist configuration parsing."""
import tempfile
import textwrap
import unittest
from pathlib import Path

from terminal_ticker.config import build_runtime_config, load_config, parse_config


class ConfigTests(unittest.TestCase):
    """Group tests for ConfigTests."""
    def _instrument_rows(self, config):
        """Provide helper behavior for instrument rows."""
        return tuple(
            (
                instrument.symbol,
                instrument.source,
                instrument.inst_type,
                instrument.label,
                instrument.group,
            )
            for instrument in config.instruments
        )

    def test_parse_config_normalizes_symbols(self) -> None:
        """Verify parse config normalizes symbols."""
        config = parse_config(
            {
                "symbols": [
                    "SPOT:btcusdt",
                    " SPOT:BTCUSDT ",
                    {"symbol": "muusdt", "inst_type": "usdt-futures", "label": "MU"},
                ],
                "display": {"refresh_interval_ms": 500},
            }
        )
        self.assertEqual(
            self._instrument_rows(config),
            (
                ("BTCUSDT", "bitget", "SPOT", None, "crypto"),
                ("MUUSDT", "bitget", "USDT-FUTURES", "MU", "crypto"),
            ),
        )
        self.assertEqual(config.display.refresh_interval_ms, 500)

    def test_build_runtime_parses_cli_prefix_syntax(self) -> None:
        """Verify build runtime parses cli prefix syntax."""
        config = build_runtime_config(
            None,
            cli_symbols=["SPOT:BTCUSDT", "USDT-FUTURES:SPXUSDT"],
        )
        self.assertEqual(
            self._instrument_rows(config),
            (
                ("BTCUSDT", "bitget", "SPOT", None, "crypto"),
                ("SPXUSDT", "bitget", "USDT-FUTURES", None, "crypto"),
            ),
        )

    def test_parse_config_supports_longbridge_source_and_collapsed_defaults(self) -> None:
        """Verify parse config supports longbridge source and collapsed defaults."""
        config = parse_config(
            {
                "symbols": [
                    {"symbol": "aapl.us", "source": "longbridge", "label": "Apple"},
                    {
                        "symbol": "spy.us",
                        "source": "longbridge",
                        "label": "SPY",
                        "show_collapsed": False,
                        "group": "watchlist",
                    },
                ],
                "display": {"longbridge_poll_interval_seconds": 2},
            }
        )

        self.assertEqual(
            self._instrument_rows(config),
            (
                ("AAPL.US", "longbridge", None, "Apple", "stocks"),
                ("SPY.US", "longbridge", None, "SPY", "watchlist"),
            ),
        )
        self.assertTrue(config.instruments[0].show_collapsed)
        self.assertFalse(config.instruments[1].show_collapsed)
        self.assertEqual(config.display.longbridge_poll_interval_seconds, 2)

    def test_parse_config_supports_analysis_defaults_and_overrides(self) -> None:
        """Verify parse config supports analysis defaults and overrides."""
        default_config = parse_config({"symbols": ["SPOT:BTCUSDT"]})
        self.assertTrue(default_config.analysis.enabled)
        self.assertEqual(default_config.analysis.interval, "5m")
        self.assertEqual(default_config.analysis.lookback, 40)

        config = parse_config(
            {
                "symbols": ["SPOT:BTCUSDT"],
                "analysis": {
                    "enabled": False,
                    "interval": "15m",
                    "lookback": 24,
                    "poll_interval_seconds": 45,
                    "stale_after_seconds": 180,
                },
            }
        )

        self.assertFalse(config.analysis.enabled)
        self.assertEqual(config.analysis.interval, "15m")
        self.assertEqual(config.analysis.lookback, 24)
        self.assertEqual(config.analysis.poll_interval_seconds, 45)
        self.assertEqual(config.analysis.stale_after_seconds, 180)

    def test_build_runtime_requires_symbols(self) -> None:
        """Verify build runtime requires symbols."""
        with self.assertRaises(ValueError):
            build_runtime_config(None)

    def test_load_config_from_file(self) -> None:
        """Verify load config from file."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "MSFTUSDT", inst_type = "USDT-FUTURES", label = "MSFT" },
                      { symbol = "BTCUSDT", inst_type = "SPOT", label = "BTC" },
                    ]

                    [display]
                    stale_after_seconds = 15
                    """
                ).strip()
            )
            config = load_config(config_path)

        self.assertEqual(
            self._instrument_rows(config),
            (
                ("MSFTUSDT", "bitget", "USDT-FUTURES", "MSFT", "crypto"),
                ("BTCUSDT", "bitget", "SPOT", "BTC", "crypto"),
            ),
        )
        self.assertEqual(config.display.stale_after_seconds, 15)


if __name__ == "__main__":
    unittest.main()
