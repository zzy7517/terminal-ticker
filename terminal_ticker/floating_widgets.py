"""Define reusable Qt widgets and formatting helpers for the ticker UI."""
from __future__ import annotations

from PySide6.QtCore import QPoint, QRect, QRectF, QSize, Qt
from PySide6.QtGui import QColor, QFont, QFontDatabase, QFontMetrics, QPainter, QPen
from collections.abc import Callable

from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .longbridge_provider import LongbridgeSecurity
from .models import QuoteState
from .price_action import Candle
from .providers import MarketInstrument

HEADER_HEIGHT = 30
ROW_HEIGHT = 28
PANEL_MIN_WIDTH = 280
PANEL_MIN_HEIGHT = 220
PANEL_GROUPED_WIDTH = 520
PANEL_MAX_HEIGHT = 620
DETAIL_PANEL_HEIGHT = 168
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
DETAIL_BACKGROUND = "rgba(48, 40, 34, 150)"
CHART_GRID = "#d6b89a"
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
CHART_UP = "#9fb08b"
CHART_DOWN = "#c87a63"

UI_FONT_CANDIDATES = ("Avenir Next", "SF Pro Text", "Helvetica Neue", "Arial")
PRICE_FONT_CANDIDATES = ("SF Mono", "Menlo", "Monaco")
STATUS_LABELS = {
    "idle": "Idle",
    "live": "Live",
    "retrying": "Reconnecting",
    "snapshot-failed": "Sync issue",
    "error": "Connection issue",
}
GROUP_ORDER = ("stocks", "crypto", "metals", "indices", "watchlist", "other")
GROUP_LABELS = {
    "stocks": "美股",
    "crypto": "Crypto",
    "metals": "Metals",
    "indices": "Indices",
    "watchlist": "Watchlist",
    "other": "Other",
}


def _pick_font(
    preferred: tuple[str, ...],
    *,
    size: int,
    weight: int,
    fixed: bool = False,
) -> QFont:
    """Choose the first available font from a preferred list."""
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


def build_ui_font(size: int, *, weight: int = QFont.Medium) -> QFont:
    """Build the standard proportional UI font."""
    return _pick_font(UI_FONT_CANDIDATES, size=size, weight=weight)


def build_price_font(size: int, *, weight: int = QFont.DemiBold) -> QFont:
    """Build the fixed-width price font."""
    return _pick_font(PRICE_FONT_CANDIDATES, size=size, weight=weight, fixed=True)


def format_stream_status(status: str) -> str:
    """Convert an internal stream status into a readable label."""
    return STATUS_LABELS.get(status, status.replace("-", " ").title())


def build_ticker_items(
    instruments: tuple[MarketInstrument, ...],
    quotes: dict[str, QuoteState],
    *,
    analysis_stale_after_seconds: int | None = None,
) -> list[str]:
    """Build collapsed ticker tape labels from quote state."""
    parts: list[str] = []
    for instrument in instruments:
        if not instrument.show_collapsed:
            continue
        quote = quotes[instrument.key]
        marker = quote.price_action_label(
            stale_after_seconds=analysis_stale_after_seconds,
        )
        suffix = f" {marker}" if marker else ""
        parts.append(f"{instrument.label} {quote.price_label()}{suffix}")
    return parts


def group_instruments(
    instruments: tuple[MarketInstrument, ...],
) -> dict[str, tuple[MarketInstrument, ...]]:
    """Group instruments for tab display while keeping known groups ordered."""
    grouped: dict[str, list[MarketInstrument]] = {}
    for instrument in instruments:
        grouped.setdefault(instrument.group, []).append(instrument)

    # Keep the Longbridge search entry reachable even before any US symbol exists.
    grouped.setdefault("stocks", [])

    ordered: dict[str, tuple[MarketInstrument, ...]] = {}
    for group in GROUP_ORDER:
        if group in grouped:
            ordered[group] = tuple(grouped.pop(group))
    for group in sorted(grouped):
        ordered[group] = tuple(grouped[group])
    return ordered


class TickerTape(QFrame):
    """Render the scrolling collapsed ticker tape."""
    def __init__(self, on_activate) -> None:
        """Initialize ticker tape state and activation callback."""
        super().__init__()
        self.on_activate = on_activate
        self.items = ["Waiting for prices"]
        self.offset = 0.0
        self.speed = 0.32
        self.item_widths: list[int] = []
        self.separator_width = 0
        self.setFixedHeight(TICKER_TAPE_HEIGHT)

    def _recalculate_metrics(self) -> None:
        """Measure current item and separator widths for scrolling."""
        metrics = QFontMetrics(self.font())
        self.item_widths = [metrics.horizontalAdvance(item) for item in self.items]
        self.separator_width = metrics.horizontalAdvance(f"  {TICKER_SEPARATOR}  ")

    def _cycle_width(self) -> int:
        """Return the pixel width of one complete marquee cycle."""
        if not self.item_widths:
            return 0
        content_width = sum(self.item_widths)
        if len(self.item_widths) > 1:
            content_width += self.separator_width * (len(self.item_widths) - 1)
        return content_width + MARQUEE_GAP

    def set_items(self, items: list[str]) -> None:
        """Replace ticker items and keep scroll offset stable."""
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
        """Advance the marquee offset and schedule repainting."""
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
        """Consume ticker clicks without expanding the panel."""
        super().mousePressEvent(event)

    def paintEvent(self, _event) -> None:
        """Paint scrolling ticker text and separators."""
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
    """Render one instrument row in the expanded ticker."""
    def __init__(
        self,
        instrument: MarketInstrument,
        on_select: Callable[[str], None] | None = None,
    ) -> None:
        """Create labels and layout for one quote row."""
        super().__init__()
        self.instrument = instrument
        self.on_select = on_select
        self.flash_direction = 0
        self.flash_frames_remaining = 0
        self.setObjectName("quoteRow")
        self.setFixedHeight(ROW_HEIGHT)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(10, 4, 10, 4)
        layout.setSpacing(8)

        self.symbol_label = QLabel(instrument.label)
        self.symbol_label.setMinimumWidth(48)
        self.symbol_label.setFont(build_ui_font(10, weight=QFont.DemiBold))
        self.symbol_label.setStyleSheet(f"color: {TEXT_SECONDARY};")

        self.analysis_label = QLabel("")
        self.analysis_label.setFixedWidth(32)
        self.analysis_label.setAlignment(Qt.AlignCenter)
        self.analysis_label.setFont(build_price_font(9, weight=QFont.Bold))
        self.analysis_label.setStyleSheet(f"color: {TEXT_MUTED};")

        self.analysis_reason_label = QLabel("")
        self.analysis_reason_label.setFixedWidth(106)
        self.analysis_reason_label.setFont(build_ui_font(8, weight=QFont.Medium))
        self.analysis_reason_label.setStyleSheet(f"color: {TEXT_MUTED};")

        self.price_label = QLabel("--")
        self.price_label.setMinimumWidth(88)
        self.price_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self.price_label.setFont(build_price_font(14, weight=QFont.Bold))
        self.price_label.setStyleSheet(f"color: {TEXT_PRIMARY};")

        layout.addWidget(self.symbol_label)
        layout.addStretch(1)
        layout.addWidget(self.analysis_reason_label)
        layout.addWidget(self.analysis_label)
        layout.addWidget(self.price_label)
        self._apply_background(ROW_BACKGROUND, ROW_BORDER)

    def set_compact_width(self, width: int) -> None:
        """Hide optional row text when the panel is very narrow."""
        self.analysis_reason_label.setVisible(width >= 315 and bool(self.analysis_reason_label.text()))

    def mousePressEvent(self, event) -> None:
        """Select this row for the detail panel."""
        if event.button() == Qt.LeftButton and self.on_select is not None:
            self.on_select(self.instrument.key)
            event.accept()
            return
        super().mousePressEvent(event)

    def _apply_background(self, background: str, border: str) -> None:
        """Apply row background and border colors."""
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
        """Temporarily color a row for an up or down price move."""
        self.flash_direction = direction
        self.flash_frames_remaining = 5

    def update_quote(
        self,
        quote: QuoteState,
        *,
        stale_after_seconds: int,
        analysis_stale_after_seconds: int | None = None,
    ) -> None:
        """Render the latest quote values into row labels."""
        self.symbol_label.setText(quote.symbol)
        self.price_label.setText(quote.price_label())
        marker = quote.price_action_label(
            stale_after_seconds=analysis_stale_after_seconds,
        )
        reason = quote.price_action_reason(
            stale_after_seconds=analysis_stale_after_seconds,
        )
        self.analysis_label.setText(marker)
        self.analysis_reason_label.setText(reason)
        self.analysis_label.setVisible(bool(marker))
        self.analysis_reason_label.setVisible(self.width() >= 315 and bool(reason))

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


class CandlestickChart(QWidget):
    """Render a compact candlestick chart without extra dependencies."""
    def __init__(self) -> None:
        """Initialize chart data."""
        super().__init__()
        self.candles: tuple[Candle, ...] = tuple()
        self.setMinimumHeight(96)

    def set_candles(self, candles: tuple[Candle, ...]) -> None:
        """Replace the chart candles."""
        self.candles = tuple(sorted(candles, key=lambda candle: candle.open_time_ms))[-36:]
        self.update()

    def paintEvent(self, _event) -> None:
        """Paint the current candle set."""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        rect = self.rect().adjusted(8, 8, -8, -8)
        if rect.width() <= 12 or rect.height() <= 12:
            return

        grid_color = QColor(CHART_GRID)
        grid_color.setAlpha(38)
        painter.setPen(QPen(grid_color, 1))
        for fraction in (0.25, 0.5, 0.75):
            y = rect.top() + rect.height() * fraction
            painter.drawLine(rect.left(), int(y), rect.right(), int(y))

        if not self.candles:
            painter.setPen(QColor(TEXT_STALE))
            painter.setFont(build_ui_font(9, weight=QFont.Medium))
            painter.drawText(rect, int(Qt.AlignCenter), "等待K线")
            return

        high = max(candle.high for candle in self.candles)
        low = min(candle.low for candle in self.candles)
        if high <= low:
            high = low + 1

        step = rect.width() / max(1, len(self.candles))
        body_width = max(2.0, min(8.0, step * 0.58))

        def y_for(price: float) -> float:
            return rect.bottom() - ((price - low) / (high - low)) * rect.height()

        for index, candle in enumerate(self.candles):
            x = rect.left() + step * index + step / 2
            color = QColor(CHART_UP if candle.close >= candle.open else CHART_DOWN)
            painter.setPen(QPen(color, 1))
            painter.drawLine(int(x), int(y_for(candle.high)), int(x), int(y_for(candle.low)))
            top = min(y_for(candle.open), y_for(candle.close))
            bottom = max(y_for(candle.open), y_for(candle.close))
            height = max(1.5, bottom - top)
            body = QRectF(x - body_width / 2, top, body_width, height)
            painter.fillRect(body, color)


class InstrumentDetailPanel(QFrame):
    """Render the selected instrument's analysis and mini chart."""
    def __init__(self) -> None:
        """Build the detail panel widgets."""
        super().__init__()
        self.setObjectName("instrumentDetailPanel")
        self.setMinimumHeight(DETAIL_PANEL_HEIGHT)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 8, 10, 10)
        layout.setSpacing(6)

        header = QHBoxLayout()
        header.setContentsMargins(0, 0, 0, 0)
        header.setSpacing(8)

        self.title_label = QLabel("选择标的")
        self.title_label.setFont(build_ui_font(10, weight=QFont.DemiBold))
        self.title_label.setStyleSheet(f"color: {TEXT_PRIMARY};")

        self.marker_label = QLabel("")
        self.marker_label.setFixedWidth(36)
        self.marker_label.setAlignment(Qt.AlignCenter)
        self.marker_label.setFont(build_price_font(9, weight=QFont.Bold))
        self.marker_label.setStyleSheet(f"color: {TEXT_MUTED};")

        self.reason_label = QLabel("等待K线")
        self.reason_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self.reason_label.setFont(build_ui_font(8, weight=QFont.Medium))
        self.reason_label.setStyleSheet(f"color: {TEXT_MUTED};")

        header.addWidget(self.title_label)
        header.addWidget(self.marker_label)
        header.addWidget(self.reason_label, 1)
        layout.addLayout(header)

        self.chart = CandlestickChart()
        layout.addWidget(self.chart, 1)

    def update_detail(
        self,
        instrument: MarketInstrument | None,
        quote: QuoteState | None,
        *,
        analysis_stale_after_seconds: int,
    ) -> None:
        """Render selected instrument state."""
        if instrument is None or quote is None:
            self.title_label.setText("选择标的")
            self.marker_label.setText("")
            self.reason_label.setText("等待K线")
            self.chart.set_candles(tuple())
            return

        self.title_label.setText(f"{instrument.label} · {quote.price_label()}")
        marker = quote.price_action_label(stale_after_seconds=analysis_stale_after_seconds)
        reason = quote.price_action_reason(stale_after_seconds=analysis_stale_after_seconds)
        self.marker_label.setText(marker)
        self.reason_label.setText(reason or "等待K线")
        self.chart.set_candles(quote.price_action_candles)


class ResizeHandle(QFrame):
    """Provide a small manual resize affordance for the frameless window."""
    def __init__(self, owner: QWidget) -> None:
        """Store the owner window and initialize drag state."""
        super().__init__()
        self.owner = owner
        self.drag_origin: QPoint | None = None
        self.start_size: QSize | None = None
        self.setObjectName("resizeGrip")
        self.setFixedSize(18, 18)
        self.setCursor(Qt.SizeFDiagCursor)
        self.setToolTip("拖拽缩放面板")

    def mousePressEvent(self, event) -> None:
        """Start resizing from the current mouse position."""
        if event.button() == Qt.LeftButton:
            self.drag_origin = event.globalPosition().toPoint()
            self.start_size = self.owner.size()
            event.accept()

    def mouseMoveEvent(self, event) -> None:
        """Resize the owner window while the handle is dragged."""
        if self.drag_origin is None or self.start_size is None:
            return
        delta = event.globalPosition().toPoint() - self.drag_origin
        self.owner.resize(
            max(PANEL_MIN_WIDTH, self.start_size.width() + delta.x()),
            max(PANEL_MIN_HEIGHT, self.start_size.height() + delta.y()),
        )
        event.accept()

    def mouseReleaseEvent(self, event) -> None:
        """Finish a manual resize drag."""
        self.drag_origin = None
        self.start_size = None
        event.accept()

    def paintEvent(self, _event) -> None:
        """Draw the diagonal resize grip marks."""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.setPen(QColor(TEXT_MUTED))
        painter.drawLine(7, 15, 15, 7)
        painter.drawLine(11, 15, 15, 11)
        painter.drawLine(3, 15, 15, 3)


class LongbridgeSearchPanel(QFrame):
    """Render Longbridge search controls and result selection state."""
    def __init__(
        self,
        *,
        on_search: Callable[[], None],
        on_action: Callable[[], None],
    ) -> None:
        """Build the search input, action button, results list, and status label."""
        super().__init__()
        self.setObjectName("searchPanel")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 7)
        layout.setSpacing(5)

        controls = QHBoxLayout()
        controls.setContentsMargins(0, 0, 0, 0)
        controls.setSpacing(6)

        self.search_input = QLineEdit()
        self.search_input.setObjectName("securitySearchInput")
        self.search_input.setPlaceholderText("搜索代码 / 名称")
        self.search_input.setFont(build_ui_font(9, weight=QFont.Medium))
        self.search_input.setMinimumHeight(24)
        self.search_input.returnPressed.connect(on_search)

        self.search_button = QPushButton("搜索")
        self.search_button.setObjectName("searchButton")
        self.search_button.setFont(build_ui_font(9, weight=QFont.DemiBold))
        self.search_button.setMinimumHeight(24)
        self.search_button.clicked.connect(on_search)

        self.add_button = QPushButton("添加")
        self.add_button.setObjectName("searchButton")
        self.add_button.setFont(build_ui_font(9, weight=QFont.DemiBold))
        self.add_button.setMinimumHeight(24)
        self.add_button.setEnabled(False)
        self.add_button.clicked.connect(on_action)

        controls.addWidget(self.search_input, 1)
        controls.addWidget(self.search_button)
        controls.addWidget(self.add_button)

        self.results_list = QListWidget()
        self.results_list.setObjectName("securitySearchResults")
        self.results_list.setFont(build_ui_font(8, weight=QFont.Medium))
        self.results_list.setMaximumHeight(82)
        self.results_list.setVisible(False)
        self.results_list.currentItemChanged.connect(self._handle_selection)

        self.status_label = QLabel("从长桥标的列表搜索美股")
        self.status_label.setObjectName("searchStatusLabel")
        self.status_label.setFont(build_ui_font(8, weight=QFont.Medium))

        layout.addLayout(controls)
        layout.addWidget(self.results_list)
        layout.addWidget(self.status_label)

    def query(self) -> str:
        """Return the trimmed search query text."""
        return self.search_input.text().strip()

    def set_busy(self) -> None:
        """Show the search panel busy state while a query runs."""
        self.search_button.setEnabled(False)
        self.add_button.setText("添加")
        self.add_button.setEnabled(False)
        self.results_list.clear()
        self.results_list.setVisible(False)
        self.set_status("搜索中")

    def set_status(self, text: str) -> None:
        """Set the small search status label."""
        self.status_label.setText(text)

    def show_error(self, message: str) -> None:
        """Render a failed search state."""
        self.search_button.setEnabled(True)
        self.add_button.setText("添加")
        self.add_button.setEnabled(False)
        self.results_list.clear()
        self.results_list.setVisible(False)
        self.set_status(f"搜索失败：{message}")

    def show_results(
        self,
        *,
        query: str,
        results: tuple[LongbridgeSecurity, ...],
        is_existing: Callable[[str], bool],
    ) -> None:
        """Render search results and mark existing watchlist symbols."""
        self.search_button.setEnabled(True)
        self.results_list.clear()
        for result in results:
            exists = is_existing(result.symbol)
            item = QListWidgetItem(result.display_text())
            item.setData(Qt.UserRole, result)
            item.setData(Qt.UserRole + 1, exists)
            if exists:
                item.setText(f"{result.display_text()}  已添加")
            self.results_list.addItem(item)
        self.results_list.setVisible(bool(results))
        if results:
            self.results_list.setCurrentRow(0)
        else:
            self.add_button.setText("添加")
            self.add_button.setEnabled(False)
        self.set_status(f"{query}: {len(results)} 个结果" if results else "没有匹配结果")

    def selected_result(self) -> LongbridgeSecurity | None:
        """Return the selected Longbridge security, if any."""
        current = self.results_list.currentItem()
        if current is None:
            return None
        result = current.data(Qt.UserRole)
        if isinstance(result, LongbridgeSecurity):
            return result
        return None

    def selected_result_exists(self) -> bool:
        """Return whether the selected result is already in the watchlist."""
        current = self.results_list.currentItem()
        if current is None:
            return False
        return bool(current.data(Qt.UserRole + 1))

    def _handle_selection(self, current: QListWidgetItem | None, _previous) -> None:
        """Update the action button for the selected search result."""
        if current is None:
            self.add_button.setText("添加")
            self.add_button.setEnabled(False)
            return
        result = current.data(Qt.UserRole)
        exists = bool(current.data(Qt.UserRole + 1))
        self.add_button.setText("移除" if exists else "添加")
        self.add_button.setEnabled(isinstance(result, LongbridgeSecurity))
