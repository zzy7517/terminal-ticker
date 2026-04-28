"""Run provider feeds in a background thread and emit normalized events."""
from __future__ import annotations

import asyncio
import queue
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .bitget import (
    BitgetInstrument,
    BitgetPublicWebSocket,
    fetch_candles as fetch_bitget_candles,
    fetch_snapshot_payloads,
)
from .config import AppConfig
from .longbridge_provider import (
    LongbridgeInstrument,
    fetch_candles as fetch_longbridge_candles,
    fetch_quote_payloads,
)
from .price_action import PriceActionState, analyze_price_action
from .providers import MarketInstrument


@dataclass(frozen=True)
class FeedEvent:
    """Carry one normalized feed event from worker threads into the controller."""
    kind: str
    payload: Any


class FeedWorker(threading.Thread):
    """Run Bitget streaming and Longbridge polling in a daemon thread."""
    def __init__(
        self,
        *,
        config: AppConfig,
        instruments: tuple[MarketInstrument, ...],
        event_queue: queue.Queue[FeedEvent],
    ) -> None:
        """Split resolved instruments by provider and prepare async worker state."""
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
        self.stop_event = threading.Event()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.socket: BitgetPublicWebSocket | None = None
        self.listen_task: asyncio.Task[None] | None = None
        self.tasks: list[asyncio.Task[None]] = []

    def run(self) -> None:
        """Create an event loop and run provider tasks until shutdown."""
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
        """Signal the worker loop to cancel provider tasks."""
        self.stop_event.set()
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self._request_shutdown)

    def _request_shutdown(self) -> None:
        """Cancel active asyncio tasks and close the Bitget socket."""
        for task in self.tasks:
            task.cancel()
        if self.listen_task is not None:
            self.listen_task.cancel()
        if self.socket is not None:
            asyncio.create_task(self.socket.close())

    async def _run(self) -> None:
        # Bitget streams and Longbridge polling run independently but share one event queue.
        """Start provider tasks and emit a final stopped status."""
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
        """Maintain the Bitget snapshot and websocket loop with reconnects."""
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
        """Poll Longbridge quote REST data on the configured interval."""
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
        """Poll provider candles and emit derived price action state."""
        while not self.stop_event.is_set():
            for instrument in self.bitget_instruments + self.longbridge_instruments:
                if self.stop_event.is_set():
                    break
                candles = tuple()
                try:
                    candles = await asyncio.to_thread(
                        self._fetch_candles,
                        instrument,
                        interval=self.config.analysis.interval,
                        limit=self.config.analysis.lookback,
                    )
                    state = self._analyze_fresh_candles(candles)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    state = PriceActionState.unavailable(str(exc) or exc.__class__.__name__)
                self.event_queue.put(
                    FeedEvent(
                        "price_action",
                        {
                            "id": instrument.key,
                            "state": state,
                            "candles": candles if state.is_available() else tuple(),
                        },
                    )
                )

            try:
                await asyncio.sleep(self.config.analysis.poll_interval_seconds)
            except asyncio.CancelledError:
                break

    def _analyze_fresh_candles(self, candles) -> PriceActionState:
        """Analyze candles only when the latest candle itself is fresh."""
        if not candles:
            return PriceActionState.unavailable("No candles returned.")
        latest_open_ms = max(candle.open_time_ms for candle in candles)
        latest_open_at = datetime.fromtimestamp(latest_open_ms / 1000, tz=timezone.utc)
        candle_age = (datetime.now(timezone.utc) - latest_open_at).total_seconds()
        if candle_age > self.config.analysis.stale_after_seconds:
            return PriceActionState.unavailable("Candle data is stale.")
        return analyze_price_action(candles)

    @staticmethod
    def _fetch_candles(
        instrument: MarketInstrument,
        *,
        interval: str,
        limit: int,
    ):
        """Fetch recent candles for the instrument's provider."""
        if isinstance(instrument, BitgetInstrument):
            return fetch_bitget_candles(instrument, interval=interval, limit=limit)
        if isinstance(instrument, LongbridgeInstrument):
            return fetch_longbridge_candles(instrument, interval=interval, limit=limit)
        raise ValueError(f"unsupported candle provider: {instrument!r}")

    def _handle_message(self, payload: dict[str, Any]) -> None:
        """Forward one Bitget websocket payload into the event queue."""
        self.event_queue.put(FeedEvent("quote", payload))
