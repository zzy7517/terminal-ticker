"""文件用途：Bitget 模拟盘交易客户端封装。"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BITGET_API_BASE = "https://api.bitget.com"
BITGET_DEMO_FILL_SOURCE = "bitget-demo"
BITGET_USDT_FUTURES = "USDT-FUTURES"
BITGET_USDC_FUTURES = "USDC-FUTURES"
BITGET_COIN_FUTURES = "COIN-FUTURES"
BITGET_FUTURES_TYPES = {BITGET_USDT_FUTURES, BITGET_USDC_FUTURES, BITGET_COIN_FUTURES}

_FUTURES_ORDER_PATH = "/api/v2/mix/order/place-order"
_ORDER_TYPES = {"market", "limit"}
_FORCE_TYPES = {"gtc", "ioc", "fok", "post_only"}
_MARGIN_MODES = {"crossed", "isolated"}


class BitgetDemoTradingError(RuntimeError):
    """说明：Bitget 模拟盘交易配置或下单失败。"""


@dataclass(frozen=True)
class BitgetDemoOrderResult:
    """说明：规范化 Bitget 模拟盘下单结果，便于写入本地 trade store。"""

    raw: dict[str, Any]
    external_order_id: str | None = None
    client_order_id: str | None = None


@dataclass(frozen=True)
class _BitgetDemoCredentials:
    api_key: str
    api_secret: str
    passphrase: str


def _optional_env(*names: str) -> str | None:
    """说明：按优先级读取第一个非空环境变量。"""
    for name in names:
        value = os.environ.get(name)
        if value:
            text = value.strip()
            if text:
                return text
    return None


def bitget_demo_credentials_available() -> bool:
    """说明：返回 Bitget 模拟盘下单所需凭证是否已配置。"""
    return (
        _optional_env("BITGET_DEMO_API_KEY") is not None
        and _optional_env("BITGET_DEMO_API_SECRET", "BITGET_DEMO_SECRET_KEY") is not None
        and _optional_env("BITGET_DEMO_PASSPHRASE", "BITGET_DEMO_API_PASSPHRASE") is not None
    )


def _load_credentials() -> _BitgetDemoCredentials:
    """说明：从环境变量读取 Bitget Demo API Key。"""
    api_key = _optional_env("BITGET_DEMO_API_KEY")
    api_secret = _optional_env("BITGET_DEMO_API_SECRET", "BITGET_DEMO_SECRET_KEY")
    passphrase = _optional_env("BITGET_DEMO_PASSPHRASE", "BITGET_DEMO_API_PASSPHRASE")
    missing = []
    if api_key is None:
        missing.append("BITGET_DEMO_API_KEY")
    if api_secret is None:
        missing.append("BITGET_DEMO_API_SECRET")
    if passphrase is None:
        missing.append("BITGET_DEMO_PASSPHRASE")
    if missing:
        raise BitgetDemoTradingError(
            "Bitget demo trading requires " + ", ".join(missing) + "."
        )
    return _BitgetDemoCredentials(
        api_key=api_key,
        api_secret=api_secret,
        passphrase=passphrase,
    )


def _json_body(payload: dict[str, Any]) -> str:
    """说明：生成签名和请求共用的紧凑 JSON body。"""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _sign(
    *,
    timestamp_ms: str,
    method: str,
    request_path: str,
    body: str,
    secret: str,
    query_string: str = "",
) -> str:
    """说明：按 Bitget HMAC 规则生成 ACCESS-SIGN。"""
    query = f"?{query_string}" if query_string else ""
    pre_hash = f"{timestamp_ms}{method.upper()}{request_path}{query}{body}"
    digest = hmac.new(
        secret.encode("utf-8"),
        pre_hash.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(digest).decode("utf-8")


def _signed_post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    """说明：向 Bitget 模拟盘 REST API 发送已签名 POST 请求。"""
    credentials = _load_credentials()
    body = _json_body(payload)
    timestamp = str(int(time.time() * 1000))
    headers = {
        "ACCESS-KEY": credentials.api_key,
        "ACCESS-SIGN": _sign(
            timestamp_ms=timestamp,
            method="POST",
            request_path=path,
            body=body,
            secret=credentials.api_secret,
        ),
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": credentials.passphrase,
        "Content-Type": "application/json",
        "locale": "en-US",
        "paptrading": "1",
        "User-Agent": "tradex/0.1",
    }
    request = Request(
        f"{BITGET_API_BASE}{path}",
        data=body.encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=15) as response:
            parsed = json.load(response)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise BitgetDemoTradingError(
            f"Bitget demo request failed: HTTP {exc.code} {detail}"
        ) from exc
    except URLError as exc:
        raise BitgetDemoTradingError(f"Bitget demo request failed: {exc.reason}") from exc
    if not isinstance(parsed, dict):
        raise BitgetDemoTradingError("Bitget demo returned unexpected payload.")
    return parsed


def _expect_success(payload: dict[str, Any]) -> BitgetDemoOrderResult:
    """说明：校验 Bitget 下单响应并提取 orderId/clientOid。"""
    if payload.get("code") != "00000":
        detail = payload.get("msg") or payload.get("message") or payload
        raise BitgetDemoTradingError(f"Bitget demo order failed: {detail}")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise BitgetDemoTradingError("Bitget demo order returned unexpected payload.")
    order_id = data.get("orderId")
    client_oid = data.get("clientOid")
    return BitgetDemoOrderResult(
        raw=payload,
        external_order_id=str(order_id) if order_id not in (None, "") else None,
        client_order_id=str(client_oid) if client_oid not in (None, "") else None,
    )


def _client_oid() -> str:
    """说明：生成符合 Bitget 长度约束的本地 clientOid。"""
    return f"tradex-{int(time.time() * 1000)}-{secrets.token_hex(3)}"


def _normalize_inst_type(inst_type: str) -> str:
    """说明：规范化并限制当前支持的 Bitget 产品类型。"""
    normalized = inst_type.strip().upper()
    if normalized not in BITGET_FUTURES_TYPES:
        supported = ", ".join(sorted(BITGET_FUTURES_TYPES))
        raise BitgetDemoTradingError(
            f"unsupported Bitget demo inst_type: {inst_type}; expected one of: {supported}"
        )
    return normalized


def _normalize_order_type(order_type: str) -> str:
    """说明：规范化订单类型。"""
    normalized = (order_type or "market").strip().lower()
    if normalized not in _ORDER_TYPES:
        raise BitgetDemoTradingError("order_type must be market or limit")
    return normalized


def _normalize_force(force: str) -> str:
    """说明：规范化限价单有效期。"""
    normalized = (force or "gtc").strip().lower()
    if normalized not in _FORCE_TYPES:
        raise BitgetDemoTradingError("force must be one of: gtc, ioc, fok, post_only")
    return normalized


def _normalize_margin_mode(margin_mode: str) -> str:
    """说明：规范化合约保证金模式。"""
    normalized = (margin_mode or "crossed").strip().lower()
    if normalized not in _MARGIN_MODES:
        raise BitgetDemoTradingError("margin_mode must be crossed or isolated")
    return normalized


def open_demo_position(
    *,
    symbol: str,
    inst_type: str,
    is_buy: bool,
    size: float,
    order_type: str,
    limit_price: float | None = None,
    margin_mode: str = "crossed",
    margin_coin: str = "USDT",
    force: str = "gtc",
    client_oid: str | None = None,
) -> BitgetDemoOrderResult:
    """说明：在 Bitget 模拟盘提交 futures 订单。"""
    normalized_symbol = symbol.strip().upper()
    if not normalized_symbol:
        raise BitgetDemoTradingError("symbol is required")
    normalized_inst_type = _normalize_inst_type(inst_type)
    normalized_order_type = _normalize_order_type(order_type)
    if size <= 0:
        raise BitgetDemoTradingError("size must be positive")
    if normalized_order_type == "limit" and limit_price is None:
        raise BitgetDemoTradingError("limit order requires limit_price")

    side = "buy" if is_buy else "sell"
    oid = client_oid.strip() if isinstance(client_oid, str) and client_oid.strip() else _client_oid()
    if len(oid) > 32:
        raise BitgetDemoTradingError("client_oid must be 32 characters or fewer")

    path = _FUTURES_ORDER_PATH
    body = {
        "symbol": normalized_symbol,
        "productType": normalized_inst_type,
        "marginMode": _normalize_margin_mode(margin_mode),
        "marginCoin": margin_coin.strip().upper() or "USDT",
        "size": str(float(size)),
        "side": side,
        "tradeSide": "open",
        "orderType": normalized_order_type,
        "clientOid": oid,
    }
    if normalized_order_type == "limit":
        body["force"] = _normalize_force(force)
        body["price"] = str(float(limit_price))

    return _expect_success(_signed_post(path, body))
