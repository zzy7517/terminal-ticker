"""Test application logging configuration."""
import logging
import unittest

from mytradebot.logging_config import configure_logging


class LoggingConfigTests(unittest.TestCase):
    """Group tests for logging configuration."""

    def tearDown(self) -> None:
        """Restore quiet logging after each test."""
        configure_logging("WARNING")

    def test_configure_logging_normalizes_level(self) -> None:
        """Verify string levels are normalized to numeric logging levels."""
        self.assertEqual(configure_logging("debug"), logging.DEBUG)
        self.assertEqual(logging.getLogger("uvicorn").level, logging.DEBUG)

    def test_configure_logging_rejects_unknown_level(self) -> None:
        """Verify unsupported levels fail clearly."""
        with self.assertRaisesRegex(ValueError, "unsupported log level"):
            configure_logging("chatty")


if __name__ == "__main__":
    unittest.main()
