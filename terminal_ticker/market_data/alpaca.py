"""文件用途：数据源层，解析 Alpaca 美股标的并拉取 quote/K 线。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import os
import time
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..config import ALPACA_SOURCE, InstrumentConfig
from ..domain.price_action import Candle

ALPACA_DATA_BASE = "https://data.alpaca.markets"
ALPACA_TRADING_BASE = "https://paper-api.alpaca.markets"
DEFAULT_ALPACA_FEED = "iex"
ASSET_CACHE_TTL_SECONDS = 15 * 60
BAR_DELAY_MINUTES = 16
_asset_cache: tuple[float, tuple["AlpacaAsset", ...]] | None = None


@dataclass(frozen=True)
class AlpacaInstrument:
    """说明：封装一个已解析的 Alpaca 美股/ETF 标的。"""
    symbol: str
    label: str
    name: str = ""
    exchange: str = ""
    show_collapsed: bool = True
    source: str = ALPACA_SOURCE
    group: str = "stocks"
    analysis_interval: str | None = None

    @property
    def key(self) -> str:
        """说明：返回 provider 内稳定使用的标的键。"""
        return f"{self.source}:{self.symbol}"


@dataclass(frozen=True)
class AlpacaAsset:
    """说明：封装 Alpaca asset 搜索返回的一条标的信息。"""
    symbol: str
    name: str = ""
    exchange: str = ""
    tradable: bool = False

    @property
    def default_label(self) -> str:
        """说明：返回标的的默认短标签。"""
        return self.symbol

    def display_text(self) -> str:
        """说明：格式化证券搜索结果展示文本。"""
        suffix = f"  {self.name}" if self.name else ""
        exchange = f" · {self.exchange}" if self.exchange else ""
        return f"{self.symbol}{exchange}{suffix}"


def clear_asset_cache() -> None:
    """说明：清空进程内 Alpaca asset 列表缓存。"""
    global _asset_cache
    _asset_cache = None


def resolve_instruments(
    configured: tuple[InstrumentConfig, ...],
) -> tuple[AlpacaInstrument, ...]:
    """说明：把配置标的解析为具体 provider 标的，并保持 watchlist 顺序。"""
    resolved: list[AlpacaInstrument] = []
    for requested in configured:
        resolved.append(
            AlpacaInstrument(
                symbol=_normalize_symbol(requested.symbol),
                label=requested.label or _normalize_symbol(requested.symbol),
                show_collapsed=requested.show_collapsed,
                group=requested.group,
                analysis_interval=requested.analysis_interval,
            )
        )
    return tuple(resolved)


def _normalize_symbol(symbol: str) -> str:
    """说明：规范化 Alpaca 股票代码，兼容旧的 .US 后缀写法。"""
    normalized = symbol.strip().upper()
    if normalized.endswith(".US"):
        normalized = normalized[:-3]
    if not normalized:
        raise ValueError("symbol entries cannot be blank")
    return normalized


def _alpaca_headers() -> dict[str, str]:
    """说明：读取 Alpaca API 凭证并构造请求头。"""
    key = os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY_ID")
    secret = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_API_SECRET_KEY")
    if not key or not secret:
        raise RuntimeError("Alpaca credentials are required: set APCA_API_KEY_ID and APCA_API_SECRET_KEY")
    return {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
        "User-Agent": "terminal-ticker/0.1",
    }


def _data_base_url() -> str:
    """说明：返回 Alpaca market data API 根地址。"""
    return os.environ.get("ALPACA_DATA_BASE_URL", ALPACA_DATA_BASE).rstrip("/")


def _trading_base_url() -> str:
    """说明：返回 Alpaca trading API 根地址，默认使用 paper trading。"""
    return os.environ.get("APCA_API_BASE_URL", ALPACA_TRADING_BASE).rstrip("/")


def _data_feed() -> str:
    """说明：返回 Alpaca market data feed，免费档默认 IEX。"""
    return os.environ.get("ALPACA_DATA_FEED", DEFAULT_ALPACA_FEED).strip().lower() or DEFAULT_ALPACA_FEED


def _fetch_json(base_url: str, path: str, params: dict[str, str] | None = None) -> Any:
    """说明：请求 Alpaca REST 接口并解析 JSON。"""
    query = f"?{urlencode(params)}" if params else ""
    request = Request(f"{base_url}{path}{query}", headers=_alpaca_headers())
    try:
        with urlopen(request, timeout=20) as response:
            return json.load(response)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        detail = body
        try:
            payload = json.loads(body)
            if isinstance(payload, dict):
                detail = str(payload.get("message") or payload.get("error") or payload)
        except json.JSONDecodeError:
            detail = body[:300]
        raise RuntimeError(f"Alpaca request failed: HTTP {exc.code}: {detail}") from exc


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
        raise RuntimeError(f"Alpaca candle missing {field_name}")
    return value


def _timestamp_to_ms(raw_value: Any) -> int | None:
    """说明：把 Alpaca ISO 时间戳转换成 Unix 毫秒。"""
    if raw_value in (None, ""):
        return None
    if isinstance(raw_value, datetime):
        return int(raw_value.timestamp() * 1000)
    if isinstance(raw_value, (int, float)):
        return int(raw_value if raw_value > 10_000_000_000 else raw_value * 1000)
    text = str(raw_value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(parsed.timestamp() * 1000)


def _timestamp_to_epoch(raw_value: Any) -> int | None:
    """说明：把 Alpaca 时间戳转换成 Unix 秒。"""
    timestamp_ms = _timestamp_to_ms(raw_value)
    return None if timestamp_ms is None else timestamp_ms // 1000


def _asset_from_payload(item: dict[str, Any]) -> AlpacaAsset | None:
    """说明：把 Alpaca asset payload 转成搜索结果。"""
    symbol = str(item.get("symbol") or "").strip().upper()
    if not symbol:
        return None
    return AlpacaAsset(
        symbol=symbol,
        name=str(item.get("name") or "").strip(),
        exchange=str(item.get("exchange") or "").strip(),
        tradable=bool(item.get("tradable")),
    )


def fetch_assets(*, now: float | None = None) -> tuple[AlpacaAsset, ...]:
    """说明：拉取并缓存 Alpaca active US equity asset 列表。"""
    global _asset_cache

    current_time = time.monotonic() if now is None else now
    if _asset_cache is not None:
        cached_at, cached_items = _asset_cache
        if current_time - cached_at < ASSET_CACHE_TTL_SECONDS:
            return cached_items

    payload = _fetch_json(
        _trading_base_url(),
        "/v2/assets",
        {"status": "active", "asset_class": "us_equity"},
    )
    if not isinstance(payload, list):
        raise RuntimeError("Alpaca assets returned unexpected payload")
    assets = tuple(
        asset
        for asset in (_asset_from_payload(item) for item in payload if isinstance(item, dict))
        if asset is not None
    )
    _asset_cache = (current_time, assets)
    return assets


def _search_score(asset: AlpacaAsset, query: str) -> tuple[int, str]:
    """说明：按精确度和前缀匹配质量给搜索结果排序。"""
    symbol = asset.symbol.upper()
    query_upper = query.upper()
    query_lower = query.lower()
    if query_upper == symbol:
        return (0, symbol)
    if symbol.startswith(query_upper):
        return (1, symbol)
    if query_upper in symbol:
        return (2, symbol)
    if asset.name.lower().startswith(query_lower):
        return (3, symbol)
    return (4, symbol)


def search_assets(query: str, *, limit: int = 20) -> tuple[AlpacaAsset, ...]:
    """说明：按 ticker 或名称搜索 Alpaca active US equity 标的。"""
    normalized = _normalize_symbol(query)
    query_lower = normalized.lower()
    matches = [
        asset
        for asset in fetch_assets()
        if (
            normalized in asset.symbol.upper()
            or query_lower in asset.name.lower()
            or normalized in asset.exchange.upper()
        )
    ]
    matches.sort(key=lambda asset: _search_score(asset, normalized))
    return tuple(matches[:limit])


def _timeframe_for_interval(interval: str) -> str:
    """说明：把应用 K 线周期映射为 Alpaca timeframe。"""
    mapping = {
        "1m": "1Min",
        "3m": "3Min",
        "5m": "5Min",
        "15m": "15Min",
        "30m": "30Min",
        "1H": "1Hour",
        "4H": "4Hour",
        "6H": "6Hour",
        "12H": "12Hour",
        "1D": "1Day",
        "3D": "3Day",
        "1W": "1Week",
        "1M": "1Month",
    }
    timeframe = mapping.get(interval)
    if timeframe is None:
        raise ValueError(f"Alpaca candles do not support interval: {interval}")
    return timeframe


def _interval_seconds(interval: str) -> int:
    """说明：返回应用 K 线周期的秒数，用于估算拉取窗口。"""
    mapping = {
        "1m": 60,
        "3m": 180,
        "5m": 300,
        "15m": 900,
        "30m": 1800,
        "1H": 3600,
        "4H": 14_400,
        "6H": 21_600,
        "12H": 43_200,
        "1D": 86_400,
        "3D": 259_200,
        "1W": 604_800,
        "1M": 2_592_000,
    }
    return mapping.get(interval, 300)


def _initial_start_time(end_time: datetime, *, interval: str, limit: int) -> datetime:
    """说明：估算一个能覆盖最近 K 线的起始时间。"""
    seconds = _interval_seconds(interval)
    if seconds < 3600:
        return end_time - timedelta(days=10)
    if seconds < 86_400:
        return end_time - timedelta(days=max(30, limit))
    return end_time - timedelta(seconds=seconds * max(limit * 4, 120))


def _normalize_candle_payload(item: dict[str, Any], instrument: AlpacaInstrument) -> Candle:
    """说明：把 Alpaca bar payload 转换成标准 Candle。"""
    open_time_ms = _timestamp_to_ms(item.get("t"))
    if open_time_ms is None:
        raise RuntimeError("Alpaca candle missing timestamp")
    return Candle(
        symbol_key=instrument.key,
        open_time_ms=open_time_ms,
        open=_expect_float(item.get("o"), "open"),
        high=_expect_float(item.get("h"), "high"),
        low=_expect_float(item.get("l"), "low"),
        close=_expect_float(item.get("c"), "close"),
        volume=_expect_float(item.get("v"), "volume"),
    )


def fetch_candles(
    instrument: AlpacaInstrument,
    *,
    interval: str,
    limit: int,
    after_open_time_ms: int | None = None,
) -> tuple[Candle, ...]:
    """说明：拉取指定 Alpaca 标的的近期 K 线。"""
    end_time = datetime.now(timezone.utc) - timedelta(minutes=BAR_DELAY_MINUTES)
    if after_open_time_ms is None:
        start_time = _initial_start_time(end_time, interval=interval, limit=limit)
    else:
        start_time = datetime.fromtimestamp((after_open_time_ms + 1) / 1000, tz=timezone.utc)
        if start_time >= end_time:
            return tuple()

    params = {
        "symbols": instrument.symbol,
        "timeframe": _timeframe_for_interval(interval),
        "start": start_time.isoformat().replace("+00:00", "Z"),
        "end": end_time.isoformat().replace("+00:00", "Z"),
        "limit": "10000",
        "feed": _data_feed(),
        "adjustment": "raw",
        "sort": "asc",
    }
    payload = _fetch_json(_data_base_url(), "/v2/stocks/bars", params)
    if not isinstance(payload, dict):
        raise RuntimeError("Alpaca bars returned unexpected payload")
    bars = payload.get("bars")
    if not isinstance(bars, dict):
        raise RuntimeError("Alpaca bars returned unexpected payload")
    rows = bars.get(instrument.symbol, [])
    if not isinstance(rows, list):
        raise RuntimeError("Alpaca bars returned unexpected symbol payload")

    candles = tuple(
        sorted(
            (
                _normalize_candle_payload(row, instrument)
                for row in rows
                if isinstance(row, dict)
            ),
            key=lambda candle: candle.open_time_ms,
        )
    )
    if after_open_time_ms is not None:
        candles = tuple(candle for candle in candles if candle.open_time_ms > after_open_time_ms)
    return candles[-limit:]


def _normalize_snapshot_payload(
    item: dict[str, Any],
    instrument: AlpacaInstrument,
) -> dict[str, Any]:
    """说明：把 Alpaca snapshot 转换成应用报价载荷。"""
    latest_trade = item.get("latestTrade") if isinstance(item.get("latestTrade"), dict) else {}
    minute_bar = item.get("minuteBar") if isinstance(item.get("minuteBar"), dict) else {}
    daily_bar = item.get("dailyBar") if isinstance(item.get("dailyBar"), dict) else {}
    previous_daily_bar = (
        item.get("prevDailyBar") if isinstance(item.get("prevDailyBar"), dict) else {}
    )

    price = _as_float(latest_trade.get("p")) or _as_float(minute_bar.get("c")) or _as_float(daily_bar.get("c"))
    previous_close = _as_float(previous_daily_bar.get("c"))
    change = None
    change_percent = None
    if price is not None and previous_close not in (None, 0):
        change = price - previous_close
        change_percent = (change / previous_close) * 100

    return {
        "id": instrument.key,
        "short_name": instrument.label,
        "display_name": instrument.label,
        "price": price,
        "change": change,
        "change_percent": change_percent,
        "previous_close": previous_close,
        "day_high": _as_float(daily_bar.get("h")),
        "day_low": _as_float(daily_bar.get("l")),
        "day_volume": _as_float(daily_bar.get("v")),
        "volume": _as_float(daily_bar.get("v")),
        "currency": "USD",
        "exchange": f"Alpaca {_data_feed().upper()}",
        "status": "alpaca",
        "time": _timestamp_to_epoch(latest_trade.get("t") or minute_bar.get("t") or daily_bar.get("t")),
    }


def fetch_snapshot_payloads(
    instruments: tuple[AlpacaInstrument, ...],
) -> dict[str, dict[str, Any]]:
    """说明：为配置的 Alpaca 标的批量拉取报价快照。"""
    payloads: dict[str, dict[str, Any]] = {}
    if not instruments:
        return payloads

    by_symbol = {instrument.symbol: instrument for instrument in instruments}
    payload = _fetch_json(
        _data_base_url(),
        "/v2/stocks/snapshots",
        {"symbols": ",".join(by_symbol), "feed": _data_feed()},
    )
    if not isinstance(payload, dict):
        raise RuntimeError("Alpaca snapshots returned unexpected payload")
    snapshots = payload.get("snapshots") if isinstance(payload.get("snapshots"), dict) else payload
    if not isinstance(snapshots, dict):
        raise RuntimeError("Alpaca snapshots returned unexpected payload")

    for symbol, item in snapshots.items():
        instrument = by_symbol.get(str(symbol).upper())
        if instrument is not None and isinstance(item, dict):
            payloads[instrument.key] = _normalize_snapshot_payload(item, instrument)
    return payloads
