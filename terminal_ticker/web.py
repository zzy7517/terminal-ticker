"""Expose market data and price action state through a local web app."""
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

from .agent import AgentAnalysisResult, build_agent_context, create_llm_provider
from .config import AppConfig, LONGBRIDGE_SOURCE, load_config
from .controller import TickerController
from .longbridge_provider import (
    LongbridgeSecurity,
    resolve_instruments as resolve_longbridge_instruments,
    search_securities,
)
from .models import QuoteState
from .price_action import Candle, PriceActionState
from .providers import MarketInstrument, resolve_instruments
from .watchlist_store import (
    append_longbridge_symbol_to_watchlist,
    remove_longbridge_symbol_from_watchlist,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_DIST = PROJECT_ROOT / "web" / "dist"


def _utc_now_iso() -> str:
    """Return an ISO timestamp suitable for browser state payloads."""
    return datetime.now(timezone.utc).isoformat()


def _instrument_payload(instrument: MarketInstrument) -> dict[str, Any]:
    """Serialize a resolved market instrument for the web UI."""
    return {
        "key": instrument.key,
        "symbol": instrument.symbol,
        "label": instrument.label,
        "source": instrument.source,
        "group": instrument.group,
    }


def _price_action_payload(
    state: PriceActionState | None,
    *,
    stale_after_seconds: int,
) -> dict[str, Any] | None:
    """Serialize price action state while marking stale analysis explicitly."""
    if state is None:
        return None
    stale = state.is_stale(stale_after_seconds)
    return {
        "label": state.label,
        "bias": state.bias,
        "marker": "" if stale else state.marker,
        "reason": state.reason,
        "strength": state.strength,
        "updatedAt": state.updated_at.isoformat(),
        "error": state.error,
        "available": state.is_available() and not stale,
        "stale": stale,
    }


def _candle_payload(candle: Candle) -> dict[str, Any]:
    """Serialize one candle for Lightweight Charts."""
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
    analysis_stale_after_seconds: int,
) -> dict[str, Any]:
    """Serialize one quote and its derived analysis for the web UI."""
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
        "priceAction": _price_action_payload(
            quote.price_action,
            stale_after_seconds=analysis_stale_after_seconds,
        ),
        "candles": [_candle_payload(candle) for candle in quote.price_action_candles],
    }


def serialize_market_state(
    *,
    config: AppConfig,
    instruments: tuple[MarketInstrument, ...],
    quotes: dict[str, QuoteState],
    stream_status: str,
    agent_analyses: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the complete browser state snapshot."""
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
                "maxCandles": config.agent.max_candles,
                "reasoningEffort": config.agent.reasoning_effort,
            },
            "display": {
                "refreshIntervalMs": config.display.refresh_interval_ms,
                "staleAfterSeconds": config.display.stale_after_seconds,
                "longbridgePollIntervalSeconds": config.display.longbridge_poll_interval_seconds,
            },
            "sourcePath": str(config.source_path) if config.source_path else None,
        },
        "instruments": [_instrument_payload(instrument) for instrument in instruments],
        "groups": groups,
        "quotes": {
            key: _quote_payload(
                quote,
                stale_after_seconds=config.display.stale_after_seconds,
                analysis_stale_after_seconds=config.analysis.stale_after_seconds,
            )
            for key, quote in quotes.items()
        },
        "agentAnalyses": agent_analyses or {},
    }


class MarketRuntime:
    """Own live market state, background feeds, and web socket clients."""

    def __init__(
        self,
        *,
        config: AppConfig,
        instruments: tuple[MarketInstrument, ...],
        controller_factory: Callable[..., Any] = TickerController,
    ) -> None:
        """Create runtime state without starting network feeds."""
        self.config = config
        self.instruments = instruments
        self.controller_factory = controller_factory
        self.controller = controller_factory(config=config, instruments=instruments)
        self.clients: set[WebSocket] = set()
        self.pump_task: asyncio.Task[None] | None = None
        self.running = False
        self.agent_analyses: dict[str, dict[str, Any]] = {}

    async def start(self) -> None:
        """Start the feed worker and websocket broadcast pump."""
        if self.running:
            return
        self.running = True
        self.controller.start()
        self.pump_task = asyncio.create_task(self._pump())

    async def stop(self) -> None:
        """Stop the feed worker and disconnect websocket clients."""
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
        """Return the latest serialized state."""
        return serialize_market_state(
            config=self.config,
            instruments=self.instruments,
            quotes=self.controller.quotes,
            stream_status=self.controller.stream_status,
            agent_analyses=self.agent_analyses,
        )

    async def connect(self, websocket: WebSocket) -> None:
        """Accept one websocket client and keep it attached until disconnect."""
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
        """Search Longbridge securities and mark active watchlist entries."""
        text = query.strip()
        if not text:
            return []
        active = {instrument.key for instrument in self.instruments}
        results = await asyncio.to_thread(search_securities, text)
        return [
            {
                "symbol": item.symbol,
                "label": item.default_label,
                "nameCn": item.name_cn,
                "nameHk": item.name_hk,
                "nameEn": item.name_en,
                "displayText": item.display_text(),
                "exists": f"{LONGBRIDGE_SOURCE}:{item.symbol}" in active,
            }
            for item in results
        ]

    async def add_longbridge(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Persist and activate one Longbridge symbol."""
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

    async def remove_longbridge(self, symbol: str) -> dict[str, Any]:
        """Remove and deactivate one Longbridge symbol."""
        source_path = self._require_source_path()
        changed = await asyncio.to_thread(
            remove_longbridge_symbol_from_watchlist,
            source_path,
            symbol=symbol,
        )
        if changed:
            await self.reload_from_source()
        return {"changed": changed, "state": self.snapshot()}

    async def analyze_instrument(self, instrument_key: str) -> dict[str, Any]:
        """Run one manual LLM analysis for an instrument."""
        if not self.config.agent.enabled:
            result = AgentAnalysisResult.unavailable(
                provider=self.config.agent.provider,
                model=self.config.agent.model,
                error="Agent is disabled in config.",
            )
            return {"result": result.to_payload(), "state": self.snapshot()}

        instrument = self._instrument_by_key(instrument_key)
        quote = self.controller.quotes.get(instrument.key)
        if quote is None:
            raise HTTPException(status_code=404, detail="Quote is not available.")
        if not quote.price_action_candles:
            result = AgentAnalysisResult.unavailable(
                provider=self.config.agent.provider,
                model=self.config.agent.model,
                error="No OHLCV candles are available for this instrument yet.",
            )
            payload = result.to_payload()
            self.agent_analyses[instrument.key] = payload
            await self.broadcast()
            return {"result": payload, "state": self.snapshot()}

        context = build_agent_context(
            instrument=instrument,
            quote=quote,
            interval=self.config.analysis.interval,
            max_candles=self.config.agent.max_candles,
        )
        provider = create_llm_provider(self.config.agent)
        result = await provider.analyze(context)
        payload = result.to_payload()
        self.agent_analyses[instrument.key] = payload
        await self.broadcast()
        return {"result": payload, "state": self.snapshot()}

    async def reload_from_source(self) -> None:
        """Reload watchlist config and restart the feed controller."""
        if self.config.source_path is None:
            raise HTTPException(status_code=409, detail="No watchlist file is active.")
        config = await asyncio.to_thread(load_config, self.config.source_path)
        instruments = await asyncio.to_thread(resolve_instruments, config.instruments)
        self.controller.stop()
        self.config = config
        self.instruments = instruments
        self.controller = self.controller_factory(config=config, instruments=instruments)
        active_keys = {instrument.key for instrument in instruments}
        self.agent_analyses = {
            key: value for key, value in self.agent_analyses.items() if key in active_keys
        }
        if self.running:
            self.controller.start()
        await self.broadcast()

    def _require_source_path(self) -> Path:
        """Return the active watchlist path or raise a web error."""
        if self.config.source_path is None:
            raise HTTPException(status_code=409, detail="Cannot edit watchlist without a file.")
        return self.config.source_path

    def _instrument_by_key(self, instrument_key: str) -> MarketInstrument:
        """Find an active instrument by provider key."""
        for instrument in self.instruments:
            if instrument.key == instrument_key:
                return instrument
        raise HTTPException(status_code=404, detail="Instrument not found.")

    async def _pump(self) -> None:
        """Drain feed events and broadcast state updates."""
        refresh_seconds = max(0.25, self.config.display.refresh_interval_ms / 1000)
        while self.running:
            result = self.controller.drain_events()
            if result.dirty:
                await self.broadcast()
            await asyncio.sleep(refresh_seconds)
            await self.broadcast()

    async def broadcast(self) -> None:
        """Send a fresh state snapshot to all websocket clients."""
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
    auto_start: bool = True,
) -> FastAPI:
    """Create the FastAPI application."""
    runtime = MarketRuntime(
        config=config,
        instruments=instruments,
        controller_factory=controller_factory,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
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
        return runtime.snapshot()

    @app.get("/api/securities/search")
    async def search_securities_endpoint(q: str) -> dict[str, Any]:
        return {"results": await runtime.search_longbridge(q)}

    @app.post("/api/watchlist/longbridge")
    async def add_longbridge_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        return await runtime.add_longbridge(payload)

    @app.delete("/api/watchlist/longbridge/{symbol}")
    async def remove_longbridge_endpoint(symbol: str) -> dict[str, Any]:
        return await runtime.remove_longbridge(symbol)

    @app.post("/api/agent/analyze/{instrument_key}")
    async def analyze_instrument_endpoint(instrument_key: str) -> dict[str, Any]:
        return await runtime.analyze_instrument(instrument_key)

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await runtime.connect(websocket)

    if WEB_DIST.exists():
        assets_dir = WEB_DIST / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/{path:path}")
        async def serve_web(path: str) -> FileResponse:
            requested = WEB_DIST / path
            if path and requested.is_file():
                return FileResponse(requested)
            return FileResponse(WEB_DIST / "index.html")

    return app
