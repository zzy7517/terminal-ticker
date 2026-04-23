from __future__ import annotations

from datetime import datetime, timezone

from PySide6.QtCore import QPoint, QRect, QTimer, Qt
from PySide6.QtGui import QColor, QCursor, QFont, QFontDatabase, QFontMetrics, QPainter
from PySide6.QtWidgets import (
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .bitget import BitgetInstrument
from .config import AppConfig
from .controller import TickerController
from .models import QuoteState

HEADER_HEIGHT = 30
ROW_HEIGHT = 24
PANEL_WIDTH = 268
PANEL_MAX_HEIGHT = 230
MARQUEE_GAP = 28
TICKER_TAPE_HEIGHT = 22
TICKER_TEXT_VERTICAL_NUDGE = -2
TICKER_SEPARATOR = "•"


def build_ticker_items(
    instruments: tuple[BitgetInstrument, ...],
    quotes: dict[str, QuoteState],
) -> list[str]:
    parts: list[str] = []
    for instrument in instruments:
        quote = quotes[instrument.key]
        parts.append(f"{instrument.label} {quote.price_label()}")
    return parts


class TickerTape(QFrame):
    def __init__(self, on_activate) -> None:
        super().__init__()
        self.on_activate = on_activate
        self.items = ["waiting"]
        self.offset = 0.0
        self.speed = 0.38
        self.item_widths: list[int] = []
        self.separator_width = 0
        self.setFixedHeight(TICKER_TAPE_HEIGHT)

    def _recalculate_metrics(self) -> None:
        metrics = QFontMetrics(self.font())
        self.item_widths = [metrics.horizontalAdvance(item) for item in self.items]
        self.separator_width = metrics.horizontalAdvance(f"  {TICKER_SEPARATOR}  ")

    def _cycle_width(self) -> int:
        if not self.item_widths:
            return 0
        content_width = sum(self.item_widths)
        if len(self.item_widths) > 1:
            content_width += self.separator_width * (len(self.item_widths) - 1)
        return content_width + MARQUEE_GAP

    def set_items(self, items: list[str]) -> None:
        normalized = items or ["waiting"]
        if normalized == self.items:
            return
        previous_cycle_width = self._cycle_width()
        self.items = normalized
        self._recalculate_metrics()
        new_cycle_width = self._cycle_width()
        if new_cycle_width <= self.width():
            self.offset = 0.0
        elif previous_cycle_width > 0:
            self.offset = self.offset % new_cycle_width
        else:
            self.offset = 0.0
        self.update()

    def advance(self) -> None:
        cycle_width = self._cycle_width()
        if cycle_width <= self.width():
            self.offset = 0
            self.update()
            return
        self.offset += self.speed
        if self.offset >= cycle_width:
            self.offset = 0
        self.update()

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.LeftButton and self.on_activate is not None:
            self.on_activate()
        super().mousePressEvent(event)

    def paintEvent(self, _event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.TextAntialiasing)
        painter.setFont(self.font())
        painter.setPen(QColor("#dce7ff"))

        if not self.items:
            return

        cycle_width = self._cycle_width()
        if cycle_width <= self.width():
            painter.drawText(
                self.rect().adjusted(8, TICKER_TEXT_VERTICAL_NUDGE, -8, 0),
                int(Qt.AlignLeft | Qt.AlignVCenter),
                f"  {TICKER_SEPARATOR}  ".join(self.items),
            )
            return

        x = -int(self.offset) + 8
        while x < self.width():
            draw_x = x
            for index, item in enumerate(self.items):
                painter.drawText(
                    QRect(draw_x, TICKER_TEXT_VERTICAL_NUDGE, self.item_widths[index], self.height()),
                    int(Qt.AlignLeft | Qt.AlignVCenter),
                    item,
                )
                draw_x += self.item_widths[index]
                if index < len(self.items) - 1:
                    painter.drawText(
                        QRect(draw_x, TICKER_TEXT_VERTICAL_NUDGE, self.separator_width, self.height()),
                        int(Qt.AlignLeft | Qt.AlignVCenter),
                        f"  {TICKER_SEPARATOR}  ",
                    )
                    draw_x += self.separator_width
            x += cycle_width


class QuoteRow(QFrame):
    def __init__(self, instrument: BitgetInstrument) -> None:
        super().__init__()
        self.instrument = instrument
        self.flash_direction = 0
        self.flash_frames_remaining = 0
        self.setObjectName("quoteRow")
        self.setFixedHeight(ROW_HEIGHT)

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
        self.flash_direction = direction
        self.flash_frames_remaining = 5

    def update_quote(self, quote: QuoteState, *, stale_after_seconds: int) -> None:
        self.symbol_label.setText(quote.symbol)
        self.price_label.setText(quote.price_label())

        if quote.is_stale(stale_after_seconds):
            self.price_label.setStyleSheet("color: #7f8aa5; font-size: 14px; font-weight: 700;")
        else:
            self.price_label.setStyleSheet("color: #f7fbff; font-size: 14px; font-weight: 700;")

        if self.flash_frames_remaining > 0:
            if self.flash_direction > 0:
                self._apply_background("rgba(26, 56, 39, 218)", "rgba(118, 214, 150, 140)")
            elif self.flash_direction < 0:
                self._apply_background("rgba(74, 26, 38, 218)", "rgba(255, 108, 145, 135)")
            self.flash_frames_remaining -= 1
        else:
            self._apply_background("rgba(11, 16, 28, 176)", "rgba(37, 49, 77, 90)")


class FloatingTickerWindow(QWidget):
    def __init__(
        self,
        config: AppConfig,
        instruments: tuple[BitgetInstrument, ...],
        *,
        controller: TickerController | None = None,
        auto_start: bool = True,
    ) -> None:
        super().__init__()
        self.config = config
        self.instruments = instruments
        self.controller = controller or TickerController(
            config=config,
            instruments=instruments,
        )
        self.drag_origin: QPoint | None = None
        self.positioned_once = False
        self.collapsed = False
        self.rows: dict[str, QuoteRow] = {}

        self._build_window()
        self._start_timers()
        if auto_start:
            self.controller.start()

    def _build_window(self) -> None:
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Window)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setMinimumWidth(PANEL_WIDTH)
        self.resize(PANEL_WIDTH, 176)

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

        self.header = QFrame()
        header_layout = QHBoxLayout(self.header)
        header_layout.setContentsMargins(6, 4, 6, 4)
        header_layout.setSpacing(6)

        self.status_dot = QLabel("●")
        self.status_dot.setStyleSheet("font-size: 10px; color: #ffb84d;")

        self.ticker_tape = TickerTape(self._expand)
        self.ticker_tape.setStyleSheet("background: transparent; border: none;")

        self.info_label = QLabel("waiting")
        self.info_label.setStyleSheet("color: #8d99b2; font-size: 9px;")
        self.info_label.setAlignment(Qt.AlignLeft | Qt.AlignVCenter)

        self.toggle_button = QPushButton("–")
        self.toggle_button.setFixedSize(16, 16)
        self.toggle_button.clicked.connect(self._toggle_collapsed)
        self.toggle_button.setStyleSheet(
            """
            QPushButton {
                background: transparent;
                border: none;
                color: #a8b6d1;
                font-size: 13px;
                font-weight: 700;
            }
            QPushButton:hover { color: #ffffff; }
            """
        )

        close_button = QPushButton("×")
        close_button.setFixedSize(16, 16)
        close_button.clicked.connect(self.close)
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

        header_layout.addWidget(self.status_dot)
        header_layout.addWidget(self.ticker_tape, 1)
        header_layout.addWidget(self.info_label, 1)
        header_layout.addWidget(self.toggle_button)
        header_layout.addWidget(close_button)
        shell_layout.addWidget(self.header)

        self.body = QFrame()
        body_layout = QVBoxLayout(self.body)
        body_layout.setContentsMargins(8, 6, 8, 8)
        body_layout.setSpacing(4)

        for instrument in self.instruments:
            row = QuoteRow(instrument)
            self.rows[instrument.key] = row
            body_layout.addWidget(row)

        shell_layout.addWidget(self.body)

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
        self.ticker_tape.setFont(mono)

        self._refresh_rows()
        self._update_status_ui()
        self._update_ticker_text()
        self._apply_collapsed_state()

    def _start_timers(self) -> None:
        self.queue_timer = QTimer(self)
        self.queue_timer.timeout.connect(self._drain_events)
        self.queue_timer.start(90)

        self.clock_timer = QTimer(self)
        self.clock_timer.timeout.connect(self._tick_clock)
        self.clock_timer.start(max(150, self.config.display.refresh_interval_ms))

        self.marquee_timer = QTimer(self)
        self.marquee_timer.timeout.connect(self.ticker_tape.advance)
        self.marquee_timer.start(28)

    def _tick_clock(self) -> None:
        self._refresh_rows()
        self._update_status_ui()
        self._update_ticker_text()

    def _toggle_collapsed(self) -> None:
        self.collapsed = not self.collapsed
        self._apply_collapsed_state()

    def _expand(self) -> None:
        if self.collapsed:
            self.collapsed = False
            self._apply_collapsed_state()

    def _apply_collapsed_state(self) -> None:
        self.body.setVisible(not self.collapsed)
        self.toggle_button.setText("+" if self.collapsed else "–")
        self.ticker_tape.setVisible(self.collapsed)
        self.info_label.setVisible(not self.collapsed)
        if self.collapsed:
            target_height = HEADER_HEIGHT + 12
        else:
            target_height = HEADER_HEIGHT + len(self.instruments) * (ROW_HEIGHT + 4) + 18
            target_height = max(92, min(target_height, PANEL_MAX_HEIGHT))
        self.setMinimumHeight(target_height)
        self.setMaximumHeight(target_height)
        self.resize(self.width(), target_height)

    def _drain_events(self) -> None:
        result = self.controller.drain_events()
        for key, direction in result.flash_directions.items():
            row = self.rows.get(key)
            if row is not None:
                row.flash(direction)

        if result.dirty:
            self._refresh_rows()
            self._update_status_ui()
            self._update_ticker_text()

    def _refresh_rows(self) -> None:
        for instrument in self.instruments:
            self.rows[instrument.key].update_quote(
                self.controller.quotes[instrument.key],
                stale_after_seconds=self.config.display.stale_after_seconds,
            )

    def _update_ticker_text(self) -> None:
        self.ticker_tape.set_items(build_ticker_items(self.instruments, self.controller.quotes))

    def _update_status_ui(self) -> None:
        if self.controller.last_message_at is None:
            age_text = "waiting"
        else:
            elapsed_ms = int(
                (datetime.now(timezone.utc) - self.controller.last_message_at).total_seconds() * 1000
            )
            if elapsed_ms < 1000:
                age_text = f"{elapsed_ms}ms"
            elif elapsed_ms < 10_000:
                age_text = f"{elapsed_ms / 1000:.1f}s"
            else:
                age_text = f"{elapsed_ms // 1000}s"

        dot_color = "#ffb84d"
        if self.controller.stream_status == "live":
            dot_color = "#7fffb7"
        elif self.controller.stream_status in {"retrying", "snapshot-failed", "error"}:
            dot_color = "#ff6c91"

        self.status_dot.setStyleSheet(f"font-size: 10px; color: {dot_color};")
        self.toggle_button.setToolTip(f"{self.controller.stream_status} · {age_text}")
        self.info_label.setText(f"{self.controller.stream_status} · {age_text}")

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
        self.controller.stop()
        super().closeEvent(event)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        if not self.positioned_once:
            self.positioned_once = True
            QTimer.singleShot(0, self._position_on_active_screen)

    def _position_on_active_screen(self) -> None:
        from PySide6.QtWidgets import QApplication

        app = QApplication.instance()
        if app is None:
            return
        screen = app.screenAt(QCursor.pos()) or app.primaryScreen()
        if screen is None:
            return
        area = screen.availableGeometry()
        self.move(area.x() + area.width() - self.width() - 24, area.y() + 24)
