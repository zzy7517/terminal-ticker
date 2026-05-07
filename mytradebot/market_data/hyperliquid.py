"""文件用途：Hyperliquid 测试网公开行情 provider。"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.request import Request, urlopen

from ..config import HYPERLIQUID_TESTNET_SOURCE, InstrumentConfig
from ..domain.price_action import Candle

HYPERLIQUID_TESTNET_API_BASE = "https://api.hyperliquid-testnet.xyz"
QUOTE_ASSET = "USDC"
_SEARCH_QUOTE_SUFFIXES = ("USDT", "USDC")

_INTERVAL_SECONDS = {
    "1m": 60,
    "3m": 3 * 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "30m": 30 * 60,
    "1H": 60 * 60,
    "4H": 4 * 60 * 60,
    "6H": 6 * 60 * 60,
    "12H": 12 * 60 * 60,
    "1D": 24 * 60 * 60,
    "3D": 3 * 24 * 60 * 60,
    "1W": 7 * 24 * 60 * 60,
    "1M": 30 * 24 * 60 * 60,
}


@dataclass(frozen=True)
class HyperliquidInstrument:
    """说明：封装一个 Hyperliquid 测试网永续合约行情标的。"""

    symbol: str
    label: str
    base_asset: str
    quote_asset: str = QUOTE_ASSET
    market_kind: str = "testnet-perp"
    sz_decimals: int | None = None
    max_leverage: int | None = None
    show_collapsed: bool = True
    source: str = HYPERLIQUID_TESTNET_SOURCE
    group: str = "crypto"
    analysis_interval: str | None = None

    @property
    def key(self) -> str:
        """说明：返回全局稳定标的键。"""
        return f"{self.source}:{self.symbol}"


def _post_info(payload: dict[str, Any]) -> Any:
    """说明：请求 Hyperliquid /info 接口并解析 JSON。"""
    request = Request(
        f"{HYPERLIQUID_TESTNET_API_BASE}/info",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "mytradebot/0.1",
        },
        method="POST",
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def _as_float(raw_value: Any) -> float | None:
    """说明：把 provider 原始数值字段转换成浮点数。"""
    if raw_value in (None, ""):
        return None
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def _as_int(raw_value: Any) -> int | None:
    """说明：把 provider 原始整数字段转换成整数。"""
    if raw_value in (None, ""):
        return None
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        return None


def _expect_float(raw_value: Any, field_name: str) -> float:
    """说明：读取必填数值字段并转换成浮点数。"""
    value = _as_float(raw_value)
    if value is None:
        raise RuntimeError(f"Hyperliquid candle missing {field_name}")
    return value


def _expect_int(raw_value: Any, field_name: str) -> int:
    """说明：读取必填整数字段并转换成整数。"""
    value = _as_int(raw_value)
    if value is None:
        raise RuntimeError(f"Hyperliquid candle missing {field_name}")
    return value


def load_instrument_catalog() -> dict[str, HyperliquidInstrument]:
    """说明：加载 Hyperliquid 测试网永续合约目录。"""
    payload = _post_info({"type": "metaAndAssetCtxs"})
    if not isinstance(payload, list) or not payload:
        raise RuntimeError("Hyperliquid meta returned unexpected payload")
    meta = payload[0]
    universe = meta.get("universe") if isinstance(meta, dict) else None
    if not isinstance(universe, list):
        raise RuntimeError("Hyperliquid meta missing universe")

    catalog: dict[str, HyperliquidInstrument] = {}
    for item in universe:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("name") or "").strip()
        if not symbol:
            continue
        catalog[symbol.upper()] = HyperliquidInstrument(
            symbol=symbol,
            label=f"{symbol} Perp",
            base_asset=symbol,
            sz_decimals=_as_int(item.get("szDecimals")),
            max_leverage=_as_int(item.get("maxLeverage")),
        )
    return catalog


def _search_score(instrument: HyperliquidInstrument, query: str) -> tuple[int, str]:
    """说明：按精确度给 Hyperliquid 搜索结果排序。"""
    symbol = instrument.symbol.upper()
    query_upper = query.upper()
    if query_upper == symbol:
        return (0, symbol)
    if symbol.startswith(query_upper):
        return (1, symbol)
    if query_upper in symbol:
        return (2, symbol)
    return (3, symbol)


def _normalize_search_query(query: str) -> str:
    """说明：把常见交易对输入转换成 Hyperliquid coin 名。"""
    normalized = query.strip().upper()
    if not normalized:
        return normalized

    for separator in (":", "/", "-", "_"):
        if separator not in normalized:
            continue
        base_asset, quote_asset = normalized.rsplit(separator, 1)
        if base_asset and quote_asset in _SEARCH_QUOTE_SUFFIXES:
            return base_asset

    for suffix in _SEARCH_QUOTE_SUFFIXES:
        if normalized.endswith(suffix) and len(normalized) > len(suffix):
            return normalized[: -len(suffix)]

    return normalized


def search_instruments(query: str, *, limit: int = 20) -> tuple[HyperliquidInstrument, ...]:
    """说明：按 coin 名称搜索 Hyperliquid 测试网永续合约。"""
    normalized = _normalize_search_query(query)
    if not normalized:
        return tuple()
    catalog = load_instrument_catalog()
    matches = [
        instrument
        for instrument in catalog.values()
        if normalized in instrument.symbol.upper() or normalized in instrument.base_asset.upper()
    ]
    matches.sort(key=lambda instrument: _search_score(instrument, normalized))
    return tuple(matches[:limit])


def resolve_instruments(
    configured: tuple[InstrumentConfig, ...],
) -> tuple[HyperliquidInstrument, ...]:
    """说明：把配置标的解析为 Hyperliquid 测试网标的，并保持 watchlist 顺序。"""
    catalog = load_instrument_catalog()
    resolved: list[HyperliquidInstrument] = []

    for requested in configured:
        symbol = requested.symbol.upper()
        instrument = catalog.get(symbol)
        if instrument is None:
            raise ValueError(f"Hyperliquid testnet instrument not found: {requested.symbol}")
        resolved.append(
            HyperliquidInstrument(
                symbol=instrument.symbol,
                label=requested.label or instrument.label,
                base_asset=instrument.base_asset,
                quote_asset=instrument.quote_asset,
                market_kind=instrument.market_kind,
                sz_decimals=instrument.sz_decimals,
                max_leverage=instrument.max_leverage,
                show_collapsed=requested.show_collapsed,
                group=requested.group,
                analysis_interval=requested.analysis_interval,
            )
        )

    return tuple(resolved)


def _api_interval(interval: str) -> str:
    """说明：把应用 K 线周期映射为 Hyperliquid API 周期。"""
    aliases = {
        "1H": "1h",
        "4H": "4h",
        "6H": "6h",
        "12H": "12h",
        "1D": "1d",
        "3D": "3d",
        "1W": "1w",
    }
    return aliases.get(interval, interval)


def _interval_ms(interval: str) -> int:
    """说明：返回 K 线周期毫秒数，用于构造 candleSnapshot 时间窗。"""
    seconds = _INTERVAL_SECONDS.get(interval)
    if seconds is None:
        raise ValueError(f"unsupported Hyperliquid candle interval: {interval}")
    return seconds * 1000


def _normalize_candle_row(symbol_key: str, row: dict[str, Any]) -> Candle:
    """说明：把 Hyperliquid K 线对象转换成标准 Candle。"""
    return Candle(
        symbol_key=symbol_key,
        open_time_ms=_expect_int(row.get("t"), "open time"),
        open=_expect_float(row.get("o"), "open"),
        high=_expect_float(row.get("h"), "high"),
        low=_expect_float(row.get("l"), "low"),
        close=_expect_float(row.get("c"), "close"),
        volume=_expect_float(row.get("v"), "volume"),
    )


def fetch_candles(
    instrument: HyperliquidInstrument,
    *,
    interval: str,
    limit: int,
    after_open_time_ms: int | None = None,
    before_open_time_ms: int | None = None,
) -> tuple[Candle, ...]:
    """说明：拉取指定 Hyperliquid 测试网标的的近期 K 线。"""
    if after_open_time_ms is not None and before_open_time_ms is not None:
        raise ValueError("after_open_time_ms and before_open_time_ms cannot both be set")
    interval_ms = _interval_ms(interval)
    now_ms = int(time.time() * 1000)
    if before_open_time_ms is not None:
        end_time = max(0, before_open_time_ms - 1)
        start_time = max(0, end_time - interval_ms * max(limit * 2, limit + 10))
    else:
        start_time = (after_open_time_ms + 1) if after_open_time_ms is not None else now_ms - interval_ms * max(limit * 2, limit + 10)
        end_time = now_ms

    payload = _post_info(
        {
            "type": "candleSnapshot",
            "req": {
                "coin": instrument.symbol,
                "interval": _api_interval(interval),
                "startTime": start_time,
                "endTime": end_time,
            },
        }
    )
    if not isinstance(payload, list):
        raise RuntimeError("Hyperliquid candles returned unexpected payload")
    candles = [
        _normalize_candle_row(instrument.key, row)
        for row in payload
        if isinstance(row, dict)
    ]
    if after_open_time_ms is not None:
        candles = [candle for candle in candles if candle.open_time_ms > after_open_time_ms]
    if before_open_time_ms is not None:
        candles = [candle for candle in candles if candle.open_time_ms < before_open_time_ms]
    return tuple(sorted(candles, key=lambda candle: candle.open_time_ms)[-limit:])


def _instrument_contexts_by_symbol() -> dict[str, dict[str, Any]]:
    """说明：按 symbol 返回 metaAndAssetCtxs 中的资产上下文。"""
    payload = _post_info({"type": "metaAndAssetCtxs"})
    if not isinstance(payload, list) or len(payload) < 2:
        raise RuntimeError("Hyperliquid asset contexts returned unexpected payload")
    meta, contexts = payload[0], payload[1]
    universe = meta.get("universe") if isinstance(meta, dict) else None
    if not isinstance(universe, list) or not isinstance(contexts, list):
        raise RuntimeError("Hyperliquid asset contexts missing universe")
    by_symbol: dict[str, dict[str, Any]] = {}
    for item, context in zip(universe, contexts):
        if not isinstance(item, dict) or not isinstance(context, dict):
            continue
        symbol = str(item.get("name") or "").strip()
        if symbol:
            by_symbol[symbol] = context
    return by_symbol


def _normalize_ticker_payload(
    context: dict[str, Any],
    instrument: HyperliquidInstrument,
) -> dict[str, Any]:
    """说明：把 Hyperliquid asset context 转换成应用报价载荷。"""
    price = _as_float(context.get("midPx") or context.get("markPx") or context.get("oraclePx"))
    previous = _as_float(context.get("prevDayPx"))
    change = None
    change_percent = None
    if price is not None and previous is not None:
        change = price - previous
        if previous:
            change_percent = change / previous * 100

    return {
        "id": instrument.key,
        "short_name": instrument.label,
        "display_name": instrument.label,
        "price": price,
        "change": change,
        "change_percent": change_percent,
        "previous_close": previous,
        "day_high": None,
        "day_low": None,
        "day_volume": _as_float(context.get("dayNtlVlm")),
        "volume": _as_float(context.get("dayNtlVlm")),
        "currency": instrument.quote_asset,
        "exchange": "Hyperliquid Testnet",
        "status": instrument.market_kind,
        "time": int(time.time() * 1000),
        "index_price": _as_float(context.get("oraclePx")),
        "mark_price": _as_float(context.get("markPx")),
        "funding": _as_float(context.get("funding")),
        "open_interest": _as_float(context.get("openInterest")),
    }


def fetch_snapshot_payloads(
    instruments: tuple[HyperliquidInstrument, ...],
) -> dict[str, dict[str, Any]]:
    """说明：为配置的 Hyperliquid 测试网标的拉取一次 REST 快照。"""
    contexts = _instrument_contexts_by_symbol()
    payloads: dict[str, dict[str, Any]] = {}
    for instrument in instruments:
        context = contexts.get(instrument.symbol)
        if context is not None:
            payloads[instrument.key] = _normalize_ticker_payload(context, instrument)
    return payloads
