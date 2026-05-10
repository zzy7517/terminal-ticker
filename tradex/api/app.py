"""文件用途：API 层入口 — 创建 FastAPI 应用、组装 runtime 和路由。"""
from __future__ import annotations

import logging
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from ..agent import AgentSessionStore
from ..config import AppConfig
from ..market_data.router import MarketInstrument
from ..runtime.controller import TickerController
from .routes import register_routes
from .runtime import MarketRuntime

PROJECT_ROOT = Path(__file__).resolve().parents[2]
WEB_DIST = PROJECT_ROOT / "web" / "dist"
WEB_CACHE_HEADERS = {"Cache-Control": "no-store, max-age=0, must-revalidate"}
LOGGER = logging.getLogger(__name__)


class NoCacheStaticFiles(StaticFiles):
    """Serve local frontend assets without browser cache reuse."""

    def file_response(self, full_path: Path, stat_result: Any, scope: Scope, status_code: int = 200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers.update(WEB_CACHE_HEADERS)
        return response


def create_app(
    *,
    config: AppConfig,
    instruments: tuple[MarketInstrument, ...],
    controller_factory: Callable[..., Any] = TickerController,
    agent_session_store: AgentSessionStore | None = None,
    auto_start: bool = True,
) -> FastAPI:
    """创建并配置 FastAPI 应用。"""
    runtime = MarketRuntime(
        config=config,
        instruments=instruments,
        controller_factory=controller_factory,
        agent_session_store=agent_session_store,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if auto_start:
            await runtime.start()
        try:
            yield
        finally:
            await runtime.stop()

    app = FastAPI(title="tradex Web", lifespan=lifespan)
    app.state.runtime = runtime

    @app.middleware("http")
    async def log_http_request(request: Request, call_next: Callable[[Request], Any]) -> Any:
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = (time.perf_counter() - started) * 1000
            LOGGER.exception(
                "http request failed: method=%s path=%s client=%s duration_ms=%.1f",
                request.method,
                request.url.path,
                request.client.host if request.client else "-",
                duration_ms,
            )
            raise
        duration_ms = (time.perf_counter() - started) * 1000
        LOGGER.info(
            "http request finished: method=%s path=%s status=%d client=%s duration_ms=%.1f",
            request.method,
            request.url.path,
            response.status_code,
            request.client.host if request.client else "-",
            duration_ms,
        )
        return response

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_routes(app, runtime)

    if WEB_DIST.exists():
        assets_dir = WEB_DIST / "assets"
        if assets_dir.exists():
            app.mount("/assets", NoCacheStaticFiles(directory=assets_dir), name="assets")

        @app.get("/{path:path}")
        async def serve_web(path: str) -> FileResponse:
            requested = WEB_DIST / path
            if path and requested.is_file():
                return FileResponse(requested, headers=WEB_CACHE_HEADERS)
            return FileResponse(WEB_DIST / "index.html", headers=WEB_CACHE_HEADERS)

    return app
