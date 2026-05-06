"""文件用途：Hyperliquid 测试网交易客户端封装。"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

from .exchange_models import ExchangeOrder, ExchangePosition

HYPERLIQUID_TESTNET_API_BASE = "https://api.hyperliquid-testnet.xyz"
HYPERLIQUID_FILL_SOURCE = "hyperliquid-testnet"
_log = logging.getLogger(__name__)


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


def _get_user_address() -> str:
    """说明：返回用户地址：优先 account_address 环境变量，否则从私钥派生。"""
    addr = _optional_env(
        "HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS",
        "HYPERLIQUID_ACCOUNT_ADDRESS",
    )
    if addr:
        return addr
    private_key = _optional_env("HYPERLIQUID_TESTNET_PRIVATE_KEY", "HYPERLIQUID_PRIVATE_KEY")
    if private_key is None:
        raise HyperliquidTradingError("Hyperliquid credentials not configured.")
    try:
        import eth_account
    except ImportError as exc:
        raise HyperliquidTradingError("eth-account is required.") from exc
    wallet = eth_account.Account.from_key(private_key)
    return wallet.address


def _load_info():
    """说明：延迟导入 SDK 并构建只读 Info 客户端。"""
    try:
        from hyperliquid.info import Info
    except ImportError as exc:
        raise HyperliquidTradingError(
            "hyperliquid-python-sdk is required for Info API."
        ) from exc
    return Info(HYPERLIQUID_TESTNET_API_BASE, skip_ws=True)


def get_positions() -> list[ExchangePosition]:
    """说明：查询 Hyperliquid 测试网当前持仓。"""
    if not hyperliquid_credentials_available():
        return []
    try:
        info = _load_info()
        address = _get_user_address()
        state = info.user_state(address)
    except Exception:
        _log.warning("Failed to fetch Hyperliquid testnet positions", exc_info=True)
        return []
    positions: list[ExchangePosition] = []
    for pos in state.get("assetPositions", []):
        p = pos.get("position", {})
        coin = p.get("coin", "")
        szi = _to_float(p.get("szi")) or 0.0
        if szi == 0:
            continue
        entry = _to_float(p.get("entryPx")) or 0.0
        unrealized = _to_float(p.get("unrealizedPnl")) or 0.0
        leverage_info = p.get("leverage", {})
        lev = _to_float(leverage_info.get("value")) if isinstance(leverage_info, dict) else None
        liq_px = _to_float(p.get("liquidationPx"))
        margin_used = _to_float(p.get("marginUsed")) or 0.0
        positions.append(ExchangePosition(
            exchange=HYPERLIQUID_FILL_SOURCE,
            symbol=coin,
            instrument_key=f"hyperliquid-testnet:{coin}",
            side="long" if szi > 0 else "short",
            size=abs(szi),
            entry_price=entry,
            mark_price=entry,
            unrealized_pnl=unrealized,
            leverage=lev,
            margin=margin_used,
            liquidation_price=liq_px,
        ))
    return positions


def get_open_orders() -> list[ExchangeOrder]:
    """说明：查询 Hyperliquid 测试网挂单。"""
    if not hyperliquid_credentials_available():
        return []
    try:
        info = _load_info()
        address = _get_user_address()
        raw_orders = info.open_orders(address)
    except Exception:
        _log.warning("Failed to fetch Hyperliquid testnet open orders", exc_info=True)
        return []
    orders: list[ExchangeOrder] = []
    for o in raw_orders:
        coin = o.get("coin", "")
        oid = str(o.get("oid", ""))
        is_buy = o.get("side", "").upper() == "B"
        sz = _to_float(o.get("sz")) or 0.0
        px = _to_float(o.get("limitPx"))
        ts = int(o.get("timestamp", 0))
        orders.append(ExchangeOrder(
            exchange=HYPERLIQUID_FILL_SOURCE,
            symbol=coin,
            instrument_key=f"hyperliquid-testnet:{coin}",
            order_id=oid,
            side="buy" if is_buy else "sell",
            order_type="limit",
            size=sz,
            price=px,
            filled_size=0.0,
            status="open",
            created_at_ms=ts,
        ))
    return orders


def cancel_order(*, order_id: str, coin: str) -> bool:
    """说明：撤销 Hyperliquid 测试网挂单。"""
    exchange = _load_exchange()
    try:
        result = exchange.cancel(coin.strip().upper(), int(order_id))
        if isinstance(result, dict) and result.get("status") == "ok":
            return True
        return False
    except Exception:
        _log.warning("Failed to cancel Hyperliquid order %s", order_id, exc_info=True)
        return False


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
