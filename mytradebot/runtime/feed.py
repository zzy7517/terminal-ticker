"""文件用途：运行时层，在后台线程中运行行情订阅、轮询和 K 线分析。"""
from __future__ import annotations

import asyncio
import queue
import sqlite3
import threading
from dataclasses import dataclass
import logging
from typing import Any

from ..market_data.alpaca import (
    AlpacaInstrument,
    fetch_candles as fetch_alpaca_candles,
    fetch_snapshot_payloads as fetch_alpaca_snapshot_payloads,
)
from ..market_data.bitget import (
    BitgetInstrument,
    BitgetPublicWebSocket,
    fetch_candles as fetch_bitget_candles,
    fetch_snapshot_payloads,
)
from ..market_data.hyperliquid import (
    HyperliquidInstrument,
    fetch_candles as fetch_hyperliquid_candles,
    fetch_snapshot_payloads as fetch_hyperliquid_snapshot_payloads,
)
from ..market_data.candle_cache import (
    CandleCache,
    cached_fetch_candles,
    retention_seconds_for_window,
)
from ..config import AppConfig
from ..market_data.router import MarketInstrument

LOGGER = logging.getLogger(__name__)
CHART_CANDLE_LIMIT = 1000
OLDER_CANDLE_LIMIT = 200
THUMBNAIL_INTERVAL = "1H"
THUMBNAIL_CANDLE_LIMIT = 60
THUMBNAIL_RETENTION_SECONDS = THUMBNAIL_CANDLE_LIMIT * 60 * 60
THUMBNAIL_CACHE_MAX_AGE_SECONDS = 15 * 60
MULTI_TIMEFRAME_CANDLE_LIMIT = 120
MULTI_TIMEFRAME_STACKS = {
    "1m": ("1D", "4H", "1H", "15m", "5m", "1m"),
    "3m": ("1D", "4H", "1H", "15m", "5m", "3m"),
    "5m": ("1D", "4H", "1H", "15m", "5m"),
    "15m": ("1D", "4H", "1H", "15m", "5m"),
    "30m": ("1W", "1D", "4H", "1H", "30m"),
    "1H": ("1W", "1D", "4H", "1H", "15m"),
    "4H": ("1W", "1D", "4H", "1H"),
    "6H": ("1W", "1D", "6H", "1H"),
    "12H": ("1W", "1D", "12H", "4H"),
    "1D": ("1M", "1W", "1D", "4H"),
    "3D": ("1M", "1W", "3D", "1D"),
    "1W": ("1M", "1W", "1D"),
    "1M": ("1M", "1W"),
}


def related_analysis_intervals(primary_interval: str) -> tuple[str, ...]:
    """说明：围绕当前主周期返回一组适合给 LLM 的多周期视图。"""
    stack = MULTI_TIMEFRAME_STACKS.get(primary_interval)
    if stack:
        return stack
    return (primary_interval,)


@dataclass(frozen=True)
class FeedEvent:
    """说明：封装后台 worker 发送给控制器的一条标准事件。"""
    kind: str
    payload: Any


class FeedWorker(threading.Thread):
    """说明：在线程中运行 Bitget 流、股票轮询和 K 线分析。"""
    def __init__(
        self,
        *,
        config: AppConfig,
        instruments: tuple[MarketInstrument, ...],
        event_queue: queue.Queue[FeedEvent],
        candle_cache: CandleCache | None = None,
    ) -> None:
        """说明：初始化当前对象的运行状态。"""
        super().__init__(daemon=True)
        self.config = config
        self.instruments = instruments
        self.bitget_instruments = tuple(
            instrument for instrument in instruments if isinstance(instrument, BitgetInstrument)
        )
        self.alpaca_instruments = tuple(
            instrument for instrument in instruments if isinstance(instrument, AlpacaInstrument)
        )
        self.hyperliquid_instruments = tuple(
            instrument for instrument in instruments if isinstance(instrument, HyperliquidInstrument)
        )
        self.event_queue = event_queue
        self.candle_cache = candle_cache
        if self.candle_cache is None and self.config.cache.enabled:
            self.candle_cache = CandleCache.from_config(self.config.cache)
        self.stop_event = threading.Event()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.socket: BitgetPublicWebSocket | None = None
        self.listen_task: asyncio.Task[None] | None = None
        self.tasks: list[asyncio.Task[None]] = []

    def run(self) -> None:
        """说明：运行线程入口并管理事件循环生命周期。"""
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._run())
        finally:
            pending = asyncio.all_tasks(self.loop)
            for task in pending:
                task.cancel()
            if pending:
                self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            self.loop.close()

    def stop(self) -> None:
        """说明：停止后台运行时组件并释放连接。"""
        self.stop_event.set()
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self._request_shutdown)

    def _request_shutdown(self) -> None:
        """说明：取消活跃 asyncio 任务并关闭行情连接。"""
        for task in self.tasks:
            task.cancel()
        if self.listen_task is not None:
            self.listen_task.cancel()
        if self.socket is not None:
            asyncio.create_task(self.socket.close())

    async def _run(self) -> None:
        # Bitget streams and stock polling run independently but share one event queue.
        """说明：启动 provider 任务并在退出时发送 stopped 状态。"""
        if self.bitget_instruments:
            self.tasks.append(asyncio.create_task(self._run_bitget()))
        if self.config.analysis.enabled and (
            self.bitget_instruments or self.alpaca_instruments or self.hyperliquid_instruments
        ):
            self.tasks.append(asyncio.create_task(self._run_candles()))
        if self.alpaca_instruments:
            self.tasks.append(asyncio.create_task(self._run_alpaca()))
        if self.hyperliquid_instruments:
            self.tasks.append(asyncio.create_task(self._run_hyperliquid()))

        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)

        self.event_queue.put(FeedEvent("status", "stopped"))

    async def _run_bitget(self) -> None:
        """说明：维护 Bitget 快照、订阅和重连循环。"""
        while not self.stop_event.is_set():
            try:
                self.event_queue.put(FeedEvent("status", "connecting"))
                snapshots = await asyncio.to_thread(
                    fetch_snapshot_payloads,
                    self.bitget_instruments,
                )
                self.event_queue.put(FeedEvent("snapshot", snapshots))

                self.socket = BitgetPublicWebSocket(self.bitget_instruments)
                self.event_queue.put(FeedEvent("status", "subscribed"))
                self.listen_task = asyncio.create_task(self.socket.listen(self._handle_message))
                await self.listen_task
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self.event_queue.put(FeedEvent("error", str(exc) or exc.__class__.__name__))
                if self.stop_event.is_set():
                    break
                await asyncio.sleep(self.config.display.reconnect_delay_seconds)
            finally:
                if self.socket is not None:
                    try:
                        await self.socket.close()
                    except Exception:
                        pass
                self.socket = None
                self.listen_task = None

    async def _run_alpaca(self) -> None:
        """说明：按配置周期轮询 Alpaca 股票快照。"""
        while not self.stop_event.is_set():
            try:
                payloads = await asyncio.to_thread(
                    fetch_alpaca_snapshot_payloads,
                    self.alpaca_instruments,
                )
                for payload in payloads.values():
                    self.event_queue.put(FeedEvent("quote", payload))
                if payloads:
                    self.event_queue.put(FeedEvent("status", "polling"))
            except asyncio.CancelledError:
                break
            except Exception as exc:
                detail = str(exc) or exc.__class__.__name__
                self.event_queue.put(
                    FeedEvent(
                        "error",
                        {
                            "message": detail,
                            "ids": [instrument.key for instrument in self.alpaca_instruments],
                        },
                    )
                )

            try:
                await asyncio.sleep(self.config.display.stock_poll_interval_seconds)
            except asyncio.CancelledError:
                break

    async def _run_hyperliquid(self) -> None:
        """说明：按配置周期轮询 Hyperliquid 测试网快照。"""
        while not self.stop_event.is_set():
            try:
                payloads = await asyncio.to_thread(
                    fetch_hyperliquid_snapshot_payloads,
                    self.hyperliquid_instruments,
                )
                for payload in payloads.values():
                    self.event_queue.put(FeedEvent("quote", payload))
                if payloads:
                    self.event_queue.put(FeedEvent("status", "polling"))
            except asyncio.CancelledError:
                break
            except Exception as exc:
                detail = str(exc) or exc.__class__.__name__
                self.event_queue.put(
                    FeedEvent(
                        "error",
                        {
                            "message": detail,
                            "ids": [instrument.key for instrument in self.hyperliquid_instruments],
                        },
                    )
                )

            try:
                await asyncio.sleep(self.config.display.stock_poll_interval_seconds)
            except asyncio.CancelledError:
                break

    async def _run_candles(self) -> None:
        """说明：轮询 provider K 线并发送图表数据。"""
        while not self.stop_event.is_set():
            for instrument in (
                self.bitget_instruments + self.alpaca_instruments + self.hyperliquid_instruments
            ):
                if self.stop_event.is_set():
                    break
                candles = tuple()
                thumbnail_candles = None
                multi_timeframe_candles: dict[str, tuple] = {}
                error = None
                interval = getattr(instrument, "analysis_interval", None) or self.config.analysis.interval
                try:
                    candle_limit = max(self.config.analysis.lookback, CHART_CANDLE_LIMIT)
                    candles = await asyncio.to_thread(
                        self._fetch_candles,
                        instrument,
                        interval=interval,
                        limit=candle_limit,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    error = str(exc) or exc.__class__.__name__

                for timeframe in related_analysis_intervals(interval):
                    try:
                        if timeframe == interval and candles:
                            multi_timeframe_candles[timeframe] = candles[-MULTI_TIMEFRAME_CANDLE_LIMIT:]
                            continue
                        timeframe_candles = await asyncio.to_thread(
                            self._fetch_candles,
                            instrument,
                            interval=timeframe,
                            limit=max(self.config.agent.max_candles, MULTI_TIMEFRAME_CANDLE_LIMIT),
                        )
                        if timeframe_candles:
                            multi_timeframe_candles[timeframe] = timeframe_candles[
                                -max(self.config.agent.max_candles, MULTI_TIMEFRAME_CANDLE_LIMIT) :
                            ]
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        LOGGER.debug(
                            "Multi-timeframe candles unavailable for %s %s: %s",
                            instrument.key,
                            timeframe,
                            exc,
                        )

                try:
                    thumbnail_candles = await self._thumbnail_candles(instrument, candles, interval)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    LOGGER.debug(
                        "Thumbnail candles unavailable for %s %s: %s",
                        instrument.key,
                        THUMBNAIL_INTERVAL,
                        exc,
                    )

                payload = {
                    "id": instrument.key,
                    "candles": candles,
                    "multi_timeframe_candles": multi_timeframe_candles,
                }
                if error is not None:
                    payload["error"] = error
                if thumbnail_candles is not None:
                    payload["thumbnail_candles"] = thumbnail_candles
                self.event_queue.put(
                    FeedEvent(
                        "candles",
                        payload,
                    )
                )

            try:
                await asyncio.sleep(self.config.analysis.poll_interval_seconds)
            except asyncio.CancelledError:
                break

    def _fetch_candles(
        self,
        instrument: MarketInstrument,
        *,
        interval: str,
        limit: int,
        minimum_retention_seconds: int | None = None,
        max_cache_age_seconds: int | None = None,
    ):
        """说明：通过缓存或 provider 拉取近期 K 线。"""
        if self.candle_cache is not None:
            retention_seconds = minimum_retention_seconds
            if retention_seconds is None:
                retention_seconds = retention_seconds_for_window(interval, limit)
            try:
                return cached_fetch_candles(
                    cache=self.candle_cache,
                    symbol_key=instrument.key,
                    interval=interval,
                    limit=limit,
                    fetcher=lambda **kwargs: self._fetch_provider_candles(instrument, **kwargs),
                    minimum_retention_seconds=retention_seconds,
                    max_cache_age_seconds=max_cache_age_seconds,
                )
            except (OSError, sqlite3.Error) as exc:
                LOGGER.warning("Candle cache unavailable for %s %s: %s", instrument.key, interval, exc)
        return self._fetch_provider_candles(instrument, interval=interval, limit=limit)

    async def _thumbnail_candles(
        self,
        instrument: MarketInstrument,
        analysis_candles: tuple,
        analysis_interval: str,
    ):
        """说明：返回固定 1 小时级别的缩略图 K 线。"""
        if analysis_interval == THUMBNAIL_INTERVAL and len(analysis_candles) >= THUMBNAIL_CANDLE_LIMIT:
            return analysis_candles[-THUMBNAIL_CANDLE_LIMIT:]
        return await asyncio.to_thread(
            self._fetch_candles,
            instrument,
            interval=THUMBNAIL_INTERVAL,
            limit=THUMBNAIL_CANDLE_LIMIT,
            minimum_retention_seconds=THUMBNAIL_RETENTION_SECONDS,
            max_cache_age_seconds=THUMBNAIL_CACHE_MAX_AGE_SECONDS,
        )

    def _fetch_provider_candles(
        self,
        instrument: MarketInstrument,
        *,
        interval: str,
        limit: int,
        after_open_time_ms: int | None = None,
        before_open_time_ms: int | None = None,
    ):
        """说明：绕过缓存直接从 provider 拉取近期 K 线。"""
        if isinstance(instrument, BitgetInstrument):
            return fetch_bitget_candles(
                instrument,
                interval=interval,
                limit=limit,
                after_open_time_ms=after_open_time_ms,
                before_open_time_ms=before_open_time_ms,
            )
        if isinstance(instrument, AlpacaInstrument):
            return fetch_alpaca_candles(
                instrument,
                interval=interval,
                limit=limit,
                after_open_time_ms=after_open_time_ms,
                before_open_time_ms=before_open_time_ms,
            )
        if isinstance(instrument, HyperliquidInstrument):
            return fetch_hyperliquid_candles(
                instrument,
                interval=interval,
                limit=limit,
                after_open_time_ms=after_open_time_ms,
                before_open_time_ms=before_open_time_ms,
            )
        raise ValueError(f"unsupported candle provider: {instrument!r}")

    def fetch_older_candles(
        self,
        instrument: MarketInstrument,
        *,
        interval: str,
        before_open_time_ms: int | None,
        limit: int = OLDER_CANDLE_LIMIT,
    ):
        """说明：按最早缓存 K 线继续向前拉取一批历史 K 线。"""
        candles = self._fetch_provider_candles(
            instrument,
            interval=interval,
            limit=limit,
            before_open_time_ms=before_open_time_ms,
        )
        if candles and self.candle_cache is not None:
            try:
                self.candle_cache.upsert(candles, interval=interval)
            except (OSError, sqlite3.Error) as exc:
                LOGGER.warning("Candle cache unavailable for %s %s: %s", instrument.key, interval, exc)
        return candles

    def _handle_message(self, payload: dict[str, Any]) -> None:
        """说明：把一条 Bitget WebSocket 消息转发到事件队列。"""
        self.event_queue.put(FeedEvent("quote", payload))
