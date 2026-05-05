"""文件用途：API 层，对外提供 FastAPI 路由、WebSocket 和运行时状态。"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from ..agent import (
    AgentAnalysisResult,
    AgentLoop,
    AgentSessionStore,
    LLMProviderError,
    LLMProviderUnavailable,
    build_agent_context,
    build_market_tools,
    build_news_tools,
    build_trading_tools,
    build_web_tools,
    create_llm_provider,
    list_available_agent_models,
    merge_registries,
)
from ..news import NewsService, NewsStore
from ..news.providers.reuters import ReutersSitemapProvider
from ..agent.provider import _result_from_text
from ..agent.tools import ToolRegistry
from ..trading import TradeStatus, TradeStore
from ..trading.paper_broker import PaperBroker
from ..trading.review import review_pending
from ..config import (
    AgentConfig,
    AnalysisConfig,
    ALPACA_SOURCE,
    AppConfig,
    BITGET_SOURCE,
    NewsConfig,
    load_config,
    parse_agent_config,
    parse_analysis_config,
    parse_news_config,
)
from ..market_data.alpaca import search_assets as search_alpaca_assets
from ..runtime.controller import TickerController
from ..runtime.feed import CHART_CANDLE_LIMIT, OLDER_CANDLE_LIMIT
from ..market_data.bitget import search_instruments as search_bitget_instruments
from ..domain.quotes import QuoteState
from ..domain.price_action import Candle, merge_candles
from ..market_data.router import MarketInstrument, resolve_instruments
from ..config.watchlist_store import (
    append_alpaca_symbol_to_watchlist,
    append_bitget_symbol_to_watchlist,
    remove_alpaca_symbol_from_watchlist,
    remove_symbol_from_watchlist,
    update_agent_config_in_watchlist,
    update_analysis_config_in_watchlist,
    update_instrument_analysis_interval_in_watchlist,
    update_news_config_in_watchlist,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
WEB_DIST = PROJECT_ROOT / "web" / "dist"
WEB_CACHE_HEADERS = {"Cache-Control": "no-store, max-age=0, must-revalidate"}
THUMBNAIL_CANDLE_LIMIT = 60
OLDER_CANDLE_SOURCES = {ALPACA_SOURCE, BITGET_SOURCE}
DEFAULT_AGENT_USER_PROMPT = "Analyze the current K-line chart and update the watch plan."
LOGGER = logging.getLogger(__name__)


class NoCacheStaticFiles(StaticFiles):
    """Serve local frontend assets without browser cache reuse."""

    def file_response(self, full_path: Path, stat_result: Any, scope: Scope, status_code: int = 200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers.update(WEB_CACHE_HEADERS)
        return response


def _utc_now_iso() -> str:
    """说明：返回当前 UTC 时间的 ISO 字符串。"""
    return datetime.now(timezone.utc).isoformat()


def _agent_session_title(instrument: MarketInstrument) -> str:
    """说明：生成某个标的会话在侧栏中展示的标题。"""
    return f"{instrument.label} · {instrument.symbol}"


def _agent_session_config_kwargs(config: AgentConfig) -> dict[str, Any]:
    """说明：把当前 Agent 配置压缩成会话元数据快照。"""
    return {
        "api_mode": config.api_mode,
        "reasoning_effort": config.reasoning_effort,
        "max_iterations": config.max_iterations,
        "use_tools": config.use_tools,
    }


def _normalize_agent_prompt(prompt: str | None) -> str:
    """说明：规范化用户发给 Agent 的问题。"""
    text = (prompt or "").strip()
    return text or DEFAULT_AGENT_USER_PROMPT


def _instrument_payload(instrument: MarketInstrument, *, default_interval: str) -> dict[str, Any]:
    """说明：把已解析标的序列化给前端。"""
    return {
        "key": instrument.key,
        "symbol": instrument.symbol,
        "label": instrument.label,
        "source": instrument.source,
        "instType": getattr(instrument, "inst_type", None),
        "group": instrument.group,
        "analysisInterval": instrument.analysis_interval or default_interval,
    }


def _candle_payload(candle: Candle) -> dict[str, Any]:
    """说明：把一根 K 线序列化为图表数据。"""
    return {
        "time": candle.open_time_ms // 1000,
        "open": candle.open,
        "high": candle.high,
        "low": candle.low,
        "close": candle.close,
        "volume": candle.volume,
    }


def _quote_payload(
    quote: QuoteState,
    *,
    stale_after_seconds: int,
) -> dict[str, Any]:
    """说明：把报价和图表 K 线序列化给前端。"""
    return {
        "symbol": quote.symbol,
        "displayName": quote.display_name,
        "price": quote.price,
        "priceLabel": quote.price_label(),
        "change": quote.change,
        "changePercent": quote.change_percent,
        "changeLabel": quote.change_label(),
        "percentLabel": quote.percent_label(),
        "previousClose": quote.previous_close,
        "dayHigh": quote.day_high,
        "dayLow": quote.day_low,
        "volume": quote.volume,
        "volumeLabel": quote.volume_label(),
        "currency": quote.currency,
        "exchange": quote.exchange,
        "status": quote.status,
        "ageLabel": quote.age_label(),
        "stale": quote.is_stale(stale_after_seconds),
        "lastError": quote.last_error,
        "updateCount": quote.update_count,
        "multiTimeframeIntervals": sorted(quote.multi_timeframe_candles.keys()),
        "candles": [_candle_payload(candle) for candle in quote.candles],
        "thumbnailCandles": [
            _candle_payload(candle)
            for candle in quote.thumbnail_candles[-THUMBNAIL_CANDLE_LIMIT:]
        ],
    }


def serialize_market_state(
    *,
    config: AppConfig,
    instruments: tuple[MarketInstrument, ...],
    quotes: dict[str, QuoteState],
    stream_status: str,
    agent_analyses: dict[str, dict[str, Any]] | None = None,
    open_trades: list[dict[str, Any]] | None = None,
    recent_news: list[dict[str, Any]] | None = None,
    news_status: dict[str, Any] | None = None,
    recent_news_decisions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """说明：构造浏览器需要的完整市场状态快照。"""
    groups: dict[str, list[str]] = {}
    for instrument in instruments:
        groups.setdefault(instrument.group, []).append(instrument.key)
    return {
        "type": "state",
        "updatedAt": _utc_now_iso(),
        "streamStatus": stream_status,
        "config": {
            "analysis": {
                "enabled": config.analysis.enabled,
                "interval": config.analysis.interval,
                "lookback": config.analysis.lookback,
                "pollIntervalSeconds": config.analysis.poll_interval_seconds,
                "staleAfterSeconds": config.analysis.stale_after_seconds,
            },
            "agent": {
                "enabled": config.agent.enabled,
                "provider": config.agent.provider,
                "apiMode": config.agent.api_mode,
                "model": config.agent.model,
                "timeoutSeconds": config.agent.timeout_seconds,
                "maxCandles": config.agent.max_candles,
                "reasoningEffort": config.agent.reasoning_effort,
                "maxIterations": config.agent.max_iterations,
                "useTools": config.agent.use_tools,
            },
            "display": {
                "refreshIntervalMs": config.display.refresh_interval_ms,
                "staleAfterSeconds": config.display.stale_after_seconds,
                "stockPollIntervalSeconds": config.display.stock_poll_interval_seconds,
            },
            "news": {
                "enabled": config.news.enabled,
                "pollIntervalSeconds": config.news.poll_interval_seconds,
                "maxIntervalSeconds": config.news.max_interval_seconds,
                "recentLimit": config.news.recent_limit,
                "reutersUrl": config.news.reuters_url,
                "requestTimeoutSeconds": config.news.request_timeout_seconds,
                "retentionDays": config.news.retention_days,
            },
            "newsAnalyst": {
                "enabled": config.news_analyst.enabled,
                "minConfidence": config.news_analyst.min_confidence,
                "maxEntryDistancePct": config.news_analyst.max_entry_distance_pct,
                "defaultSize": config.news_analyst.default_size,
                "cooldownMinutes": config.news_analyst.cooldown_minutes,
                "universe": [
                    {
                        "instrumentKey": e.instrument_key,
                        "aliases": list(e.aliases),
                    }
                    for e in config.news_analyst.universe
                ],
            },
            "sourcePath": str(config.source_path) if config.source_path else None,
        },
        "instruments": [
            _instrument_payload(instrument, default_interval=config.analysis.interval)
            for instrument in instruments
        ],
        "groups": groups,
        "quotes": {
            key: _quote_payload(
                quote,
                stale_after_seconds=config.display.stale_after_seconds,
            )
            for key, quote in quotes.items()
        },
        "agentAnalyses": agent_analyses or {},
        "openTrades": open_trades or [],
        "recentNews": recent_news or [],
        "newsStatus": news_status or {},
        "recentNewsDecisions": recent_news_decisions or [],
    }


class MarketContextProvider:
    """为 agent tools 提供行情数据访问的适配器。"""

    def __init__(self, runtime: "MarketRuntime") -> None:
        self._runtime = runtime

    def get_quote(self, instrument_key: str) -> QuoteState | None:
        return self._runtime.controller.quotes.get(instrument_key)

    def get_candles(
        self,
        instrument_key: str,
        *,
        interval: str | None = None,
    ) -> tuple[Candle, ...]:
        quote = self.get_quote(instrument_key)
        if quote is None:
            return tuple()
        if interval:
            return tuple(quote.multi_timeframe_candles.get(interval, tuple()))
        instrument = self._runtime._instrument_by_key(instrument_key)
        current_interval = instrument.analysis_interval or self._runtime.config.analysis.interval
        return tuple(quote.multi_timeframe_candles.get(current_interval, quote.candles))

    def list_instruments(self) -> tuple[MarketInstrument, ...]:
        return self._runtime.instruments


class MarketRuntime:
    """说明：维护实时行情状态、后台 feed 和 WebSocket 客户端。"""

    def __init__(
        self,
        *,
        config: AppConfig,
        instruments: tuple[MarketInstrument, ...],
        controller_factory: Callable[..., Any] = TickerController,
        agent_session_store: AgentSessionStore | None = None,
        trade_store: TradeStore | None = None,
    ) -> None:
        """说明：初始化当前对象的运行状态。"""
        self.config = config
        self.instruments = instruments
        self.controller_factory = controller_factory
        self.trade_store = trade_store or TradeStore()
        self.paper_broker = PaperBroker(self.trade_store)
        try:
            self.controller = controller_factory(
                config=config,
                instruments=instruments,
                paper_broker=self.paper_broker,
            )
        except TypeError:
            # 兼容不支持 paper_broker 参数的测试替身
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
        self.news_service: NewsService | None = None
        self.news_analyst = None  # type: ignore[var-annotated]  # NewsAnalyst | None, lazy import below
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

    def _wire_news_analyst(self) -> None:
        """说明：把 NewsAnalyst 接到 NewsService.on_top_changed。

        延迟 import 避免顶层循环依赖。当前价从 controller.quotes 取；
        LLM 走 agent config 选定的 provider (codex 或 anthropic)，二者都实现
        了 LLMProvider.chat(messages) 协议。
        """
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
            """从 controller 内存里拿 multi-timeframe candles。"""
            quote = self.controller.quotes.get(instrument_key)
            if quote is None:
                return ()
            mtf = quote.multi_timeframe_candles or {}
            candles = mtf.get(interval) or ()
            # 已是按时间正序的 tuple，限制条数取最近 N 根
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

    async def start(self) -> None:
        """说明：启动后台运行时组件。"""
        if self.running:
            return
        self.running = True
        self.controller.start()
        self.pump_task = asyncio.create_task(self._pump())
        self.review_task = asyncio.create_task(self._run_review_loop())
        if self.news_service is not None:
            await self.news_service.start()

    async def stop(self) -> None:
        """说明：停止后台运行时组件并释放连接。"""
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

    def snapshot(self) -> dict[str, Any]:
        """说明：返回当前可序列化的市场状态快照。"""
        open_trades = [
            trade.to_payload()
            for trade in self.trade_store.list_trades(
                statuses=[TradeStatus.PLANNED, TradeStatus.OPEN],
            )
        ]
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
            recent_news=recent_news,
            news_status=news_status,
            recent_news_decisions=recent_news_decisions,
        )

    async def connect(self, websocket: WebSocket) -> None:
        """说明：接受一个 WebSocket 连接并维持订阅。"""
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

    async def search_alpaca(self, query: str) -> list[dict[str, Any]]:
        """说明：搜索 Alpaca 美股/ETF 标的，并标记已在 watchlist 中的结果。"""
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
        """说明：搜索 Bitget 标的，并标记已在 watchlist 中的结果。"""
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

    async def search_instruments(self, source: str, query: str) -> list[dict[str, Any]]:
        """说明：按 provider 搜索可加入 watchlist 的标的。"""
        normalized_source = source.strip().lower()
        if normalized_source == ALPACA_SOURCE:
            return await self.search_alpaca(query)
        if normalized_source == BITGET_SOURCE:
            return await self.search_bitget(query)
        raise HTTPException(status_code=400, detail="Unsupported search source.")

    async def add_alpaca(self, payload: dict[str, Any]) -> dict[str, Any]:
        """说明：把一个 Alpaca 标的写入 watchlist 并激活。"""
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
        """说明：把一个 Bitget 标的写入 watchlist 并激活。"""
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

    async def remove_alpaca(self, symbol: str) -> dict[str, Any]:
        """说明：从 watchlist 移除一个 Alpaca 标的并停用。"""
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
        """说明：从 watchlist 移除任意当前激活标的。"""
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

    async def list_agent_models(self) -> dict[str, Any]:
        """说明：返回当前 Agent provider 可见的模型列表。"""
        try:
            models = await list_available_agent_models(self.config.agent)
        except (LLMProviderUnavailable, LLMProviderError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {
            "provider": self.config.agent.provider,
            "apiMode": self.config.agent.api_mode,
            "activeModel": self.config.agent.model,
            "models": models,
        }

    async def update_agent_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        """说明：持久化 Agent 配置并重新加载运行时。"""
        source_path = self._require_source_path()
        try:
            next_config = _agent_config_from_payload(self.config.agent, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        changed = await asyncio.to_thread(
            update_agent_config_in_watchlist,
            source_path,
            next_config,
        )
        self.agent_analyses = {}
        if changed:
            await self.reload_from_source()
        else:
            await self.broadcast()
        return {"changed": changed, "state": self.snapshot()}

    async def update_analysis_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        """说明：持久化 K 线配置并重新加载运行时。"""
        source_path = self._require_source_path()
        try:
            next_config = _analysis_config_from_payload(self.config.analysis, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        changed = await asyncio.to_thread(
            update_analysis_config_in_watchlist,
            source_path,
            next_config,
        )
        self.agent_analyses = {}
        if changed:
            await self.reload_from_source()
        else:
            await self.broadcast()
        return {"changed": changed, "state": self.snapshot()}

    async def update_news_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        """说明：持久化 news 配置并按需启停 NewsService。"""
        source_path = self._require_source_path()
        try:
            next_config = _news_config_from_payload(self.config.news, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        changed = await asyncio.to_thread(
            update_news_config_in_watchlist,
            source_path,
            next_config,
        )
        # 替换内存 config.news（保持其他字段）。
        self.config = replace(self.config, news=next_config)
        await self._apply_news_service_state(next_config)
        await self.broadcast()
        return {"changed": changed, "state": self.snapshot()}

    async def _apply_news_service_state(self, next_config: NewsConfig) -> None:
        """说明：根据新配置启停或重建 NewsService。"""
        if not next_config.enabled:
            if self.news_service is not None:
                await self.news_service.stop()
                self.news_service = None
            self.news_analyst = None
            return
        # 已启用：若未实例化则创建并启动；若已存在则重建以应用新参数。
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

    async def update_instrument_analysis_interval(
        self,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """说明：持久化单个标的的 K 线周期并重新加载运行时。"""
        source_path = self._require_source_path()
        instrument = self._instrument_by_key(instrument_key)
        if "interval" not in payload:
            raise HTTPException(status_code=400, detail="interval is required.")
        try:
            next_config = _analysis_config_from_payload(
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

    async def get_agent_session(self, instrument_key: str) -> dict[str, Any]:
        """说明：读取某个标的的 active Agent 会话。"""
        instrument = self._instrument_by_key(instrument_key)
        payload = await asyncio.to_thread(
            self.agent_session_store.active_session_payload,
            instrument.key,
        )
        return payload or {"session": None, "messages": []}

    async def reset_agent_session(self, instrument_key: str) -> dict[str, Any]:
        """说明：为某个标的创建一个新的 active Agent 会话。"""
        instrument = self._instrument_by_key(instrument_key)
        session = await asyncio.to_thread(
            self.agent_session_store.create_session,
            instrument_key=instrument.key,
            title=_agent_session_title(instrument),
            provider=self.config.agent.provider,
            model=self.config.agent.model,
            **_agent_session_config_kwargs(self.config.agent),
        )
        self.agent_analyses.pop(instrument.key, None)
        await self.broadcast()
        return {
            **(await self._agent_session_payload(session.id)),
            "history": await self._agent_session_history_payload(instrument.key),
        }

    async def list_agent_session_history(self, instrument_key: str) -> dict[str, Any]:
        """说明：列出某个标的的本地 Agent 历史会话。"""
        instrument = self._instrument_by_key(instrument_key)
        return await self._agent_session_history_payload(instrument.key)

    async def resume_agent_session(self, instrument_key: str, session_id: str) -> dict[str, Any]:
        """说明：恢复某个历史 Agent 会话为 active。"""
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
        analysis = _latest_session_analysis(session_payload)
        if analysis is None:
            self.agent_analyses.pop(instrument.key, None)
        else:
            self.agent_analyses[instrument.key] = analysis
        await self.broadcast()
        return {
            "session": session_payload,
            "history": await self._agent_session_history_payload(instrument.key),
            "state": self.snapshot(),
        }

    async def delete_agent_session(self, instrument_key: str, session_id: str) -> dict[str, Any]:
        """说明：删除某个历史 Agent 会话。"""
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
            self.agent_analyses.pop(instrument.key, None)
        else:
            session_payload = await self._agent_session_payload(next_session.id)
            analysis = _latest_session_analysis(session_payload)
            if analysis is None:
                self.agent_analyses.pop(instrument.key, None)
            else:
                self.agent_analyses[instrument.key] = analysis
        await self.broadcast()
        return {
            "deleted": True,
            "session": session_payload,
            "history": await self._agent_session_history_payload(instrument.key),
            "state": self.snapshot(),
        }

    async def analyze_instrument(
        self,
        instrument_key: str,
        prompt: str | None = None,
    ) -> dict[str, Any]:
        """说明：对单个标的执行一次会话式 LLM 分析，支持 agent loop with tools。"""
        instrument = self._instrument_by_key(instrument_key)
        quote = self.controller.quotes.get(instrument.key)
        if quote is None:
            raise HTTPException(status_code=404, detail="Quote is not available.")

        session = await asyncio.to_thread(
            self.agent_session_store.get_or_create_active_session,
            instrument_key=instrument.key,
            title=_agent_session_title(instrument),
            provider=self.config.agent.provider,
            model=self.config.agent.model,
            **_agent_session_config_kwargs(self.config.agent),
        )
        user_prompt = _normalize_agent_prompt(prompt)
        await asyncio.to_thread(
            self.agent_session_store.append_message,
            session_id=session.id,
            role="user",
            content=user_prompt,
        )

        if not self.config.agent.enabled:
            result = AgentAnalysisResult.unavailable(
                provider=self.config.agent.provider,
                model=self.config.agent.model,
                error="Agent is disabled in config.",
            )
            payload = result.to_payload()
            self.agent_analyses[instrument.key] = payload
            await self._record_agent_assistant_message(session.id, payload)
            await self.broadcast()
            return {
                "result": payload,
                "session": await self._agent_session_payload(session.id),
                "history": await self._agent_session_history_payload(instrument.key),
                "state": self.snapshot(),
            }

        if not quote.candles:
            result = AgentAnalysisResult.unavailable(
                provider=self.config.agent.provider,
                model=self.config.agent.model,
                error="No OHLCV candles are available for this instrument yet.",
            )
            payload = result.to_payload()
            self.agent_analyses[instrument.key] = payload
            await self._record_agent_assistant_message(session.id, payload)
            await self.broadcast()
            return {
                "result": payload,
                "session": await self._agent_session_payload(session.id),
                "history": await self._agent_session_history_payload(instrument.key),
                "state": self.snapshot(),
            }

        history = await asyncio.to_thread(
            self.agent_session_store.history_for_context,
            session.id,
            limit=8,
        )

        provider = create_llm_provider(self.config.agent)

        if self.config.agent.use_tools and hasattr(provider, "chat"):
            return await self._run_agent_loop(
                instrument=instrument,
                quote=quote,
                session=session,
                user_prompt=user_prompt,
                history=history,
                provider=provider,
            )

        context = build_agent_context(
            instrument=instrument,
            quote=quote,
            interval=instrument.analysis_interval or self.config.analysis.interval,
            max_candles=self.config.agent.max_candles,
            session_history=history,
        )
        result = await provider.analyze(context)
        payload = result.to_payload()
        self.agent_analyses[instrument.key] = payload
        await self._record_agent_assistant_message(session.id, payload, context=context)
        await self.broadcast()
        return {
            "result": payload,
            "session": await self._agent_session_payload(session.id),
            "history": await self._agent_session_history_payload(instrument.key),
            "state": self.snapshot(),
        }

    async def _run_agent_loop(
        self,
        *,
        instrument: MarketInstrument,
        quote: QuoteState,
        session: Any,
        user_prompt: str,
        history: tuple[dict[str, Any], ...],
        provider: Any,
    ) -> dict[str, Any]:
        """通过 agent loop 执行带工具调用的 LLM 分析。"""
        context_provider = MarketContextProvider(self)
        market_tools = build_market_tools(context_provider)

        active_session_id = session.id
        trading_tools = build_trading_tools(
            store=self.trade_store,
            snapshot_provider=lambda key: self._trading_snapshot_payload(key),
            session_id_provider=lambda: active_session_id,
        )
        news_tools = build_news_tools(self.news_service)
        web_tools = build_web_tools()
        tools = merge_registries(market_tools, trading_tools, news_tools, web_tools)

        current_context = build_agent_context(
            instrument=instrument,
            quote=quote,
            interval=instrument.analysis_interval or self.config.analysis.interval,
            max_candles=self.config.agent.max_candles,
            session_history=tuple(),
        )

        lessons = self.trade_store.list_lessons(
            instrument_key=instrument.key,
            limit=5,
        )
        lessons_block = ""
        if lessons:
            bullets = "\n".join(
                f"- [{lesson['category'] or 'general'}] {lesson['text']}"
                for lesson in lessons
            )
            lessons_block = (
                "\n\n过去同标的交易复盘 (最多 5 条，时间倒序):\n"
                f"{bullets}\n"
                "在给出计划和开单前请参考上述教训，避免重复错误。\n"
            )

        enriched_prompt = (
            f"当前分析标的: {instrument.label} ({instrument.key})\n\n"
            "当前行情上下文(JSON，工具返回值优先于这里的快照):\n"
            f"{json.dumps(current_context, ensure_ascii=False, separators=(',', ':'))}"
            f"{lessons_block}\n\n"
            f"{user_prompt}"
        )

        conversation_history = _agent_loop_history_without_current_turn(
            history,
            current_user_prompt=user_prompt,
        )

        loop = AgentLoop(
            provider=provider,
            tools=tools,
            max_iterations=self.config.agent.max_iterations,
        )

        loop_result = await loop.run(
            user_message=enriched_prompt,
            conversation_history=conversation_history if conversation_history else None,
        )

        if loop_result.finished and not loop_result.content.strip():
            result = AgentAnalysisResult.unavailable(
                provider=provider.name,
                model=provider.model,
                error="Agent returned no output text.",
            )
        elif loop_result.finished:
            result = _result_from_text(
                loop_result.content, provider=provider.name, model=provider.model,
            )
        else:
            result = AgentAnalysisResult.unavailable(
                provider=provider.name,
                model=provider.model,
                error=loop_result.error or "Agent loop did not finish.",
                raw_text=loop_result.content or None,
            )
        payload = result.to_payload()
        payload["loopResult"] = loop_result.to_payload()
        self.agent_analyses[instrument.key] = payload
        await self._record_agent_assistant_message(session.id, payload)
        await self.broadcast()
        return {
            "result": payload,
            "session": await self._agent_session_payload(session.id),
            "history": await self._agent_session_history_payload(instrument.key),
            "state": self.snapshot(),
        }

    async def _record_agent_assistant_message(
        self,
        session_id: str,
        analysis_payload: dict[str, Any],
        context: dict[str, Any] | None = None,
    ) -> None:
        """说明：把 LLM 结果写入会话消息历史。"""
        content = str(
            analysis_payload.get("summary")
            or analysis_payload.get("error")
            or "Agent response unavailable."
        )
        await asyncio.to_thread(
            self.agent_session_store.append_message,
            session_id=session_id,
            role="assistant",
            content=content,
            analysis=analysis_payload,
            context=context,
            error=analysis_payload.get("error") if not analysis_payload.get("available") else None,
        )

    async def _agent_session_payload(self, session_id: str) -> dict[str, Any]:
        """说明：异步读取一个 session payload。"""
        payload = await asyncio.to_thread(self.agent_session_store.session_payload, session_id)
        return payload or {"session": None, "messages": []}

    async def _agent_session_history_payload(self, instrument_key: str) -> dict[str, Any]:
        """说明：异步读取某个标的的 session 历史列表。"""
        sessions = await asyncio.to_thread(
            self.agent_session_store.list_sessions,
            instrument_key,
        )
        return {"sessions": [session.to_payload() for session in sessions]}

    async def load_older_candles(self, instrument_key: str) -> dict[str, Any]:
        """说明：为图表继续向前加载一批历史 K 线。"""
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

    async def reload_from_source(self, *, clear_candle_keys: set[str] | None = None) -> None:
        """说明：重新读取 watchlist 配置并重启 feed controller。"""
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

    def _require_source_path(self) -> Path:
        """说明：返回当前 watchlist 路径，缺失时抛出 Web 错误。"""
        if self.config.source_path is None:
            raise HTTPException(status_code=409, detail="Cannot edit watchlist without a file.")
        return self.config.source_path

    def _instrument_by_key(self, instrument_key: str) -> MarketInstrument:
        """说明：按稳定 key 查找当前激活标的。"""
        for instrument in self.instruments:
            if instrument.key == instrument_key:
                return instrument
        raise HTTPException(status_code=404, detail="Instrument not found.")

    async def _pump(self) -> None:
        """说明：消费 feed 事件并按刷新节奏广播状态。"""
        refresh_seconds = max(0.25, self.config.display.refresh_interval_ms / 1000)
        while self.running:
            result = self.controller.drain_events()
            consume = getattr(self.controller, "consume_fill_events", None)
            fills = tuple(consume()) if callable(consume) else ()
            if result.dirty or fills:
                await self.broadcast()
            await asyncio.sleep(refresh_seconds)
            if not (result.dirty or fills):
                await self.broadcast()

    async def _run_review_loop(self) -> None:
        """说明：周期性扫描已关闭交易，用 LLM 生成 lesson 写入 store。"""
        # 后台 review 节奏：每 15 分钟扫一次 pending closed trades。
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
        """说明：把 review payload 丢给 LLM，返回解析后的 lesson dict。"""
        prompt_text = (
            "请基于下列 JSON 中的交易与当时快照做简短复盘，"
            "输出严格 JSON，字段: lesson (string), category (string), tags (array of string)。\n\n"
            f"{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}"
        )
        if hasattr(provider, "chat"):
            response = await provider.chat(
                messages=[
                    {"role": "system", "content": "你是 price action 交易复盘助手，只输出 JSON。"},
                    {"role": "user", "content": prompt_text},
                ],
                tools=None,
            )
            content = response.content or ""
        else:
            # 回退到 analyze pipeline（不会拿到结构化 lesson，这里尽力而为）
            result = await provider.analyze({
                "instructions": "请生成复盘 JSON，字段 lesson / category / tags。",
                "payload": payload,
            })
            content = (result.summary or "") if hasattr(result, "summary") else ""
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            # 容忍 LLM 用代码块包裹的情况
            text = content.strip()
            if text.startswith("```"):
                text = text.strip("`")
                # 去掉可能的语言标识
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
        """说明：为 trade snapshot 打包多周期上下文 + 当前 agent reasoning。"""
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
            context = build_agent_context(
                instrument=instrument,
                quote=quote,
                interval=instrument.analysis_interval or self.config.analysis.interval,
                max_candles=self.config.agent.max_candles,
                session_history=tuple(),
            )
        except Exception:
            context = {}
        current_analysis = self.agent_analyses.get(instrument_key)
        return {
            "capturedAt": _utc_now_iso(),
            "instrument": {
                "key": instrument.key,
                "label": instrument.label,
                "source": instrument.source,
                "group": instrument.group,
            },
            "context": context,
            "currentAnalysis": current_analysis,
        }

    async def broadcast(self) -> None:
        """说明：向所有已连接 WebSocket 客户端推送最新状态。"""
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


def create_app(
    *,
    config: AppConfig,
    instruments: tuple[MarketInstrument, ...],
    controller_factory: Callable[..., Any] = TickerController,
    agent_session_store: AgentSessionStore | None = None,
    auto_start: bool = True,
) -> FastAPI:
    """说明：创建并配置 FastAPI 应用。"""
    runtime = MarketRuntime(
        config=config,
        instruments=instruments,
        controller_factory=controller_factory,
        agent_session_store=agent_session_store,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        """说明：在 FastAPI 生命周期内启动和停止运行时。"""
        if auto_start:
            await runtime.start()
        try:
            yield
        finally:
            await runtime.stop()

    app = FastAPI(title="mytradebot Web", lifespan=lifespan)
    app.state.runtime = runtime
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/state")
    async def get_state() -> dict[str, Any]:
        """说明：返回当前完整市场状态。"""
        return runtime.snapshot()

    @app.get("/api/securities/search")
    async def search_securities_endpoint(q: str) -> dict[str, Any]:
        """说明：处理证券搜索请求，默认使用 Alpaca。"""
        return {"results": await runtime.search_alpaca(q)}

    @app.get("/api/instruments/search")
    async def search_instruments_endpoint(source: str, q: str) -> dict[str, Any]:
        """说明：处理 provider 标的搜索请求。"""
        return {"results": await runtime.search_instruments(source, q)}

    @app.post("/api/watchlist/alpaca")
    async def add_alpaca_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        """说明：处理新增 Alpaca 标的请求。"""
        return await runtime.add_alpaca(payload)

    @app.post("/api/watchlist/bitget")
    async def add_bitget_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        """说明：处理新增 Bitget 标的请求。"""
        return await runtime.add_bitget(payload)

    @app.delete("/api/watchlist/alpaca/{symbol}")
    async def remove_alpaca_endpoint(symbol: str) -> dict[str, Any]:
        """说明：处理移除 Alpaca 标的请求。"""
        return await runtime.remove_alpaca(symbol)

    @app.delete("/api/watchlist/instruments/{instrument_key}")
    async def remove_instrument_endpoint(instrument_key: str) -> dict[str, Any]:
        """说明：处理移除任意 watchlist 标的请求。"""
        return await runtime.remove_instrument(instrument_key)

    @app.get("/api/agent/models")
    async def list_agent_models_endpoint() -> dict[str, Any]:
        """说明：处理 Agent 可用模型列表请求。"""
        return await runtime.list_agent_models()

    @app.post("/api/agent/config")
    async def update_agent_config_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        """说明：处理 Agent 配置更新请求。"""
        return await runtime.update_agent_config(payload)

    @app.get("/api/agent/sessions/{instrument_key}")
    async def get_agent_session_endpoint(instrument_key: str) -> dict[str, Any]:
        """说明：读取某个标的当前 active Agent 会话。"""
        return await runtime.get_agent_session(instrument_key)

    @app.get("/api/agent/sessions/{instrument_key}/history")
    async def list_agent_session_history_endpoint(instrument_key: str) -> dict[str, Any]:
        """说明：列出某个标的的历史 Agent 会话。"""
        return await runtime.list_agent_session_history(instrument_key)

    @app.post("/api/agent/sessions/{instrument_key}/history/{session_id}/resume")
    async def resume_agent_session_endpoint(instrument_key: str, session_id: str) -> dict[str, Any]:
        """说明：恢复某个历史 Agent 会话。"""
        return await runtime.resume_agent_session(instrument_key, session_id)

    @app.delete("/api/agent/sessions/{instrument_key}/history/{session_id}")
    async def delete_agent_session_endpoint(instrument_key: str, session_id: str) -> dict[str, Any]:
        """说明：删除某个历史 Agent 会话。"""
        return await runtime.delete_agent_session(instrument_key, session_id)

    @app.post("/api/agent/sessions/{instrument_key}/messages")
    async def append_agent_session_message_endpoint(
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """说明：追加用户问题并触发一次会话式 Agent 分析。"""
        message = payload.get("message", payload.get("prompt"))
        return await runtime.analyze_instrument(instrument_key, prompt=str(message) if message is not None else None)

    @app.post("/api/agent/sessions/{instrument_key}/reset")
    async def reset_agent_session_endpoint(instrument_key: str) -> dict[str, Any]:
        """说明：为某个标的开启一个新的 Agent 会话。"""
        return await runtime.reset_agent_session(instrument_key)

    @app.post("/api/analysis/config")
    async def update_analysis_config_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        """说明：处理分析配置更新请求。"""
        return await runtime.update_analysis_config(payload)

    @app.post("/api/instruments/{instrument_key}/analysis-interval")
    async def update_instrument_analysis_interval_endpoint(
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """说明：处理单个标的 K 线周期更新请求。"""
        return await runtime.update_instrument_analysis_interval(instrument_key, payload)

    @app.post("/api/instruments/{instrument_key}/candles/older")
    async def load_older_candles_endpoint(instrument_key: str) -> dict[str, Any]:
        """说明：处理图表向前加载历史 K 线请求。"""
        return await runtime.load_older_candles(instrument_key)

    @app.post("/api/agent/analyze/{instrument_key}")
    async def analyze_instrument_endpoint(instrument_key: str) -> dict[str, Any]:
        """说明：处理单个标的的手动 Agent 分析请求。"""
        return await runtime.analyze_instrument(instrument_key)

    @app.get("/api/trades")
    async def list_trades_endpoint(
        instrument_key: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        """说明：返回虚拟订单列表，支持按 instrument / status 过滤。"""
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

    @app.get("/api/trades/{trade_id}")
    async def get_trade_endpoint(trade_id: int) -> dict[str, Any]:
        """说明：返回单笔订单及其成交和快照。"""
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
        """说明：返回 review 过程生成的 lesson 列表。"""
        lessons = runtime.trade_store.list_lessons(
            instrument_key=instrument_key,
            limit=max(1, min(int(limit), 500)),
        )
        return {"lessons": list(lessons)}

    @app.post("/api/trades/review")
    async def trigger_trade_review_endpoint(
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """说明：手动触发 closed 交易复盘。"""
        limit = int((payload or {}).get("limit", 3))
        if not runtime.config.agent.enabled:
            raise HTTPException(status_code=409, detail="agent disabled in config")
        try:
            provider = create_llm_provider(runtime.config.agent)
        except (LLMProviderUnavailable, LLMProviderError) as exc:
            raise HTTPException(status_code=503, detail=str(exc))

        async def _reviewer(review_payload: dict[str, Any]) -> dict[str, Any]:
            return await runtime._llm_generate_lesson(provider, review_payload)

        results = await review_pending(
            store=runtime.trade_store,
            llm=_reviewer,
            limit=max(1, min(limit, 20)),
        )
        await runtime.broadcast()
        return {
            "results": [
                {
                    "tradeId": r.trade_id,
                    "lessonId": r.lesson_id,
                    "success": r.success,
                    "error": r.error,
                }
                for r in results
            ],
        }

    @app.get("/api/news")
    async def get_news_endpoint(limit: int = 50) -> dict[str, Any]:
        """说明：读取本地缓存的最近新闻。"""
        if runtime.news_service is None:
            return {"news": [], "enabled": False}
        resolved = max(1, min(int(limit), 200))
        items = runtime.news_service.recent(limit=resolved)
        return {"news": [item.to_payload() for item in items], "enabled": True}

    @app.get("/api/news/decisions")
    async def get_news_decisions_endpoint(limit: int = 50) -> dict[str, Any]:
        """说明：读取最近的 news_analyst 决策日志（含已下单 + skip）。"""
        if runtime.news_analyst is None:
            return {"decisions": [], "enabled": False}
        resolved = max(1, min(int(limit), 200))
        return {
            "decisions": runtime.news_analyst.decision_store.recent(limit=resolved),
            "enabled": True,
        }

    @app.post("/api/news/config")
    async def update_news_config_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        """说明：处理 News 配置更新请求。"""
        return await runtime.update_news_config(payload)

    @app.post("/api/news/refresh")
    async def refresh_news_endpoint() -> dict[str, Any]:
        """说明：手动触发一次新闻抓取，超时降级返回缓存。"""
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

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        """说明：接入 WebSocket 客户端并推送市场状态。"""
        await runtime.connect(websocket)

    if WEB_DIST.exists():
        assets_dir = WEB_DIST / "assets"
        if assets_dir.exists():
            app.mount("/assets", NoCacheStaticFiles(directory=assets_dir), name="assets")

        @app.get("/{path:path}")
        async def serve_web(path: str) -> FileResponse:
            """说明：返回构建后的前端静态文件或入口页面。"""
            requested = WEB_DIST / path
            if path and requested.is_file():
                return FileResponse(requested, headers=WEB_CACHE_HEADERS)
            return FileResponse(WEB_DIST / "index.html", headers=WEB_CACHE_HEADERS)

    return app


def _agent_config_from_payload(current: AgentConfig, payload: dict[str, Any]) -> AgentConfig:
    """说明：合并前端 Agent 设置并重新规范化。"""
    raw: dict[str, Any] = {
        "enabled": current.enabled,
        "provider": current.provider,
        "api_mode": current.api_mode,
        "model": current.model,
        "timeout_seconds": current.timeout_seconds,
        "max_candles": current.max_candles,
        "reasoning_effort": current.reasoning_effort,
        "max_iterations": current.max_iterations,
        "use_tools": current.use_tools,
    }
    field_map = {
        "enabled": "enabled",
        "provider": "provider",
        "apiMode": "api_mode",
        "api_mode": "api_mode",
        "model": "model",
        "timeoutSeconds": "timeout_seconds",
        "timeout_seconds": "timeout_seconds",
        "maxCandles": "max_candles",
        "max_candles": "max_candles",
        "reasoningEffort": "reasoning_effort",
        "reasoning_effort": "reasoning_effort",
        "maxIterations": "max_iterations",
        "max_iterations": "max_iterations",
        "useTools": "use_tools",
        "use_tools": "use_tools",
    }
    for incoming, normalized in field_map.items():
        if incoming in payload:
            raw[normalized] = payload[incoming]
    incoming_provider = payload.get("provider")
    if isinstance(incoming_provider, str) and incoming_provider.strip().lower() != current.provider:
        if "apiMode" not in payload and "api_mode" not in payload:
            raw["api_mode"] = None
    return parse_agent_config(raw)


def _agent_loop_history_without_current_turn(
    history: tuple[dict[str, Any], ...],
    *,
    current_user_prompt: str,
) -> list[dict[str, Any]]:
    """Return prior chat history without the user turn already represented by the prompt."""
    history_items = list(history)
    if history_items:
        latest = history_items[-1]
        if latest.get("role") == "user" and str(latest.get("content", "")) == current_user_prompt:
            history_items = history_items[:-1]
    return [
        {"role": msg["role"], "content": msg["content"]}
        for msg in history_items
        if msg.get("role") in ("user", "assistant")
    ]


def _latest_session_analysis(session_payload: dict[str, Any]) -> dict[str, Any] | None:
    """说明：从 session payload 中提取最近一次 assistant 分析结果。"""
    messages = session_payload.get("messages")
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        analysis = message.get("analysis")
        if isinstance(analysis, dict):
            return analysis
    return None


def _analysis_config_from_payload(current: AnalysisConfig, payload: dict[str, Any]) -> AnalysisConfig:
    """说明：合并前端分析设置并重新规范化。"""
    raw: dict[str, Any] = {
        "enabled": current.enabled,
        "interval": current.interval,
        "lookback": current.lookback,
        "poll_interval_seconds": current.poll_interval_seconds,
        "stale_after_seconds": current.stale_after_seconds,
    }
    field_map = {
        "enabled": "enabled",
        "interval": "interval",
        "lookback": "lookback",
        "pollIntervalSeconds": "poll_interval_seconds",
        "poll_interval_seconds": "poll_interval_seconds",
        "staleAfterSeconds": "stale_after_seconds",
        "stale_after_seconds": "stale_after_seconds",
    }
    for incoming, normalized in field_map.items():
        if incoming in payload:
            raw[normalized] = payload[incoming]
    return parse_analysis_config(raw)


def _news_config_from_payload(current: NewsConfig, payload: dict[str, Any]) -> NewsConfig:
    """说明：合并前端 news 设置并重新规范化。"""
    raw: dict[str, Any] = {
        "enabled": current.enabled,
        "poll_interval_seconds": current.poll_interval_seconds,
        "max_interval_seconds": current.max_interval_seconds,
        "reuters_url": current.reuters_url,
        "request_timeout_seconds": current.request_timeout_seconds,
        "retention_days": current.retention_days,
        "recent_limit": current.recent_limit,
    }
    field_map = {
        "enabled": "enabled",
        "pollIntervalSeconds": "poll_interval_seconds",
        "poll_interval_seconds": "poll_interval_seconds",
        "maxIntervalSeconds": "max_interval_seconds",
        "max_interval_seconds": "max_interval_seconds",
        "reutersUrl": "reuters_url",
        "reuters_url": "reuters_url",
        "requestTimeoutSeconds": "request_timeout_seconds",
        "request_timeout_seconds": "request_timeout_seconds",
        "retentionDays": "retention_days",
        "retention_days": "retention_days",
        "recentLimit": "recent_limit",
        "recent_limit": "recent_limit",
    }
    for incoming, normalized in field_map.items():
        if incoming in payload:
            raw[normalized] = payload[incoming]
    return parse_news_config(raw)
