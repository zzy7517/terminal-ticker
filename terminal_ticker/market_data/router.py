"""文件用途：数据源路由，按配置把标的分发给对应 provider。"""
from __future__ import annotations

from . import alpaca, bitget, longbridge
from .alpaca import AlpacaInstrument
from .bitget import BitgetInstrument
from ..config import ALPACA_SOURCE, BITGET_SOURCE, InstrumentConfig, LONGBRIDGE_SOURCE
from .longbridge import LongbridgeInstrument

MarketInstrument = AlpacaInstrument | BitgetInstrument | LongbridgeInstrument


def resolve_instruments(configured: tuple[InstrumentConfig, ...]) -> tuple[MarketInstrument, ...]:
    # Resolve by provider, then rebuild the original watchlist order for the UI.
    """说明：把配置标的解析为具体 provider 标的，并保持 watchlist 顺序。"""
    bitget_configs = tuple(item for item in configured if item.source == BITGET_SOURCE)
    alpaca_configs = tuple(item for item in configured if item.source == ALPACA_SOURCE)
    longbridge_configs = tuple(item for item in configured if item.source == LONGBRIDGE_SOURCE)

    resolved_bitget = {}
    if bitget_configs:
        resolved_bitget = {
            config.dedupe_key: instrument
            for config, instrument in zip(bitget_configs, bitget.resolve_instruments(bitget_configs))
        }

    resolved_alpaca = {}
    if alpaca_configs:
        resolved_alpaca = {
            config.dedupe_key: instrument
            for config, instrument in zip(alpaca_configs, alpaca.resolve_instruments(alpaca_configs))
        }

    resolved_longbridge = {}
    if longbridge_configs:
        resolved_longbridge = {
            config.dedupe_key: instrument
            for config, instrument in zip(
                longbridge_configs,
                longbridge.resolve_instruments(longbridge_configs),
            )
        }

    resolved: list[MarketInstrument] = []
    for config in configured:
        if config.source == BITGET_SOURCE:
            resolved.append(resolved_bitget[config.dedupe_key])
        elif config.source == ALPACA_SOURCE:
            resolved.append(resolved_alpaca[config.dedupe_key])
        elif config.source == LONGBRIDGE_SOURCE:
            resolved.append(resolved_longbridge[config.dedupe_key])
        else:
            raise ValueError(f"unsupported data source: {config.source}")
    return tuple(resolved)
