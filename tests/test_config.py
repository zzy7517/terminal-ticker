import tempfile
import textwrap
import unittest
from pathlib import Path

from deskquotes.config import build_runtime_config, load_config, parse_config


class ConfigTests(unittest.TestCase):
    def test_parse_config_normalizes_symbols(self) -> None:
        config = parse_config(
            {
                "title": "Desk",
                "symbols": ["aapl", " AAPL ", "btc-usd", "gc=f"],
                "display": {"refresh_interval_ms": 500},
            }
        )
        self.assertEqual(config.symbols, ("AAPL", "BTC-USD", "GC=F"))
        self.assertEqual(config.display.refresh_interval_ms, 500)

    def test_build_runtime_requires_symbols(self) -> None:
        with self.assertRaises(ValueError):
            build_runtime_config(None)

    def test_load_config_from_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    title = "Desk Quotes"
                    symbols = ["AAPL", "NVDA"]

                    [display]
                    stale_after_seconds = 15
                    """
                ).strip()
            )
            config = load_config(config_path)

        self.assertEqual(config.title, "Desk Quotes")
        self.assertEqual(config.symbols, ("AAPL", "NVDA"))
        self.assertEqual(config.display.stale_after_seconds, 15)


if __name__ == "__main__":
    unittest.main()
