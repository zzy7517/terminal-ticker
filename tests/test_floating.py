"""Test floating ticker UI behavior."""
import os
import tempfile
import textwrap
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from terminal_ticker.bitget import BitgetInstrument
from terminal_ticker.config import AppConfig, DisplayConfig, InstrumentConfig, load_config
from terminal_ticker.controller import DrainResult
from terminal_ticker.floating import FloatingTickerWindow, build_ticker_items, group_instruments
from terminal_ticker.longbridge_provider import LongbridgeInstrument, LongbridgeSecurity
from terminal_ticker.models import QuoteState


class FakeController:
    """Provide a minimal controller double for UI tests."""
    def __init__(self, quotes) -> None:
        """Initialize fake quote state for UI tests."""
        self.quotes = quotes
        self.stream_status = "idle"
        self.last_message_at = None

    def start(self) -> None:
        """Satisfy the controller start interface without side effects."""
        pass

    def stop(self) -> None:
        """Satisfy the controller stop interface without side effects."""
        pass

    def drain_events(self) -> DrainResult:
        """Return an unchanged drain result for UI tests."""
        return DrainResult(dirty=False, flash_directions={})


class FloatingTests(unittest.TestCase):
    """Group tests for FloatingTests."""

    @classmethod
    def setUpClass(cls) -> None:
        """Prepare shared test fixtures."""
        cls.app = QApplication.instance() or QApplication([])

    def test_build_ticker_items_use_symbol_and_price_only(self) -> None:
        """Verify build ticker items use symbol and price only."""
        instruments = (
            BitgetInstrument("MUUSDT", "USDT-FUTURES", "MU", "MU", "USDT", "perp"),
            BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp"),
        )
        quotes = {
            "USDT-FUTURES:MUUSDT": QuoteState(symbol="MU", display_name="MU", price=478.91),
            "USDT-FUTURES:BTCUSDT": QuoteState(symbol="BTC", display_name="BTC", price=78001.5),
        }

        items = build_ticker_items(instruments, quotes)

        self.assertEqual(items, ["MU 478.91", "BTC 78001.50"])

    def test_build_ticker_items_use_placeholder_when_price_missing(self) -> None:
        """Verify build ticker items use placeholder when price missing."""
        instruments = (
            BitgetInstrument("XAUUSDT", "USDT-FUTURES", "XAU", "XAU", "USDT", "perp"),
        )
        quotes = {
            "USDT-FUTURES:XAUUSDT": QuoteState(symbol="XAU", display_name="XAU", price=None),
        }

        items = build_ticker_items(instruments, quotes)

        self.assertEqual(items, ["XAU -"])

    def test_build_ticker_items_respects_show_collapsed(self) -> None:
        """Verify build ticker items respects show collapsed."""
        instruments = (
            BitgetInstrument("MUUSDT", "USDT-FUTURES", "MU", "MU", "USDT", "perp"),
            BitgetInstrument(
                "BTCUSDT",
                "USDT-FUTURES",
                "BTC",
                "BTC",
                "USDT",
                "perp",
                show_collapsed=False,
            ),
        )
        quotes = {
            "USDT-FUTURES:MUUSDT": QuoteState(symbol="MU", display_name="MU", price=478.91),
            "USDT-FUTURES:BTCUSDT": QuoteState(symbol="BTC", display_name="BTC", price=78001.5),
        }

        items = build_ticker_items(instruments, quotes)

        self.assertEqual(items, ["MU 478.91"])

    def test_group_instruments_orders_known_groups_first(self) -> None:
        """Verify group instruments orders known groups first."""
        stock = BitgetInstrument(
            "AAPLUSDT",
            "USDT-FUTURES",
            "AAPL",
            "AAPL",
            "USDT",
            "perp",
            group="stocks",
        )
        crypto = BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp")
        custom = BitgetInstrument(
            "WATCHUSDT",
            "USDT-FUTURES",
            "Watch",
            "WATCH",
            "USDT",
            "perp",
            group="watchlist",
        )

        grouped = group_instruments((crypto, custom, stock))

        self.assertEqual(tuple(grouped), ("stocks", "crypto", "watchlist"))
        self.assertEqual([item.label for item in grouped["stocks"]], ["AAPL"])
        self.assertEqual([item.label for item in grouped["crypto"]], ["BTC"])

    def test_window_toggle_switches_between_body_and_ticker(self) -> None:
        """Verify window toggle switches between body and ticker."""
        instruments = (
            BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp"),
        )
        quotes = {
            instruments[0].key: QuoteState(symbol="BTC", display_name="BTC", price=78001.5),
        }
        window = FloatingTickerWindow(
            AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments,
            controller=FakeController(quotes),
            auto_start=False,
        )

        self.assertFalse(window.body.isHidden())
        self.assertTrue(window.ticker_tape.isHidden())
        self.assertFalse(window.info_label.isHidden())
        self.assertEqual(window.tabs.count(), 2)

        window._toggle_collapsed()

        self.assertTrue(window.body.isHidden())
        self.assertFalse(window.ticker_tape.isHidden())
        self.assertTrue(window.info_label.isHidden())
        self.assertEqual(window.toggle_button.text(), "+")

        window.close()

    def test_stock_tab_uses_chinese_label_and_search_controls(self) -> None:
        """Verify stock tab uses chinese label and search controls."""
        instruments = (
            LongbridgeInstrument("AAPL.US", "AAPL"),
        )
        quotes = {
            instruments[0].key: QuoteState(symbol="AAPL", display_name="AAPL", price=201.5),
        }
        window = FloatingTickerWindow(
            AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments,
            controller=FakeController(quotes),
            auto_start=False,
        )

        self.assertEqual(window.tabs.tabText(0), "美股")
        self.assertEqual(window.search_input.placeholderText(), "搜索代码 / 名称")
        self.assertFalse(window.add_search_button.isEnabled())

        window.close()

    def test_expanded_window_allows_manual_resize(self) -> None:
        """Verify expanded window allows manual resize."""
        instruments = (
            LongbridgeInstrument("AAPL.US", "AAPL"),
        )
        quotes = {
            instruments[0].key: QuoteState(symbol="AAPL", display_name="AAPL", price=201.5),
        }
        window = FloatingTickerWindow(
            AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments,
            controller=FakeController(quotes),
            auto_start=False,
        )

        self.assertGreater(window.maximumHeight(), window.minimumHeight())
        self.assertFalse(window.resize_grip.isHidden())

        window.resize(420, 360)
        self.app.processEvents()
        window._toggle_collapsed()
        self.assertEqual(window.maximumHeight(), window.minimumHeight())
        self.assertTrue(window.resize_grip.isHidden())

        window._toggle_collapsed()
        self.assertEqual(window.width(), 420)
        self.assertEqual(window.height(), 360)
        self.assertGreater(window.maximumHeight(), window.minimumHeight())

        window.close()

    def test_search_results_offer_remove_for_existing_symbols(self) -> None:
        """Verify search results offer remove for existing symbols."""
        instruments = (
            LongbridgeInstrument("AAPL.US", "AAPL"),
        )
        quotes = {
            instruments[0].key: QuoteState(symbol="AAPL", display_name="AAPL", price=201.5),
        }
        window = FloatingTickerWindow(
            AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments,
            controller=FakeController(quotes),
            auto_start=False,
        )

        window.search_queue.put(
            (
                "results",
                "AAPL",
                (LongbridgeSecurity("AAPL.US", name_cn="苹果", name_en="Apple Inc."),),
            )
        )
        window._drain_search_results()

        self.assertEqual(window.search_results.count(), 1)
        self.assertTrue(window.add_search_button.isEnabled())
        self.assertEqual(window.add_search_button.text(), "移除")
        self.assertIn("已添加", window.search_results.item(0).text())

        window.close()

    def test_remove_selected_search_result_updates_runtime_and_watchlist(self) -> None:
        """Verify remove selected search result updates runtime and watchlist."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "AAPL.US", source = "longbridge", label = "AAPL", group = "stocks" },
                      { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC", group = "crypto" },
                    ]
                    """
                ).strip()
            )
            instruments = (
                LongbridgeInstrument("AAPL.US", "AAPL"),
                BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp"),
            )
            quotes = {
                instruments[0].key: QuoteState(symbol="AAPL", display_name="AAPL", price=201.5),
                instruments[1].key: QuoteState(symbol="BTC", display_name="BTC", price=78001.5),
            }
            window = FloatingTickerWindow(
                AppConfig(
                    instruments=(
                        InstrumentConfig(
                            symbol="AAPL.US",
                            source="longbridge",
                            label="AAPL",
                            group="stocks",
                        ),
                        InstrumentConfig(
                            symbol="BTCUSDT",
                            inst_type="USDT-FUTURES",
                            label="BTC",
                            group="crypto",
                        ),
                    ),
                    display=DisplayConfig(),
                    source_path=config_path,
                ),
                instruments,
                controller=FakeController(quotes),
                auto_start=False,
            )

            window.search_queue.put(
                (
                    "results",
                    "AAPL",
                    (LongbridgeSecurity("AAPL.US", name_cn="苹果", name_en="Apple Inc."),),
                )
            )
            window._drain_search_results()
            window.search_results.setCurrentRow(0)
            window._apply_selected_search_result()
            config = load_config(config_path)

            self.assertEqual([item.key for item in window.instruments], ["USDT-FUTURES:BTCUSDT"])
            self.assertEqual([item.symbol for item in config.instruments], ["BTCUSDT"])
            self.assertEqual(window.search_results.count(), 1)
            self.assertEqual(window.add_search_button.text(), "添加")
            self.assertTrue(window.add_search_button.isEnabled())

            window.close()

    def test_collapsed_window_does_not_expand_on_ticker_click(self) -> None:
        """Verify collapsed window does not expand on ticker click."""
        instruments = (
            BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp"),
        )
        quotes = {
            instruments[0].key: QuoteState(symbol="BTC", display_name="BTC", price=78001.5),
        }
        window = FloatingTickerWindow(
            AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments,
            controller=FakeController(quotes),
            auto_start=False,
        )
        window.show()
        self.app.processEvents()

        window._toggle_collapsed()
        self.assertTrue(window.body.isHidden())

        QTest.mouseClick(window.ticker_tape, Qt.LeftButton)
        self.app.processEvents()

        self.assertTrue(window.body.isHidden())
        self.assertEqual(window.toggle_button.text(), "+")

        window.close()


if __name__ == "__main__":
    unittest.main()
