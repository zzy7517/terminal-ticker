"""文件用途：Hyperliquid 主网交易客户端封装。"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any
from urllib.request import Request, urlopen

from .exchange_models import ExchangeOrder, ExchangePosition

HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz"
HYPERLIQUID_FILL_SOURCE = "hyperliquid"
MAINNET_TRADING_ENV = "MYTRADEBOT_ENABLE_HYPERLIQUID_MAINNET_TRADING"
_TRUTHY_ENV_VALUES = {"1", "true", "yes", "on"}
_log = logging.getLogger(__name__)


class HyperliquidTradingError(RuntimeError):
    """说明：Hyperliquid 主网交易配置或下单失败。"""


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
    """说明：返回主网下单所需凭证是否已配置。"""
    return _optional_env("HYPERLIQUID_PRIVATE_KEY") is not None


def hyperliquid_mainnet_trading_enabled() -> bool:
    """说明：主网真实交易必须显式启用，避免仅配置私钥就可下单。"""
    value = os.environ.get(MAINNET_TRADING_ENV, "")
    return value.strip().lower() in _TRUTHY_ENV_VALUES


def _require_mainnet_trading_enabled() -> None:
    if not hyperliquid_mainnet_trading_enabled():
        raise HyperliquidTradingError(
            f"Hyperliquid mainnet trading is disabled. Set {MAINNET_TRADING_ENV}=true to enable live order mutations."
        )


def _load_exchange():
    """说明：延迟导入 SDK 并根据环境变量构建 Exchange。"""
    _require_mainnet_trading_enabled()
    private_key = _optional_env("HYPERLIQUID_PRIVATE_KEY")
    if private_key is None:
        raise HyperliquidTradingError(
            "Hyperliquid trading requires HYPERLIQUID_PRIVATE_KEY."
        )
    account_address = _optional_env(
        "HYPERLIQUID_ACCOUNT_ADDRESS",
    )
    vault_address = _optional_env(
        "HYPERLIQUID_VAULT_ADDRESS",
    )
    try:
        import eth_account
        from hyperliquid.exchange import Exchange
    except ImportError as exc:
        raise HyperliquidTradingError(
            "Hyperliquid trading requires hyperliquid-python-sdk and eth-account."
        ) from exc

    wallet = eth_account.Account.from_key(private_key)
    return Exchange(
        wallet,
        HYPERLIQUID_API_BASE,
        account_address=account_address,
        vault_address=vault_address,
    )


def _get_user_address() -> str:
    """说明：返回用户地址：优先 account_address 环境变量，否则从私钥派生。"""
    addr = _optional_env(
        "HYPERLIQUID_ACCOUNT_ADDRESS",
    )
    if addr:
        return addr
    private_key = _optional_env("HYPERLIQUID_PRIVATE_KEY")
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
    return Info(HYPERLIQUID_API_BASE, skip_ws=True)


def _post_info(payload: dict[str, Any]) -> Any:
    """说明：调用 Hyperliquid 主网 /info；用于 SDK 暂未覆盖的 dex 参数。"""
    request = Request(
        f"{HYPERLIQUID_API_BASE}/info",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "mytradebot/0.1"},
        method="POST",
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def _perp_dex_names() -> tuple[str | None, ...]:
    """说明：返回主 DEX 和 builder DEX 名称；失败时至少返回主 DEX。"""
    try:
        payload = _post_info({"type": "perpDexs"})
    except Exception:
        return (None,)
    if not isinstance(payload, list):
        return (None,)
    names: list[str | None] = [None]
    for item in payload:
        if item is None or not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if name and name not in names:
            names.append(name)
    return tuple(names)


def _dex_payload(base: dict[str, Any], dex: str | None) -> dict[str, Any]:
    payload = dict(base)
    if dex:
        payload["dex"] = dex
    return payload


def _normalize_coin_for_api(coin: str) -> str:
    """说明：规范化 builder DEX coin，避免把 flx:NVDA 错改成 FLX:NVDA。"""
    value = coin.strip()
    if ":" in value:
        dex, asset = value.split(":", 1)
        dex = dex.strip().lower()
        asset = asset.strip().upper()
        return f"{dex}:{asset}" if dex and asset else ""
    return value


def _coin_with_dex(coin: Any, dex: str | None) -> str:
    """说明：把 per-dex 查询返回的裸 coin 补成全局唯一 coin。"""
    value = str(coin or "").strip()
    if not value:
        return ""
    if ":" in value:
        return _normalize_coin_for_api(value)
    if dex:
        return f"{dex.strip().lower()}:{value.upper()}"
    return value


def get_positions() -> list[ExchangePosition]:
    """说明：查询 Hyperliquid 主网当前持仓。"""
    if not hyperliquid_credentials_available():
        return []
    address = _get_user_address()
    positions: list[ExchangePosition] = []
    for dex in _perp_dex_names():
        try:
            state = _post_info(_dex_payload({
                "type": "clearinghouseState",
                "user": address,
            }, dex))
        except Exception:
            _log.warning("Failed to fetch Hyperliquid positions for dex=%s", dex or "main", exc_info=True)
            continue
        positions.extend(_positions_from_state(state, dex=dex))
    return positions


def _positions_from_state(state: Any, *, dex: str | None = None) -> list[ExchangePosition]:
    if not isinstance(state, dict):
        return []
    positions: list[ExchangePosition] = []
    for pos in state.get("assetPositions", []):
        p = pos.get("position", {}) if isinstance(pos, dict) else {}
        if not isinstance(p, dict):
            continue
        coin = _coin_with_dex(p.get("coin", ""), dex)
        szi = _to_float(p.get("szi")) or 0.0
        if szi == 0:
            continue
        entry = _to_float(p.get("entryPx")) or 0.0
        mark = _to_float(p.get("markPx")) or entry
        unrealized = _to_float(p.get("unrealizedPnl")) or 0.0
        leverage_info = p.get("leverage", {})
        lev = _to_float(leverage_info.get("value")) if isinstance(leverage_info, dict) else None
        liq_px = _to_float(p.get("liquidationPx"))
        margin_used = _to_float(p.get("marginUsed")) or 0.0
        positions.append(ExchangePosition(
            exchange=HYPERLIQUID_FILL_SOURCE,
            symbol=coin,
            instrument_key=f"hyperliquid:{coin}",
            side="long" if szi > 0 else "short",
            size=abs(szi),
            entry_price=entry,
            mark_price=mark,
            unrealized_pnl=unrealized,
            leverage=lev,
            margin=margin_used,
            liquidation_price=liq_px,
        ))
    return positions


def _legacy_sdk_positions() -> list[ExchangePosition]:
    try:
        info = _load_info()
        address = _get_user_address()
        state = info.user_state(address)
    except Exception:
        _log.warning("Failed to fetch Hyperliquid positions", exc_info=True)
        return []
    return _positions_from_state(state)


def get_open_orders() -> list[ExchangeOrder]:
    """说明：查询 Hyperliquid 主网挂单。"""
    if not hyperliquid_credentials_available():
        return []
    address = _get_user_address()
    orders: list[ExchangeOrder] = []
    for dex in _perp_dex_names():
        try:
            raw_orders = _post_info(_dex_payload({
                "type": "openOrders",
                "user": address,
            }, dex))
        except Exception:
            _log.warning("Failed to fetch Hyperliquid open orders for dex=%s", dex or "main", exc_info=True)
            continue
        orders.extend(_orders_from_payload(raw_orders, dex=dex))
    return orders


def _orders_from_payload(raw_orders: Any, *, dex: str | None = None) -> list[ExchangeOrder]:
    if not isinstance(raw_orders, list):
        return []
    orders: list[ExchangeOrder] = []
    for o in raw_orders:
        if not isinstance(o, dict):
            continue
        coin = _coin_with_dex(o.get("coin", ""), dex)
        oid = str(o.get("oid", ""))
        is_buy = o.get("side", "").upper() == "B"
        sz = _to_float(o.get("sz")) or 0.0
        px = _to_float(o.get("limitPx"))
        trigger_px = _to_float(o.get("triggerPx"))
        ts = int(o.get("timestamp", 0))
        reduce_only = o.get("reduceOnly")
        if isinstance(reduce_only, str):
            reduce_only = reduce_only.lower() == "true"
        orders.append(ExchangeOrder(
            exchange=HYPERLIQUID_FILL_SOURCE,
            symbol=coin,
            instrument_key=f"hyperliquid:{coin}",
            order_id=oid,
            side="buy" if is_buy else "sell",
            order_type="trigger" if trigger_px is not None else "limit",
            size=sz,
            price=px,
            filled_size=0.0,
            status="open",
            created_at_ms=ts,
            reduce_only=reduce_only if isinstance(reduce_only, bool) else None,
            trigger_price=trigger_px,
            tpsl=o.get("tpsl"),
        ))
    return orders


def _legacy_sdk_open_orders() -> list[ExchangeOrder]:
    try:
        info = _load_info()
        address = _get_user_address()
        raw_orders = info.open_orders(address)
    except Exception:
        _log.warning("Failed to fetch Hyperliquid open orders", exc_info=True)
        return []
    return _orders_from_payload(raw_orders)


def get_user_fills(
    *,
    coin: str | None = None,
    start_time_ms: int | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    if not hyperliquid_credentials_available():
        return []
    try:
        info = _load_info()
        address = _get_user_address()
        start = start_time_ms or 0
        raw_fills = info.user_fills_by_time(address, start)
    except Exception:
        _log.warning("Failed to fetch Hyperliquid user fills", exc_info=True)
        return []
    results: list[dict[str, Any]] = []
    for item in raw_fills:
        fill_coin = item.get("coin", "")
        if coin and fill_coin != coin:
            continue
        px = _to_float(item.get("px"))
        sz = _to_float(item.get("sz"))
        fee = _to_float(item.get("fee"))
        closed_pnl = _to_float(item.get("closedPnl"))
        results.append({
            "oid": item.get("oid"),
            "coin": fill_coin,
            "instrumentKey": f"hyperliquid:{fill_coin}",
            "side": item.get("side"),
            "price": float(px) if px is not None else 0.0,
            "size": float(sz) if sz is not None else 0.0,
            "fee": float(fee) if fee is not None else 0.0,
            "closedPnl": float(closed_pnl) if closed_pnl is not None else 0.0,
            "filledAtMs": int(item.get("time", 0)),
            "dir": item.get("dir"),
            "exchange": HYPERLIQUID_FILL_SOURCE,
        })
        if len(results) >= limit:
            break
    return results


def cancel_order(*, order_id: str, coin: str) -> bool:
    """说明：撤销 Hyperliquid 主网挂单。"""
    exchange = _load_exchange()
    try:
        result = exchange.cancel(_normalize_coin_for_api(coin), int(order_id))
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


def open_position(
    *,
    coin: str,
    is_buy: bool,
    size: float,
    order_type: str,
    limit_price: float | None = None,
    slippage: float = 0.05,
    take_profit_price: float | None = None,
    stop_loss_price: float | None = None,
) -> HyperliquidOrderResult:
    """说明：在 Hyperliquid 主网开仓，market 使用 SDK 的 IOC 包装。"""
    if size <= 0:
        raise HyperliquidTradingError("size must be positive")
    normalized_coin = _normalize_coin_for_api(coin)
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
        result = _parse_order_result(payload)
        tpsl_payloads = _place_tpsl_children(
            exchange,
            coin=normalized_coin,
            is_buy=bool(is_buy),
            size=float(size),
            take_profit_price=take_profit_price,
            stop_loss_price=stop_loss_price,
        )
        if tpsl_payloads:
            return HyperliquidOrderResult(
                raw={"parent": payload, "tpsl": tpsl_payloads},
                external_order_id=result.external_order_id,
                average_price=result.average_price,
                filled_size=result.filled_size,
                resting=result.resting,
            )
        return result
    elif normalized_type == "limit":
        if limit_price is None:
            raise HyperliquidTradingError("limit order requires limit_price")
        if take_profit_price is not None or stop_loss_price is not None:
            orders = [{
                "coin": normalized_coin,
                "is_buy": bool(is_buy),
                "sz": float(size),
                "limit_px": float(limit_price),
                "order_type": {"limit": {"tif": "Gtc"}},
                "reduce_only": False,
            }]
            orders.extend(_tpsl_order_specs(
                coin=normalized_coin,
                is_buy=bool(is_buy),
                size=float(size),
                take_profit_price=take_profit_price,
                stop_loss_price=stop_loss_price,
            ))
            payload = exchange.bulk_orders(orders, grouping="normalTpsl")
        else:
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


def _tpsl_order_specs(
    *,
    coin: str,
    is_buy: bool,
    size: float,
    take_profit_price: float | None,
    stop_loss_price: float | None,
) -> list[dict[str, Any]]:
    """说明：构建 Hyperliquid reduce-only TP/SL trigger 子单。"""
    orders: list[dict[str, Any]] = []
    close_is_buy = not is_buy
    if take_profit_price is not None:
        orders.append({
            "coin": coin,
            "is_buy": close_is_buy,
            "sz": size,
            "limit_px": float(take_profit_price),
            "order_type": {
                "trigger": {
                    "triggerPx": float(take_profit_price),
                    "isMarket": True,
                    "tpsl": "tp",
                }
            },
            "reduce_only": True,
        })
    if stop_loss_price is not None:
        orders.append({
            "coin": coin,
            "is_buy": close_is_buy,
            "sz": size,
            "limit_px": float(stop_loss_price),
            "order_type": {
                "trigger": {
                    "triggerPx": float(stop_loss_price),
                    "isMarket": True,
                    "tpsl": "sl",
                }
            },
            "reduce_only": True,
        })
    return orders


def _place_tpsl_children(
    exchange: Any,
    *,
    coin: str,
    is_buy: bool,
    size: float,
    take_profit_price: float | None,
    stop_loss_price: float | None,
) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    for spec in _tpsl_order_specs(
        coin=coin,
        is_buy=is_buy,
        size=size,
        take_profit_price=take_profit_price,
        stop_loss_price=stop_loss_price,
    ):
        try:
            payload = exchange.order(
                spec["coin"],
                spec["is_buy"],
                spec["sz"],
                spec["limit_px"],
                spec["order_type"],
                reduce_only=True,
            )
            payloads.append(payload)
        except Exception as exc:
            _log.warning("Failed to place Hyperliquid TP/SL child order", exc_info=True)
            payloads.append({
                "status": "error",
                "error": str(exc) or exc.__class__.__name__,
                "order": spec,
            })
    return payloads


def place_trigger_order(
    *,
    coin: str,
    is_buy: bool,
    size: float,
    trigger_price: float,
    tpsl: str,
    limit_price: float | None = None,
) -> HyperliquidOrderResult:
    """说明：提交 reduce-only TP/SL trigger order，用于调整已有仓位风控。"""
    if size <= 0:
        raise HyperliquidTradingError("size must be positive")
    normalized_tpsl = tpsl.strip().lower()
    if normalized_tpsl not in {"tp", "sl"}:
        raise HyperliquidTradingError("tpsl must be tp or sl")
    normalized_coin = _normalize_coin_for_api(coin)
    if not normalized_coin:
        raise HyperliquidTradingError("coin is required")
    exchange = _load_exchange()
    payload = exchange.order(
        normalized_coin,
        bool(is_buy),
        float(size),
        float(limit_price if limit_price is not None else trigger_price),
        {"trigger": {
            "triggerPx": float(trigger_price),
            "isMarket": True,
            "tpsl": normalized_tpsl,
        }},
        reduce_only=True,
    )
    return _parse_order_result(payload)


def close_position(
    *,
    coin: str,
    size: float | None = None,
    slippage: float = 0.05,
) -> HyperliquidOrderResult:
    """说明：用 Hyperliquid market_close 市价平仓；size 为空时平该 coin 全部仓位。"""
    normalized_coin = _normalize_coin_for_api(coin)
    if not normalized_coin:
        raise HyperliquidTradingError("coin is required")
    if size is not None and size <= 0:
        raise HyperliquidTradingError("size must be positive")
    exchange = _load_exchange()
    payload = exchange.market_close(
        normalized_coin,
        sz=None if size is None else float(size),
        slippage=float(slippage),
    )
    return _parse_order_result(payload)
