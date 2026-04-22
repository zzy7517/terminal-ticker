from __future__ import annotations

import argparse
import asyncio
import queue
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PySide6.QtCore import QPoint, QTimer, Qt
from PySide6.QtGui import QColor, QFont, QFontDatabase
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

from .bitget import BitgetPublicWebSocket, BitgetInstrument, fetch_snapshot_payloads, resolve_instruments
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
                self.event_queue.put(FeedEvent("status", ("connecting", "opening Bitget public websocket")))
                snapshots = await asyncio.to_thread(fetch_snapshot_payloads, self.instruments)
                self.event_queue.put(FeedEvent("snapshot", snapshots))

                self.socket = BitgetPublicWebSocket(self.instruments)
                self.event_queue.put(
                    FeedEvent(
                        "status",
                        ("subscribed", f"watching {len(self.instruments)} Bitget instruments"),
                    )
                )
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
    def __init__(self, symbol: str) -> None:
        super().__init__()
        self.symbol = symbol
        self.setObjectName("quoteRow")
        self.setFixedHeight(34)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(10, 4, 10, 4)
        layout.setSpacing(8)

        self.symbol_label = QLabel(symbol)
        self.symbol_label.setObjectName("symbolLabel")
        self.symbol_label.setMinimumWidth(44)

        self.price_label = QLabel("--")
        self.price_label.setObjectName("priceLabel")
        self.price_label.setMinimumWidth(78)
        self.price_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)

        self.change_label = QLabel("--")
        self.change_label.setObjectName("changeLabel")
        self.change_label.setMinimumWidth(66)
        self.change_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)

        self.percent_label = QLabel("--")
        self.percent_label.setObjectName("percentLabel")
        self.percent_label.setMinimumWidth(58)
        self.percent_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)

        self.age_label = QLabel("waiting")
        self.age_label.setObjectName("ageLabel")
        self.age_label.setMinimumWidth(52)
        self.age_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)

        layout.addWidget(self.symbol_label)
        layout.addWidget(self.price_label, 1)
        layout.addWidget(self.change_label)
        layout.addWidget(self.percent_label)
        layout.addWidget(self.age_label)

    def update_quote(self, quote: QuoteState) -> None:
        self.symbol_label.setText(quote.symbol)
        self.price_label.setText(quote.price_label())
        self.change_label.setText(quote.change_label())
        self.percent_label.setText(quote.percent_label())
        self.age_label.setText(quote.age_label())

        positive = QColor("#8ad66f")
        negative = QColor("#ff5c8a")
        muted = QColor("#9aa4bf")

        change_color = muted
        if quote.change is not None:
            if quote.change > 0:
                change_color = positive
            elif quote.change < 0:
                change_color = negative

        for label in (self.change_label, self.percent_label):
            label.setStyleSheet(f"color: {change_color.name()};")

        if quote.is_stale(20):
            stale_color = "#7d8597"
            self.price_label.setStyleSheet(f"color: {stale_color};")
            self.age_label.setStyleSheet(f"color: {stale_color};")
        else:
            self.price_label.setStyleSheet("color: #f7f9ff;")
            self.age_label.setStyleSheet("color: #8a93ab;")


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
        self.status_detail = "waiting to connect"
        self.last_message_at: datetime | None = None
        self.drag_origin: QPoint | None = None

        self._build_window()
        self._start_timers()
        self.feed_worker.start()

    def _build_window(self) -> None:
        self.setWindowTitle(self.config.title)
        self.setWindowFlags(
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setMinimumWidth(430)
        self.resize(450, 244)

        shell = QFrame(self)
        shell.setObjectName("shell")
        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(26)
        shadow.setOffset(0, 10)
        shadow.setColor(QColor(0, 0, 0, 110))
        shell.setGraphicsEffect(shadow)

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.addWidget(shell)

        shell_layout = QVBoxLayout(shell)
        shell_layout.setContentsMargins(0, 0, 0, 0)
        shell_layout.setSpacing(0)

        self.title_bar = QFrame()
        self.title_bar.setObjectName("titleBar")
        title_layout = QHBoxLayout(self.title_bar)
        title_layout.setContentsMargins(12, 8, 10, 8)
        title_layout.setSpacing(8)

        self.status_dot = QLabel("●")
        self.status_dot.setObjectName("statusDot")
        self.status_dot.setFixedWidth(12)

        title_label = QLabel(self.config.title)
        title_label.setObjectName("titleLabel")

        self.last_label = QLabel("waiting")
        self.last_label.setObjectName("lastLabel")

        close_button = QPushButton("×")
        close_button.setObjectName("closeButton")
        close_button.setFixedSize(20, 20)
        close_button.clicked.connect(self.close)

        title_layout.addWidget(self.status_dot)
        title_layout.addWidget(title_label)
        title_layout.addStretch(1)
        title_layout.addWidget(self.last_label)
        title_layout.addWidget(close_button)
        shell_layout.addWidget(self.title_bar)

        header = QFrame()
        header.setObjectName("headerRow")
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(10, 6, 10, 6)
        header_layout.setSpacing(8)
        header_layout.addWidget(self._header_label("Asset", 44))
        header_layout.addWidget(self._header_label("Price", 78, Qt.AlignRight))
        header_layout.addWidget(self._header_label("24h", 66, Qt.AlignRight))
        header_layout.addWidget(self._header_label("24h %", 58, Qt.AlignRight))
        header_layout.addWidget(self._header_label("Age", 52, Qt.AlignRight))
        shell_layout.addWidget(header)

        rows_container = QFrame()
        rows_layout = QVBoxLayout(rows_container)
        rows_layout.setContentsMargins(0, 0, 0, 0)
        rows_layout.setSpacing(0)
        self.rows: dict[str, QuoteRow] = {}
        for instrument in self.instruments:
            row = QuoteRow(instrument.label)
            rows_layout.addWidget(row)
            self.rows[instrument.key] = row
        shell_layout.addWidget(rows_container)

        self.status_bar = QLabel("stream=idle")
        self.status_bar.setObjectName("statusBar")
        self.status_bar.setAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        self.status_bar.setContentsMargins(12, 8, 12, 10)
        shell_layout.addWidget(self.status_bar)

        mono = QFont("Menlo")
        if mono.family() != "Menlo":
            mono = QFontDatabase.systemFont(QFontDatabase.FixedFont)
        mono.setPointSize(11)
        self.setFont(mono)

        self.setStyleSheet(
            """
            QWidget { color: #f7f9ff; }
            #shell {
                background: rgba(9, 12, 20, 235);
                border: 1px solid rgba(87, 97, 129, 160);
                border-radius: 18px;
            }
            #titleBar {
                background: qlineargradient(
                    x1: 0, y1: 0, x2: 1, y2: 0,
                    stop: 0 rgba(24, 33, 84, 255),
                    stop: 1 rgba(10, 16, 42, 255)
                );
                border-top-left-radius: 18px;
                border-top-right-radius: 18px;
                border-bottom: 1px solid rgba(77, 91, 145, 140);
            }
            #titleLabel {
                font-size: 13px;
                font-weight: 600;
                letter-spacing: 0.6px;
            }
            #lastLabel {
                color: #9da7c1;
                font-size: 11px;
            }
            #closeButton {
                background: transparent;
                border: none;
                color: #b8c0d9;
                font-size: 16px;
            }
            #closeButton:hover { color: #ffffff; }
            #headerRow {
                background: rgba(16, 21, 38, 180);
                border-bottom: 1px solid rgba(59, 68, 97, 110);
            }
            #headerCell {
                color: #7f8aad;
                font-size: 10px;
                font-weight: 600;
                letter-spacing: 0.8px;
            }
            #quoteRow {
                background: transparent;
                border-bottom: 1px solid rgba(41, 48, 68, 90);
            }
            #symbolLabel {
                color: #e9ecf5;
                font-weight: 700;
                letter-spacing: 0.4px;
            }
            #priceLabel {
                color: #f7f9ff;
                font-weight: 600;
            }
            #ageLabel {
                color: #8a93ab;
            }
            #statusBar {
                color: #8a93ab;
                background: rgba(12, 16, 29, 180);
                border-bottom-left-radius: 18px;
                border-bottom-right-radius: 18px;
            }
            """
        )
        self._update_status_ui()
        self._refresh_rows()

    def _header_label(self, text: str, width: int, align: Qt.AlignmentFlag = Qt.AlignLeft) -> QLabel:
        label = QLabel(text)
        label.setObjectName("headerCell")
        label.setMinimumWidth(width)
        label.setAlignment(align | Qt.AlignVCenter)
        return label

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
                    self.quotes[key].apply_payload(payload)
                    self.last_message_at = datetime.now(timezone.utc)
                    self.stream_status = "live"
                    self.status_detail = "receiving Bitget ticks"
                    dirty = True
            elif event.kind == "snapshot":
                for key, payload in event.payload.items():
                    if key in self.quotes and self.quotes[key].update_count == 0:
                        self.quotes[key].apply_snapshot(payload)
                        dirty = True
            elif event.kind == "status":
                self.stream_status, self.status_detail = event.payload
                dirty = True
            elif event.kind == "error":
                detail = str(event.payload)
                self.stream_status = "retrying"
                self.status_detail = detail
                for quote in self.quotes.values():
                    quote.mark_error(detail)
                dirty = True

        if dirty:
            self._refresh_rows()
            self._update_status_ui()

    def _refresh_rows(self) -> None:
        for instrument in self.instruments:
            self.rows[instrument.key].update_quote(self.quotes[instrument.key])

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
            dot_color = "#8ad66f"
        elif self.stream_status in {"retrying", "snapshot-failed"}:
            dot_color = "#ff5c8a"
        self.status_dot.setStyleSheet(f"color: {dot_color};")

        self.last_label.setText(last_text)
        self.status_bar.setText(
            f"stream={self.stream_status}  last={last_text}  detail={self.status_detail}"
        )

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
    parser.add_argument(
        "--title",
        help="override the configured title",
    )
    return parser.parse_args()


def resolve_config(args: argparse.Namespace) -> AppConfig:
    file_config: AppConfig | None = None
    config_path = Path(args.config).expanduser()
    if config_path.exists():
        file_config = load_config(config_path)
    elif not args.symbols:
        raise ValueError(
            f"config file not found: {config_path}. Create it or pass --symbols."
        )
    return build_runtime_config(
        file_config,
        cli_symbols=args.symbols,
        cli_title=args.title,
    )


def main() -> int:
    args = parse_args()
    config = resolve_config(args)
    instruments = resolve_instruments(config.instruments)

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(True)

    window = FloatingTickerWindow(config, instruments)
    window.show()
    return app.exec()
