"""文件用途：Hyperliquid 测试网交易客户端封装。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

HYPERLIQUID_TESTNET_API_BASE = "https://api.hyperliquid-testnet.xyz"
HYPERLIQUID_FILL_SOURCE = "hyperliquid-testnet"


class HyperliquidTradingError(RuntimeError):
    """说明：Hyperliquid 测试网交易配置或下单失败。"""


@dataclass(frozen=True)
class HyperliquidOrderResult:
    """说明：规范化 Hyperliquid 下单结果，便于写入本地 trade store。"""

    raw: dict[str, Any]
    external_order_id: str | None = None
    average_price: float | None = None
    filled_size: float | None = None
    resting: bool = False


def _optional_env(*names: str) -> str | None:
    """说明：按优先级读取第一个非空环境变量。"""
    for name in names:
        value = os.environ.get(name)
        if value:
            text = value.strip()
            if text:
                return text
    return None


def hyperliquid_credentials_available() -> bool:
    """说明：返回测试网下单所需凭证是否已配置。"""
    return _optional_env("HYPERLIQUID_TESTNET_PRIVATE_KEY", "HYPERLIQUID_PRIVATE_KEY") is not None


def _load_exchange():
    """说明：延迟导入 SDK 并根据环境变量构建 Exchange。"""
    private_key = _optional_env("HYPERLIQUID_TESTNET_PRIVATE_KEY", "HYPERLIQUID_PRIVATE_KEY")
    if private_key is None:
        raise HyperliquidTradingError(
            "Hyperliquid testnet trading requires HYPERLIQUID_TESTNET_PRIVATE_KEY."
        )
    account_address = _optional_env(
        "HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS",
        "HYPERLIQUID_ACCOUNT_ADDRESS",
    )
    vault_address = _optional_env(
        "HYPERLIQUID_TESTNET_VAULT_ADDRESS",
        "HYPERLIQUID_VAULT_ADDRESS",
    )
    try:
        import eth_account
        from hyperliquid.exchange import Exchange
    except ImportError as exc:
        raise HyperliquidTradingError(
            "Hyperliquid testnet trading requires hyperliquid-python-sdk and eth-account."
        ) from exc

    wallet = eth_account.Account.from_key(private_key)
    return Exchange(
        wallet,
        HYPERLIQUID_TESTNET_API_BASE,
        account_address=account_address,
        vault_address=vault_address,
    )


def _parse_order_result(payload: Any) -> HyperliquidOrderResult:
    """说明：从 SDK 原始响应中提取 oid、成交价和成交数量。"""
    if not isinstance(payload, dict):
        raise HyperliquidTradingError("Hyperliquid returned unexpected order payload.")
    if payload.get("status") != "ok":
        raise HyperliquidTradingError(str(payload.get("response") or payload))
    response = payload.get("response")
    data = response.get("data") if isinstance(response, dict) else None
    statuses = data.get("statuses") if isinstance(data, dict) else None
    if not isinstance(statuses, list) or not statuses:
        return HyperliquidOrderResult(raw=payload)

    status = statuses[0]
    if isinstance(status, dict) and "error" in status:
        raise HyperliquidTradingError(str(status["error"]))
    if isinstance(status, dict) and isinstance(status.get("filled"), dict):
        filled = status["filled"]
        return HyperliquidOrderResult(
            raw=payload,
            external_order_id=str(filled.get("oid")) if filled.get("oid") is not None else None,
            average_price=_to_float(filled.get("avgPx")),
            filled_size=_to_float(filled.get("totalSz")),
            resting=False,
        )
    if isinstance(status, dict) and isinstance(status.get("resting"), dict):
        resting = status["resting"]
        return HyperliquidOrderResult(
            raw=payload,
            external_order_id=str(resting.get("oid")) if resting.get("oid") is not None else None,
            resting=True,
        )
    return HyperliquidOrderResult(raw=payload)


def _to_float(value: Any) -> float | None:
    """说明：把 SDK 字符串数值转换成 float。"""
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def open_testnet_position(
    *,
    coin: str,
    is_buy: bool,
    size: float,
    order_type: str,
    limit_price: float | None = None,
    slippage: float = 0.05,
) -> HyperliquidOrderResult:
    """说明：在 Hyperliquid 测试网开仓，market 使用 SDK 的 IOC 包装。"""
    if size <= 0:
        raise HyperliquidTradingError("size must be positive")
    normalized_coin = coin.strip().upper()
    if not normalized_coin:
        raise HyperliquidTradingError("coin is required")
    exchange = _load_exchange()
    normalized_type = (order_type or "market").strip().lower()
    if normalized_type == "market":
        payload = exchange.market_open(
            normalized_coin,
            bool(is_buy),
            float(size),
            slippage=float(slippage),
        )
    elif normalized_type == "limit":
        if limit_price is None:
            raise HyperliquidTradingError("limit order requires limit_price")
        payload = exchange.order(
            normalized_coin,
            bool(is_buy),
            float(size),
            float(limit_price),
            {"limit": {"tif": "Gtc"}},
            reduce_only=False,
        )
    else:
        raise HyperliquidTradingError("order_type must be market or limit")
    return _parse_order_result(payload)
