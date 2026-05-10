"""文件用途：Hyperliquid 主网公开行情 provider。"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.request import Request, urlopen

from ..config import HYPERLIQUID_SOURCE, InstrumentConfig
from ..domain.price_action import Candle

HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz"
QUOTE_ASSET = "USDC"
DEFAULT_DEX = ""
TRADEFI_GROUPS = {"stocks", "indices", "commodities", "fx", "preipo"}

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
    """说明：封装一个 Hyperliquid 主网永续合约行情标的。"""

    symbol: str
    label: str
    base_asset: str
    quote_asset: str = QUOTE_ASSET
    market_kind: str = "perp"
    sz_decimals: int | None = None
    max_leverage: int | None = None
    show_collapsed: bool = True
    source: str = HYPERLIQUID_SOURCE
    group: str = "crypto"
    analysis_interval: str | None = None
    dex: str | None = None
    category: str | None = None

    @property
    def key(self) -> str:
        """说明：返回全局稳定标的键。"""
        return f"{self.source}:{self.symbol}"


def _post_info(payload: dict[str, Any]) -> Any:
    """说明：请求 Hyperliquid /info 接口并解析 JSON。"""
    request = Request(
        f"{HYPERLIQUID_API_BASE}/info",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "tradex/0.1",
        },
        method="POST",
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def _normalize_symbol(symbol: str) -> str:
    """说明：生成配置查找键；builder DEX 前缀必须是小写。"""
    value = symbol.strip()
    if ":" in value:
        dex, coin = value.split(":", 1)
        dex = dex.strip().lower()
        coin = coin.strip().upper()
        return f"{dex}:{coin}" if dex and coin else ""
    return value.upper()


def _api_symbol(symbol: str) -> str:
    """说明：生成可直接传给 Hyperliquid API 的 symbol，保留主 DEX 混合大小写。"""
    value = symbol.strip()
    if ":" in value:
        dex, coin = value.split(":", 1)
        dex = dex.strip().lower()
        coin = coin.strip().upper()
        return f"{dex}:{coin}" if dex and coin else ""
    return value


def _base_asset(symbol: str) -> str:
    """说明：从 flx:NVDA 这类 builder DEX symbol 中提取展示资产名。"""
    return symbol.split(":", 1)[1] if ":" in symbol else symbol


def _dex_name(symbol: str) -> str | None:
    """说明：返回 builder DEX 名称；主 DEX 标的返回 None。"""
    return symbol.split(":", 1)[0] if ":" in symbol else None


def _group_for_category(category: str | None) -> str:
    """说明：把 Hyperliquid 分类映射到 UI 分组。"""
    normalized = (category or "crypto").strip().lower()
    if normalized in TRADEFI_GROUPS:
        return normalized
    return "crypto"


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


def _load_perp_categories() -> dict[str, str]:
    """说明：读取 Hyperliquid perps 分类，主要用于识别 TradeFi 标的。"""
    try:
        payload = _post_info({"type": "perpCategories"})
    except Exception:
        return {}
    if not isinstance(payload, list):
        return {}
    categories: dict[str, str] = {}
    for item in payload:
        if (
            isinstance(item, list)
            and len(item) >= 2
            and isinstance(item[0], str)
            and isinstance(item[1], str)
        ):
            categories[_normalize_symbol(item[0])] = item[1].strip().lower()
    return categories


def _load_perp_dex_names() -> tuple[str | None, ...]:
    """说明：读取主 DEX 和 builder-deployed perp DEX 名称。"""
    try:
        payload = _post_info({"type": "perpDexs"})
    except Exception:
        return (None,)
    if not isinstance(payload, list):
        return (None,)
    names: list[str | None] = [None]
    for item in payload:
        if item is None:
            continue
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if name and name not in names:
            names.append(name)
    return tuple(names)


def _meta_and_contexts_payload(dex: str | None = None) -> Any:
    payload: dict[str, Any] = {"type": "metaAndAssetCtxs"}
    if dex:
        payload["dex"] = dex
    return _post_info(payload)


def load_instrument_catalog() -> dict[str, HyperliquidInstrument]:
    """说明：加载 Hyperliquid 主网永续合约目录（包含 TradeFi builder DEX）。"""
    categories = _load_perp_categories()
    catalog: dict[str, HyperliquidInstrument] = {}

    for dex in _load_perp_dex_names():
        try:
            payload = _meta_and_contexts_payload(dex)
        except Exception:
            continue
        catalog.update(_catalog_from_meta_payload(payload, categories=categories, dex=dex))
    return catalog


def _catalog_from_meta_payload(
    payload: Any,
    *,
    categories: dict[str, str],
    dex: str | None,
) -> dict[str, HyperliquidInstrument]:
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
        symbol = _api_symbol(str(item.get("name") or ""))
        if dex and ":" not in symbol:
            symbol = f"{dex}:{symbol.upper()}"
        if not symbol:
            continue
        base_asset = _base_asset(symbol)
        symbol_dex = _dex_name(symbol) or dex
        category = categories.get(symbol, "crypto")
        label = f"{base_asset} Perp"
        if symbol_dex:
            label = f"{label} ({symbol_dex})"
        catalog[_normalize_symbol(symbol)] = HyperliquidInstrument(
            symbol=symbol,
            label=label,
            base_asset=base_asset,
            sz_decimals=_as_int(item.get("szDecimals")),
            max_leverage=_as_int(item.get("maxLeverage")),
            group=_group_for_category(category),
            dex=symbol_dex,
            category=category,
        )
    return catalog


def resolve_instruments(
    configured: tuple[InstrumentConfig, ...],
) -> tuple[HyperliquidInstrument, ...]:
    """说明：把配置标的解析为 Hyperliquid 主网标的，并保持 watchlist 顺序。"""
    catalog = load_instrument_catalog()
    resolved: list[HyperliquidInstrument] = []

    for requested in configured:
        symbol = _normalize_symbol(requested.symbol)
        instrument = catalog.get(symbol)
        if instrument is None:
            raise ValueError(f"Hyperliquid instrument not found: {requested.symbol}")
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
                group=instrument.group if requested.group == "crypto" else requested.group,
                analysis_interval=requested.analysis_interval,
                dex=instrument.dex,
                category=instrument.category,
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
    """说明：拉取指定 Hyperliquid 主网标的的近期 K 线。"""
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


def _instrument_contexts_by_symbol(dex: str | None = None) -> dict[str, dict[str, Any]]:
    """说明：按 symbol 返回 metaAndAssetCtxs 中的资产上下文。"""
    payload = _meta_and_contexts_payload(dex)
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
        symbol = _api_symbol(str(item.get("name") or ""))
        if dex and ":" not in symbol:
            symbol = f"{dex}:{symbol.upper()}"
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
        "exchange": "Hyperliquid",
        "status": instrument.category or instrument.market_kind,
        "time": int(time.time() * 1000),
        "index_price": _as_float(context.get("oraclePx")),
        "mark_price": _as_float(context.get("markPx")),
        "funding": _as_float(context.get("funding")),
        "open_interest": _as_float(context.get("openInterest")),
    }


def fetch_snapshot_payloads(
    instruments: tuple[HyperliquidInstrument, ...],
) -> dict[str, dict[str, Any]]:
    """说明：为配置的 Hyperliquid 主网标的拉取一次 REST 快照。"""
    payloads: dict[str, dict[str, Any]] = {}
    by_dex: dict[str | None, list[HyperliquidInstrument]] = {}
    for instrument in instruments:
        by_dex.setdefault(instrument.dex, []).append(instrument)
    for dex, dex_instruments in by_dex.items():
        contexts = _instrument_contexts_by_symbol(dex)
        for instrument in dex_instruments:
            context = contexts.get(instrument.symbol)
            if context is not None:
                payloads[instrument.key] = _normalize_ticker_payload(context, instrument)
    return payloads
