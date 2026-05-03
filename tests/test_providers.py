"""Test provider routing behavior."""
import unittest
from unittest.mock import patch

from terminal_ticker.market_data.alpaca import AlpacaInstrument
from terminal_ticker.market_data.bitget import BitgetInstrument
from terminal_ticker.config import InstrumentConfig
from terminal_ticker.market_data.router import resolve_instruments


class ProviderTests(unittest.TestCase):
    """Group tests for ProviderTests."""
    def test_resolve_alpaca_only_does_not_load_bitget_catalog(self) -> None:
        """Verify resolve alpaca only does not load bitget catalog."""
        configs = (
            InstrumentConfig(
                symbol="AAPL",
                source="alpaca",
                label="AAPL",
                group="watchlist",
            ),
        )

        with patch("terminal_ticker.market_data.router.bitget.resolve_instruments") as bitget_resolve:
            instruments = resolve_instruments(configs)

        bitget_resolve.assert_not_called()
        self.assertEqual(instruments[0].key, "alpaca:AAPL")
        self.assertEqual(instruments[0].group, "watchlist")

    def test_resolve_mixed_sources_preserves_watchlist_order(self) -> None:
        """Verify resolve mixed sources preserves watchlist order."""
        configs = (
            InstrumentConfig(symbol="AAPL", source="alpaca", label="AAPL"),
            InstrumentConfig(symbol="BTCUSDT", source="bitget", inst_type="USDT-FUTURES"),
        )
        alpaca_instrument = AlpacaInstrument("AAPL", "AAPL")
        bitget_instrument = BitgetInstrument(
            "BTCUSDT",
            "USDT-FUTURES",
            "BTCUSDT",
            "BTC",
            "USDT",
            "perp",
        )

        with patch(
            "terminal_ticker.market_data.router.alpaca.resolve_instruments",
            return_value=(alpaca_instrument,),
        ):
            with patch(
                "terminal_ticker.market_data.router.bitget.resolve_instruments",
                return_value=(bitget_instrument,),
            ):
                instruments = resolve_instruments(configs)

        self.assertEqual(
            [instrument.key for instrument in instruments],
            ["alpaca:AAPL", "USDT-FUTURES:BTCUSDT"],
        )

if __name__ == "__main__":
    unittest.main()
