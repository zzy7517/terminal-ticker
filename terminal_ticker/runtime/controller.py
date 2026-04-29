"""文件用途：运行时层，消费 feed 事件并维护内存报价状态。"""
from __future__ import annotations

import queue
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from ..config import AppConfig
from .feed import FeedEvent, FeedWorker
from ..domain.quotes import QuoteState
from ..market_data.router import MarketInstrument


@dataclass(frozen=True)
class DrainResult:
    """说明：封装事件队列消费后的状态变更结果。"""
    dirty: bool
    flash_directions: dict[str, int]


class TickerController:
    """说明：维护报价状态并协调后台 feed worker。"""
    def __init__(
        self,
        *,
        config: AppConfig,
        instruments: tuple[MarketInstrument, ...],
        worker_factory: Callable[..., Any] = FeedWorker,
    ) -> None:
        """说明：初始化当前对象的运行状态。"""
        self.config = config
        self.instruments = instruments
        self.quotes = {
            instrument.key: QuoteState.placeholder(instrument.label)
            for instrument in instruments
        }
        self.stream_status = "idle"
        self.last_message_at: datetime | None = None
        self.event_queue: queue.Queue[FeedEvent] = queue.Queue()
        self.feed_worker = worker_factory(
            config=config,
            instruments=instruments,
            event_queue=self.event_queue,
        )

    def start(self) -> None:
        """说明：启动后台运行时组件。"""
        self.feed_worker.start()

    def stop(self) -> None:
        """说明：停止后台运行时组件并释放连接。"""
        stop = getattr(self.feed_worker, "stop", None)
        if callable(stop):
            stop()
        join = getattr(self.feed_worker, "join", None)
        if callable(join):
            try:
                join(timeout=2)
            except RuntimeError:
                pass

    def drain_events(self) -> DrainResult:
        """说明：消费所有排队事件并收集行闪动方向。"""
        dirty = False
        flash_directions: dict[str, int] = {}
        while True:
            try:
                event = self.event_queue.get_nowait()
            except queue.Empty:
                break
            dirty = self._apply_event(event, flash_directions) or dirty
        return DrainResult(dirty=dirty, flash_directions=flash_directions)

    def _apply_event(self, event: FeedEvent, flash_directions: dict[str, int]) -> bool:
        """说明：把一条 feed 事件应用到报价状态和流状态。"""
        if event.kind == "quote":
            payload = event.payload
            key = str(payload.get("id") or "")
            if key not in self.quotes:
                return False
            quote = self.quotes[key]
            previous_price = quote.price
            quote.apply_payload(payload)
            direction = self._flash_direction(previous_price, quote.price)
            if direction != 0:
                flash_directions[key] = direction
            self.last_message_at = datetime.now(timezone.utc)
            self.stream_status = "live"
            return True

        if event.kind == "snapshot":
            dirty = False
            for key, payload in event.payload.items():
                if key in self.quotes and self.quotes[key].update_count == 0:
                    self.quotes[key].apply_snapshot(payload)
                    dirty = True
            return dirty

        if event.kind == "status":
            self.stream_status = str(event.payload)
            return True

        if event.kind == "error":
            self.stream_status = "retrying"
            payload = event.payload
            if isinstance(payload, dict):
                detail = str(payload.get("message") or "")
                ids = payload.get("ids")
                if detail and isinstance(ids, list):
                    for key in ids:
                        quote = self.quotes.get(str(key))
                        if quote is not None:
                            quote.mark_error(detail)
            return True

        if event.kind == "candles":
            payload = event.payload
            key = str(payload.get("id") or "")
            if key not in self.quotes:
                return False
            self.quotes[key].apply_candles(
                candles=tuple(payload.get("candles", tuple())),
                thumbnail_candles=tuple(payload["thumbnail_candles"])
                if "thumbnail_candles" in payload
                else None,
            )
            if payload.get("error"):
                self.quotes[key].mark_error(str(payload["error"]))
            return True

        return False

    @staticmethod
    def _flash_direction(previous_price: float | None, current_price: float | None) -> int:
        """说明：比较两次价格并返回行闪动方向。"""
        if previous_price is None or current_price is None:
            return 0
        if current_price > previous_price:
            return 1
        if current_price < previous_price:
            return -1
        return 0
