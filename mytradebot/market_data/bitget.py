"""文件用途：数据源层，解析 Bitget 标的并规范化公开行情。"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import websockets

from ..config import BITGET_SOURCE, InstrumentConfig
from ..domain.price_action import Candle

BITGET_API_BASE = "https://api.bitget.com"
BITGET_WS_PUBLIC = "wss://ws.bitget.com/v2/ws/public"
SPOT = "SPOT"
USDT_FUTURES = "USDT-FUTURES"


@dataclass(frozen=True)
class BitgetInstrument:
    """说明：封装一个已解析的 Bitget 行情标的。"""
    symbol: str
    inst_type: str
    label: str
    base_asset: str
    quote_asset: str
    market_kind: str
    show_collapsed: bool = True
    source: str = BITGET_SOURCE
    group: str = "crypto"
    analysis_interval: str | None = None

    @property
    def key(self) -> str:
        """说明：返回 provider 内稳定使用的标的键。"""
        return f"{self.inst_type}:{self.symbol}"


def _fetch_json(path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    """说明：请求 Bitget REST 接口并解析 JSON。"""
    query = f"?{urlencode(params)}" if params else ""
    request = Request(
        f"{BITGET_API_BASE}{path}{query}",
        headers={"User-Agent": "mytradebot/0.1"},
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def _expect_success(payload: dict[str, Any], context: str) -> list[Any]:
    """说明：校验 Bitget 响应成功并返回 data 列表。"""
    if payload.get("code") != "00000":
        detail = payload.get("msg") or "unknown error"
        raise RuntimeError(f"{context} failed: {detail}")
    data = payload.get("data")
    if not isinstance(data, list):
        raise RuntimeError(f"{context} returned unexpected payload")
    return data


def load_instrument_catalog() -> dict[tuple[str, str], BitgetInstrument]:
    """说明：加载 Bitget 现货和 USDT 合约标的目录。"""
    catalog: dict[tuple[str, str], BitgetInstrument] = {}

    spot_payload = _fetch_json("/api/v2/spot/public/symbols")
    for item in _expect_success(spot_payload, "Bitget spot symbols"):
        symbol = str(item.get("symbol") or "").upper()
        if not symbol:
            continue
        catalog[(SPOT, symbol)] = BitgetInstrument(
            symbol=symbol,
            inst_type=SPOT,
            label=symbol,
            base_asset=str(item.get("baseCoin") or symbol),
            quote_asset=str(item.get("quoteCoin") or "USDT"),
            market_kind="spot",
        )

    futures_payload = _fetch_json(
        "/api/v2/mix/market/contracts",
        {"productType": USDT_FUTURES},
    )
    for item in _expect_success(futures_payload, "Bitget futures contracts"):
        symbol = str(item.get("symbol") or "").upper()
        if not symbol:
            continue
        market_kind = "perp" if item.get("symbolType") == "perpetual" else "futures"
        catalog[(USDT_FUTURES, symbol)] = BitgetInstrument(
            symbol=symbol,
            inst_type=USDT_FUTURES,
            label=symbol,
            base_asset=str(item.get("baseCoin") or symbol),
            quote_asset=str(item.get("quoteCoin") or "USDT"),
            market_kind=market_kind,
        )

    return catalog


def _search_score(instrument: BitgetInstrument, query: str) -> tuple[int, str, str]:
    """说明：按精确度和市场类型给 Bitget 搜索结果排序。"""
    symbol = instrument.symbol.upper()
    base_asset = instrument.base_asset.upper()
    query_upper = query.upper()
    if query_upper in {symbol, base_asset}:
        return (0, symbol, instrument.inst_type)
    if symbol.startswith(query_upper) or base_asset.startswith(query_upper):
        return (1, symbol, instrument.inst_type)
    if query_upper in symbol:
        return (2, symbol, instrument.inst_type)
    return (3, symbol, instrument.inst_type)


def search_instruments(query: str, *, limit: int = 20) -> tuple[BitgetInstrument, ...]:
    """说明：按 symbol/base asset 搜索 Bitget 现货和 USDT 合约标的。"""
    normalized = query.strip().upper()
    if not normalized:
        return tuple()
    catalog = load_instrument_catalog()
    matches = [
        instrument
        for instrument in catalog.values()
        if (
            normalized in instrument.symbol.upper()
            or normalized in instrument.base_asset.upper()
            or normalized in instrument.quote_asset.upper()
        )
    ]
    matches.sort(key=lambda instrument: _search_score(instrument, normalized))
    return tuple(matches[:limit])


def resolve_instruments(configured: tuple[InstrumentConfig, ...]) -> tuple[BitgetInstrument, ...]:
    """说明：把配置标的解析为具体 provider 标的，并保持 watchlist 顺序。"""
    catalog = load_instrument_catalog()
    resolved: list[BitgetInstrument] = []

    for requested in configured:
        if requested.inst_type is not None:
            instrument = catalog.get((requested.inst_type, requested.symbol))
            if instrument is None:
                raise ValueError(
                    f"Bitget instrument not found: {requested.inst_type}:{requested.symbol}"
                )
        else:
            matches = [item for key, item in catalog.items() if key[1] == requested.symbol]
            if not matches:
                raise ValueError(f"Bitget instrument not found: {requested.symbol}")
            if len(matches) > 1:
                choices = ", ".join(sorted(item.inst_type for item in matches))
                raise ValueError(
                    f"Bitget symbol is ambiguous: {requested.symbol}. Specify inst_type ({choices})."
                )
            instrument = matches[0]

        label = requested.label or instrument.symbol
        resolved.append(
            BitgetInstrument(
                symbol=instrument.symbol,
                inst_type=instrument.inst_type,
                label=label,
                base_asset=instrument.base_asset,
                quote_asset=instrument.quote_asset,
                market_kind=instrument.market_kind,
                show_collapsed=requested.show_collapsed,
                group=requested.group,
                analysis_interval=requested.analysis_interval,
            )
        )

    return tuple(resolved)


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
        raise RuntimeError(f"Bitget candle missing {field_name}")
    return value


def _expect_int(raw_value: Any, field_name: str) -> int:
    """说明：读取必填整数字段并转换成整数。"""
    value = _as_int(raw_value)
    if value is None:
        raise RuntimeError(f"Bitget candle missing {field_name}")
    return value


def _normalize_candle_row(symbol_key: str, row: list[Any]) -> Candle:
    """说明：把 Bitget K 线数组转换成标准 Candle。"""
    if len(row) < 6:
        raise RuntimeError("Bitget candle returned unexpected payload")
    return Candle(
        symbol_key=symbol_key,
        open_time_ms=_expect_int(row[0], "timestamp"),
        open=_expect_float(row[1], "open"),
        high=_expect_float(row[2], "high"),
        low=_expect_float(row[3], "low"),
        close=_expect_float(row[4], "close"),
        volume=_expect_float(row[5], "volume"),
    )


def _api_granularity(inst_type: str, interval: str) -> str:
    """说明：把应用 K 线周期映射为 Bitget API 粒度。"""
    if inst_type == SPOT:
        minute_aliases = {
            "1m": "1min",
            "3m": "3min",
            "5m": "5min",
            "15m": "15min",
            "30m": "30min",
        }
        day_aliases = {"1D": "1day", "3D": "3day"}
        larger_aliases = {"1W": "1week", "1M": "1M"}
        return minute_aliases.get(
            interval,
            day_aliases.get(interval, larger_aliases.get(interval, interval.lower())),
        )
    return interval


def fetch_candles(
    instrument: BitgetInstrument,
    *,
    interval: str,
    limit: int,
    after_open_time_ms: int | None = None,
    before_open_time_ms: int | None = None,
) -> tuple[Candle, ...]:
    """说明：拉取指定 provider 标的的近期 K 线。"""
    if after_open_time_ms is not None and before_open_time_ms is not None:
        raise ValueError("after_open_time_ms and before_open_time_ms cannot both be set")
    if instrument.inst_type == SPOT:
        params = {
            "symbol": instrument.symbol,
            "granularity": _api_granularity(instrument.inst_type, interval),
            "endTime": str(
                before_open_time_ms - 1
                if before_open_time_ms is not None
                else int(time.time() * 1000)
            ),
            "limit": str(min(limit, 200 if before_open_time_ms is not None else 1000)),
        }
        if after_open_time_ms is not None:
            params["startTime"] = str(after_open_time_ms + 1)
        path = (
            "/api/v2/spot/market/history-candles"
            if before_open_time_ms is not None
            else "/api/v2/spot/market/candles"
        )
        payload = _fetch_json(
            path,
            params,
        )
        context = "Bitget spot candles"
    else:
        params = {
            "symbol": instrument.symbol,
            "productType": instrument.inst_type,
            "granularity": _api_granularity(instrument.inst_type, interval),
            "limit": str(min(limit, 200 if before_open_time_ms is not None else 1000)),
        }
        if after_open_time_ms is not None:
            params["startTime"] = str(after_open_time_ms + 1)
            params["endTime"] = str(int(time.time() * 1000))
        if before_open_time_ms is not None:
            params["endTime"] = str(before_open_time_ms - 1)
        path = (
            "/api/v2/mix/market/history-candles"
            if before_open_time_ms is not None
            else "/api/v2/mix/market/candles"
        )
        payload = _fetch_json(
            path,
            params,
        )
        context = "Bitget futures candles"

    rows = _expect_success(payload, context)
    candles = [
        _normalize_candle_row(instrument.key, row)
        for row in rows
        if isinstance(row, list)
    ]
    if after_open_time_ms is not None:
        candles = [candle for candle in candles if candle.open_time_ms > after_open_time_ms]
    if before_open_time_ms is not None:
        candles = [candle for candle in candles if candle.open_time_ms < before_open_time_ms]
    return tuple(sorted(candles, key=lambda candle: candle.open_time_ms)[-limit:])


def _normalize_ticker_payload(
    item: dict[str, Any],
    instrument: BitgetInstrument,
) -> dict[str, Any]:
    """说明：把 Bitget ticker 转换成应用报价载荷。"""
    price = _as_float(item.get("lastPr") or item.get("lastPrice"))
    reference = _as_float(item.get("open24h") or item.get("open") or item.get("openPrice24h"))
    change_percent = _as_float(item.get("change24h"))
    if change_percent is not None:
        change_percent *= 100

    change = None
    if price is not None and reference is not None:
        change = price - reference

    return {
        "id": instrument.key,
        "short_name": instrument.label,
        "display_name": instrument.label,
        "price": price,
        "change": change,
        "change_percent": change_percent,
        "previous_close": reference,
        "day_high": _as_float(item.get("high24h")),
        "day_low": _as_float(item.get("low24h")),
        "day_volume": _as_float(item.get("baseVolume")),
        "volume": _as_float(item.get("baseVolume")),
        "currency": instrument.quote_asset,
        "exchange": "Bitget",
        "status": instrument.market_kind,
        "time": _as_int(item.get("ts")),
        "index_price": _as_float(item.get("indexPrice")),
        "mark_price": _as_float(item.get("markPrice")),
    }


def fetch_snapshot_payloads(
    instruments: tuple[BitgetInstrument, ...],
) -> dict[str, dict[str, Any]]:
    """说明：为配置的 Bitget 标的拉取一次 REST 快照。"""
    payloads: dict[str, dict[str, Any]] = {}
    spot_symbols = {item.symbol for item in instruments if item.inst_type == SPOT}
    futures_symbols = {item.symbol for item in instruments if item.inst_type == USDT_FUTURES}

    spot_tickers_by_symbol: dict[str, dict[str, Any]] = {}
    if spot_symbols:
        spot_payload = _fetch_json("/api/v2/spot/market/tickers")
        for item in _expect_success(spot_payload, "Bitget spot tickers"):
            symbol = str(item.get("symbol") or "").upper()
            if symbol in spot_symbols:
                spot_tickers_by_symbol[symbol] = item

    futures_tickers_by_symbol: dict[str, dict[str, Any]] = {}
    if futures_symbols:
        futures_payload = _fetch_json(
            "/api/v2/mix/market/tickers",
            {"productType": USDT_FUTURES},
        )
        for item in _expect_success(futures_payload, "Bitget futures tickers"):
            symbol = str(item.get("symbol") or "").upper()
            if symbol in futures_symbols:
                futures_tickers_by_symbol[symbol] = item

    for instrument in instruments:
        if instrument.inst_type == SPOT:
            item = spot_tickers_by_symbol.get(instrument.symbol)
        else:
            item = futures_tickers_by_symbol.get(instrument.symbol)
        if item is not None:
            payloads[instrument.key] = _normalize_ticker_payload(item, instrument)

    return payloads


class BitgetPublicWebSocket:
    """说明：管理 Bitget 公共 WebSocket 的连接、订阅和消息转发。"""
    def __init__(self, instruments: tuple[BitgetInstrument, ...]) -> None:
        """说明：初始化当前对象的运行状态。"""
        self.instruments = instruments
        self.lookup = {
            (instrument.inst_type, instrument.symbol): instrument
            for instrument in instruments
        }
        self.websocket = None
        self.ping_task: asyncio.Task[None] | None = None

    async def _connect(self) -> None:
        """说明：打开连接并确保底层资源已经初始化。"""
        if self.websocket is not None:
            return
        self.websocket = await websockets.connect(
            BITGET_WS_PUBLIC,
            ping_interval=None,
            ping_timeout=None,
            max_size=None,
        )

    async def _ping_loop(self) -> None:
        """说明：按 Bitget 要求定期发送 WebSocket ping。"""
        assert self.websocket is not None
        while True:
            await asyncio.sleep(25)
            await self.websocket.send("ping")

    async def subscribe(self) -> None:
        """说明：向行情 WebSocket 订阅配置的标的。"""
        await self._connect()
        assert self.websocket is not None
        args = [
            {
                "instType": instrument.inst_type,
                "channel": "ticker",
                "instId": instrument.symbol,
            }
            for instrument in self.instruments
        ]
        await self.websocket.send(json.dumps({"op": "subscribe", "args": args}))
        if self.ping_task is None:
            self.ping_task = asyncio.create_task(self._ping_loop())

    async def listen(self, message_handler) -> None:
        """说明：读取 WebSocket 消息并转成标准报价载荷。"""
        await self.subscribe()
        assert self.websocket is not None

        async for raw_message in self.websocket:
            if raw_message == "pong":
                continue

            message = json.loads(raw_message)
            if message.get("event") == "error":
                detail = message.get("msg") or "Bitget websocket error"
                raise RuntimeError(detail)

            data = message.get("data")
            arg = message.get("arg")
            if not isinstance(data, list) or not isinstance(arg, dict):
                continue

            inst_type = str(arg.get("instType") or "").upper()
            symbol = str(arg.get("instId") or "").upper()
            instrument = self.lookup.get((inst_type, symbol))
            if instrument is None:
                continue

            for item in data:
                payload = _normalize_ticker_payload(item, instrument)
                if asyncio.iscoroutinefunction(message_handler):
                    await message_handler(payload)
                else:
                    message_handler(payload)

    async def close(self) -> None:
        """说明：关闭 WebSocket 连接和后台心跳任务。"""
        if self.ping_task is not None:
            self.ping_task.cancel()
            try:
                await self.ping_task
            except asyncio.CancelledError:
                pass
            self.ping_task = None

        if self.websocket is not None:
            await self.websocket.close()
            self.websocket = None
