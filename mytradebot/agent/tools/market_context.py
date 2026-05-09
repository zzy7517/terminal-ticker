"""Market context serialization for agent tools."""
from __future__ import annotations

from typing import Any

from ...domain.price_action import Candle
from ...domain.quotes import QuoteState
from ...market_data.router import MarketInstrument


def short_candle(candle: Candle) -> dict[str, Any]:
    """Return a compact OHLCV payload suitable for LLM tool results."""
    return {
        "time": candle.open_time_ms // 1000,
        "open": candle.open,
        "high": candle.high,
        "low": candle.low,
        "close": candle.close,
        "volume": candle.volume,
    }


def build_market_context(
    *,
    instrument: MarketInstrument,
    quote: QuoteState,
    interval: str,
    max_candles: int,
) -> dict[str, Any]:
    """Serialize one instrument's current quote and multi-timeframe candles."""
    capped = max(1, min(int(max_candles), 100))
    timeframes = _serialized_timeframes(
        quote,
        primary_interval=interval,
        max_candles=capped,
    )
    return {
        "instrument": {
            "key": instrument.key,
            "symbol": instrument.symbol,
            "label": instrument.label,
            "source": instrument.source,
            "group": instrument.group,
        },
        "quote": {
            "price": quote.price,
            "priceLabel": quote.price_label(),
            "change": quote.change,
            "changePercent": quote.change_percent,
            "previousClose": quote.previous_close,
            "dayHigh": quote.day_high,
            "dayLow": quote.day_low,
            "volume": quote.volume,
            "currency": quote.currency,
            "exchange": quote.exchange,
            "status": quote.status,
            "ageLabel": quote.age_label(),
            "lastError": quote.last_error,
        },
        "analysis": {
            "primaryInterval": interval,
            "availableIntervals": [item["interval"] for item in timeframes],
        },
        "timeframes": timeframes,
    }


def _serialized_timeframes(
    quote: QuoteState,
    *,
    primary_interval: str,
    max_candles: int,
) -> list[dict[str, Any]]:
    """将报价中各时间周期的K线数据序列化为字典列表。"""
    ordered: list[str] = []
    if primary_interval in quote.multi_timeframe_candles:
        ordered.append(primary_interval)
    for interval in quote.multi_timeframe_candles:
        if interval not in ordered:
            ordered.append(interval)
    timeframes: list[dict[str, Any]] = []
    for interval in ordered:
        candles = tuple(quote.multi_timeframe_candles.get(interval, tuple()))[-max_candles:]
        if not candles:
            continue
        timeframes.append({
            "interval": interval,
            "candles": [short_candle(candle) for candle in candles],
        })
    return timeframes
