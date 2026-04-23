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
ROW_HEIGHT = 28
PANEL_WIDTH = 268
PANEL_MAX_HEIGHT = 248
MARQUEE_GAP = 36
TICKER_TAPE_HEIGHT = 24
TICKER_TEXT_VERTICAL_NUDGE = -1
TICKER_SEPARATOR = "·"
SHELL_RADIUS = 14
ROW_RADIUS = 10
CONTROL_RADIUS = 9

SHELL_BACKGROUND = "rgba(31, 26, 22, 246)"
SHELL_BORDER = "rgba(173, 144, 116, 96)"
HEADER_BACKGROUND = "rgba(54, 45, 38, 218)"
HEADER_DIVIDER = "rgba(173, 144, 116, 54)"
ROW_BACKGROUND = "rgba(86, 71, 58, 132)"
ROW_BORDER = "rgba(177, 147, 118, 58)"
ROW_FLASH_UP_BACKGROUND = "rgba(91, 100, 76, 210)"
ROW_FLASH_UP_BORDER = "rgba(153, 169, 126, 126)"
ROW_FLASH_DOWN_BACKGROUND = "rgba(112, 67, 52, 214)"
ROW_FLASH_DOWN_BORDER = "rgba(201, 125, 95, 128)"
TEXT_PRIMARY = "#f3ebdf"
TEXT_SECONDARY = "#d3c1ad"
TEXT_MUTED = "#b5a392"
TEXT_STALE = "#8e7f72"
TEXT_TICKER = "#eadfce"
BUTTON_BACKGROUND = "rgba(246, 236, 224, 0.06)"
BUTTON_BORDER = "rgba(214, 184, 154, 0.12)"
BUTTON_BACKGROUND_HOVER = "rgba(201, 125, 95, 0.18)"
BUTTON_BORDER_HOVER = "rgba(214, 184, 154, 0.2)"
BUTTON_BACKGROUND_PRESSED = "rgba(201, 125, 95, 0.26)"
STATUS_WAITING = "#d2a465"
STATUS_LIVE = "#9fb08b"
STATUS_ERROR = "#c87a63"

UI_FONT_CANDIDATES = ("Avenir Next", "SF Pro Text", "Helvetica Neue", "Arial")
PRICE_FONT_CANDIDATES = ("SF Mono", "Menlo", "Monaco")
STATUS_LABELS = {
    "idle": "Idle",
    "live": "Live",
    "retrying": "Reconnecting",
    "snapshot-failed": "Sync issue",
    "error": "Connection issue",
}


def _pick_font(
    preferred: tuple[str, ...],
    *,
    size: int,
    weight: int,
    fixed: bool = False,
) -> QFont:
    available = set(QFontDatabase.families())
    for family in preferred:
        if family in available:
            font = QFont(family)
            break
    else:
        if fixed:
            font = QFontDatabase.systemFont(QFontDatabase.FixedFont)
        else:
            font = QFont()
    font.setPointSize(size)
    font.setWeight(weight)
    return font


def _build_ui_font(size: int, *, weight: int = QFont.Medium) -> QFont:
    return _pick_font(UI_FONT_CANDIDATES, size=size, weight=weight)


def _build_price_font(size: int, *, weight: int = QFont.DemiBold) -> QFont:
    return _pick_font(PRICE_FONT_CANDIDATES, size=size, weight=weight, fixed=True)


def _format_stream_status(status: str) -> str:
    return STATUS_LABELS.get(status, status.replace("-", " ").title())


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
        self.items = ["Waiting for prices"]
        self.offset = 0.0
        self.speed = 0.32
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
        normalized = items or ["Waiting for prices"]
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
        super().mousePressEvent(event)

    def paintEvent(self, _event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.TextAntialiasing)
        painter.setFont(self.font())
        painter.setPen(QColor(TEXT_TICKER))

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
        layout.setContentsMargins(10, 4, 10, 4)
        layout.setSpacing(10)

        self.symbol_label = QLabel(instrument.label)
        self.symbol_label.setMinimumWidth(48)
        self.symbol_label.setFont(_build_ui_font(10, weight=QFont.DemiBold))
        self.symbol_label.setStyleSheet(f"color: {TEXT_SECONDARY};")

        self.price_label = QLabel("--")
        self.price_label.setMinimumWidth(104)
        self.price_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self.price_label.setFont(_build_price_font(14, weight=QFont.Bold))
        self.price_label.setStyleSheet(f"color: {TEXT_PRIMARY};")

        layout.addWidget(self.symbol_label)
        layout.addStretch(1)
        layout.addWidget(self.price_label)
        self._apply_background(ROW_BACKGROUND, ROW_BORDER)

    def _apply_background(self, background: str, border: str) -> None:
        self.setStyleSheet(
            f"""
            QFrame#quoteRow {{
                background: {background};
                border: 1px solid {border};
                border-radius: {ROW_RADIUS}px;
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
            self.price_label.setStyleSheet(f"color: {TEXT_STALE};")
        else:
            self.price_label.setStyleSheet(f"color: {TEXT_PRIMARY};")

        if self.flash_frames_remaining > 0:
            if self.flash_direction > 0:
                self._apply_background(ROW_FLASH_UP_BACKGROUND, ROW_FLASH_UP_BORDER)
            elif self.flash_direction < 0:
                self._apply_background(ROW_FLASH_DOWN_BACKGROUND, ROW_FLASH_DOWN_BORDER)
            self.flash_frames_remaining -= 1
        else:
            self._apply_background(ROW_BACKGROUND, ROW_BORDER)


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
        shell.setObjectName("shell")
        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(18)
        shadow.setOffset(0, 6)
        shadow.setColor(QColor(0, 0, 0, 116))
        shell.setGraphicsEffect(shadow)

        root = QVBoxLayout(self)
        root.setContentsMargins(10, 10, 10, 10)
        root.addWidget(shell)

        shell_layout = QVBoxLayout(shell)
        shell_layout.setContentsMargins(0, 0, 0, 0)
        shell_layout.setSpacing(0)

        self.header = QFrame()
        self.header.setObjectName("headerBar")
        self.header.setFixedHeight(HEADER_HEIGHT)
        header_layout = QHBoxLayout(self.header)
        header_layout.setContentsMargins(10, 5, 8, 5)
        header_layout.setSpacing(8)

        self.status_dot = QLabel("●")
        self.status_dot.setFixedWidth(12)
        self.status_dot.setFont(_build_ui_font(11, weight=QFont.Bold))
        self.status_dot.setStyleSheet(f"color: {STATUS_WAITING};")

        self.ticker_tape = TickerTape(self._expand)
        self.ticker_tape.setStyleSheet("background: transparent; border: none;")
        self.ticker_tape.setFont(_build_ui_font(10, weight=QFont.Medium))

        self.info_label = QLabel("waiting")
        self.info_label.setObjectName("infoLabel")
        self.info_label.setMinimumWidth(110)
        self.info_label.setFont(_build_ui_font(9, weight=QFont.DemiBold))
        self.info_label.setStyleSheet(f"color: {TEXT_MUTED};")
        self.info_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)

        self.toggle_button = QPushButton("–")
        self.toggle_button.setObjectName("windowButton")
        self.toggle_button.setFixedSize(18, 18)
        self.toggle_button.setFont(_build_ui_font(11, weight=QFont.Bold))
        self.toggle_button.clicked.connect(self._toggle_collapsed)

        close_button = QPushButton("×")
        close_button.setObjectName("windowButton")
        close_button.setFixedSize(18, 18)
        close_button.setFont(_build_ui_font(11, weight=QFont.Medium))
        close_button.clicked.connect(self.close)

        header_layout.addWidget(self.status_dot)
        header_layout.addWidget(self.ticker_tape, 1)
        header_layout.addWidget(self.info_label)
        header_layout.addWidget(self.toggle_button)
        header_layout.addWidget(close_button)
        shell_layout.addWidget(self.header)

        self.body = QFrame()
        self.body.setObjectName("bodyPanel")
        body_layout = QVBoxLayout(self.body)
        body_layout.setContentsMargins(10, 8, 10, 10)
        body_layout.setSpacing(6)

        for instrument in self.instruments:
            row = QuoteRow(instrument)
            self.rows[instrument.key] = row
            body_layout.addWidget(row)

        shell_layout.addWidget(self.body)

        shell.setStyleSheet(
            f"""
            QFrame#shell {{
                background: {SHELL_BACKGROUND};
                border: 1px solid {SHELL_BORDER};
                border-radius: {SHELL_RADIUS}px;
            }}
            QFrame#headerBar {{
                background: {HEADER_BACKGROUND};
                border: none;
                border-top-left-radius: {SHELL_RADIUS}px;
                border-top-right-radius: {SHELL_RADIUS}px;
                border-bottom: 1px solid {HEADER_DIVIDER};
            }}
            QFrame#bodyPanel {{
                background: transparent;
                border: none;
            }}
            QLabel#infoLabel {{
                color: {TEXT_MUTED};
                background: transparent;
                border: none;
            }}
            QPushButton#windowButton {{
                background: {BUTTON_BACKGROUND};
                border: 1px solid {BUTTON_BORDER};
                border-radius: {CONTROL_RADIUS}px;
                color: {TEXT_MUTED};
                padding-bottom: 1px;
            }}
            QPushButton#windowButton:hover {{
                background: {BUTTON_BACKGROUND_HOVER};
                border-color: {BUTTON_BORDER_HOVER};
                color: {TEXT_PRIMARY};
            }}
            QPushButton#windowButton:pressed {{
                background: {BUTTON_BACKGROUND_PRESSED};
            }}
            """
        )

        self.setFont(_build_ui_font(10))

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
            target_height = HEADER_HEIGHT + 20
        else:
            target_height = HEADER_HEIGHT + len(self.instruments) * (ROW_HEIGHT + 6) + 22
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
            age_text = "--"
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

        dot_color = STATUS_WAITING
        if self.controller.stream_status == "live":
            dot_color = STATUS_LIVE
        elif self.controller.stream_status in {"retrying", "snapshot-failed", "error"}:
            dot_color = STATUS_ERROR

        status_text = _format_stream_status(self.controller.stream_status)
        self.status_dot.setStyleSheet(f"color: {dot_color};")
        self.toggle_button.setToolTip(f"{status_text} · {age_text}")
        self.info_label.setText(f"{status_text} · {age_text}")

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
