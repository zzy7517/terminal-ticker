"""Test Longbridge provider normalization and search."""
import os
import unittest
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from terminal_ticker.config import InstrumentConfig
from terminal_ticker.longbridge_provider import (
    _build_quote_context,
    clear_security_list_cache,
    LongbridgeInstrument,
    fetch_candles,
    fetch_quote_payloads,
    resolve_instruments,
    search_securities,
)


class FakeQuoteContext:
    """Provide quote responses without calling Longbridge."""
    def __init__(self, quotes) -> None:
        """Store fake quote rows for provider tests."""
        self.quotes = quotes
        self.requested_symbols = None

    def quote(self, symbols):
        """Return fake quote rows and record requested symbols."""
        self.requested_symbols = symbols
        return self.quotes


class FakeCandleContext:
    """Provide candle responses without calling Longbridge."""
    def __init__(self, candles) -> None:
        """Store fake candle rows."""
        self.candles = candles
        self.request = None
        self.history_request = None

    def candlesticks(self, symbol, period, count, adjust_type, trade_sessions):
        """Return fake candles and record request arguments."""
        self.request = (symbol, period, count, adjust_type, trade_sessions)
        return self.candles

    def history_candlesticks_by_offset(
        self,
        symbol,
        period,
        adjust_type,
        forward,
        count,
        time,
        trade_sessions,
    ):
        """Return fake historical candles and record request arguments."""
        self.history_request = (symbol, period, adjust_type, forward, count, time, trade_sessions)
        return self.candles


class FakeSecurityContext:
    """Provide security-list responses without calling Longbridge."""
    def __init__(self, securities) -> None:
        """Store fake securities and request tracking fields."""
        self.securities = securities
        self.requested_market = None
        self.requested_category = None

    def security_list(self, market, category):
        """Return fake securities and record list parameters."""
        self.requested_market = market
        self.requested_category = category
        return self.securities


class FakeExactSearchContext:
    """Provide static-info responses for exact search tests."""
    def __init__(self, static_items) -> None:
        """Store fake static-info rows and call flags."""
        self.static_items = static_items
        self.static_symbols = None
        self.security_list_called = False

    def static_info(self, symbols):
        """Return fake static-info rows and record requested symbols."""
        self.static_symbols = symbols
        return self.static_items

    def security_list(self, market, category):
        """Record unexpected fallback list calls."""
        self.security_list_called = True
        return []


class FakeConfig:
    """Stand in for the Longbridge SDK config class."""

    @classmethod
    def from_apikey_env(cls):
        """Return a fake Longbridge SDK config object."""
        return "fake-config"


class FakeQuoteContextFactory:
    """Stand in for the Longbridge SDK quote context constructor."""
    def __init__(self, config):
        """Record the config passed to the fake quote context."""
        self.config = config


class LongbridgeProviderTests(unittest.TestCase):
    """Group tests for LongbridgeProviderTests."""
    def tearDown(self) -> None:
        """Clean up shared test fixtures."""
        clear_security_list_cache()

    def test_fetch_quote_payloads_batches_symbols_and_normalizes_quotes(self) -> None:
        """Verify fetch quote payloads batches symbols and normalizes quotes."""
        instruments = (
            LongbridgeInstrument("AAPL.US", "AAPL"),
            LongbridgeInstrument("SPY.US", "SPY"),
        )
        quote_context = FakeQuoteContext(
            [
                SimpleNamespace(
                    symbol="AAPL.US",
                    last_done=Decimal("201.50"),
                    prev_close=Decimal("200.25"),
                    high=Decimal("202.00"),
                    low=Decimal("199.80"),
                    volume=123456,
                    trade_status="Normal",
                    timestamp=1776846198,
                ),
                {
                    "symbol": "SPY.US",
                    "last_done": "500.25",
                    "prev_close": "499.25",
                    "volume": "654321",
                },
            ]
        )

        payloads = fetch_quote_payloads(instruments, quote_context=quote_context)

        self.assertEqual(quote_context.requested_symbols, ["AAPL.US", "SPY.US"])
        self.assertEqual(payloads["longbridge:AAPL.US"]["price"], 201.5)
        self.assertAlmostEqual(payloads["longbridge:AAPL.US"]["change"], 1.25)
        self.assertAlmostEqual(payloads["longbridge:AAPL.US"]["change_percent"], 0.6242, places=4)
        self.assertEqual(payloads["longbridge:AAPL.US"]["exchange"], "Longbridge")
        self.assertEqual(payloads["longbridge:SPY.US"]["price"], 500.25)

    def test_fetch_quote_payloads_handles_empty_input_without_context(self) -> None:
        """Verify fetch quote payloads handles empty input without context."""
        self.assertEqual(fetch_quote_payloads(tuple(), quote_context=FakeQuoteContext([])), {})

    def test_fetch_candles_normalizes_longbridge_candles(self) -> None:
        """Verify fetch candles normalizes longbridge candles."""
        context = FakeCandleContext(
            [
                SimpleNamespace(
                    timestamp=1776846000,
                    open=Decimal("200.00"),
                    high=Decimal("202.00"),
                    low=Decimal("199.50"),
                    close=Decimal("201.25"),
                    volume=12345,
                )
            ]
        )
        instrument = LongbridgeInstrument("AAPL.US", "AAPL")

        with patch("terminal_ticker.longbridge_provider._period_for_interval", return_value="5m"):
            with patch("terminal_ticker.longbridge_provider._no_adjust_type", return_value="none"):
                with patch("terminal_ticker.longbridge_provider._all_trade_sessions", return_value="all"):
                    candles = fetch_candles(
                        instrument,
                        interval="5m",
                        limit=40,
                        quote_context=context,
                    )

        self.assertEqual(context.request, ("AAPL.US", "5m", 40, "none", "all"))
        self.assertEqual(candles[0].symbol_key, "longbridge:AAPL.US")
        self.assertEqual(candles[0].open_time_ms, 1776846000000)
        self.assertEqual(candles[0].open, 200.0)
        self.assertEqual(candles[0].high, 202.0)
        self.assertEqual(candles[0].low, 199.5)
        self.assertEqual(candles[0].close, 201.25)
        self.assertEqual(candles[0].volume, 12345)

    def test_fetch_candles_after_uses_history_offset(self) -> None:
        """Verify incremental Longbridge fetches request history after cached time."""
        context = FakeCandleContext(
            [
                SimpleNamespace(
                    timestamp=1776846000,
                    open=Decimal("200.00"),
                    high=Decimal("202.00"),
                    low=Decimal("199.50"),
                    close=Decimal("201.25"),
                    volume=12345,
                ),
                SimpleNamespace(
                    timestamp=1776846300,
                    open=Decimal("201.25"),
                    high=Decimal("203.00"),
                    low=Decimal("201.00"),
                    close=Decimal("202.50"),
                    volume=23456,
                ),
            ]
        )
        instrument = LongbridgeInstrument("AAPL.US", "AAPL")

        with patch("terminal_ticker.longbridge_provider._period_for_interval", return_value="5m"):
            with patch("terminal_ticker.longbridge_provider._no_adjust_type", return_value="none"):
                with patch("terminal_ticker.longbridge_provider._all_trade_sessions", return_value="all"):
                    candles = fetch_candles(
                        instrument,
                        interval="5m",
                        limit=40,
                        quote_context=context,
                        after_open_time_ms=1776846000000,
                    )

        self.assertIsNone(context.request)
        self.assertEqual(context.history_request[:5], ("AAPL.US", "5m", "none", False, 40))
        self.assertEqual([candle.open_time_ms for candle in candles], [1776846300000])

    def test_resolve_instruments_preserves_collapsed_default(self) -> None:
        """Verify resolve instruments preserves collapsed default."""
        instruments = resolve_instruments(
            (
                InstrumentConfig(
                    symbol="AAPL.US",
                    source="longbridge",
                    label="AAPL",
                    show_collapsed=False,
                    group="watchlist",
                ),
            )
        )

        self.assertEqual(instruments[0].key, "longbridge:AAPL.US")
        self.assertFalse(instruments[0].show_collapsed)
        self.assertEqual(instruments[0].group, "watchlist")

    def test_quote_context_defaults_to_cn_region_without_overriding_existing_env(self) -> None:
        """Verify quote context defaults to cn region without overriding existing env."""
        with patch.dict(os.environ, {}, clear=True):
            with patch(
                "terminal_ticker.longbridge_provider._openapi",
                return_value=(FakeConfig, FakeQuoteContextFactory),
            ):
                context = _build_quote_context()
            self.assertEqual(os.environ["LONGBRIDGE_REGION"], "cn")
            self.assertEqual(os.environ["LONGBRIDGE_PRINT_QUOTE_PACKAGES"], "false")
            self.assertEqual(context.config, "fake-config")

        with patch.dict(os.environ, {"LONGBRIDGE_REGION": "hk"}, clear=True):
            with patch(
                "terminal_ticker.longbridge_provider._openapi",
                return_value=(FakeConfig, FakeQuoteContextFactory),
            ):
                _build_quote_context()
            self.assertEqual(os.environ["LONGBRIDGE_REGION"], "hk")

        with patch.dict(os.environ, {"LONGBRIDGE_PRINT_QUOTE_PACKAGES": "true"}, clear=True):
            with patch(
                "terminal_ticker.longbridge_provider._openapi",
                return_value=(FakeConfig, FakeQuoteContextFactory),
            ):
                _build_quote_context()
            self.assertEqual(os.environ["LONGBRIDGE_PRINT_QUOTE_PACKAGES"], "true")

    def test_search_securities_filters_local_security_list(self) -> None:
        """Verify search securities filters local security list."""
        context = FakeSecurityContext(
            [
                SimpleNamespace(
                    symbol="AAPL.US",
                    name_cn="苹果",
                    name_hk="蘋果",
                    name_en="Apple Inc.",
                ),
                SimpleNamespace(
                    symbol="AAP.US",
                    name_cn="Advance Auto Parts",
                    name_hk="",
                    name_en="Advance Auto Parts",
                ),
                SimpleNamespace(
                    symbol="MSFT.US",
                    name_cn="微软",
                    name_hk="微軟",
                    name_en="Microsoft",
                ),
            ]
        )

        with patch("terminal_ticker.longbridge_provider._market_us", return_value="US"):
            with patch("terminal_ticker.longbridge_provider._security_list_category", return_value="Overnight"):
                results = search_securities("apple", quote_context=context)

        self.assertEqual(context.requested_market, "US")
        self.assertEqual(context.requested_category, "Overnight")
        self.assertEqual([item.symbol for item in results], ["AAPL.US"])
        self.assertEqual(results[0].default_label, "AAPL")
        self.assertIn("苹果", results[0].display_text())

    def test_search_securities_uses_static_info_for_symbol_query(self) -> None:
        """Verify search securities uses static info for symbol query."""
        context = FakeExactSearchContext(
            [
                SimpleNamespace(
                    symbol="NVDA.US",
                    name_cn="英伟达",
                    name_hk="英偉達",
                    name_en="NVIDIA",
                )
            ]
        )

        results = search_securities("NVDA", quote_context=context)

        self.assertEqual(context.static_symbols, ["NVDA.US"])
        self.assertFalse(context.security_list_called)
        self.assertEqual([item.symbol for item in results], ["NVDA.US"])


if __name__ == "__main__":
    unittest.main()
