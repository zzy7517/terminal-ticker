"""文件用途：API 层，对外提供 FastAPI 路由、WebSocket 和运行时状态。"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ..agent import (
    AgentAnalysisResult,
    AgentSessionStore,
    LLMProviderError,
    LLMProviderUnavailable,
    build_agent_context,
    create_llm_provider,
    list_available_agent_models,
)
from ..config import (
    AgentConfig,
    AnalysisConfig,
    ALPACA_SOURCE,
    AppConfig,
    BITGET_SOURCE,
    LONGBRIDGE_SOURCE,
    load_config,
    parse_agent_config,
    parse_analysis_config,
)
from ..market_data.alpaca import search_assets as search_alpaca_assets
from ..runtime.controller import TickerController
from ..runtime.feed import CHART_CANDLE_LIMIT, OLDER_CANDLE_LIMIT
from ..market_data.longbridge import search_securities
from ..market_data.bitget import search_instruments as search_bitget_instruments
from ..domain.quotes import QuoteState
from ..domain.price_action import Candle, merge_candles
from ..domain.strategy import StrategyConfig, generate_signal
from ..market_data.router import MarketInstrument, resolve_instruments
from ..config.watchlist_store import (
    append_alpaca_symbol_to_watchlist,
    append_bitget_symbol_to_watchlist,
    append_longbridge_symbol_to_watchlist,
    remove_alpaca_symbol_from_watchlist,
    remove_longbridge_symbol_from_watchlist,
    remove_symbol_from_watchlist,
    update_agent_config_in_watchlist,
    update_analysis_config_in_watchlist,
    update_instrument_analysis_interval_in_watchlist,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
WEB_DIST = PROJECT_ROOT / "web" / "dist"
THUMBNAIL_CANDLE_LIMIT = 60
OLDER_CANDLE_SOURCES = {ALPACA_SOURCE, BITGET_SOURCE}
DEFAULT_AGENT_USER_PROMPT = "Analyze the current K-line chart and update the watch plan."


def _utc_now_iso() -> str:
    """说明：返回当前 UTC 时间的 ISO 字符串。"""
    return datetime.now(timezone.utc).isoformat()


def _agent_session_title(instrument: MarketInstrument) -> str:
    """说明：生成某个标的会话在侧栏中展示的标题。"""
    return f"{instrument.label} · {instrument.symbol}"


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


def _strategy_signal_payload(quote: QuoteState, config: AnalysisConfig) -> dict[str, Any]:
    """说明：把当前 K 线窗口转换成可展示的研究信号。"""
    minimum_window = 24
    if len(quote.candles) < minimum_window:
        return {
            "available": False,
            "side": "flat",
            "regime": "unclear",
            "confidence": 0,
            "reason": f"Waiting for at least {minimum_window} candles.",
            "features": None,
        }
    window = min(len(quote.candles), max(minimum_window, min(config.lookback, 48)))
    strategy_config = StrategyConfig(window=window, horizon=max(2, min(6, window // 8)))
    signal = generate_signal(quote.candles, strategy_config)
    return {
        "available": True,
        "side": signal.side,
        "regime": signal.regime,
        "confidence": signal.confidence,
        "reason": signal.reason,
        "features": {
            "closeReturn": signal.features.close_return,
            "rangeEfficiency": signal.features.range_efficiency,
            "atrPercent": signal.features.atr_percent,
            "realizedVolatility": signal.features.realized_volatility,
            "trendScore": signal.features.trend_score,
            "positionInRange": signal.features.position_in_range,
            "volumeRatio": signal.features.volume_ratio,
            "latestClose": signal.features.latest_close,
            "recentHigh": signal.features.recent_high,
            "recentLow": signal.features.recent_low,
        },
    }


def _quote_payload(
    quote: QuoteState,
    *,
    stale_after_seconds: int,
    analysis_config: AnalysisConfig,
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
        "strategySignal": _strategy_signal_payload(quote, analysis_config),
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
            },
            "display": {
                "refreshIntervalMs": config.display.refresh_interval_ms,
                "staleAfterSeconds": config.display.stale_after_seconds,
                "stockPollIntervalSeconds": config.display.stock_poll_interval_seconds,
                "longbridgePollIntervalSeconds": config.display.longbridge_poll_interval_seconds,
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
                analysis_config=config.analysis,
            )
            for key, quote in quotes.items()
        },
        "agentAnalyses": agent_analyses or {},
    }


class MarketRuntime:
    """说明：维护实时行情状态、后台 feed 和 WebSocket 客户端。"""

    def __init__(
        self,
        *,
        config: AppConfig,
        instruments: tuple[MarketInstrument, ...],
        controller_factory: Callable[..., Any] = TickerController,
        agent_session_store: AgentSessionStore | None = None,
    ) -> None:
        """说明：初始化当前对象的运行状态。"""
        self.config = config
        self.instruments = instruments
        self.controller_factory = controller_factory
        self.controller = controller_factory(config=config, instruments=instruments)
        self.clients: set[WebSocket] = set()
        self.pump_task: asyncio.Task[None] | None = None
        self.running = False
        self.agent_analyses: dict[str, dict[str, Any]] = {}
        self.agent_session_store = agent_session_store or AgentSessionStore()

    async def start(self) -> None:
        """说明：启动后台运行时组件。"""
        if self.running:
            return
        self.running = True
        self.controller.start()
        self.pump_task = asyncio.create_task(self._pump())

    async def stop(self) -> None:
        """说明：停止后台运行时组件并释放连接。"""
        self.running = False
        if self.pump_task is not None:
            self.pump_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.pump_task
            self.pump_task = None
        self.controller.stop()
        for websocket in tuple(self.clients):
            with suppress(Exception):
                await websocket.close()
        self.clients.clear()

    def snapshot(self) -> dict[str, Any]:
        """说明：返回当前可序列化的市场状态快照。"""
        return serialize_market_state(
            config=self.config,
            instruments=self.instruments,
            quotes=self.controller.quotes,
            stream_status=self.controller.stream_status,
            agent_analyses=self.agent_analyses,
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

    async def search_longbridge(self, query: str) -> list[dict[str, Any]]:
        """说明：搜索长桥证券，并标记已在 watchlist 中的结果。"""
        text = query.strip()
        if not text:
            return []
        active = {instrument.key for instrument in self.instruments}
        results = await asyncio.to_thread(search_securities, text)
        return [
            {
                "source": LONGBRIDGE_SOURCE,
                "symbol": item.symbol,
                "label": item.default_label,
                "instType": None,
                "key": f"{LONGBRIDGE_SOURCE}:{item.symbol}",
                "nameCn": item.name_cn,
                "nameHk": item.name_hk,
                "nameEn": item.name_en,
                "displayText": item.display_text(),
                "exists": f"{LONGBRIDGE_SOURCE}:{item.symbol}" in active,
            }
            for item in results
        ]

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
        if normalized_source == LONGBRIDGE_SOURCE:
            return await self.search_longbridge(query)
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

    async def add_longbridge(self, payload: dict[str, Any]) -> dict[str, Any]:
        """说明：把一个长桥标的写入 watchlist 并激活。"""
        source_path = self._require_source_path()
        symbol = str(payload.get("symbol") or "")
        label = str(payload.get("label") or "").strip() or None
        changed = await asyncio.to_thread(
            append_longbridge_symbol_to_watchlist,
            source_path,
            symbol=symbol,
            label=label,
            group="stocks",
            show_collapsed=True,
        )
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

    async def remove_longbridge(self, symbol: str) -> dict[str, Any]:
        """说明：从 watchlist 移除一个长桥标的并停用。"""
        source_path = self._require_source_path()
        changed = await asyncio.to_thread(
            remove_longbridge_symbol_from_watchlist,
            source_path,
            symbol=symbol,
        )
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
        )
        self.agent_analyses.pop(instrument.key, None)
        await self.broadcast()
        return await self._agent_session_payload(session.id)

    async def analyze_instrument(
        self,
        instrument_key: str,
        prompt: str | None = None,
    ) -> dict[str, Any]:
        """说明：对单个标的执行一次会话式 LLM 分析。"""
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
                "state": self.snapshot(),
            }

        history = await asyncio.to_thread(
            self.agent_session_store.history_for_context,
            session.id,
            limit=8,
        )
        context = build_agent_context(
            instrument=instrument,
            quote=quote,
            interval=instrument.analysis_interval or self.config.analysis.interval,
            max_candles=self.config.agent.max_candles,
            session_history=history,
        )
        provider = create_llm_provider(self.config.agent)
        result = await provider.analyze(context)
        payload = result.to_payload()
        self.agent_analyses[instrument.key] = payload
        await self._record_agent_assistant_message(session.id, payload, context=context)
        await self.broadcast()
        return {
            "result": payload,
            "session": await self._agent_session_payload(session.id),
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
            if result.dirty:
                await self.broadcast()
            await asyncio.sleep(refresh_seconds)
            if not result.dirty:
                await self.broadcast()

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

    app = FastAPI(title="Terminal Ticker Web", lifespan=lifespan)
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

    @app.post("/api/watchlist/longbridge")
    async def add_longbridge_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        """说明：处理新增长桥标的请求。"""
        return await runtime.add_longbridge(payload)

    @app.post("/api/watchlist/bitget")
    async def add_bitget_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        """说明：处理新增 Bitget 标的请求。"""
        return await runtime.add_bitget(payload)

    @app.delete("/api/watchlist/longbridge/{symbol}")
    async def remove_longbridge_endpoint(symbol: str) -> dict[str, Any]:
        """说明：处理移除长桥标的请求。"""
        return await runtime.remove_longbridge(symbol)

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

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        """说明：接入 WebSocket 客户端并推送市场状态。"""
        await runtime.connect(websocket)

    if WEB_DIST.exists():
        assets_dir = WEB_DIST / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/{path:path}")
        async def serve_web(path: str) -> FileResponse:
            """说明：返回构建后的前端静态文件或入口页面。"""
            requested = WEB_DIST / path
            if path and requested.is_file():
                return FileResponse(requested)
            return FileResponse(WEB_DIST / "index.html")

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
    }
    for incoming, normalized in field_map.items():
        if incoming in payload:
            raw[normalized] = payload[incoming]
    return parse_agent_config(raw)


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
