from __future__ import annotations

import queue
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .bitget import BitgetInstrument
from .config import AppConfig
from .feed import FeedEvent, FeedWorker
from .models import QuoteState


@dataclass(frozen=True)
class DrainResult:
    dirty: bool
    flash_directions: dict[str, int]


class TickerController:
    def __init__(
        self,
        *,
        config: AppConfig,
        instruments: tuple[BitgetInstrument, ...],
        worker_factory: Callable[..., Any] = FeedWorker,
    ) -> None:
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
        self.feed_worker.start()

    def stop(self) -> None:
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
            return True

        return False

    @staticmethod
    def _flash_direction(previous_price: float | None, current_price: float | None) -> int:
        if previous_price is None or current_price is None:
            return 0
        if current_price > previous_price:
            return 1
        if current_price < previous_price:
            return -1
        return 0
