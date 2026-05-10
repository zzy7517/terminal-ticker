"""文件用途：Bitget demo trading 客户端，走 REST API v2 + PAPTRADING 模式。"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .exchange_models import ExchangeOrder, ExchangePosition, OrderResult

BITGET_API_BASE = "https://api.bitget.com"
BITGET_DEMO_FILL_SOURCE = "bitget-demo"
_log = logging.getLogger(__name__)


class BitgetTradingError(RuntimeError):
    pass


def _env(name: str) -> str | None:
    v = os.environ.get(name, "").strip()
    return v or None


def bitget_credentials_available() -> bool:
    return all(_env(k) for k in ("BITGET_API_KEY", "BITGET_API_SECRET", "BITGET_API_PASSPHRASE"))


def _sign(timestamp: str, method: str, path: str, query: str, body: str, secret: str) -> str:
    message = timestamp + method.upper() + path + query + body
    mac = hmac.new(secret.encode(), message.encode(), hashlib.sha256).digest()
    return base64.b64encode(mac).decode()


def _request(
    method: str,
    path: str,
    params: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    api_key = _env("BITGET_API_KEY")
    api_secret = _env("BITGET_API_SECRET")
    passphrase = _env("BITGET_API_PASSPHRASE")
    if not api_key or not api_secret or not passphrase:
        raise BitgetTradingError("BITGET_API_KEY, BITGET_API_SECRET, BITGET_API_PASSPHRASE required.")

    timestamp = str(int(time.time() * 1000))
    query_str = ("?" + urlencode(params)) if params else ""
    body_str = json.dumps(body) if body else ""

    signature = _sign(timestamp, method, path, query_str, body_str, api_secret)

    url = f"{BITGET_API_BASE}{path}{query_str}"
    headers = {
        "ACCESS-KEY": api_key,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
        "User-Agent": "tradex/0.1",
        "PAPTRADING": "1",
    }

    req = Request(url, method=method, headers=headers)
    if body_str:
        req.data = body_str.encode()

    try:
        with urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except HTTPError as exc:
        try:
            detail = exc.read().decode()
        except Exception:
            detail = str(exc)
        raise BitgetTradingError(f"Bitget API {method} {path} failed: {detail}") from exc


def _to_float(v: Any) -> float:
    if v in (None, ""):
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _instrument_key(symbol: str, product_type: str) -> str:
    return f"{product_type}:{symbol}"


def get_positions(product_type: str = "USDT-FUTURES") -> list[ExchangePosition]:
    if not bitget_credentials_available():
        return []
    try:
        resp = _request("GET", "/api/v2/mix/position/all-position", params={"productType": product_type})
    except Exception:
        _log.warning("Failed to fetch Bitget demo positions", exc_info=True)
        return []
    if resp.get("code") != "00000":
        _log.warning("Bitget positions error: %s", resp.get("msg"))
        return []
    data = resp.get("data", [])
    if not isinstance(data, list):
        return []
    positions: list[ExchangePosition] = []
    for item in data:
        symbol = item.get("symbol", "")
        size = _to_float(item.get("total"))
        if size == 0:
            continue
        hold_side = item.get("holdSide", "long")
        positions.append(ExchangePosition(
            exchange=BITGET_DEMO_FILL_SOURCE,
            symbol=symbol,
            instrument_key=_instrument_key(symbol, product_type),
            side=hold_side,
            size=size,
            entry_price=_to_float(item.get("openPriceAvg")),
            mark_price=_to_float(item.get("markPrice")),
            unrealized_pnl=_to_float(item.get("unrealizedPL")),
            leverage=_to_float(item.get("leverage")) or None,
            margin=_to_float(item.get("margin")) or None,
            liquidation_price=_to_float(item.get("liquidationPrice")) or None,
        ))
    return positions


def get_open_orders(product_type: str = "USDT-FUTURES") -> list[ExchangeOrder]:
    if not bitget_credentials_available():
        return []
    try:
        resp = _request("GET", "/api/v2/mix/order/orders-pending", params={"productType": product_type})
    except Exception:
        _log.warning("Failed to fetch Bitget demo open orders", exc_info=True)
        return []
    if resp.get("code") != "00000":
        _log.warning("Bitget open orders error: %s", resp.get("msg"))
        return []
    data = resp.get("data", {})
    order_list = data.get("entrustedList", []) if isinstance(data, dict) else []
    if not isinstance(order_list, list):
        return []
    orders: list[ExchangeOrder] = []
    for item in order_list:
        symbol = item.get("symbol", "")
        oid = item.get("orderId", "")
        side_raw = item.get("side", "buy")
        orders.append(ExchangeOrder(
            exchange=BITGET_DEMO_FILL_SOURCE,
            symbol=symbol,
            instrument_key=_instrument_key(symbol, product_type),
            order_id=str(oid),
            side=side_raw,
            order_type=item.get("orderType", "limit"),
            size=_to_float(item.get("size")),
            price=_to_float(item.get("price")) or None,
            filled_size=_to_float(item.get("baseVolume")),
            status="open",
            created_at_ms=int(item.get("cTime", 0)),
        ))
    return orders


def place_order(
    *,
    symbol: str,
    product_type: str = "USDT-FUTURES",
    margin_mode: str = "crossed",
    margin_coin: str = "USDT",
    side: str = "buy",
    trade_side: str = "open",
    order_type: str = "market",
    size: float,
    price: float | None = None,
    preset_stop_surplus_price: float | None = None,
    preset_stop_loss_price: float | None = None,
    preset_stop_surplus_execute_price: float | None = None,
    preset_stop_loss_execute_price: float | None = None,
) -> OrderResult:
    body: dict[str, Any] = {
        "symbol": symbol,
        "productType": product_type,
        "marginMode": margin_mode,
        "marginCoin": margin_coin,
        "side": side,
        "tradeSide": trade_side,
        "orderType": order_type,
        "size": str(size),
    }
    if price is not None and order_type == "limit":
        body["price"] = str(price)
    if preset_stop_surplus_price is not None:
        body["presetStopSurplusPrice"] = str(preset_stop_surplus_price)
    if preset_stop_loss_price is not None:
        body["presetStopLossPrice"] = str(preset_stop_loss_price)
    if preset_stop_surplus_execute_price is not None:
        body["presetStopSurplusExecutePrice"] = str(preset_stop_surplus_execute_price)
    if preset_stop_loss_execute_price is not None:
        body["presetStopLossExecutePrice"] = str(preset_stop_loss_execute_price)

    try:
        resp = _request("POST", "/api/v2/mix/order/place-order", body=body)
    except BitgetTradingError as exc:
        return OrderResult(exchange=BITGET_DEMO_FILL_SOURCE, error=str(exc))

    if resp.get("code") != "00000":
        return OrderResult(
            exchange=BITGET_DEMO_FILL_SOURCE,
            error=resp.get("msg") or "unknown error",
            raw=resp,
        )
    data = resp.get("data", {})
    return OrderResult(
        exchange=BITGET_DEMO_FILL_SOURCE,
        order_id=data.get("orderId"),
        raw=resp,
    )


def place_tpsl_order(
    *,
    symbol: str,
    product_type: str = "USDT-FUTURES",
    margin_coin: str = "USDT",
    plan_type: str,
    trigger_price: float,
    hold_side: str,
    size: float | None = None,
    trigger_type: str = "mark_price",
    execute_price: float | None = None,
) -> OrderResult:
    body: dict[str, Any] = {
        "symbol": symbol,
        "productType": product_type,
        "marginCoin": margin_coin,
        "planType": plan_type,
        "triggerPrice": str(trigger_price),
        "triggerType": trigger_type,
        "executePrice": "0" if execute_price is None else str(execute_price),
        "holdSide": hold_side,
    }
    if size is not None:
        body["size"] = str(size)

    try:
        resp = _request("POST", "/api/v2/mix/order/place-tpsl-order", body=body)
    except BitgetTradingError as exc:
        return OrderResult(exchange=BITGET_DEMO_FILL_SOURCE, error=str(exc))

    if resp.get("code") != "00000":
        return OrderResult(
            exchange=BITGET_DEMO_FILL_SOURCE,
            error=resp.get("msg") or "unknown error",
            raw=resp,
        )
    data = resp.get("data", {})
    return OrderResult(
        exchange=BITGET_DEMO_FILL_SOURCE,
        order_id=data.get("orderId"),
        raw=resp,
    )


def close_position(
    *,
    symbol: str,
    product_type: str = "USDT-FUTURES",
    hold_side: str | None = None,
) -> OrderResult:
    body: dict[str, Any] = {
        "symbol": symbol,
        "productType": product_type,
    }
    if hold_side:
        body["holdSide"] = hold_side

    try:
        resp = _request("POST", "/api/v2/mix/order/close-positions", body=body)
    except BitgetTradingError as exc:
        return OrderResult(exchange=BITGET_DEMO_FILL_SOURCE, error=str(exc))

    if resp.get("code") != "00000":
        return OrderResult(
            exchange=BITGET_DEMO_FILL_SOURCE,
            error=resp.get("msg") or "unknown error",
            raw=resp,
        )
    data = resp.get("data", {})
    success_list = data.get("successList", []) if isinstance(data, dict) else []
    failure_list = data.get("failureList", []) if isinstance(data, dict) else []
    if not success_list and failure_list:
        first_failure = failure_list[0]
        error = first_failure.get("errorMsg") if isinstance(first_failure, dict) else None
        return OrderResult(
            exchange=BITGET_DEMO_FILL_SOURCE,
            error=error or "close position failed",
            raw=resp,
        )
    first_success = success_list[0] if success_list else {}
    return OrderResult(
        exchange=BITGET_DEMO_FILL_SOURCE,
        order_id=first_success.get("orderId") if isinstance(first_success, dict) else None,
        raw=resp,
    )


def get_order_fills(
    *,
    symbol: str,
    product_type: str = "USDT-FUTURES",
    order_id: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    if not bitget_credentials_available():
        return []
    params: dict[str, str] = {
        "symbol": symbol,
        "productType": product_type,
        "limit": str(max(1, min(int(limit), 100))),
    }
    if order_id:
        params["orderId"] = str(order_id)
    try:
        resp = _request("GET", "/api/v2/mix/order/fills", params=params)
    except Exception:
        _log.warning("Failed to fetch Bitget order fills for %s", symbol, exc_info=True)
        return []
    if resp.get("code") != "00000":
        _log.warning("Bitget order fills error: %s", resp.get("msg"))
        return []
    fill_list = resp.get("data", {}).get("fillList", [])
    if not isinstance(fill_list, list):
        return []
    results: list[dict[str, Any]] = []
    for item in fill_list[:limit]:
        results.append({
            "tradeId": item.get("tradeId"),
            "orderId": item.get("orderId"),
            "symbol": item.get("symbol", symbol),
            "side": item.get("side"),
            "price": _to_float(item.get("price")),
            "size": _to_float(item.get("baseVolume") or item.get("size")),
            "fee": _to_float(item.get("fee")),
            "profit": _to_float(item.get("profit")),
            "filledAtMs": int(item.get("cTime", 0)),
            "exchange": BITGET_DEMO_FILL_SOURCE,
        })
    return results


def cancel_order(*, order_id: str, symbol: str, product_type: str = "USDT-FUTURES") -> bool:
    try:
        resp = _request("POST", "/api/v2/mix/order/cancel-order", body={
            "symbol": symbol,
            "productType": product_type,
            "orderId": order_id,
        })
        return resp.get("code") == "00000"
    except Exception:
        _log.warning("Failed to cancel Bitget order %s", order_id, exc_info=True)
        return False
