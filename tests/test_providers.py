"""Test provider routing behavior."""
import unittest
from unittest.mock import patch

from terminal_ticker.bitget import BitgetInstrument
from terminal_ticker.config import InstrumentConfig
from terminal_ticker.providers import resolve_instruments


class ProviderTests(unittest.TestCase):
    """Group tests for ProviderTests."""
    def test_resolve_longbridge_only_does_not_load_bitget_catalog(self) -> None:
        """Verify resolve longbridge only does not load bitget catalog."""
        configs = (
            InstrumentConfig(
                symbol="AAPL.US",
                source="longbridge",
                label="AAPL",
                group="watchlist",
            ),
        )

        with patch("terminal_ticker.providers.bitget.resolve_instruments") as bitget_resolve:
            instruments = resolve_instruments(configs)

        bitget_resolve.assert_not_called()
        self.assertEqual(instruments[0].key, "longbridge:AAPL.US")
        self.assertEqual(instruments[0].group, "watchlist")

    def test_resolve_mixed_sources_preserves_watchlist_order(self) -> None:
        """Verify resolve mixed sources preserves watchlist order."""
        configs = (
            InstrumentConfig(symbol="AAPL.US", source="longbridge", label="AAPL"),
            InstrumentConfig(symbol="BTCUSDT", source="bitget", inst_type="USDT-FUTURES"),
        )
        bitget_instrument = BitgetInstrument(
            "BTCUSDT",
            "USDT-FUTURES",
            "BTCUSDT",
            "BTC",
            "USDT",
            "perp",
        )

        with patch(
            "terminal_ticker.providers.bitget.resolve_instruments",
            return_value=(bitget_instrument,),
        ):
            instruments = resolve_instruments(configs)

        self.assertEqual(
            [instrument.key for instrument in instruments],
            ["longbridge:AAPL.US", "USDT-FUTURES:BTCUSDT"],
        )


if __name__ == "__main__":
    unittest.main()
