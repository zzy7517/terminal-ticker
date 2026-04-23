from __future__ import annotations

import argparse
import asyncio
import queue
import signal
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PySide6.QtCore import QPoint, QTimer, Qt
from PySide6.QtGui import QColor, QCursor, QFont, QFontDatabase
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .bitget import (
    BitgetInstrument,
    BitgetPublicWebSocket,
    fetch_snapshot_payloads,
    resolve_instruments,
)
from .config import AppConfig, build_runtime_config, load_config
from .models import QuoteState


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
                self.event_queue.put(FeedEvent("status", ("connecting", "opening Bitget websocket")))
                snapshots = await asyncio.to_thread(fetch_snapshot_payloads, self.instruments)
                self.event_queue.put(FeedEvent("snapshot", snapshots))

                self.socket = BitgetPublicWebSocket(self.instruments)
                self.event_queue.put(FeedEvent("status", ("subscribed", "watching symbols")))
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

        self.event_queue.put(FeedEvent("status", ("stopped", "stream stopped")))

    def _handle_message(self, payload: dict[str, Any]) -> None:
        self.event_queue.put(FeedEvent("quote", payload))


class QuoteRow(QFrame):
    def __init__(self, instrument: BitgetInstrument) -> None:
        super().__init__()
        self.instrument = instrument
        self.flash_until: datetime | None = None
        self.flash_direction = 0

        self.setObjectName("quoteRow")
        self.setFixedHeight(24)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(8, 2, 8, 2)
        layout.setSpacing(8)

        self.symbol_label = QLabel(instrument.label)
        self.symbol_label.setMinimumWidth(48)
        self.symbol_label.setStyleSheet(
            "color: #eef4ff; font-size: 12px; font-weight: 700; letter-spacing: 0.5px;"
        )

        self.price_label = QLabel("--")
        self.price_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self.price_label.setStyleSheet(
            "color: #f7fbff; font-size: 14px; font-weight: 700;"
        )

        layout.addWidget(self.symbol_label)
        layout.addStretch(1)
        layout.addWidget(self.price_label)

        self._apply_background("rgba(11, 16, 28, 176)", "rgba(37, 49, 77, 90)")

    def _apply_background(self, background: str, border: str) -> None:
        self.setStyleSheet(
            f"""
            QFrame#quoteRow {{
                background: {background};
                border: 1px solid {border};
                border-radius: 8px;
            }}
            """
        )

    def flash(self, direction: int) -> None:
        self.flash_until = datetime.now(timezone.utc)
        self.flash_direction = direction

    def update_quote(self, quote: QuoteState, *, stale_after_seconds: int) -> None:
        self.symbol_label.setText(quote.symbol)
        self.price_label.setText(quote.price_label())

        if quote.is_stale(stale_after_seconds):
            self.price_label.setStyleSheet("color: #7f8aa5; font-size: 14px; font-weight: 700;")
        else:
            self.price_label.setStyleSheet("color: #f7fbff; font-size: 14px; font-weight: 700;")

        now = datetime.now(timezone.utc)
        if self.flash_until is not None and (now - self.flash_until).total_seconds() < 0.45:
            if self.flash_direction > 0:
                self._apply_background("rgba(26, 56, 39, 218)", "rgba(118, 214, 150, 140)")
            elif self.flash_direction < 0:
                self._apply_background("rgba(74, 26, 38, 218)", "rgba(255, 108, 145, 135)")
        else:
            self._apply_background("rgba(11, 16, 28, 176)", "rgba(37, 49, 77, 90)")


class FloatingTickerWindow(QWidget):
    def __init__(self, config: AppConfig, instruments: tuple[BitgetInstrument, ...]) -> None:
        super().__init__()
        self.config = config
        self.instruments = instruments
        self.quotes = {
            instrument.key: QuoteState.placeholder(instrument.label)
            for instrument in instruments
        }
        self.event_queue: queue.Queue[FeedEvent] = queue.Queue()
        self.feed_worker = FeedWorker(
            config=config,
            instruments=instruments,
            event_queue=self.event_queue,
        )
        self.stream_status = "idle"
        self.last_message_at: datetime | None = None
        self.drag_origin: QPoint | None = None
        self.positioned_once = False
        self.rows: dict[str, QuoteRow] = {}

        self._build_window()
        self._start_timers()
        self.feed_worker.start()

    def _build_window(self) -> None:
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Window)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setMinimumWidth(248)
        self.resize(268, 176)

        shell = QFrame(self)
        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(18)
        shadow.setOffset(0, 6)
        shadow.setColor(QColor(0, 0, 0, 116))
        shell.setGraphicsEffect(shadow)

        root = QVBoxLayout(self)
        root.setContentsMargins(8, 8, 8, 8)
        root.addWidget(shell)

        shell_layout = QVBoxLayout(shell)
        shell_layout.setContentsMargins(0, 0, 0, 0)
        shell_layout.setSpacing(0)

        title_bar = QFrame()
        title_layout = QHBoxLayout(title_bar)
        title_layout.setContentsMargins(8, 6, 8, 6)
        title_layout.setSpacing(6)

        self.status_dot = QLabel("●")
        self.status_dot.setStyleSheet("font-size: 10px; color: #ffb84d;")

        self.last_label = QLabel("waiting")
        self.last_label.setStyleSheet("color: #8d99b2; font-size: 9px;")

        close_button = QPushButton("×")
        close_button.setFixedSize(16, 16)
        close_button.setStyleSheet(
            """
            QPushButton {
                background: transparent;
                border: none;
                color: #a8b6d1;
                font-size: 13px;
            }
            QPushButton:hover { color: #ffffff; }
            """
        )
        close_button.clicked.connect(self.close)

        title_layout.addWidget(self.status_dot)
        title_layout.addStretch(1)
        title_layout.addWidget(self.last_label)
        title_layout.addWidget(close_button)
        shell_layout.addWidget(title_bar)

        body = QFrame()
        body_layout = QVBoxLayout(body)
        body_layout.setContentsMargins(8, 6, 8, 8)
        body_layout.setSpacing(4)

        for instrument in self.instruments:
            row = QuoteRow(instrument)
            self.rows[instrument.key] = row
            body_layout.addWidget(row)

        shell_layout.addWidget(body)

        shell.setStyleSheet(
            """
            QFrame {
                background: rgba(7, 11, 18, 238);
                border: 1px solid rgba(65, 78, 112, 145);
                border-radius: 12px;
            }
            """
        )

        mono = QFont("Menlo")
        if mono.family() != "Menlo":
            mono = QFontDatabase.systemFont(QFontDatabase.FixedFont)
        mono.setPointSize(10)
        self.setFont(mono)

        self._refresh_rows()
        self._update_status_ui()

    def _start_timers(self) -> None:
        self.queue_timer = QTimer(self)
        self.queue_timer.timeout.connect(self._drain_events)
        self.queue_timer.start(90)

        self.clock_timer = QTimer(self)
        self.clock_timer.timeout.connect(self._tick_clock)
        self.clock_timer.start(max(150, self.config.display.refresh_interval_ms))

    def _tick_clock(self) -> None:
        self._refresh_rows()
        self._update_status_ui()

    def _drain_events(self) -> None:
        dirty = False
        while True:
            try:
                event = self.event_queue.get_nowait()
            except queue.Empty:
                break

            if event.kind == "quote":
                payload = event.payload
                key = str(payload.get("id") or "")
                if key in self.quotes:
                    quote = self.quotes[key]
                    previous_price = quote.price
                    quote.apply_payload(payload)
                    if previous_price is not None and quote.price is not None:
                        direction = 1 if quote.price > previous_price else -1 if quote.price < previous_price else 0
                        if direction != 0:
                            self.rows[key].flash(direction)
                    self.last_message_at = datetime.now(timezone.utc)
                    self.stream_status = "live"
                    dirty = True
            elif event.kind == "snapshot":
                for key, payload in event.payload.items():
                    if key in self.quotes and self.quotes[key].update_count == 0:
                        self.quotes[key].apply_snapshot(payload)
                        dirty = True
            elif event.kind == "status":
                self.stream_status, _detail = event.payload
                dirty = True
            elif event.kind == "error":
                self.stream_status = "retrying"
                dirty = True

        if dirty:
            self._refresh_rows()
            self._update_status_ui()

    def _refresh_rows(self) -> None:
        for instrument in self.instruments:
            self.rows[instrument.key].update_quote(
                self.quotes[instrument.key],
                stale_after_seconds=self.config.display.stale_after_seconds,
            )

        target_height = 30 + len(self.instruments) * 28 + 16
        self.resize(self.width(), max(92, min(target_height, 230)))

    def _update_status_ui(self) -> None:
        if self.last_message_at is None:
            last_text = "waiting"
        else:
            elapsed_ms = int((datetime.now(timezone.utc) - self.last_message_at).total_seconds() * 1000)
            if elapsed_ms < 1000:
                last_text = f"{elapsed_ms}ms"
            elif elapsed_ms < 10_000:
                last_text = f"{elapsed_ms / 1000:.1f}s"
            else:
                last_text = f"{elapsed_ms // 1000}s"

        dot_color = "#ffb84d"
        if self.stream_status == "live":
            dot_color = "#7fffb7"
        elif self.stream_status in {"retrying", "snapshot-failed"}:
            dot_color = "#ff6c91"

        self.status_dot.setStyleSheet(f"font-size: 10px; color: {dot_color};")
        self.last_label.setText(last_text)

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self.drag_origin = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event) -> None:
        if self.drag_origin is not None and event.buttons() & Qt.LeftButton:
            self.move(event.globalPosition().toPoint() - self.drag_origin)
            event.accept()

    def mouseReleaseEvent(self, event) -> None:
        self.drag_origin = None
        event.accept()

    def closeEvent(self, event) -> None:
        self.feed_worker.stop()
        self.feed_worker.join(timeout=2)
        super().closeEvent(event)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        if not self.positioned_once:
            self.positioned_once = True
            QTimer.singleShot(0, self._position_on_active_screen)

    def _position_on_active_screen(self) -> None:
        app = QApplication.instance()
        if app is None:
            return
        screen = app.screenAt(QCursor.pos()) or app.primaryScreen()
        if screen is None:
            return
        area = screen.availableGeometry()
        self.move(area.x() + area.width() - self.width() - 24, area.y() + 24)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="terminal_ticker",
        description="Compact floating Bitget ticker window",
    )
    parser.add_argument(
        "--config",
        default="watchlist.toml",
        help="path to a TOML watchlist config (default: watchlist.toml)",
    )
    parser.add_argument(
        "--symbols",
        nargs="+",
        help="override the config and watch Bitget symbols, e.g. USDT-FUTURES:BTCUSDT",
    )
    return parser.parse_args()


def resolve_config(args: argparse.Namespace) -> AppConfig:
    file_config: AppConfig | None = None
    config_path = Path(args.config).expanduser()
    if config_path.exists():
        file_config = load_config(config_path)
    elif not args.symbols:
        raise ValueError(f"config file not found: {config_path}. Create it or pass --symbols.")
    return build_runtime_config(
        file_config,
        cli_symbols=args.symbols,
    )


def main() -> int:
    args = parse_args()
    config = resolve_config(args)
    instruments = resolve_instruments(config.instruments)

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(True)

    window = FloatingTickerWindow(config, instruments)

    def _request_quit(*_args) -> None:
        window.close()
        app.quit()

    signal.signal(signal.SIGINT, _request_quit)
    signal.signal(signal.SIGTERM, _request_quit)

    window.show()
    window.raise_()
    window.activateWindow()
    return app.exec()
