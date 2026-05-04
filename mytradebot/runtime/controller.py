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
from ..domain.price_action import merge_candles
from ..market_data.router import MarketInstrument
from ..trading.paper_broker import FillEvent, PaperBroker

FILL_INTERVAL = "1m"


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
        paper_broker: PaperBroker | None = None,
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
        self.paper_broker = paper_broker
        self.recent_fill_events: list[FillEvent] = []
        self._last_fill_candle_time_ms: dict[str, int] = {}

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

    def fetch_older_candles(
        self,
        instrument: MarketInstrument,
        *,
        interval: str,
        before_open_time_ms: int | None,
        limit: int,
    ):
        """说明：同步拉取一批更早的历史 K 线。"""
        return self.feed_worker.fetch_older_candles(
            instrument,
            interval=interval,
            before_open_time_ms=before_open_time_ms,
            limit=limit,
        )

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
            incoming_candles = tuple(payload.get("candles", tuple()))
            multi_tf_raw = payload.get("multi_timeframe_candles") or {}
            self.quotes[key].apply_candles(
                candles=merge_candles(self.quotes[key].candles, incoming_candles)
                if incoming_candles
                else tuple(),
                thumbnail_candles=tuple(payload["thumbnail_candles"])
                if "thumbnail_candles" in payload
                else None,
                multi_timeframe_candles={
                    interval: tuple(candles)
                    for interval, candles in multi_tf_raw.items()
                }
                if "multi_timeframe_candles" in payload
                else None,
            )
            if payload.get("error"):
                self.quotes[key].mark_error(str(payload["error"]))
            self._drive_paper_broker(key, multi_tf_raw, incoming_candles)
            return True

        return False

    def _drive_paper_broker(
        self,
        instrument_key: str,
        multi_timeframe_candles: dict[str, Any],
        primary_candles: tuple,
    ) -> None:
        """说明：把新的 1m K 线喂给 PaperBroker 做撮合。"""
        broker = self.paper_broker
        if broker is None:
            return
        fill_bars = multi_timeframe_candles.get(FILL_INTERVAL)
        if not fill_bars and primary_candles:
            primary_interval = getattr(self.config.analysis, "interval", None)
            if primary_interval == FILL_INTERVAL:
                fill_bars = primary_candles
        if not fill_bars:
            return
        last_seen = self._last_fill_candle_time_ms.get(instrument_key)
        fresh = [c for c in fill_bars if last_seen is None or c.open_time_ms > last_seen]
        if not fresh:
            return
        try:
            events = broker.process_candles(fresh)
        except Exception:
            # 撮合失败不应让行情流挂掉。
            import logging
            logging.getLogger(__name__).exception("paper broker failed on %s", instrument_key)
            return
        self._last_fill_candle_time_ms[instrument_key] = max(c.open_time_ms for c in fresh)
        if events:
            self.recent_fill_events.extend(events)

    def consume_fill_events(self) -> tuple[FillEvent, ...]:
        """说明：取出并清空 broker 自上次读取以来产生的 fill 事件。"""
        events = tuple(self.recent_fill_events)
        self.recent_fill_events.clear()
        return events

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
