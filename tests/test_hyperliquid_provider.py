"""Test Hyperliquid provider symbol handling."""
import unittest
from unittest.mock import patch

from mytradebot.config import HYPERLIQUID_TESTNET_SOURCE, InstrumentConfig
from mytradebot.market_data.hyperliquid import (
    HyperliquidInstrument,
    resolve_instruments,
    search_instruments,
)


class HyperliquidProviderTests(unittest.TestCase):
    def test_resolve_preserves_exchange_symbol_case(self) -> None:
        """Verify mixed-case Hyperliquid coin names stay usable for API calls."""
        catalog = {
            "KPEPE": HyperliquidInstrument(
                symbol="kPEPE",
                label="kPEPE Perp",
                base_asset="kPEPE",
            )
        }
        configured = (
            InstrumentConfig(
                symbol="KPEPE",
                source=HYPERLIQUID_TESTNET_SOURCE,
            ),
        )

        with patch("mytradebot.market_data.hyperliquid.load_instrument_catalog", return_value=catalog):
            resolved = resolve_instruments(configured)

        self.assertEqual(resolved[0].symbol, "kPEPE")
        self.assertEqual(resolved[0].key, "hyperliquid-testnet:kPEPE")

    def test_search_accepts_pair_style_queries(self) -> None:
        """Verify Hyperliquid search accepts common exchange pair input."""
        catalog = {
            "BTC": HyperliquidInstrument(
                symbol="BTC",
                label="BTC Perp",
                base_asset="BTC",
            ),
            "KPEPE": HyperliquidInstrument(
                symbol="kPEPE",
                label="kPEPE Perp",
                base_asset="kPEPE",
            ),
        }

        with patch("mytradebot.market_data.hyperliquid.load_instrument_catalog", return_value=catalog):
            btc_results = search_instruments("BTCUSDT")
            slash_results = search_instruments("BTC/USDC")
            mixed_case_results = search_instruments("kPEPE-USDC")

        self.assertEqual([item.symbol for item in btc_results], ["BTC"])
        self.assertEqual([item.symbol for item in slash_results], ["BTC"])
        self.assertEqual([item.symbol for item in mixed_case_results], ["kPEPE"])


if __name__ == "__main__":
    unittest.main()
