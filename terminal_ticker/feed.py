from __future__ import annotations

import asyncio
import queue
import threading
from dataclasses import dataclass
from typing import Any

from .bitget import BitgetInstrument, BitgetPublicWebSocket, fetch_snapshot_payloads
from .config import AppConfig


@dataclass(frozen=True)
class FeedEvent:
    kind: str
    payload: Any


class FeedWorker(threading.Thread):
    def __init__(
        self,
        *,
        config: AppConfig,
        instruments: tuple[BitgetInstrument, ...],
        event_queue: queue.Queue[FeedEvent],
    ) -> None:
        super().__init__(daemon=True)
        self.config = config
        self.instruments = instruments
        self.event_queue = event_queue
        self.stop_event = threading.Event()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.socket: BitgetPublicWebSocket | None = None
        self.listen_task: asyncio.Task[None] | None = None

    def run(self) -> None:
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
        self.stop_event.set()
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self._request_shutdown)

    def _request_shutdown(self) -> None:
        if self.listen_task is not None:
            self.listen_task.cancel()
        if self.socket is not None:
            asyncio.create_task(self.socket.close())

    async def _run(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.event_queue.put(FeedEvent("status", "connecting"))
                snapshots = await asyncio.to_thread(fetch_snapshot_payloads, self.instruments)
                self.event_queue.put(FeedEvent("snapshot", snapshots))

                self.socket = BitgetPublicWebSocket(self.instruments)
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

        self.event_queue.put(FeedEvent("status", "stopped"))

    def _handle_message(self, payload: dict[str, Any]) -> None:
        self.event_queue.put(FeedEvent("quote", payload))
