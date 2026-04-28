"""Route configured instruments to the correct market data provider."""
from __future__ import annotations

from . import bitget, longbridge_provider
from .bitget import BitgetInstrument
from .config import BITGET_SOURCE, InstrumentConfig, LONGBRIDGE_SOURCE
from .longbridge_provider import LongbridgeInstrument

MarketInstrument = BitgetInstrument | LongbridgeInstrument


def resolve_instruments(configured: tuple[InstrumentConfig, ...]) -> tuple[MarketInstrument, ...]:
    # Resolve by provider, then rebuild the original watchlist order for the UI.
    """Resolve configured rows through each provider and preserve watchlist order."""
    bitget_configs = tuple(item for item in configured if item.source == BITGET_SOURCE)
    longbridge_configs = tuple(item for item in configured if item.source == LONGBRIDGE_SOURCE)

    resolved_bitget = {}
    if bitget_configs:
        resolved_bitget = {
            config.dedupe_key: instrument
            for config, instrument in zip(bitget_configs, bitget.resolve_instruments(bitget_configs))
        }

    resolved_longbridge = {}
    if longbridge_configs:
        resolved_longbridge = {
            config.dedupe_key: instrument
            for config, instrument in zip(
                longbridge_configs,
                longbridge_provider.resolve_instruments(longbridge_configs),
            )
        }

    resolved: list[MarketInstrument] = []
    for config in configured:
        if config.source == BITGET_SOURCE:
            resolved.append(resolved_bitget[config.dedupe_key])
        elif config.source == LONGBRIDGE_SOURCE:
            resolved.append(resolved_longbridge[config.dedupe_key])
        else:
            raise ValueError(f"unsupported data source: {config.source}")
    return tuple(resolved)
