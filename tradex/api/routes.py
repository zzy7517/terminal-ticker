"""文件用途：注册所有 FastAPI 路由到 app 实例。"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import StreamingResponse

from ..trading import TradeStatus
from ..trading.models import FillKind, TradeDirection
from .helpers import (
    require_local_social_request,
    require_local_trading_request,
)
from .runtime import MarketRuntime


def register_routes(app: FastAPI, runtime: MarketRuntime) -> None:
    """把所有 REST / WebSocket 路由挂到 app 上。"""

    @app.get("/api/state")
    async def get_state() -> dict[str, Any]:
        return runtime.snapshot()

    @app.get("/api/instruments/catalog")
    async def instrument_catalog_endpoint() -> dict[str, Any]:
        return runtime.instrument_catalog_payload()

    # -- Watchlist --

    @app.post("/api/watchlist/bitget")
    async def add_bitget_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        return await runtime.add_bitget(payload)

    @app.post("/api/watchlist/hyperliquid")
    async def add_hyperliquid_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        return await runtime.add_hyperliquid(payload)

    @app.delete("/api/watchlist/instruments/{instrument_key}")
    async def remove_instrument_endpoint(instrument_key: str) -> dict[str, Any]:
        return await runtime.remove_instrument(instrument_key)

    # -- Agent config --

    @app.get("/api/agent/models")
    async def list_agent_models_endpoint() -> dict[str, Any]:
        return await runtime.list_agent_models()

    @app.get("/api/agent/providers/{provider_name}/models")
    async def list_provider_models_endpoint(provider_name: str) -> dict[str, Any]:
        return await runtime.list_agent_models(provider=provider_name)

    @app.post("/api/agent/providers/{provider_name}")
    async def update_provider_profile_endpoint(
        provider_name: str, payload: dict[str, Any],
    ) -> dict[str, Any]:
        return await runtime.update_provider_profile(provider_name, payload)

    @app.post("/api/agent/config")
    async def update_agent_config_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        return await runtime.update_agent_config(payload)

    # -- Memory --

    @app.post("/api/memory/notes")
    async def create_memory_note_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        return await runtime.create_memory_note(payload)

    @app.get("/api/memory/status")
    async def memory_status_endpoint() -> dict[str, Any]:
        return runtime.memory_status()

    @app.post("/api/memory/config")
    async def update_memory_config_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        return await runtime.update_memory_config(payload)

    @app.post("/api/memory/browse")
    async def memory_browse_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        action = str(payload.get("action") or "list")
        params = payload.get("params") or {}
        if not isinstance(params, dict):
            params = {}
        return await runtime.memory_browse(action, params)

    # -- Agent sessions --

    @app.get("/api/agent/sessions")
    async def list_agent_sessions_endpoint(limit: int = 20, preload: int = 10) -> dict[str, Any]:
        return await runtime.list_agent_sessions(limit=limit, preload=preload)

    @app.post("/api/agent/sessions")
    async def create_agent_session_endpoint(payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return await runtime.create_agent_session(payload)

    @app.get("/api/agent/sessions/{identifier}")
    async def get_agent_session_endpoint(identifier: str) -> dict[str, Any]:
        return await runtime.get_agent_session_resource(identifier)

    @app.patch("/api/agent/sessions/{session_id}")
    async def update_agent_session_endpoint(session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await runtime.update_agent_session(session_id, payload)

    @app.delete("/api/agent/sessions/{session_id}")
    async def delete_agent_session_by_id_endpoint(session_id: str) -> dict[str, Any]:
        return await runtime.delete_agent_session_by_id(session_id)

    @app.get("/api/agent/sessions/{instrument_key}/history")
    async def list_agent_session_history_endpoint(instrument_key: str) -> dict[str, Any]:
        return await runtime.list_agent_session_history(instrument_key)

    @app.post("/api/agent/sessions/{instrument_key}/history/{session_id}/resume")
    async def resume_agent_session_endpoint(instrument_key: str, session_id: str) -> dict[str, Any]:
        return await runtime.resume_agent_session(instrument_key, session_id)

    @app.delete("/api/agent/sessions/{instrument_key}/history/{session_id}")
    async def delete_agent_session_endpoint(instrument_key: str, session_id: str) -> dict[str, Any]:
        return await runtime.delete_agent_session(instrument_key, session_id)

    @app.post("/api/agent/sessions/{instrument_key}/messages")
    async def append_agent_session_message_endpoint(
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        message = payload.get("message", payload.get("prompt"))
        session_payload = dict(payload)
        if message is not None:
            session_payload["message"] = str(message)
        session = await runtime._agent_session_payload(instrument_key)
        if session["session"] is not None:
            return await runtime.analyze_agent_session(instrument_key, session_payload)
        return await runtime.analyze_instrument(
            instrument_key,
            prompt=session_payload.get("message"),
            override_provider=session_payload.get("provider"),
            override_model=session_payload.get("model"),
        )

    @app.post("/api/agent/sessions/{instrument_key}/messages/stream")
    async def stream_agent_session_message_endpoint(
        instrument_key: str,
        payload: dict[str, Any],
    ) -> StreamingResponse:
        stream = await runtime.stream_agent_message(instrument_key, payload)
        return StreamingResponse(
            stream,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/agent/sessions/{instrument_key}/reset")
    async def reset_agent_session_endpoint(instrument_key: str) -> dict[str, Any]:
        return await runtime.reset_agent_session(instrument_key)

    # -- Analysis config --

    @app.post("/api/analysis/config")
    async def update_analysis_config_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        return await runtime.update_analysis_config(payload)

    @app.post("/api/instruments/{instrument_key}/analysis-interval")
    async def update_instrument_analysis_interval_endpoint(
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        return await runtime.update_instrument_analysis_interval(instrument_key, payload)

    @app.post("/api/agent/analyze/{instrument_key}")
    async def analyze_instrument_endpoint(instrument_key: str) -> dict[str, Any]:
        return await runtime.analyze_instrument(instrument_key)

    # -- Trading --

    @app.post("/api/bitget-demo/trades/{instrument_key}")
    async def open_bitget_demo_trade_endpoint(
        request: Request,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        require_local_trading_request(request)
        return await runtime.open_bitget_demo_trade(instrument_key, payload)

    @app.post("/api/hyperliquid/trades/{instrument_key}")
    async def open_hyperliquid_trade_endpoint(
        request: Request,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        require_local_trading_request(request)
        return await runtime.open_hyperliquid_trade(instrument_key, payload)

    @app.get("/api/trades")
    async def list_trades_endpoint(
        instrument_key: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        status_list: list[TradeStatus] | None = None
        if status:
            parts = [s.strip().lower() for s in status.split(",") if s.strip()]
            parsed: list[TradeStatus] = []
            for part in parts:
                try:
                    parsed.append(TradeStatus(part))
                except ValueError:
                    raise HTTPException(status_code=400, detail=f"invalid status: {part}")
            status_list = parsed
        trades = runtime.trade_store.list_trades(
            instrument_key=instrument_key,
            statuses=status_list,
            limit=max(1, min(int(limit), 500)),
        )
        return {"trades": [trade.to_payload() for trade in trades]}

    @app.post("/api/bitget-demo/{instrument_key}/open")
    async def open_bitget_demo_trade_alias_endpoint(
        request: Request,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        require_local_trading_request(request)
        return await runtime.open_bitget_demo_trade(instrument_key, payload)

    @app.post("/api/hyperliquid/{instrument_key}/open")
    async def open_hyperliquid_trade_alias_endpoint(
        request: Request,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        require_local_trading_request(request)
        return await runtime.open_hyperliquid_trade(instrument_key, payload)

    @app.get("/api/trades/{trade_id}")
    async def get_trade_endpoint(trade_id: int) -> dict[str, Any]:
        trade = runtime.trade_store.get_trade(int(trade_id))
        if trade is None:
            raise HTTPException(status_code=404, detail="trade not found")
        snapshot = None
        if trade.snapshot_id is not None:
            snap = runtime.trade_store.get_snapshot(trade.snapshot_id)
            snapshot = snap.to_payload() if snap else None
        lessons = runtime.trade_store.list_lessons(
            instrument_key=trade.instrument_key,
            limit=5,
        )
        return {
            "trade": trade.to_payload(),
            "snapshot": snapshot,
            "lessons": list(lessons),
        }

    @app.get("/api/lessons")
    async def list_lessons_endpoint(
        instrument_key: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        lessons = runtime.trade_store.list_lessons(
            instrument_key=instrument_key,
            limit=max(1, min(int(limit), 500)),
        )
        return {"lessons": list(lessons)}

    # -- Exchange --

    @app.get("/api/exchange/positions")
    async def get_exchange_positions_endpoint() -> dict[str, Any]:
        positions = runtime.exchange_router.get_all_positions()
        return {"positions": [p.to_payload() for p in positions]}

    @app.get("/api/exchange/orders")
    async def get_exchange_orders_endpoint() -> dict[str, Any]:
        orders = runtime.exchange_router.get_all_orders()
        return {"orders": [o.to_payload() for o in orders]}

    @app.post("/api/exchange/orders")
    async def place_exchange_order_endpoint(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
        require_local_trading_request(request)
        instrument_key = payload.get("instrumentKey", "")
        if not instrument_key:
            raise HTTPException(status_code=400, detail="instrumentKey required")
        order_kwargs = {k: v for k, v in payload.items() if k != "instrumentKey"}
        result = await asyncio.to_thread(
            lambda: runtime.exchange_router.place_order(instrument_key=instrument_key, **order_kwargs)
        )
        if not result.ok:
            raise HTTPException(status_code=400, detail=result.error)
        direction_str = str(payload.get("direction", "long")).lower()
        try:
            direction = TradeDirection(direction_str)
        except ValueError:
            direction = TradeDirection.LONG
        size = float(payload.get("size", 0))
        reasoning = str(payload.get("reasoning", "Manual exchange trade"))
        status = TradeStatus.OPEN if result.filled_size else TradeStatus.PLANNED
        snapshot_payload = runtime._trading_snapshot_payload(instrument_key)
        snapshot_id = None
        if snapshot_payload:
            snap = await asyncio.to_thread(
                runtime.trade_store.save_snapshot,
                instrument_key=instrument_key,
                payload=snapshot_payload,
            )
            snapshot_id = snap.id
        trade = await asyncio.to_thread(
            runtime.trade_store.create_trade,
            instrument_key=instrument_key,
            direction=direction,
            size=size,
            intent_price=result.average_price,
            stop_price=None,
            target_prices=tuple(),
            reasoning_text=reasoning,
            session_id=None,
            snapshot_id=snapshot_id,
            market_kind=result.exchange,
            fill_source=result.exchange,
            status=status,
            external_order_id=result.order_id,
        )
        if result.filled_size and result.average_price is not None:
            await asyncio.to_thread(
                runtime.trade_store.record_fill,
                trade_id=trade.id,
                kind=FillKind.ENTRY,
                price=float(result.average_price),
                quantity=float(result.filled_size),
                trigger_reason=f"{result.exchange} order filled",
                fill_source=result.exchange,
                external_order_id=result.order_id,
            )
        await runtime.broadcast()
        resp = result.to_payload()
        resp["localTradeId"] = trade.id
        return resp

    @app.delete("/api/exchange/orders/{exchange}/{order_id}")
    async def cancel_exchange_order_endpoint(
        request: Request,
        exchange: str,
        order_id: str,
        symbol: str = "",
    ) -> dict[str, Any]:
        require_local_trading_request(request)
        ok = runtime.exchange_router.cancel_order(
            exchange=exchange,
            order_id=order_id,
            symbol=symbol,
        )
        if not ok:
            raise HTTPException(status_code=400, detail="cancel failed")
        await runtime.broadcast()
        return {"cancelled": True}

    # -- News --

    @app.get("/api/news")
    async def get_news_endpoint(limit: int = 50) -> dict[str, Any]:
        if runtime.news_service is None:
            return {"news": [], "enabled": False}
        resolved = max(1, min(int(limit), 200))
        items = runtime.news_service.recent(limit=resolved)
        return {"news": [item.to_payload() for item in items], "enabled": True}

    @app.post("/api/news/config")
    async def update_news_config_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        return await runtime.update_news_config(payload)

    @app.post("/api/news/refresh")
    async def refresh_news_endpoint() -> dict[str, Any]:
        if runtime.news_service is None:
            raise HTTPException(status_code=409, detail="news module disabled")
        outcome = await runtime.news_service.refresh_now()
        items = runtime.news_service.recent()
        return {
            "status": outcome.status,
            "inserted": outcome.inserted,
            "totalRecent": outcome.total_recent,
            "stale": outcome.status == "timeout",
            "error": outcome.error,
            "news": [item.to_payload() for item in items],
        }

    # -- Social feed --

    @app.get("/api/social/feed")
    async def get_social_feed_endpoint(
        request: Request,
        limit: int = 50,
        query: str | None = None,
    ) -> dict[str, Any]:
        require_local_social_request(request)
        if runtime.social_feed_service is None:
            return {"items": [], "enabled": False}
        resolved = max(1, min(int(limit), 200))
        items = runtime.social_feed_service.recent_items(limit=resolved, query=query)
        return {
            "enabled": True,
            "items": [item.to_payload() for item in items],
            "status": {
                "lastStatus": runtime.social_feed_service.last_status,
                "lastError": runtime.social_feed_service.last_error,
                "lastFetchedAtMs": runtime.social_feed_service.last_fetched_at_ms,
            },
        }

    @app.post("/api/social/x/refresh")
    async def refresh_x_following_endpoint(
        request: Request,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        require_local_social_request(request)
        if runtime.social_feed_service is None:
            raise HTTPException(status_code=409, detail="social feed module disabled")
        raw_count = (payload or {}).get("count", 20)
        try:
            count = max(1, min(int(raw_count), 100))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="count must be an integer") from exc
        outcome = await runtime.social_feed_service.refresh_x_following(count=count)
        await runtime.broadcast()
        items = runtime.social_feed_service.recent_items(limit=50)
        return {
            "status": outcome.status,
            "inserted": outcome.inserted,
            "totalRecent": outcome.total_recent,
            "error": outcome.error,
            "items": [item.to_payload() for item in items],
        }

    @app.get("/api/social/auth")
    async def get_social_auth_endpoint(request: Request) -> dict[str, Any]:
        require_local_social_request(request)
        return runtime.x_auth_store.status().to_payload()

    @app.post("/api/social/auth")
    async def save_social_auth_endpoint(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
        require_local_social_request(request)
        auth_token = str(payload.get("authToken") or payload.get("auth_token") or "")
        ct0 = str(payload.get("ct0") or "")
        try:
            status = runtime.x_auth_store.save(auth_token=auth_token, ct0=ct0)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return status.to_payload()

    @app.delete("/api/social/auth")
    async def clear_social_auth_endpoint(request: Request) -> dict[str, Any]:
        require_local_social_request(request)
        return runtime.x_auth_store.clear().to_payload()

    @app.post("/api/social/config")
    async def update_social_feed_config_endpoint(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
        require_local_social_request(request)
        return await runtime.update_social_feed_config(payload)

    # -- WebSocket --

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await runtime.connect(websocket)
