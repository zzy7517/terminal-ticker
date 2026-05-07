"""文件用途：MarketRuntime — 维护实时行情状态、后台 feed 和 WebSocket 客户端。"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import suppress
from dataclasses import replace
from pathlib import Path
from typing import Any

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from ..agent import (
    AgentRuntimeServices,
    AgentSessionRuntime,
    AgentSessionStore,
    LLMProviderError,
    LLMProviderUnavailable,
    TradingAgentRuntime,
    TradingAgentRuntimeServices,
    create_llm_provider,
    list_available_agent_models,
)
from ..agent.market_context import build_market_context, build_multi_market_context
from ..config import (
    AgentConfig,
    ALPACA_SOURCE,
    AppConfig,
    BITGET_SOURCE,
    HYPERLIQUID_TESTNET_SOURCE,
    NewsConfig,
    ProviderProfile,
    SocialFeedConfig,
    load_config,
)
from ..config.agent_models import (
    SUPPORTED_AGENT_PROVIDERS,
    normalize_api_mode,
    normalize_model,
    normalize_reasoning_effort,
)
from ..domain.price_action import Candle, merge_candles
from ..domain.quotes import QuoteState
from ..market_data.alpaca import search_assets as search_alpaca_assets
from ..market_data.bitget import search_instruments as search_bitget_instruments
from ..market_data.hyperliquid import search_instruments as search_hyperliquid_instruments
from ..market_data.router import MarketInstrument, resolve_instruments
from ..news import NewsService, NewsStore
from ..news.providers.reuters import ReutersSitemapProvider
from ..runtime.controller import TickerController
from ..runtime.feed import CHART_CANDLE_LIMIT, OLDER_CANDLE_LIMIT
from ..social_feed import SocialFeedService, SocialFeedStore, XAuthStore
from ..trading import TradeStatus, TradeStore, ExchangeRouter
from ..trading.bitget_demo import (
    BITGET_DEMO_FILL_SOURCE,
    BitgetDemoTradingError,
    open_demo_position as open_bitget_demo_position,
)
from ..trading.hyperliquid import (
    HYPERLIQUID_FILL_SOURCE,
    HyperliquidTradingError,
    open_testnet_position as open_hyperliquid_testnet_position,
)
from ..trading.models import FillKind, TradeDirection
from ..trading.review import review_pending
from ..config.watchlist_store import (
    append_alpaca_symbol_to_watchlist,
    append_bitget_symbol_to_watchlist,
    append_hyperliquid_symbol_to_watchlist,
    remove_alpaca_symbol_from_watchlist,
    remove_symbol_from_watchlist,
    update_agent_config_in_watchlist,
    update_analysis_config_in_watchlist,
    update_instrument_analysis_interval_in_watchlist,
    update_news_config_in_watchlist,
    update_social_feed_config_in_watchlist,
)
from .helpers import (
    agent_config_from_payload,
    agent_tool_audit_hook,
    analysis_config_from_payload,
    effective_agent_config,
    news_config_from_payload,
    normalize_agent_prompt,
    request_float,
    social_feed_config_from_payload,
)
from .serializers import (
    DEFAULT_AGENT_USER_PROMPT,
    agent_session_config_kwargs,
    agent_session_title,
    serialize_market_state,
    sse_event,
    utc_now_iso,
)

LOGGER = logging.getLogger(__name__)
OLDER_CANDLE_SOURCES = {ALPACA_SOURCE, BITGET_SOURCE, HYPERLIQUID_TESTNET_SOURCE}


class MarketContextProvider:
    """为 agent tools 提供行情数据访问的适配器。"""

    def __init__(self, runtime: MarketRuntime) -> None:
        self._runtime = runtime

    def get_quote(self, instrument_key: str) -> QuoteState | None:
        return self._runtime.controller.quotes.get(self._resolve_instrument_key(instrument_key))

    def get_candles(
        self,
        instrument_key: str,
        *,
        interval: str | None = None,
    ) -> tuple[Candle, ...]:
        resolved_key = self._resolve_instrument_key(instrument_key)
        quote = self._runtime.controller.quotes.get(resolved_key)
        if quote is None:
            return tuple()
        if interval:
            return tuple(quote.multi_timeframe_candles.get(interval, tuple()))
        instrument = self._runtime._instrument_by_key(resolved_key)
        current_interval = instrument.analysis_interval or self._runtime.config.analysis.interval
        return tuple(quote.multi_timeframe_candles.get(current_interval, quote.candles))

    def list_instruments(self) -> tuple[MarketInstrument, ...]:
        return self._runtime.instruments

    def get_market_context(
        self,
        instrument_key: str,
        *,
        max_candles: int = 40,
    ) -> dict[str, Any]:
        resolved_key = self._resolve_instrument_key(instrument_key)
        instrument = self._runtime._instrument_by_key(resolved_key)
        quote = self._runtime.controller.quotes.get(resolved_key)
        if quote is None:
            return {}
        return build_market_context(
            instrument=instrument,
            quote=quote,
            interval=instrument.analysis_interval or self._runtime.config.analysis.interval,
            max_candles=max_candles,
        )

    def get_multi_market_context(
        self,
        instrument_keys: tuple[str, ...],
        *,
        max_candles: int = 25,
    ) -> dict[str, Any]:
        items: list[tuple[MarketInstrument, QuoteState, str]] = []
        for key in instrument_keys[:6]:
            resolved_key = self._resolve_instrument_key(key)
            instrument = self._runtime._instrument_by_key(resolved_key)
            quote = self._runtime.controller.quotes.get(resolved_key)
            if quote is None:
                continue
            items.append((
                instrument,
                quote,
                instrument.analysis_interval or self._runtime.config.analysis.interval,
            ))
        return build_multi_market_context(tuple(items), max_candles=max_candles) if items else {}

    def resolve_instrument_key(self, instrument_key: str) -> str:
        return self._resolve_instrument_key(instrument_key)

    def _resolve_instrument_key(self, instrument_key: str) -> str:
        if instrument_key in self._runtime.controller.quotes:
            return instrument_key
        parts = [part.strip() for part in instrument_key.split(":") if part.strip()]
        if len(parts) == 3 and parts[0].lower() == BITGET_SOURCE:
            candidate = f"{parts[2].upper()}:{parts[1].upper()}"
            if candidate in self._runtime.controller.quotes:
                return candidate
        return instrument_key


class MarketRuntime:
    """维护实时行情状态、后台 feed 和 WebSocket 客户端。"""

    def __init__(
        self,
        *,
        config: AppConfig,
        instruments: tuple[MarketInstrument, ...],
        controller_factory: Callable[..., Any] = TickerController,
        agent_session_store: AgentSessionStore | None = None,
        trade_store: TradeStore | None = None,
    ) -> None:
        self.config = config
        self.instruments = instruments
        self.controller_factory = controller_factory
        self.trade_store = trade_store or TradeStore()
        self.exchange_router = ExchangeRouter(trade_store=self.trade_store)
        self.controller = controller_factory(
            config=config,
            instruments=instruments,
        )
        self.clients: set[WebSocket] = set()
        self.pump_task: asyncio.Task[None] | None = None
        self.review_task: asyncio.Task[None] | None = None
        self.running = False
        self.agent_analyses: dict[str, dict[str, Any]] = {}
        self.agent_session_store = agent_session_store or AgentSessionStore()
        self._active_session_for_tools: str | None = None
        self.x_auth_store = XAuthStore()
        self.social_feed_service: SocialFeedService | None = None
        if config.social_feed.enabled:
            self.social_feed_service = self._create_social_feed_service(config.social_feed)
        self._flush_handle: asyncio.TimerHandle | None = None
        self._flush_delay: float = 2.0
        self.news_service: NewsService | None = None
        self.news_analyst = None  # type: ignore[var-annotated]
        if config.news.enabled:
            news_store = NewsStore()
            news_provider = ReutersSitemapProvider(
                url=config.news.reuters_url,
                timeout_seconds=config.news.request_timeout_seconds,
            )
            self.news_service = NewsService(
                store=news_store,
                provider=news_provider,
                poll_interval_seconds=config.news.poll_interval_seconds,
                max_interval_seconds=config.news.max_interval_seconds,
                retention_days=config.news.retention_days,
                recent_limit=config.news.recent_limit,
            )
            if config.news_analyst.enabled:
                self._wire_news_analyst()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if self.running:
            return
        self.running = True
        self.controller.start()
        self.pump_task = asyncio.create_task(self._pump())
        self.review_task = asyncio.create_task(self._run_review_loop())
        if self.news_service is not None:
            await self.news_service.start()

    async def stop(self) -> None:
        self.running = False
        if self.pump_task is not None:
            self.pump_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.pump_task
            self.pump_task = None
        if self.review_task is not None:
            self.review_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.review_task
            self.review_task = None
        if self.news_service is not None:
            await self.news_service.stop()
        self.controller.stop()
        for websocket in tuple(self.clients):
            with suppress(Exception):
                await websocket.close()
        self.clients.clear()

    # ------------------------------------------------------------------
    # Snapshot & broadcast
    # ------------------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        open_trades = [
            trade.to_payload()
            for trade in self.trade_store.list_trades(
                statuses=[TradeStatus.PLANNED, TradeStatus.OPEN],
            )
        ]
        exchange_positions: list[dict[str, Any]] = []
        exchange_orders: list[dict[str, Any]] = []
        try:
            exchange_positions = [p.to_payload() for p in self.exchange_router.get_all_positions()]
        except Exception:
            LOGGER.debug("Failed to fetch exchange positions for snapshot", exc_info=True)
        try:
            exchange_orders = [o.to_payload() for o in self.exchange_router.get_all_orders()]
        except Exception:
            LOGGER.debug("Failed to fetch exchange orders for snapshot", exc_info=True)
        recent_news: list[dict[str, Any]] = []
        news_status: dict[str, Any] = {"enabled": self.config.news.enabled}
        if self.news_service is not None:
            recent_news = [item.to_payload() for item in self.news_service.recent()]
            news_status.update({
                "lastStatus": self.news_service.last_status,
                "lastError": self.news_service.last_error,
                "lastFetchedAtMs": self.news_service.last_fetched_at_ms,
            })
        recent_news_decisions: list[dict[str, Any]] = []
        if self.news_analyst is not None:
            recent_news_decisions = self.news_analyst.decision_store.recent(limit=50)
        return serialize_market_state(
            config=self.config,
            instruments=self.instruments,
            quotes=self.controller.quotes,
            stream_status=self.controller.stream_status,
            agent_analyses=self.agent_analyses,
            open_trades=open_trades,
            exchange_positions=exchange_positions,
            exchange_orders=exchange_orders,
            recent_news=recent_news,
            news_status=news_status,
            recent_news_decisions=recent_news_decisions,
        )

    async def broadcast(self) -> None:
        if not self.clients:
            return
        payload = self.snapshot()
        stale_clients: list[WebSocket] = []
        for websocket in tuple(self.clients):
            try:
                await websocket.send_json(payload)
            except Exception:
                stale_clients.append(websocket)
        for websocket in stale_clients:
            self.clients.discard(websocket)

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.clients.add(websocket)
        await websocket.send_json(self.snapshot())
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            self.clients.discard(websocket)

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    async def search_alpaca(self, query: str) -> list[dict[str, Any]]:
        text = query.strip()
        if not text:
            return []
        active = {instrument.key for instrument in self.instruments}
        results = await asyncio.to_thread(search_alpaca_assets, text)
        return [
            {
                "source": ALPACA_SOURCE,
                "symbol": item.symbol,
                "label": item.default_label,
                "instType": None,
                "key": f"{ALPACA_SOURCE}:{item.symbol}",
                "nameCn": "",
                "nameHk": "",
                "nameEn": item.name,
                "displayText": item.display_text(),
                "exists": f"{ALPACA_SOURCE}:{item.symbol}" in active,
            }
            for item in results
        ]

    async def search_bitget(self, query: str) -> list[dict[str, Any]]:
        text = query.strip()
        if not text:
            return []
        active = {instrument.key for instrument in self.instruments}
        results = await asyncio.to_thread(search_bitget_instruments, text)
        return [
            {
                "source": BITGET_SOURCE,
                "symbol": item.symbol,
                "label": item.label,
                "instType": item.inst_type,
                "key": item.key,
                "nameCn": "",
                "nameHk": "",
                "nameEn": "",
                "displayText": f"{item.inst_type} · {item.base_asset}/{item.quote_asset}",
                "exists": item.key in active,
            }
            for item in results
        ]

    async def search_hyperliquid(self, query: str) -> list[dict[str, Any]]:
        text = query.strip()
        if not text:
            return []
        active = {instrument.key for instrument in self.instruments}
        results = await asyncio.to_thread(search_hyperliquid_instruments, text)
        return [
            {
                "source": HYPERLIQUID_TESTNET_SOURCE,
                "symbol": item.symbol,
                "label": item.label,
                "instType": None,
                "key": item.key,
                "nameCn": "",
                "nameHk": "",
                "nameEn": "",
                "displayText": f"Testnet perp · {item.base_asset}/{item.quote_asset}",
                "exists": item.key in active,
            }
            for item in results
        ]

    async def search_instruments(self, source: str, query: str) -> list[dict[str, Any]]:
        normalized_source = source.strip().lower()
        if normalized_source == ALPACA_SOURCE:
            return await self.search_alpaca(query)
        if normalized_source == BITGET_SOURCE:
            return await self.search_bitget(query)
        if normalized_source == HYPERLIQUID_TESTNET_SOURCE:
            return await self.search_hyperliquid(query)
        raise HTTPException(status_code=400, detail="Unsupported search source.")

    # ------------------------------------------------------------------
    # Watchlist management
    # ------------------------------------------------------------------

    async def add_alpaca(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_path = self._require_source_path()
        symbol = str(payload.get("symbol") or "")
        label = str(payload.get("label") or "").strip() or None
        try:
            changed = await asyncio.to_thread(
                append_alpaca_symbol_to_watchlist,
                source_path,
                symbol=symbol,
                label=label,
                group="stocks",
                show_collapsed=True,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if changed:
            await self.reload_from_source()
        return {"changed": changed, "state": self.snapshot()}

    async def add_bitget(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_path = self._require_source_path()
        symbol = str(payload.get("symbol") or "")
        inst_type = str(payload.get("instType") or payload.get("inst_type") or "")
        label = str(payload.get("label") or "").strip() or None
        try:
            changed = await asyncio.to_thread(
                append_bitget_symbol_to_watchlist,
                source_path,
                symbol=symbol,
                inst_type=inst_type,
                label=label,
                group="crypto",
                show_collapsed=True,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if changed:
            await self.reload_from_source()
        return {"changed": changed, "state": self.snapshot()}

    async def add_hyperliquid(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_path = self._require_source_path()
        symbol = str(payload.get("symbol") or "")
        label = str(payload.get("label") or "").strip() or None
        try:
            changed = await asyncio.to_thread(
                append_hyperliquid_symbol_to_watchlist,
                source_path,
                symbol=symbol,
                label=label,
                group="crypto",
                show_collapsed=True,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if changed:
            await self.reload_from_source()
        return {"changed": changed, "state": self.snapshot()}

    async def remove_alpaca(self, symbol: str) -> dict[str, Any]:
        source_path = self._require_source_path()
        changed = await asyncio.to_thread(
            remove_alpaca_symbol_from_watchlist,
            source_path,
            symbol=symbol,
        )
        if changed:
            await self.reload_from_source()
        return {"changed": changed, "state": self.snapshot()}

    async def remove_instrument(self, instrument_key: str) -> dict[str, Any]:
        source_path = self._require_source_path()
        instrument = self._instrument_by_key(instrument_key)
        try:
            changed = await asyncio.to_thread(
                remove_symbol_from_watchlist,
                source_path,
                source=instrument.source,
                symbol=instrument.symbol,
                inst_type=getattr(instrument, "inst_type", None),
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        self.agent_analyses.pop(instrument.key, None)
        if changed:
            await self.reload_from_source()
        return {"changed": changed, "state": self.snapshot()}

    # ------------------------------------------------------------------
    # Config updates
    # ------------------------------------------------------------------

    async def list_agent_models(self, provider: str | None = None) -> dict[str, Any]:
        try:
            models = await list_available_agent_models(
                self.config.agent, provider_override=provider,
            )
        except (LLMProviderUnavailable, LLMProviderError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        resolved_provider = provider or self.config.agent.provider
        return {
            "provider": resolved_provider,
            "apiMode": normalize_api_mode(resolved_provider),
            "activeModel": self.config.agent.model,
            "models": models,
        }

    async def update_agent_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_source_path()
        try:
            next_config = agent_config_from_payload(self.config.agent, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self.config = replace(self.config, agent=next_config)
        self.agent_analyses = {}
        self._schedule_flush()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    async def update_provider_profile(
        self, provider_name: str, payload: dict[str, Any],
    ) -> dict[str, Any]:
        self._require_source_path()
        if provider_name not in SUPPORTED_AGENT_PROVIDERS:
            raise HTTPException(status_code=400, detail=f"Unknown provider: {provider_name}")
        current = self.config.agent
        profiles = dict(current.provider_profiles)
        old = profiles.get(provider_name, ProviderProfile())
        new_models = old.models
        if "models" in payload:
            raw = payload["models"]
            new_models = tuple(normalize_model(provider_name, m) for m in raw if m)
        elif "toggleModel" in payload:
            slug = normalize_model(provider_name, payload["toggleModel"])
            if slug in old.models:
                new_models = tuple(m for m in old.models if m != slug)
            else:
                new_models = (*old.models, slug)
        new_efforts = dict(old.model_efforts)
        if "modelEffort" in payload:
            me = payload["modelEffort"]
            if isinstance(me, dict) and "model" in me and "effort" in me:
                effort_model = normalize_model(provider_name, me["model"])
                new_efforts[effort_model] = normalize_reasoning_effort(me["effort"])
        new_efforts = {
            model: effort
            for model, effort in new_efforts.items()
            if model in new_models
        }
        from ..config import _primary_from_profiles
        profiles[provider_name] = ProviderProfile(
            enabled=payload.get("enabled", old.enabled),
            models=new_models,
            model_efforts=tuple(new_efforts.items()),
        )
        primary_provider, primary_model, primary_effort = _primary_from_profiles(profiles)
        next_config = AgentConfig(
            enabled=current.enabled,
            provider=primary_provider,
            api_mode=normalize_api_mode(primary_provider),
            model=primary_model,
            max_candles=current.max_candles,
            reasoning_effort=primary_effort,
            provider_profiles=profiles,
        )
        self.config = replace(self.config, agent=next_config)
        self.agent_analyses = {}
        self._schedule_flush()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    async def update_analysis_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_source_path()
        try:
            next_config = analysis_config_from_payload(self.config.analysis, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self.config = replace(self.config, analysis=next_config)
        self.agent_analyses = {}
        self._schedule_flush()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    async def update_news_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_source_path()
        try:
            next_config = news_config_from_payload(self.config.news, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self.config = replace(self.config, news=next_config)
        await self._apply_news_service_state(next_config)
        self._schedule_flush()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    async def update_social_feed_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_source_path()
        try:
            next_config = social_feed_config_from_payload(self.config.social_feed, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self.config = replace(self.config, social_feed=next_config)
        self._apply_social_feed_service_state(next_config)
        self._schedule_flush()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    async def update_instrument_analysis_interval(
        self,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        source_path = self._require_source_path()
        instrument = self._instrument_by_key(instrument_key)
        if "interval" not in payload:
            raise HTTPException(status_code=400, detail="interval is required.")
        try:
            next_config = analysis_config_from_payload(
                self.config.analysis,
                {"interval": payload["interval"]},
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            changed = await asyncio.to_thread(
                update_instrument_analysis_interval_in_watchlist,
                source_path,
                source=instrument.source,
                symbol=instrument.symbol,
                inst_type=getattr(instrument, "inst_type", None),
                interval=next_config.interval,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        self.agent_analyses.pop(instrument.key, None)
        if changed:
            await self.reload_from_source(clear_candle_keys={instrument.key})
        else:
            await self.broadcast()
        return {"changed": changed, "state": self.snapshot()}

    # ------------------------------------------------------------------
    # Agent sessions
    # ------------------------------------------------------------------

    async def get_agent_session(self, instrument_key: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        payload = await asyncio.to_thread(
            self.agent_session_store.active_session_payload,
            instrument.key,
        )
        return payload or {"session": None, "messages": []}

    async def list_agent_sessions(self) -> dict[str, Any]:
        return await self._agent_session_history_payload()

    async def create_agent_session(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        agent_cfg = self._effective_agent_config(payload.get("provider"), payload.get("model"))
        title = str(payload.get("title") or "New Agent Session")
        session = await asyncio.to_thread(
            self.agent_session_store.create_global_session,
            title=title,
            provider=agent_cfg.provider,
            model=agent_cfg.model,
            **agent_session_config_kwargs(agent_cfg),
        )
        await self.broadcast()
        return {
            **(await self._agent_session_payload(session.id)),
            "history": await self._agent_session_history_payload(),
        }

    async def get_agent_session_resource(self, identifier: str) -> dict[str, Any]:
        payload = await self._agent_session_payload(identifier)
        if payload["session"] is not None:
            return payload
        return await self.get_agent_session(identifier)

    async def update_agent_session(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        title = str(payload.get("title") or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="title is required.")
        try:
            session = await asyncio.to_thread(
                self.agent_session_store.rename_session,
                session_id,
                title,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        await self.broadcast()
        return {
            "session": await self._agent_session_payload(session.id),
            "history": await self._agent_session_history_payload(),
            "state": self.snapshot(),
        }

    async def delete_agent_session_by_id(self, session_id: str) -> dict[str, Any]:
        try:
            deleted = await asyncio.to_thread(
                self.agent_session_store.delete_session_by_id,
                session_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        await self.broadcast()
        return {
            "deleted": deleted,
            "session": {"session": None, "messages": []},
            "history": await self._agent_session_history_payload(),
            "state": self.snapshot(),
        }

    async def reset_agent_session(self, instrument_key: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        session = await asyncio.to_thread(
            self.agent_session_store.create_session,
            instrument_key=instrument.key,
            title=agent_session_title(instrument),
            provider=self.config.agent.provider,
            model=self.config.agent.model,
            **agent_session_config_kwargs(self.config.agent),
        )
        self.agent_analyses.pop(instrument.key, None)
        await self.broadcast()
        return {
            **(await self._agent_session_payload(session.id)),
            "history": await self._agent_session_history_payload(instrument.key),
        }

    async def list_agent_session_history(self, instrument_key: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        return await self._agent_session_history_payload(instrument.key)

    async def resume_agent_session(self, instrument_key: str, session_id: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        try:
            session = await asyncio.to_thread(
                self.agent_session_store.activate_session,
                instrument_key=instrument.key,
                session_id=session_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        session_payload = await self._agent_session_payload(session.id)
        self.agent_analyses.pop(instrument.key, None)
        await self.broadcast()
        return {
            "session": session_payload,
            "history": await self._agent_session_history_payload(instrument.key),
            "state": self.snapshot(),
        }

    async def delete_agent_session(self, instrument_key: str, session_id: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        try:
            next_session = await asyncio.to_thread(
                self.agent_session_store.delete_session,
                instrument_key=instrument.key,
                session_id=session_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if next_session is None:
            session_payload = {"session": None, "messages": []}
        else:
            session_payload = await self._agent_session_payload(next_session.id)
        self.agent_analyses.pop(instrument.key, None)
        await self.broadcast()
        return {
            "deleted": True,
            "session": session_payload,
            "history": await self._agent_session_history_payload(instrument.key),
            "state": self.snapshot(),
        }

    # ------------------------------------------------------------------
    # Trading
    # ------------------------------------------------------------------

    async def open_bitget_demo_trade(
        self,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        if instrument.source != BITGET_SOURCE:
            raise HTTPException(
                status_code=400,
                detail="Bitget demo trading only supports bitget instruments.",
            )
        inst_type = getattr(instrument, "inst_type", None)
        if inst_type is None:
            raise HTTPException(status_code=400, detail="Bitget instrument is missing inst_type.")
        try:
            direction = TradeDirection(str(payload.get("direction") or "").lower())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="direction must be long or short") from exc
        size = request_float(payload.get("size"), "size")
        if size <= 0:
            raise HTTPException(status_code=400, detail="size must be positive")
        order_type = str(payload.get("orderType") or payload.get("order_type") or "market").lower()
        if order_type not in {"market", "limit"}:
            raise HTTPException(status_code=400, detail="orderType must be market or limit")
        limit_price = payload.get("limitPrice", payload.get("limit_price"))
        resolved_limit = None if limit_price in (None, "") else request_float(limit_price, "limitPrice")
        if order_type == "limit" and resolved_limit is None:
            raise HTTPException(status_code=400, detail="limitPrice is required for limit orders")
        if resolved_limit is not None and resolved_limit <= 0:
            raise HTTPException(status_code=400, detail="limitPrice must be positive")
        reasoning = str(payload.get("reasoning") or "Manual Bitget demo trade")
        try:
            result = await asyncio.to_thread(
                open_bitget_demo_position,
                symbol=instrument.symbol,
                inst_type=inst_type,
                is_buy=direction is TradeDirection.LONG,
                size=size,
                order_type=order_type,
                limit_price=resolved_limit,
                margin_mode=str(payload.get("marginMode") or payload.get("margin_mode") or "crossed"),
                margin_coin=str(payload.get("marginCoin") or payload.get("margin_coin") or "USDT"),
                force=str(payload.get("force") or "gtc"),
                client_oid=(
                    None
                    if payload.get("clientOid", payload.get("client_oid")) in (None, "")
                    else str(payload.get("clientOid", payload.get("client_oid")))
                ),
            )
        except BitgetDemoTradingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        snapshot_payload = self._trading_snapshot_payload(instrument.key)
        snapshot_id = await asyncio.to_thread(
            lambda: self.trade_store.save_snapshot(
                instrument_key=instrument.key,
                payload=snapshot_payload,
            ).id
            if snapshot_payload
            else None
        )
        trade = await asyncio.to_thread(
            self.trade_store.create_trade,
            instrument_key=instrument.key,
            direction=direction,
            size=size,
            intent_price=resolved_limit,
            stop_price=None,
            target_prices=tuple(),
            reasoning_text=reasoning,
            session_id=None,
            snapshot_id=snapshot_id,
            market_kind=f"bitget-demo-{inst_type.lower()}",
            fill_source=BITGET_DEMO_FILL_SOURCE,
            status=TradeStatus.PLANNED,
            external_order_id=result.external_order_id,
        )
        await self.broadcast()
        return {
            "ok": True,
            "demo": True,
            "exchange": "bitget",
            "trade": trade.to_payload(),
            "fill": None,
            "order": result.raw,
            "state": self.snapshot(),
        }

    async def open_hyperliquid_testnet_trade(
        self,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        if instrument.source != HYPERLIQUID_TESTNET_SOURCE:
            raise HTTPException(
                status_code=400,
                detail="Hyperliquid testnet trading only supports hyperliquid-testnet instruments.",
            )
        try:
            direction = TradeDirection(str(payload.get("direction") or "").lower())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="direction must be long or short") from exc
        size = request_float(payload.get("size"), "size")
        if size <= 0:
            raise HTTPException(status_code=400, detail="size must be positive")
        order_type = str(payload.get("orderType") or payload.get("order_type") or "market").strip().lower()
        if order_type not in {"market", "limit"}:
            raise HTTPException(status_code=400, detail="orderType must be market or limit")
        limit_price = payload.get("limitPrice", payload.get("limit_price"))
        resolved_limit = None if limit_price in (None, "") else request_float(limit_price, "limitPrice")
        if order_type == "limit" and resolved_limit is None:
            raise HTTPException(status_code=400, detail="limitPrice is required for limit orders")
        if resolved_limit is not None and resolved_limit <= 0:
            raise HTTPException(status_code=400, detail="limitPrice must be positive")
        slippage = request_float(payload.get("slippage", 0.05), "slippage")
        if slippage < 0:
            raise HTTPException(status_code=400, detail="slippage must be non-negative")
        reasoning = str(payload.get("reasoning") or "Manual Hyperliquid testnet trade")
        try:
            result = await asyncio.to_thread(
                open_hyperliquid_testnet_position,
                coin=instrument.symbol,
                is_buy=direction is TradeDirection.LONG,
                size=size,
                order_type=order_type,
                limit_price=resolved_limit,
                slippage=slippage,
            )
        except HyperliquidTradingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        status = TradeStatus.OPEN if result.filled_size else TradeStatus.PLANNED
        intent_price = result.average_price if result.average_price is not None else resolved_limit
        snapshot_payload = self._trading_snapshot_payload(instrument.key)
        snapshot_id = await asyncio.to_thread(
            lambda: self.trade_store.save_snapshot(
                instrument_key=instrument.key,
                payload=snapshot_payload,
            ).id
            if snapshot_payload
            else None
        )
        trade = await asyncio.to_thread(
            self.trade_store.create_trade,
            instrument_key=instrument.key,
            direction=direction,
            size=size,
            intent_price=None if intent_price is None else float(intent_price),
            stop_price=None,
            target_prices=tuple(),
            reasoning_text=reasoning,
            session_id=None,
            snapshot_id=snapshot_id,
            market_kind="hyperliquid-testnet-perp",
            fill_source=HYPERLIQUID_FILL_SOURCE,
            status=status,
            external_order_id=result.external_order_id,
        )
        fill_payload = None
        if result.filled_size and result.average_price is not None:
            fill = await asyncio.to_thread(
                self.trade_store.record_fill,
                trade_id=trade.id,
                kind=FillKind.ENTRY,
                price=float(result.average_price),
                quantity=float(result.filled_size),
                trigger_reason="hyperliquid testnet order filled",
                fill_source=HYPERLIQUID_FILL_SOURCE,
                external_order_id=result.external_order_id,
            )
            fill_payload = fill.to_payload()
            trade = await asyncio.to_thread(self.trade_store.get_trade, trade.id) or trade
        await self.broadcast()
        return {
            "ok": True,
            "testnet": True,
            "trade": trade.to_payload(),
            "fill": fill_payload,
            "order": result.raw,
            "state": self.snapshot(),
        }

    # ------------------------------------------------------------------
    # Agent analysis
    # ------------------------------------------------------------------

    async def analyze_instrument(
        self,
        instrument_key: str,
        prompt: str | None = None,
        override_provider: str | None = None,
        override_model: str | None = None,
    ) -> dict[str, Any]:
        agent_cfg = self._effective_agent_config(override_provider, override_model)
        instrument = self._instrument_by_key(instrument_key)
        provider = create_llm_provider(agent_cfg)
        session_runtime = await AgentSessionRuntime.get_or_create_active(
            store=self.agent_session_store,
            instrument_key=instrument.key,
            title=agent_session_title(instrument),
            config=agent_cfg,
            provider=provider,
            runtime_services=AgentRuntimeServices(
                after_tool_hooks=(agent_tool_audit_hook,),
            ),
        )
        user_prompt = normalize_agent_prompt(prompt, DEFAULT_AGENT_USER_PROMPT)
        await session_runtime.append_user_message(user_prompt)
        history = await session_runtime.history_for_context(limit=8)
        return await self._run_agent_loop(
            session_runtime=session_runtime,
            user_prompt=user_prompt,
            history=history,
            agent_cfg=agent_cfg,
            candidate_instrument_keys=(instrument.key,),
            history_instrument_key=instrument.key,
        )

    async def analyze_agent_session(
        self,
        session_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        message = payload.get("message", payload.get("prompt"))
        agent_cfg = self._effective_agent_config(payload.get("provider"), payload.get("model"))
        session_runtime = await self._session_runtime_by_id(session_id, agent_cfg)
        user_prompt = normalize_agent_prompt(str(message) if message is not None else None, DEFAULT_AGENT_USER_PROMPT)
        await session_runtime.append_user_message(user_prompt)
        history = await session_runtime.history_for_context(limit=8)
        return await self._run_agent_loop(
            session_runtime=session_runtime,
            user_prompt=user_prompt,
            history=history,
            agent_cfg=agent_cfg,
            candidate_instrument_keys=self._candidate_instrument_keys(payload),
        )

    async def _run_agent_loop(
        self,
        *,
        session_runtime: AgentSessionRuntime,
        user_prompt: str,
        history: tuple[dict[str, Any], ...],
        agent_cfg: AgentConfig | None = None,
        candidate_instrument_keys: tuple[str, ...] = tuple(),
        history_instrument_key: str | None = None,
        event_handler: Callable[[dict[str, Any]], Any] | None = None,
    ) -> dict[str, Any]:
        cfg = agent_cfg or self.config.agent
        runtime = TradingAgentRuntime(
            provider=session_runtime.provider,
            config=cfg,
            services=TradingAgentRuntimeServices(
                context_provider=MarketContextProvider(self),
                trade_store=self.trade_store,
                snapshot_provider=lambda key: self._trading_snapshot_payload(key),
                news_service=self.news_service,
                social_feed_service=self.social_feed_service,
                runtime_services=session_runtime.runtime_services,
            ),
        )
        turn_result = await runtime.run_turn(
            session_id=session_runtime.session.id,
            user_prompt=user_prompt,
            history=history,
            candidate_instrument_keys=candidate_instrument_keys,
            event_handler=event_handler,
        )
        payload = turn_result.to_payload()
        await session_runtime.append_transcript_messages(
            [message.to_payload() for message in turn_result.loop_result.messages],
            context=turn_result.context if turn_result.context else None,
        )
        for key in candidate_instrument_keys:
            self.agent_analyses.pop(key, None)
        await self.broadcast()
        return {
            "result": payload,
            "session": await session_runtime.payload(),
            "history": await self._agent_session_history_payload(history_instrument_key),
            "state": self.snapshot(),
        }

    async def stream_agent_message(
        self,
        identifier: str,
        payload: dict[str, Any],
    ) -> AsyncIterator[str]:
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

        async def emit(event: dict[str, Any]) -> None:
            await queue.put(event)

        async def worker() -> None:
            try:
                message = payload.get("message", payload.get("prompt"))
                agent_cfg = self._effective_agent_config(payload.get("provider"), payload.get("model"))
                session_runtime, legacy_key = await self._session_runtime_for_identifier(identifier, agent_cfg)
                user_prompt = normalize_agent_prompt(str(message) if message is not None else None, DEFAULT_AGENT_USER_PROMPT)
                user_message = await session_runtime.append_user_message(user_prompt)
                await emit({"type": "message_end", "message": user_message})
                history = await session_runtime.history_for_context(limit=8)
                await self._run_agent_loop(
                    session_runtime=session_runtime,
                    user_prompt=user_prompt,
                    history=history,
                    agent_cfg=agent_cfg,
                    candidate_instrument_keys=self._candidate_instrument_keys(payload, legacy_key=legacy_key),
                    history_instrument_key=legacy_key,
                    event_handler=emit,
                )
                await emit({
                    "type": "session_update",
                    "session": await session_runtime.payload(),
                    "history": await self._agent_session_history_payload(legacy_key),
                    "state": self.snapshot(),
                })
            except HTTPException as exc:
                await emit({"type": "error", "error": str(exc.detail)})
            except Exception as exc:
                LOGGER.exception("agent stream failed")
                await emit({"type": "error", "error": str(exc) or exc.__class__.__name__})
            finally:
                await queue.put(None)

        task = asyncio.create_task(worker())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield sse_event(event)
        finally:
            if not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    # ------------------------------------------------------------------
    # Candle loading
    # ------------------------------------------------------------------

    async def load_older_candles(self, instrument_key: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        if instrument.source not in OLDER_CANDLE_SOURCES:
            raise HTTPException(status_code=400, detail="Older candle loading is not supported.")
        quote = self.controller.quotes.get(instrument.key)
        if quote is None:
            raise HTTPException(status_code=404, detail="Quote is not available.")
        interval = instrument.analysis_interval or self.config.analysis.interval
        before_open_time_ms = quote.candles[0].open_time_ms if quote.candles else None
        limit = OLDER_CANDLE_LIMIT if before_open_time_ms is not None else CHART_CANDLE_LIMIT
        try:
            incoming = await asyncio.to_thread(
                self.controller.fetch_older_candles,
                instrument,
                interval=interval,
                before_open_time_ms=before_open_time_ms,
                limit=limit,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc) or exc.__class__.__name__) from exc
        if before_open_time_ms is not None:
            incoming = tuple(
                candle for candle in incoming if candle.open_time_ms < before_open_time_ms
            )
        previous_count = len(quote.candles)
        quote.apply_candles(
            candles=merge_candles(quote.candles, tuple(incoming)),
            thumbnail_candles=quote.thumbnail_candles,
        )
        added = max(0, len(quote.candles) - previous_count)
        if added:
            self.agent_analyses.pop(instrument.key, None)
        await self.broadcast()
        return {"added": added, "state": self.snapshot()}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _create_social_feed_service(self, config: SocialFeedConfig) -> SocialFeedService:
        from ..social_feed.providers import XInternalClient

        return SocialFeedService(
            store=SocialFeedStore(),
            client_factory=lambda: XInternalClient(self.x_auth_store.load()),
            recent_limit=config.recent_limit,
            retention_days=config.retention_days,
            max_items=config.max_items,
        )

    def _wire_news_analyst(self) -> None:
        from ..agent.provider import create_llm_provider, LLMProviderUnavailable
        from ..news_analyst import NewsAnalyst, NewsDecisionStore

        try:
            llm_provider = create_llm_provider(self.config.agent)
        except LLMProviderUnavailable as exc:
            LOGGER.warning("news_analyst disabled: %s", exc)
            return

        decision_store = NewsDecisionStore(self.trade_store.path)

        def _current_price(instrument_key: str) -> float | None:
            quote = self.controller.quotes.get(instrument_key)
            return quote.price if quote is not None else None

        def _candles(instrument_key: str, interval: str, limit: int):
            quote = self.controller.quotes.get(instrument_key)
            if quote is None:
                return ()
            mtf = quote.multi_timeframe_candles or {}
            candles = mtf.get(interval) or ()
            return tuple(candles[-limit:]) if limit > 0 else tuple(candles)

        async def _llm_chat(messages: list[dict[str, Any]]) -> Any:
            return await llm_provider.chat(messages)

        analyst = NewsAnalyst(
            config=self.config.news_analyst,
            decision_store=decision_store,
            trade_store=self.trade_store,
            llm_chat=_llm_chat,
            current_price_provider=_current_price,
            candle_provider=_candles,
        )
        self.news_analyst = analyst
        assert self.news_service is not None
        self.news_service.on_top_changed = analyst.on_top_changed
        universe = self.config.news_analyst.universe
        LOGGER.info(
            "news_analyst enabled: universe=%d aliases=%d min_confidence=%.2f",
            len(universe),
            sum(len(entry.aliases) for entry in universe),
            self.config.news_analyst.min_confidence,
        )

    def _apply_social_feed_service_state(self, next_config: SocialFeedConfig) -> None:
        if not next_config.enabled:
            self.social_feed_service = None
            return
        self.social_feed_service = self._create_social_feed_service(next_config)

    async def _apply_news_service_state(self, next_config: NewsConfig) -> None:
        if not next_config.enabled:
            if self.news_service is not None:
                await self.news_service.stop()
                self.news_service = None
            self.news_analyst = None
            return
        if self.news_service is not None:
            await self.news_service.stop()
            self.news_service = None
        self.news_analyst = None
        store = NewsStore()
        provider = ReutersSitemapProvider(
            url=next_config.reuters_url,
            timeout_seconds=next_config.request_timeout_seconds,
        )
        service = NewsService(
            store=store,
            provider=provider,
            poll_interval_seconds=next_config.poll_interval_seconds,
            max_interval_seconds=next_config.max_interval_seconds,
            retention_days=next_config.retention_days,
            recent_limit=next_config.recent_limit,
        )
        self.news_service = service
        if self.config.news_analyst.enabled:
            self._wire_news_analyst()
        if self.running:
            await service.start()

    async def _agent_session_payload(self, session_id: str) -> dict[str, Any]:
        payload = await asyncio.to_thread(self.agent_session_store.session_payload, session_id)
        return payload or {"session": None, "messages": []}

    async def _agent_session_history_payload(self, instrument_key: str | None = None) -> dict[str, Any]:
        sessions = await asyncio.to_thread(
            self.agent_session_store.list_sessions,
            instrument_key,
        )
        return {"sessions": [session.to_payload() for session in sessions]}

    async def _session_runtime_by_id(
        self,
        session_id: str,
        agent_cfg: AgentConfig,
    ) -> AgentSessionRuntime:
        session = await asyncio.to_thread(self.agent_session_store.get_session, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail=f"agent session not found: {session_id}")
        provider = create_llm_provider(agent_cfg)
        if (
            session.provider != agent_cfg.provider
            or session.model != agent_cfg.model
            or session.api_mode != agent_cfg.api_mode
            or session.reasoning_effort != agent_cfg.reasoning_effort
        ):
            session = await asyncio.to_thread(
                self.agent_session_store.update_session_metadata,
                session.id,
                provider=agent_cfg.provider,
                model=agent_cfg.model,
                api_mode=agent_cfg.api_mode,
                reasoning_effort=agent_cfg.reasoning_effort,
            )
        return AgentSessionRuntime(
            session=session,
            store=self.agent_session_store,
            config=agent_cfg,
            provider=provider,
            runtime_services=AgentRuntimeServices(
                after_tool_hooks=(agent_tool_audit_hook,),
            ),
        )

    async def _session_runtime_for_identifier(
        self,
        identifier: str,
        agent_cfg: AgentConfig,
    ) -> tuple[AgentSessionRuntime, str | None]:
        session = await asyncio.to_thread(self.agent_session_store.get_session, identifier)
        if session is not None:
            return await self._session_runtime_by_id(identifier, agent_cfg), None
        instrument = self._instrument_by_key(identifier)
        provider = create_llm_provider(agent_cfg)
        runtime = await AgentSessionRuntime.get_or_create_active(
            store=self.agent_session_store,
            instrument_key=instrument.key,
            title=agent_session_title(instrument),
            config=agent_cfg,
            provider=provider,
            runtime_services=AgentRuntimeServices(
                after_tool_hooks=(agent_tool_audit_hook,),
            ),
        )
        return runtime, instrument.key

    def _candidate_instrument_keys(
        self,
        payload: dict[str, Any],
        *,
        legacy_key: str | None = None,
    ) -> tuple[str, ...]:
        raw = payload.get("candidateInstrumentKeys")
        if raw is None:
            return (legacy_key,) if legacy_key else tuple()
        if not isinstance(raw, list):
            raise HTTPException(status_code=400, detail="candidateInstrumentKeys must be an array.")
        provider = MarketContextProvider(self)
        keys: list[str] = []
        for item in raw[:12]:
            key = provider.resolve_instrument_key(str(item))
            self._instrument_by_key(key)
            if key not in keys:
                keys.append(key)
        return tuple(keys)

    def _effective_agent_config(
        self,
        override_provider: str | None = None,
        override_model: str | None = None,
    ) -> AgentConfig:
        return effective_agent_config(self.config.agent, override_provider, override_model)

    def _require_source_path(self) -> Path:
        if self.config.source_path is None:
            raise HTTPException(status_code=409, detail="Cannot edit watchlist without a file.")
        return self.config.source_path

    def _instrument_by_key(self, instrument_key: str) -> MarketInstrument:
        for instrument in self.instruments:
            if instrument.key == instrument_key:
                return instrument
        raise HTTPException(status_code=404, detail="Instrument not found.")

    def _schedule_flush(self) -> None:
        if self._flush_handle is not None:
            self._flush_handle.cancel()
        loop = asyncio.get_event_loop()
        self._flush_handle = loop.call_later(
            self._flush_delay,
            lambda: asyncio.ensure_future(self._flush_to_disk()),
        )

    async def _flush_to_disk(self) -> None:
        self._flush_handle = None
        source_path = self.config.source_path
        if source_path is None:
            return
        try:
            await asyncio.to_thread(
                update_agent_config_in_watchlist, source_path, self.config.agent,
            )
            await asyncio.to_thread(
                update_analysis_config_in_watchlist, source_path, self.config.analysis,
            )
            await asyncio.to_thread(
                update_news_config_in_watchlist, source_path, self.config.news,
            )
            await asyncio.to_thread(
                update_social_feed_config_in_watchlist, source_path, self.config.social_feed,
            )
        except Exception:
            LOGGER.warning("Config flush to disk failed", exc_info=True)

    async def reload_from_source(self, *, clear_candle_keys: set[str] | None = None) -> None:
        if self.config.source_path is None:
            raise HTTPException(status_code=409, detail="No watchlist file is active.")
        config = await asyncio.to_thread(load_config, self.config.source_path)
        instruments = await asyncio.to_thread(resolve_instruments, config.instruments)
        previous_quotes = self.controller.quotes
        self.controller.stop()
        self.config = config
        self.instruments = instruments
        self.controller = self.controller_factory(config=config, instruments=instruments)
        active_keys = {instrument.key for instrument in instruments}
        for key in active_keys & previous_quotes.keys():
            self.controller.quotes[key] = previous_quotes[key]
        for key in clear_candle_keys or set():
            quote = self.controller.quotes.get(key)
            if quote is not None:
                quote.candles = tuple()
        self.agent_analyses = {
            key: value for key, value in self.agent_analyses.items() if key in active_keys
        }
        if self.running:
            self.controller.start()
        await self.broadcast()

    async def _pump(self) -> None:
        refresh_seconds = max(0.25, self.config.display.refresh_interval_ms / 1000)
        while self.running:
            result = self.controller.drain_events()
            if result.dirty:
                await self.broadcast()
            await asyncio.sleep(refresh_seconds)
            if not result.dirty:
                await self.broadcast()

    async def _run_review_loop(self) -> None:
        review_interval_seconds = 15 * 60
        while self.running:
            try:
                await asyncio.sleep(review_interval_seconds)
            except asyncio.CancelledError:
                break
            if not self.config.agent.enabled:
                continue
            pending = self.trade_store.trade_ids_without_review(limit=1)
            if not pending:
                continue
            try:
                provider = create_llm_provider(self.config.agent)
            except (LLMProviderUnavailable, LLMProviderError):
                continue
            except Exception:
                continue

            async def _reviewer(payload: dict[str, Any]) -> dict[str, Any]:
                return await self._llm_generate_lesson(provider, payload)

            try:
                await review_pending(
                    store=self.trade_store,
                    llm=_reviewer,
                    limit=3,
                )
            except Exception:
                continue
            await self.broadcast()

    async def _llm_generate_lesson(
        self,
        provider: Any,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        prompt_text = (
            "请基于下列 JSON 中的交易与当时快照做简短复盘，"
            "输出严格 JSON，字段: lesson (string), category (string), tags (array of string)。\n\n"
            f"{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}"
        )
        response = await provider.chat(
            messages=[
                {"role": "system", "content": "你是 price action 交易复盘助手，只输出 JSON。"},
                {"role": "user", "content": prompt_text},
            ],
            tools=None,
        )
        content = response.content or ""
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            text = content.strip()
            if text.startswith("```"):
                text = text.strip("`")
                if "\n" in text:
                    text = text.split("\n", 1)[1]
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                return {"lesson": content.strip(), "category": "general", "tags": []}
        if not isinstance(parsed, dict):
            return {"lesson": str(parsed), "category": "general", "tags": []}
        return parsed

    def _trading_snapshot_payload(self, instrument_key: str) -> dict[str, Any]:
        instrument = None
        for candidate in self.instruments:
            if candidate.key == instrument_key:
                instrument = candidate
                break
        if instrument is None:
            return {}
        quote = self.controller.quotes.get(instrument_key)
        if quote is None:
            return {}
        try:
            context = build_market_context(
                instrument=instrument,
                quote=quote,
                interval=instrument.analysis_interval or self.config.analysis.interval,
                max_candles=self.config.agent.max_candles,
            )
        except Exception:
            context = {}
        current_analysis = self.agent_analyses.get(instrument_key)
        return {
            "capturedAt": utc_now_iso(),
            "instrument": {
                "key": instrument.key,
                "label": instrument.label,
                "source": instrument.source,
                "group": instrument.group,
            },
            "context": context,
            "currentAnalysis": current_analysis,
        }
