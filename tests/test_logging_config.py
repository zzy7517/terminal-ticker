"""Test application logging configuration."""
import logging
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tradex import __main__ as cli
from tradex.logging_config import configure_logging, normalize_log_level, uvicorn_log_level


class LoggingConfigTests(unittest.TestCase):
    """Group tests for logging configuration."""

    def tearDown(self) -> None:
        """Restore quiet logging after each test."""
        configure_logging("WARNING")

    def test_configure_logging_normalizes_level(self) -> None:
        """Verify string levels are normalized to numeric logging levels."""
        self.assertEqual(configure_logging("debug"), logging.DEBUG)
        self.assertEqual(logging.getLogger("uvicorn").level, logging.DEBUG)
        self.assertEqual(logging.getLogger("uvicorn.access").getEffectiveLevel(), logging.DEBUG)
        self.assertTrue(logging.getLogger("uvicorn.access").propagate)

    def test_normalize_log_level_returns_canonical_name(self) -> None:
        """Verify log level helpers share one normalization path."""
        self.assertEqual(normalize_log_level("warning"), "WARNING")
        self.assertEqual(uvicorn_log_level("WARNING"), "warning")

    def test_cli_accepts_lowercase_log_level(self) -> None:
        """Verify argparse does not reject levels that logging accepts."""
        args = cli.parse_args(["--log-level", "debug", "--symbols", "USDT-FUTURES:BTCUSDT"])
        self.assertEqual(args.log_level, "DEBUG")

    def test_main_uses_project_logging_config_for_uvicorn(self) -> None:
        """Verify Uvicorn does not replace the project logging setup."""
        args = SimpleNamespace(log_level="DEBUG", host="127.0.0.1", port=9876)
        config = SimpleNamespace(instruments=())
        with patch.object(cli, "parse_args", return_value=args), \
            patch.object(cli, "resolve_config", return_value=config), \
            patch.object(cli, "resolve_instruments", return_value=()), \
            patch.object(cli, "create_app", return_value=object()), \
            patch.object(cli.uvicorn, "run") as run:
            self.assertEqual(cli.main(), 0)

        self.assertEqual(run.call_args.kwargs["log_level"], "debug")
        self.assertIsNone(run.call_args.kwargs["log_config"])
        self.assertFalse(run.call_args.kwargs["access_log"])

    def test_configure_logging_rejects_unknown_level(self) -> None:
        """Verify unsupported levels fail clearly."""
        with self.assertRaisesRegex(ValueError, "unsupported log level"):
            configure_logging("chatty")


if __name__ == "__main__":
    unittest.main()
