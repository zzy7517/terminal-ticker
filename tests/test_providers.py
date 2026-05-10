"""Test provider routing behavior."""
import unittest
from unittest.mock import patch

from tradex.market_data.bitget import BitgetInstrument
from tradex.market_data.hyperliquid import HyperliquidInstrument
from tradex.config import InstrumentConfig
from tradex.market_data.router import resolve_instruments


class ProviderTests(unittest.TestCase):
    """Group tests for ProviderTests."""
    def test_resolve_bitget_only_does_not_load_hyperliquid_catalog(self) -> None:
        """Verify resolving Bitget-only configs does not touch Hyperliquid."""
        configs = (
            InstrumentConfig(
                symbol="BTCUSDT",
                source="bitget",
                inst_type="USDT-FUTURES",
                label="BTC",
                group="watchlist",
            ),
        )
        bitget_instrument = BitgetInstrument(
            "BTCUSDT",
            "USDT-FUTURES",
            "BTC",
            "BTC",
            "USDT",
            "perp",
            group="watchlist",
        )

        with patch(
            "tradex.market_data.router.bitget.resolve_instruments",
            return_value=(bitget_instrument,),
        ):
            with patch(
                "tradex.market_data.router.hyperliquid.resolve_instruments"
            ) as hyperliquid_resolve:
                instruments = resolve_instruments(configs)

        hyperliquid_resolve.assert_not_called()
        self.assertEqual(instruments[0].key, "USDT-FUTURES:BTCUSDT")
        self.assertEqual(instruments[0].group, "watchlist")

    def test_resolve_hyperliquid_only_does_not_load_bitget_catalog(self) -> None:
        """Verify resolving Hyperliquid-only configs does not touch Bitget."""
        configs = (
            InstrumentConfig(
                symbol="BTC",
                source="hyperliquid",
                label="BTC",
                group="watchlist",
            ),
        )
        hyperliquid_instrument = HyperliquidInstrument("BTC", "BTC", "BTC", group="watchlist")

        with patch("tradex.market_data.router.bitget.resolve_instruments") as bitget_resolve:
            with patch(
                "tradex.market_data.router.hyperliquid.resolve_instruments",
                return_value=(hyperliquid_instrument,),
            ):
                instruments = resolve_instruments(configs)

        bitget_resolve.assert_not_called()
        self.assertEqual(instruments[0].key, "hyperliquid:BTC")
        self.assertEqual(instruments[0].group, "watchlist")

    def test_resolve_mixed_sources_preserves_watchlist_order(self) -> None:
        """Verify resolve mixed sources preserves watchlist order."""
        configs = (
            InstrumentConfig(symbol="BTC", source="hyperliquid", label="BTC"),
            InstrumentConfig(symbol="BTCUSDT", source="bitget", inst_type="USDT-FUTURES"),
        )
        hyperliquid_instrument = HyperliquidInstrument("BTC", "BTC", "BTC")
        bitget_instrument = BitgetInstrument(
            "BTCUSDT",
            "USDT-FUTURES",
            "BTCUSDT",
            "BTC",
            "USDT",
            "perp",
        )

        with patch(
            "tradex.market_data.router.hyperliquid.resolve_instruments",
            return_value=(hyperliquid_instrument,),
        ):
            with patch(
                "tradex.market_data.router.bitget.resolve_instruments",
                return_value=(bitget_instrument,),
            ):
                instruments = resolve_instruments(configs)

        self.assertEqual(
            [instrument.key for instrument in instruments],
            ["hyperliquid:BTC", "USDT-FUTURES:BTCUSDT"],
        )

if __name__ == "__main__":
    unittest.main()
