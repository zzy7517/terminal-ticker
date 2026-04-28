"""Run provider feeds in a background thread and emit normalized events."""
from __future__ import annotations

import asyncio
import queue
import threading
from dataclasses import dataclass
from typing import Any

from .bitget import BitgetInstrument, BitgetPublicWebSocket, fetch_snapshot_payloads
from .config import AppConfig
from .longbridge_provider import LongbridgeInstrument, fetch_quote_payloads
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

    def _handle_message(self, payload: dict[str, Any]) -> None:
        """Forward one Bitget websocket payload into the event queue."""
        self.event_queue.put(FeedEvent("quote", payload))
