import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from terminal_ticker.bitget import BitgetInstrument
from terminal_ticker.config import AppConfig, DisplayConfig
from terminal_ticker.controller import DrainResult
from terminal_ticker.floating import FloatingTickerWindow, build_ticker_items
from terminal_ticker.models import QuoteState


class FakeController:
    def __init__(self, quotes) -> None:
        self.quotes = quotes
        self.stream_status = "idle"
        self.last_message_at = None

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass

    def drain_events(self) -> DrainResult:
        return DrainResult(dirty=False, flash_directions={})


class FloatingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_build_ticker_items_use_symbol_and_price_only(self) -> None:
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
        instruments = (
            BitgetInstrument("XAUUSDT", "USDT-FUTURES", "XAU", "XAU", "USDT", "perp"),
        )
        quotes = {
            "USDT-FUTURES:XAUUSDT": QuoteState(symbol="XAU", display_name="XAU", price=None),
        }

        items = build_ticker_items(instruments, quotes)

        self.assertEqual(items, ["XAU -"])

    def test_window_toggle_switches_between_body_and_ticker(self) -> None:
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

        window._toggle_collapsed()

        self.assertTrue(window.body.isHidden())
        self.assertFalse(window.ticker_tape.isHidden())
        self.assertTrue(window.info_label.isHidden())
        self.assertEqual(window.toggle_button.text(), "+")

        window.close()

    def test_collapsed_window_does_not_expand_on_ticker_click(self) -> None:
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
