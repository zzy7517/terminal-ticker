"""文件用途：数据源路由，按配置把标的分发给对应 provider。"""
from __future__ import annotations

from . import bitget, hyperliquid
from .bitget import BitgetInstrument
from .hyperliquid import HyperliquidInstrument
from ..config import (
    BITGET_SOURCE,
    HYPERLIQUID_TESTNET_SOURCE,
    InstrumentConfig,
)

MarketInstrument = BitgetInstrument | HyperliquidInstrument


def resolve_instruments(configured: tuple[InstrumentConfig, ...]) -> tuple[MarketInstrument, ...]:
    # Resolve by provider, then rebuild the original watchlist order for the UI.
    """说明：把配置标的解析为具体 provider 标的，并保持 watchlist 顺序。"""
    bitget_configs = tuple(item for item in configured if item.source == BITGET_SOURCE)
    hyperliquid_configs = tuple(
        item for item in configured if item.source == HYPERLIQUID_TESTNET_SOURCE
    )

    resolved_bitget = {}
    if bitget_configs:
        resolved_bitget = {
            config.dedupe_key: instrument
            for config, instrument in zip(bitget_configs, bitget.resolve_instruments(bitget_configs))
        }

    resolved_hyperliquid = {}
    if hyperliquid_configs:
        resolved_hyperliquid = {
            config.dedupe_key: instrument
            for config, instrument in zip(
                hyperliquid_configs,
                hyperliquid.resolve_instruments(hyperliquid_configs),
            )
        }

    resolved: list[MarketInstrument] = []
    for config in configured:
        if config.source == BITGET_SOURCE:
            resolved.append(resolved_bitget[config.dedupe_key])
        elif config.source == HYPERLIQUID_TESTNET_SOURCE:
            resolved.append(resolved_hyperliquid[config.dedupe_key])
        else:
            raise ValueError(f"unsupported data source: {config.source}")
    return tuple(resolved)
