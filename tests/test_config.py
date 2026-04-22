import tempfile
import textwrap
import unittest
from pathlib import Path

from terminal_ticker.config import build_runtime_config, load_config, parse_config


class ConfigTests(unittest.TestCase):
    def _instrument_rows(self, config):
        return tuple(
            (instrument.symbol, instrument.inst_type, instrument.label)
            for instrument in config.instruments
        )

    def test_parse_config_normalizes_symbols(self) -> None:
        config = parse_config(
            {
                "title": "Desk",
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
                ("BTCUSDT", "SPOT", None),
                ("MUUSDT", "USDT-FUTURES", "MU"),
            ),
        )
        self.assertEqual(config.display.refresh_interval_ms, 500)

    def test_build_runtime_parses_cli_prefix_syntax(self) -> None:
        config = build_runtime_config(
            None,
            cli_symbols=["SPOT:BTCUSDT", "USDT-FUTURES:SPXUSDT"],
        )
        self.assertEqual(
            self._instrument_rows(config),
            (
                ("BTCUSDT", "SPOT", None),
                ("SPXUSDT", "USDT-FUTURES", None),
            ),
        )

    def test_build_runtime_requires_symbols(self) -> None:
        with self.assertRaises(ValueError):
            build_runtime_config(None)

    def test_load_config_from_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    title = "Terminal Ticker"
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

        self.assertEqual(config.title, "Terminal Ticker")
        self.assertEqual(
            self._instrument_rows(config),
            (
                ("MSFTUSDT", "USDT-FUTURES", "MSFT"),
                ("BTCUSDT", "SPOT", "BTC"),
            ),
        )
        self.assertEqual(config.display.stale_after_seconds, 15)


if __name__ == "__main__":
    unittest.main()
