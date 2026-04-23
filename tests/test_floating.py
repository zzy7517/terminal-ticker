import unittest

from terminal_ticker.bitget import BitgetInstrument
from terminal_ticker.floating import build_ticker_text
from terminal_ticker.models import QuoteState


class FloatingTests(unittest.TestCase):
    def test_build_ticker_text_uses_symbol_and_price_only(self) -> None:
        instruments = (
            BitgetInstrument("MUUSDT", "USDT-FUTURES", "MU", "MU", "USDT", "perp"),
            BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp"),
        )
        quotes = {
            "USDT-FUTURES:MUUSDT": QuoteState(symbol="MU", display_name="MU", price=478.91),
            "USDT-FUTURES:BTCUSDT": QuoteState(symbol="BTC", display_name="BTC", price=78001.5),
        }

        text = build_ticker_text(instruments, quotes)

        self.assertEqual(text, "MU 478.91  •  BTC 78001.50")

    def test_build_ticker_text_uses_placeholder_when_price_missing(self) -> None:
        instruments = (
            BitgetInstrument("XAUUSDT", "USDT-FUTURES", "XAU", "XAU", "USDT", "perp"),
        )
        quotes = {
            "USDT-FUTURES:XAUUSDT": QuoteState(symbol="XAU", display_name="XAU", price=None),
        }

        text = build_ticker_text(instruments, quotes)

        self.assertEqual(text, "XAU -")


if __name__ == "__main__":
    unittest.main()
