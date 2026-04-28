"""文件用途：运行时层，在后台线程中运行行情订阅、轮询和 K 线分析。"""
from __future__ import annotations

import asyncio
import queue
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
import logging
from typing import Any

from ..market_data.bitget import (
    BitgetInstrument,
    BitgetPublicWebSocket,
    fetch_candles as fetch_bitget_candles,
    fetch_snapshot_payloads,
)
from ..market_data.candle_cache import CandleCache, cached_fetch_candles
from ..config import AppConfig
from ..market_data.longbridge import (
    LongbridgeInstrument,
    fetch_candles as fetch_longbridge_candles,
    fetch_quote_payloads,
)
from ..domain.price_action import PriceActionState, analyze_price_action
from ..market_data.router import MarketInstrument

LOGGER = logging.getLogger(__name__)
THUMBNAIL_INTERVAL = "1H"
THUMBNAIL_CANDLE_LIMIT = 60
THUMBNAIL_RETENTION_SECONDS = THUMBNAIL_CANDLE_LIMIT * 60 * 60


@dataclass(frozen=True)
class FeedEvent:
    """说明：封装后台 worker 发送给控制器的一条标准事件。"""
    kind: str
    payload: Any


class FeedWorker(threading.Thread):
    """说明：在线程中运行 Bitget 流、长桥轮询和 K 线分析。"""
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
        self.longbridge_instruments = tuple(
            instrument for instrument in instruments if isinstance(instrument, LongbridgeInstrument)
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
        # Bitget streams and Longbridge polling run independently but share one event queue.
        """说明：启动 provider 任务并在退出时发送 stopped 状态。"""
        if self.bitget_instruments:
            self.tasks.append(asyncio.create_task(self._run_bitget()))
        if self.config.analysis.enabled and (self.bitget_instruments or self.longbridge_instruments):
            self.tasks.append(asyncio.create_task(self._run_price_action()))
        if self.longbridge_instruments:
            self.tasks.append(asyncio.create_task(self._run_longbridge()))

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

    async def _run_longbridge(self) -> None:
        """说明：按配置周期轮询长桥报价 REST 数据。"""
        while not self.stop_event.is_set():
            try:
                # Polling reuses the same quote event shape as websocket updates.
                payloads = await asyncio.to_thread(fetch_quote_payloads, self.longbridge_instruments)
                for payload in payloads.values():
                    self.event_queue.put(FeedEvent("quote", payload))
                if payloads:
                    self.event_queue.put(FeedEvent("status", "polling"))
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self.event_queue.put(FeedEvent("error", str(exc) or exc.__class__.__name__))

            try:
                await asyncio.sleep(self.config.display.longbridge_poll_interval_seconds)
            except asyncio.CancelledError:
                break

    async def _run_price_action(self) -> None:
        """说明：轮询 provider K 线并发送 price action 状态。"""
        while not self.stop_event.is_set():
            for instrument in self.bitget_instruments + self.longbridge_instruments:
                if self.stop_event.is_set():
                    break
                candles = tuple()
                thumbnail_candles = None
                try:
                    interval = getattr(instrument, "analysis_interval", None) or self.config.analysis.interval
                    candles = await asyncio.to_thread(
                        self._fetch_candles,
                        instrument,
                        interval=interval,
                        limit=self.config.analysis.lookback,
                    )
                    state = self._analyze_fresh_candles(candles)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    state = PriceActionState.unavailable(str(exc) or exc.__class__.__name__)
                    interval = getattr(instrument, "analysis_interval", None) or self.config.analysis.interval

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
                    "state": state,
                    "candles": candles if state.is_available() else tuple(),
                }
                if thumbnail_candles is not None:
                    payload["thumbnail_candles"] = thumbnail_candles
                self.event_queue.put(
                    FeedEvent(
                        "price_action",
                        payload,
                    )
                )

            try:
                await asyncio.sleep(self.config.analysis.poll_interval_seconds)
            except asyncio.CancelledError:
                break

    def _analyze_fresh_candles(self, candles) -> PriceActionState:
        """说明：只在最新 K 线仍新鲜时执行 price action 分析。"""
        if not candles:
            return PriceActionState.unavailable("No candles returned.")
        latest_open_ms = max(candle.open_time_ms for candle in candles)
        latest_open_at = datetime.fromtimestamp(latest_open_ms / 1000, tz=timezone.utc)
        candle_age = (datetime.now(timezone.utc) - latest_open_at).total_seconds()
        if candle_age > self.config.analysis.stale_after_seconds:
            return PriceActionState.unavailable("Candle data is stale.")
        return analyze_price_action(candles)

    def _fetch_candles(
        self,
        instrument: MarketInstrument,
        *,
        interval: str,
        limit: int,
        minimum_retention_seconds: int | None = None,
    ):
        """说明：通过缓存或 provider 拉取近期 K 线。"""
        if self.candle_cache is not None:
            try:
                return cached_fetch_candles(
                    cache=self.candle_cache,
                    symbol_key=instrument.key,
                    interval=interval,
                    limit=limit,
                    fetcher=lambda **kwargs: self._fetch_provider_candles(instrument, **kwargs),
                    minimum_retention_seconds=minimum_retention_seconds,
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
        )

    @staticmethod
    def _fetch_provider_candles(
        instrument: MarketInstrument,
        *,
        interval: str,
        limit: int,
        after_open_time_ms: int | None = None,
    ):
        """说明：绕过缓存直接从 provider 拉取近期 K 线。"""
        if isinstance(instrument, BitgetInstrument):
            return fetch_bitget_candles(
                instrument,
                interval=interval,
                limit=limit,
                after_open_time_ms=after_open_time_ms,
            )
        if isinstance(instrument, LongbridgeInstrument):
            return fetch_longbridge_candles(
                instrument,
                interval=interval,
                limit=limit,
                after_open_time_ms=after_open_time_ms,
            )
        raise ValueError(f"unsupported candle provider: {instrument!r}")

    def _handle_message(self, payload: dict[str, Any]) -> None:
        """说明：把一条 Bitget WebSocket 消息转发到事件队列。"""
        self.event_queue.put(FeedEvent("quote", payload))
