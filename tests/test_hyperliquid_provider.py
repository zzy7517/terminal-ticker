"""Test Hyperliquid provider symbol handling."""
import unittest
from unittest.mock import patch

from mytradebot.config import HYPERLIQUID_SOURCE, InstrumentConfig
from mytradebot.market_data.hyperliquid import (
    HyperliquidInstrument,
    _catalog_from_meta_payload,
    resolve_instruments,
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
                source=HYPERLIQUID_SOURCE,
            ),
        )

        with patch("mytradebot.market_data.hyperliquid.load_instrument_catalog", return_value=catalog):
            resolved = resolve_instruments(configured)

        self.assertEqual(resolved[0].symbol, "kPEPE")
        self.assertEqual(resolved[0].key, "hyperliquid:kPEPE")

    def test_builder_dex_naked_symbols_are_prefixed(self) -> None:
        """Verify builder DEX catalog entries stay globally unique when API returns bare names."""
        payload = [
            {
                "universe": [
                    {"name": "NVDA", "szDecimals": 2, "maxLeverage": 10},
                ],
            },
            [{}],
        ]

        catalog = _catalog_from_meta_payload(
            payload,
            categories={"flx:NVDA": "stocks"},
            dex="flx",
        )

        instrument = catalog["flx:NVDA"]
        self.assertEqual(instrument.symbol, "flx:NVDA")
        self.assertEqual(instrument.key, "hyperliquid:flx:NVDA")
        self.assertEqual(instrument.group, "stocks")

if __name__ == "__main__":
    unittest.main()
