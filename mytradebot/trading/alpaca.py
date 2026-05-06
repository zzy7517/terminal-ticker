"""文件用途：Alpaca paper trading 客户端，复用 market_data 层的凭证。"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .exchange_models import ExchangeOrder, ExchangePosition, OrderResult

ALPACA_TRADING_BASE = "https://paper-api.alpaca.markets"
ALPACA_PAPER_FILL_SOURCE = "alpaca-paper"
_log = logging.getLogger(__name__)


class AlpacaTradingError(RuntimeError):
    pass


def _trading_base_url() -> str:
    return os.environ.get("APCA_API_BASE_URL", ALPACA_TRADING_BASE).rstrip("/")


def _headers() -> dict[str, str]:
    key = os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY_ID")
    secret = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_API_SECRET_KEY")
    if not key or not secret:
        raise AlpacaTradingError("APCA_API_KEY_ID and APCA_API_SECRET_KEY required.")
    return {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
        "Content-Type": "application/json",
        "User-Agent": "mytradebot/0.1",
    }


def alpaca_credentials_available() -> bool:
    key = os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY_ID")
    secret = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_API_SECRET_KEY")
    return bool(key and secret)


def _request(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    url = f"{_trading_base_url()}{path}"
    headers = _headers()
    req = Request(url, method=method, headers=headers)
    if body is not None:
        req.data = json.dumps(body).encode()
    try:
        with urlopen(req, timeout=15) as resp:
            raw = resp.read()
            if not raw:
                return None
            return json.loads(raw)
    except HTTPError as exc:
        try:
            detail = exc.read().decode()
        except Exception:
            detail = str(exc)
        raise AlpacaTradingError(f"Alpaca {method} {path}: {detail}") from exc


def get_positions() -> list[ExchangePosition]:
    if not alpaca_credentials_available():
        return []
    try:
        data = _request("GET", "/v2/positions")
    except Exception:
        _log.warning("Failed to fetch Alpaca paper positions", exc_info=True)
        return []
    if not isinstance(data, list):
        return []
    positions: list[ExchangePosition] = []
    for item in data:
        symbol = item.get("symbol", "")
        qty = float(item.get("qty", 0))
        if qty == 0:
            continue
        positions.append(ExchangePosition(
            exchange=ALPACA_PAPER_FILL_SOURCE,
            symbol=symbol,
            instrument_key=f"alpaca:{symbol}",
            side="long" if qty > 0 else "short",
            size=abs(qty),
            entry_price=float(item.get("avg_entry_price", 0)),
            mark_price=float(item.get("current_price", 0)),
            unrealized_pnl=float(item.get("unrealized_pl", 0)),
            leverage=None,
            margin=float(item.get("cost_basis", 0)) or None,
        ))
    return positions


def get_open_orders() -> list[ExchangeOrder]:
    if not alpaca_credentials_available():
        return []
    try:
        data = _request("GET", "/v2/orders?status=open")
    except Exception:
        _log.warning("Failed to fetch Alpaca paper open orders", exc_info=True)
        return []
    if not isinstance(data, list):
        return []
    orders: list[ExchangeOrder] = []
    for item in data:
        symbol = item.get("symbol", "")
        oid = item.get("id", "")
        created = item.get("created_at", "")
        ts = 0
        if created:
            try:
                from datetime import datetime
                dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                ts = int(dt.timestamp() * 1000)
            except Exception:
                pass
        orders.append(ExchangeOrder(
            exchange=ALPACA_PAPER_FILL_SOURCE,
            symbol=symbol,
            instrument_key=f"alpaca:{symbol}",
            order_id=str(oid),
            side=item.get("side", "buy"),
            order_type=item.get("type", "market"),
            size=float(item.get("qty", 0) or 0),
            price=float(item.get("limit_price", 0) or 0) or None,
            filled_size=float(item.get("filled_qty", 0) or 0),
            status=item.get("status", "open"),
            created_at_ms=ts,
        ))
    return orders


def place_order(
    *,
    symbol: str,
    side: str = "buy",
    order_type: str = "market",
    qty: float | None = None,
    notional: float | None = None,
    limit_price: float | None = None,
    time_in_force: str = "day",
) -> OrderResult:
    body: dict[str, Any] = {
        "symbol": symbol,
        "side": side,
        "type": order_type,
        "time_in_force": time_in_force,
    }
    if qty is not None:
        body["qty"] = str(qty)
    elif notional is not None:
        body["notional"] = str(notional)
    else:
        return OrderResult(exchange=ALPACA_PAPER_FILL_SOURCE, error="qty or notional required")

    if limit_price is not None and order_type == "limit":
        body["limit_price"] = str(limit_price)

    try:
        resp = _request("POST", "/v2/orders", body=body)
    except AlpacaTradingError as exc:
        return OrderResult(exchange=ALPACA_PAPER_FILL_SOURCE, error=str(exc))

    if not isinstance(resp, dict):
        return OrderResult(exchange=ALPACA_PAPER_FILL_SOURCE, error="unexpected response")

    filled_price = resp.get("filled_avg_price")
    filled_qty = resp.get("filled_qty")
    return OrderResult(
        exchange=ALPACA_PAPER_FILL_SOURCE,
        order_id=resp.get("id"),
        average_price=float(filled_price) if filled_price else None,
        filled_size=float(filled_qty) if filled_qty else None,
        resting=resp.get("status") in ("new", "accepted", "pending_new", "partially_filled"),
        raw=resp,
    )


def cancel_order(*, order_id: str) -> bool:
    try:
        _request("DELETE", f"/v2/orders/{order_id}")
        return True
    except Exception:
        _log.warning("Failed to cancel Alpaca order %s", order_id, exc_info=True)
        return False
