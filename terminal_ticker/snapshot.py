from __future__ import annotations

from typing import Any

import yfinance as yf


def _as_float(raw_value: Any) -> float | None:
    if raw_value in (None, ""):
        return None
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def _as_int(raw_value: Any) -> int | None:
    if raw_value in (None, ""):
        return None
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        return None


def fetch_snapshot_payloads(symbols: list[str]) -> dict[str, dict[str, Any]]:
    snapshot_payloads: dict[str, dict[str, Any]] = {}
    tickers = yf.Tickers(" ".join(symbols))

    for symbol in symbols:
        payload: dict[str, Any] = {}
        ticker = tickers.tickers[symbol]

        try:
            fast_info = ticker.fast_info
        except Exception:
            fast_info = {}

        try:
            info = ticker.info
        except Exception:
            info = {}

        price = _as_float(getattr(fast_info, "get", lambda *_: None)("lastPrice"))
        previous_close = _as_float(
            getattr(fast_info, "get", lambda *_: None)("previousClose")
        )
        change = None
        change_percent = None
        if price is not None and previous_close not in (None, 0):
            change = price - previous_close
            change_percent = (change / previous_close) * 100

        if price is None:
            price = _as_float(info.get("currentPrice"))
        if previous_close is None:
            previous_close = _as_float(info.get("previousClose"))

        payload["display_name"] = info.get("shortName") or info.get("longName") or symbol
        payload["price"] = price
        payload["previous_close"] = previous_close
        payload["change"] = change
        payload["change_percent"] = change_percent
        payload["day_high"] = _as_float(getattr(fast_info, "get", lambda *_: None)("dayHigh"))
        payload["day_low"] = _as_float(getattr(fast_info, "get", lambda *_: None)("dayLow"))
        payload["volume"] = _as_int(getattr(fast_info, "get", lambda *_: None)("lastVolume"))
        payload["currency"] = info.get("currency") or ""
        payload["exchange"] = info.get("exchange") or ""

        snapshot_payloads[symbol] = payload

    return snapshot_payloads
