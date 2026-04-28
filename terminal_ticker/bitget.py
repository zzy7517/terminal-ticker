"""Resolve Bitget instruments and normalize public market data."""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import websockets

from .config import BITGET_SOURCE, InstrumentConfig
from .price_action import Candle

BITGET_API_BASE = "https://api.bitget.com"
BITGET_WS_PUBLIC = "wss://ws.bitget.com/v2/ws/public"
SPOT = "SPOT"
USDT_FUTURES = "USDT-FUTURES"


@dataclass(frozen=True)
class BitgetInstrument:
    """Describe one resolved Bitget market instrument used by the app."""
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
        """Return the stable quote key used for Bitget rows and events."""
        return f"{self.inst_type}:{self.symbol}"


def _fetch_json(path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    """Fetch a Bitget REST endpoint and decode its JSON response."""
    query = f"?{urlencode(params)}" if params else ""
    request = Request(
        f"{BITGET_API_BASE}{path}{query}",
        headers={"User-Agent": "terminal-ticker/0.1"},
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def _expect_success(payload: dict[str, Any], context: str) -> list[Any]:
    """Validate a Bitget API payload and return its data list."""
    if payload.get("code") != "00000":
        detail = payload.get("msg") or "unknown error"
        raise RuntimeError(f"{context} failed: {detail}")
    data = payload.get("data")
    if not isinstance(data, list):
        raise RuntimeError(f"{context} returned unexpected payload")
    return data


def load_instrument_catalog() -> dict[tuple[str, str], BitgetInstrument]:
    """Load spot and USDT futures instruments from Bitget public metadata."""
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


def resolve_instruments(configured: tuple[InstrumentConfig, ...]) -> tuple[BitgetInstrument, ...]:
    """Map configured Bitget symbols onto concrete catalog instruments."""
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
    """Convert a raw Bitget numeric field into a float when possible."""
    if raw_value in (None, ""):
        return None
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def _as_int(raw_value: Any) -> int | None:
    """Convert a raw Bitget integer field into an int when possible."""
    if raw_value in (None, ""):
        return None
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        return None


def _expect_float(raw_value: Any, field_name: str) -> float:
    """Convert a required numeric candle field."""
    value = _as_float(raw_value)
    if value is None:
        raise RuntimeError(f"Bitget candle missing {field_name}")
    return value


def _expect_int(raw_value: Any, field_name: str) -> int:
    """Convert a required integer candle field."""
    value = _as_int(raw_value)
    if value is None:
        raise RuntimeError(f"Bitget candle missing {field_name}")
    return value


def _normalize_candle_row(symbol_key: str, row: list[Any]) -> Candle:
    """Convert a Bitget candle row into a normalized candle."""
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
    """Map the app interval to Bitget spot/futures granularity names."""
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
) -> tuple[Candle, ...]:
    """Fetch recent Bitget candles for one instrument."""
    if instrument.inst_type == SPOT:
        params = {
            "symbol": instrument.symbol,
            "granularity": _api_granularity(instrument.inst_type, interval),
            "endTime": str(int(time.time() * 1000)),
            "limit": str(min(limit, 200)),
        }
        if after_open_time_ms is not None:
            params["startTime"] = str(after_open_time_ms + 1)
        payload = _fetch_json(
            "/api/v2/spot/market/history-candles",
            params,
        )
        context = "Bitget spot candles"
    else:
        params = {
            "symbol": instrument.symbol,
            "productType": instrument.inst_type,
            "granularity": _api_granularity(instrument.inst_type, interval),
            "limit": str(min(limit, 1000)),
        }
        if after_open_time_ms is not None:
            params["startTime"] = str(after_open_time_ms + 1)
            params["endTime"] = str(int(time.time() * 1000))
        payload = _fetch_json(
            "/api/v2/mix/market/candles",
            params,
        )
        context = "Bitget futures candles"

    rows = _expect_success(payload, context)
    candles = [
        _normalize_candle_row(instrument.key, row)
        for row in rows
        if isinstance(row, list)
    ]
    return tuple(sorted(candles, key=lambda candle: candle.open_time_ms))


def _normalize_ticker_payload(
    item: dict[str, Any],
    instrument: BitgetInstrument,
) -> dict[str, Any]:
    """Convert a Bitget ticker item into the app quote payload shape."""
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
    """Fetch one REST snapshot for the configured Bitget instruments."""
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
    """Manage the Bitget public websocket subscription for live tickers."""
    def __init__(self, instruments: tuple[BitgetInstrument, ...]) -> None:
        """Initialize websocket state and lookup tables for Bitget instruments."""
        self.instruments = instruments
        self.lookup = {
            (instrument.inst_type, instrument.symbol): instrument
            for instrument in instruments
        }
        self.websocket = None
        self.ping_task: asyncio.Task[None] | None = None

    async def _connect(self) -> None:
        """Open the Bitget websocket if it is not already connected."""
        if self.websocket is not None:
            return
        self.websocket = await websockets.connect(
            BITGET_WS_PUBLIC,
            ping_interval=None,
            ping_timeout=None,
            max_size=None,
        )

    async def _ping_loop(self) -> None:
        """Send periodic websocket pings required by Bitget."""
        assert self.websocket is not None
        while True:
            await asyncio.sleep(25)
            await self.websocket.send("ping")

    async def subscribe(self) -> None:
        """Subscribe the websocket to all configured ticker channels."""
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
        """Read websocket messages and forward normalized ticker payloads."""
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
        """Cancel background pinging and close the websocket connection."""
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
