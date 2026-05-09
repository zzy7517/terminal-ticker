"""Test watchlist configuration parsing."""
import tempfile
import textwrap
import unittest
from pathlib import Path

from mytradebot.config import build_runtime_config, load_config, parse_config
from mytradebot.config.agent_models import DEFAULT_CODEX_MODEL


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

    def test_parse_config_rejects_removed_sources(self) -> None:
        """Verify removed market-data sources are rejected at config load time."""
        with self.assertRaisesRegex(
            ValueError,
            "source must be one of: bitget, hyperliquid-testnet",
        ):
            parse_config(
                {
                    "symbols": [
                        {"symbol": "AAPL", "source": "legacy", "label": "Apple"},
                    ],
                }
            )

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

    def test_parse_config_supports_cache_defaults_and_overrides(self) -> None:
        """Verify parse config supports local candle cache settings."""
        default_config = parse_config({"symbols": ["SPOT:BTCUSDT"]})
        self.assertTrue(default_config.cache.enabled)
        self.assertEqual(default_config.cache.candle_retention_seconds, 86_400)
        self.assertIsNone(default_config.cache.path)

        config = parse_config(
            {
                "symbols": ["SPOT:BTCUSDT"],
                "cache": {
                    "enabled": False,
                    "path": "~/tmp/mytradebot-cache.sqlite3",
                    "candle_retention_seconds": 3_600,
                },
            }
        )

        self.assertFalse(config.cache.enabled)
        self.assertEqual(config.cache.path, Path("~/tmp/mytradebot-cache.sqlite3").expanduser())
        self.assertEqual(config.cache.candle_retention_seconds, 3_600)

    def test_parse_config_supports_per_symbol_analysis_interval(self) -> None:
        """Verify individual symbols can override the default K-line interval."""
        config = parse_config(
            {
                "symbols": [
                    {"symbol": "BTCUSDT", "inst_type": "USDT-FUTURES", "analysis_interval": "15m"},
                    {"symbol": "ETHUSDT", "inst_type": "USDT-FUTURES"},
                ],
            }
        )

        self.assertEqual(config.instruments[0].analysis_interval, "15m")
        self.assertIsNone(config.instruments[1].analysis_interval)

    def test_parse_config_supports_agent_defaults_and_overrides(self) -> None:
        """Verify parse config supports LLM agent settings."""
        default_config = parse_config({"symbols": ["SPOT:BTCUSDT"]})
        self.assertTrue(default_config.agent.enabled)
        self.assertEqual(default_config.agent.provider, "codex")
        self.assertEqual(default_config.agent.api_mode, "codex_responses")
        self.assertEqual(default_config.agent.model, DEFAULT_CODEX_MODEL)

        config = parse_config(
            {
                "symbols": ["SPOT:BTCUSDT"],
                "agent": {
                    "enabled": False,
                    "provider": "codex",
                    "api_mode": "codex_responses",
                    "model": "default",
                    "max_candles": 24,
                    "reasoning_effort": "high",
                },
            }
        )

        self.assertFalse(config.agent.enabled)
        self.assertEqual(config.agent.provider, "codex")
        self.assertEqual(config.agent.api_mode, "codex_responses")
        self.assertEqual(config.agent.model, DEFAULT_CODEX_MODEL)
        self.assertEqual(config.agent.max_candles, 24)
        self.assertEqual(config.agent.reasoning_effort, "high")

        anthropic_config = parse_config(
            {
                "symbols": ["SPOT:BTCUSDT"],
                "agent": {
                    "provider": "anthropic",
                    "api_mode": "anthropic_messages",
                    "model": "global.anthropic.claude-opus-4-6-v1",
                },
            }
        )

        self.assertEqual(anthropic_config.agent.provider, "anthropic")
        self.assertEqual(anthropic_config.agent.api_mode, "anthropic_messages")

    def test_parse_config_supports_memory_defaults_and_overrides(self) -> None:
        """Verify parse config supports local memory settings."""
        default_config = parse_config({"symbols": ["SPOT:BTCUSDT"]})
        self.assertFalse(default_config.memory.enabled)
        self.assertTrue(default_config.memory.use_memories)
        self.assertTrue(default_config.memory.generate_memories)

        config = parse_config(
            {
                "symbols": ["SPOT:BTCUSDT"],
                "memory": {
                    "enabled": True,
                    "use_memories": False,
                    "generate_memories": True,
                },
            }
        )

        self.assertTrue(config.memory.enabled)
        self.assertFalse(config.memory.use_memories)
        self.assertTrue(config.memory.generate_memories)

    def test_parse_config_news_defaults_when_absent(self) -> None:
        """Verify NewsConfig defaults when the [news] section is absent."""
        config = parse_config({"symbols": [{"symbol": "BTCUSDT", "inst_type": "USDT-FUTURES"}]})
        self.assertFalse(config.news.enabled)
        self.assertEqual(config.news.poll_interval_seconds, 30)
        self.assertEqual(config.news.recent_limit, 50)
        self.assertTrue(config.news.reuters_url.startswith("https://"))

    def test_parse_config_news_section_overrides(self) -> None:
        """Verify NewsConfig honors [news] overrides."""
        config = parse_config({
            "symbols": [{"symbol": "BTCUSDT", "inst_type": "USDT-FUTURES"}],
            "news": {
                "enabled": True,
                "poll_interval_seconds": 45,
                "max_interval_seconds": 300,
                "recent_limit": 100,
                "retention_days": 7,
                "reuters_url": "https://example/sitemap.xml",
            },
        })
        self.assertTrue(config.news.enabled)
        self.assertEqual(config.news.poll_interval_seconds, 45)
        self.assertEqual(config.news.max_interval_seconds, 300)
        self.assertEqual(config.news.recent_limit, 100)
        self.assertEqual(config.news.retention_days, 7)
        self.assertEqual(config.news.reuters_url, "https://example/sitemap.xml")

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
