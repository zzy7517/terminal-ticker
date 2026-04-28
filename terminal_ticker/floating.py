"""Build the floating Qt ticker window and wire user interactions."""
from __future__ import annotations

import queue
import threading
from datetime import datetime, timezone

from PySide6.QtCore import QPoint, QSize, QTimer, Qt
from PySide6.QtGui import QColor, QCursor, QFont
from PySide6.QtWidgets import (
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from .config import AppConfig, InstrumentConfig, LONGBRIDGE_SOURCE
from .controller import TickerController
from .floating_widgets import (
    BUTTON_BACKGROUND,
    BUTTON_BACKGROUND_HOVER,
    BUTTON_BACKGROUND_PRESSED,
    BUTTON_BORDER,
    BUTTON_BORDER_HOVER,
    CONTROL_RADIUS,
    GROUP_LABELS,
    HEADER_BACKGROUND,
    HEADER_DIVIDER,
    HEADER_HEIGHT,
    LongbridgeSearchPanel,
    PANEL_GROUPED_WIDTH,
    PANEL_MAX_HEIGHT,
    PANEL_MIN_HEIGHT,
    PANEL_MIN_WIDTH,
    QuoteRow,
    ResizeHandle,
    ROW_HEIGHT,
    SHELL_BACKGROUND,
    SHELL_BORDER,
    SHELL_RADIUS,
    STATUS_ERROR,
    STATUS_LIVE,
    STATUS_WAITING,
    TEXT_MUTED,
    TEXT_PRIMARY,
    TEXT_SECONDARY,
    TEXT_STALE,
    TickerTape,
    build_ticker_items,
    build_ui_font,
    format_stream_status,
    group_instruments,
)
from .longbridge_provider import LongbridgeSecurity, resolve_instruments as resolve_longbridge
from .longbridge_provider import search_securities
from .providers import MarketInstrument
from .watchlist_store import (
    append_longbridge_symbol_to_watchlist,
    remove_longbridge_symbol_from_watchlist,
)


class FloatingTickerWindow(QWidget):
    """Render the floating ticker window and coordinate UI actions."""
    def __init__(
        self,
        config: AppConfig,
        instruments: tuple[MarketInstrument, ...],
        *,
        controller: TickerController | None = None,
        auto_start: bool = True,
    ) -> None:
        """Initialize window state, build widgets, timers, and optional data feed."""
        super().__init__()
        self.config = config
        self.instruments = instruments
        self.controller = controller or TickerController(
            config=config,
            instruments=instruments,
        )
        self.drag_origin: QPoint | None = None
        self.auto_start = auto_start
        self.expanded_size: QSize | None = None
        self.search_queue: queue.Queue[tuple[str, str, object]] = queue.Queue()
        self.last_search_query = ""
        self.last_search_results: tuple[LongbridgeSecurity, ...] = tuple()
        self.positioned_once = False
        self.collapsed = False
        self.rows: dict[str, QuoteRow] = {}
        self.grouped_instruments = group_instruments(instruments)

        self._build_window()
        self._start_timers()
        if auto_start:
            self.controller.start()

    def _build_window(self) -> None:
        """Construct the Qt widget tree and stylesheet for the ticker shell."""
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Window)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setMinimumWidth(PANEL_MIN_WIDTH)
        self.resize(PANEL_GROUPED_WIDTH, 196)

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
        self.status_dot.setFont(build_ui_font(11, weight=QFont.Bold))
        self.status_dot.setStyleSheet(f"color: {STATUS_WAITING};")

        self.ticker_tape = TickerTape(self._expand)
        self.ticker_tape.setStyleSheet("background: transparent; border: none;")
        self.ticker_tape.setFont(build_ui_font(10, weight=QFont.Medium))

        self.info_label = QLabel("waiting")
        self.info_label.setObjectName("infoLabel")
        self.info_label.setMinimumWidth(110)
        self.info_label.setFont(build_ui_font(9, weight=QFont.DemiBold))
        self.info_label.setStyleSheet(f"color: {TEXT_MUTED};")
        self.info_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)

        self.toggle_button = QPushButton("–")
        self.toggle_button.setObjectName("windowButton")
        self.toggle_button.setFixedSize(18, 18)
        self.toggle_button.setFont(build_ui_font(11, weight=QFont.Bold))
        self.toggle_button.clicked.connect(self._toggle_collapsed)

        close_button = QPushButton("×")
        close_button.setObjectName("windowButton")
        close_button.setFixedSize(18, 18)
        close_button.setFont(build_ui_font(11, weight=QFont.Medium))
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

        self.tabs = QTabWidget()
        self.tabs.setObjectName("quoteTabs")
        body_layout.addWidget(self.tabs)

        self._rebuild_tabs()

        grip_layout = QHBoxLayout()
        grip_layout.setContentsMargins(0, 0, 0, 0)
        grip_layout.setSpacing(0)
        grip_layout.addStretch(1)
        self.resize_grip = ResizeHandle(self)
        grip_layout.addWidget(self.resize_grip)
        body_layout.addLayout(grip_layout)

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
            QTabWidget#quoteTabs {{
                background: transparent;
                border: none;
            }}
            QTabWidget#quoteTabs::pane {{
                background: transparent;
                border: none;
                top: -1px;
            }}
            QTabBar::tab {{
                background: rgba(246, 236, 224, 0.05);
                border: 1px solid rgba(214, 184, 154, 0.10);
                border-radius: 8px;
                color: {TEXT_MUTED};
                min-width: 56px;
                padding: 4px 8px;
                margin-right: 5px;
            }}
            QTabBar::tab:selected {{
                background: rgba(201, 125, 95, 0.20);
                border-color: rgba(214, 184, 154, 0.24);
                color: {TEXT_PRIMARY};
            }}
            QFrame#tabQuotePanel, QScrollArea#quoteScroll {{
                background: transparent;
                border: none;
            }}
            QFrame#resizeGrip {{
                background: transparent;
                border: none;
            }}
            QFrame#searchPanel {{
                background: rgba(86, 71, 58, 0.38);
                border: 1px solid rgba(177, 147, 118, 0.16);
                border-radius: 10px;
            }}
            QLineEdit#securitySearchInput {{
                background: rgba(246, 236, 224, 0.07);
                border: 1px solid rgba(214, 184, 154, 0.16);
                border-radius: 8px;
                color: {TEXT_PRIMARY};
                padding: 4px 8px;
                selection-background-color: rgba(201, 125, 95, 0.35);
            }}
            QLineEdit#securitySearchInput::placeholder {{
                color: {TEXT_STALE};
            }}
            QListWidget#securitySearchResults {{
                background: rgba(31, 26, 22, 0.34);
                border: 1px solid rgba(214, 184, 154, 0.12);
                border-radius: 8px;
                color: {TEXT_SECONDARY};
                padding: 2px;
            }}
            QListWidget#securitySearchResults::item {{
                min-height: 20px;
                padding: 2px 6px;
                border-radius: 5px;
            }}
            QListWidget#securitySearchResults::item:selected {{
                background: rgba(201, 125, 95, 0.22);
                color: {TEXT_PRIMARY};
            }}
            QLabel#searchStatusLabel {{
                color: {TEXT_MUTED};
                background: transparent;
                border: none;
            }}
            QLabel#infoLabel {{
                color: {TEXT_MUTED};
                background: transparent;
                border: none;
            }}
            QPushButton#windowButton, QPushButton#searchButton {{
                background: {BUTTON_BACKGROUND};
                border: 1px solid {BUTTON_BORDER};
                border-radius: {CONTROL_RADIUS}px;
                color: {TEXT_MUTED};
                padding-bottom: 1px;
            }}
            QPushButton#searchButton {{
                min-width: 42px;
                padding-left: 8px;
                padding-right: 8px;
            }}
            QPushButton#windowButton:hover, QPushButton#searchButton:hover {{
                background: {BUTTON_BACKGROUND_HOVER};
                border-color: {BUTTON_BORDER_HOVER};
                color: {TEXT_PRIMARY};
            }}
            QPushButton#windowButton:pressed, QPushButton#searchButton:pressed {{
                background: {BUTTON_BACKGROUND_PRESSED};
            }}
            QPushButton#searchButton:disabled {{
                color: {TEXT_STALE};
                background: rgba(246, 236, 224, 0.03);
            }}
            """
        )

        self.setFont(build_ui_font(10))

        self._refresh_rows()
        self._update_status_ui()
        self._update_ticker_text()
        self._apply_collapsed_state()

    def _rebuild_tabs(self) -> None:
        """Rebuild group tabs and quote rows from the current instruments."""
        self.rows.clear()
        self.grouped_instruments = group_instruments(self.instruments)
        self.tabs.clear()
        for group, group_instruments_ in self.grouped_instruments.items():
            page = self._build_group_page(group, group_instruments_)
            self.tabs.addTab(page, GROUP_LABELS.get(group, group.replace("_", " ").title()))

    def _build_group_page(
        self,
        group: str,
        instruments: tuple[MarketInstrument, ...],
    ) -> QWidget:
        """Create one tab page, including search controls for the stocks tab."""
        if group != "stocks":
            return self._build_quote_scroll_area(instruments)

        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(6)
        page_layout.addWidget(self._build_stock_search_panel())
        page_layout.addWidget(self._build_quote_scroll_area(instruments), 1)
        return page

    def _build_stock_search_panel(self) -> QFrame:
        """Create the Longbridge search panel and expose test-friendly handles."""
        self.search_panel = LongbridgeSearchPanel(
            on_search=self._start_longbridge_search,
            on_action=self._apply_selected_search_result,
        )
        # Preserve stable attributes used by tests and small UI callbacks.
        self.search_input = self.search_panel.search_input
        self.search_button = self.search_panel.search_button
        self.add_search_button = self.search_panel.add_button
        self.search_results = self.search_panel.results_list
        self.search_status_label = self.search_panel.status_label
        return self.search_panel

    def _build_quote_scroll_area(
        self,
        instruments: tuple[MarketInstrument, ...],
    ) -> QScrollArea:
        """Build a scrollable list of quote rows for one instrument group."""
        panel = QFrame()
        panel.setObjectName("tabQuotePanel")
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(0, 8, 0, 0)
        panel_layout.setSpacing(6)

        for instrument in instruments:
            self._add_quote_row(panel_layout, instrument)
        panel_layout.addStretch(1)

        scroll_area = QScrollArea()
        scroll_area.setObjectName("quoteScroll")
        scroll_area.setFrameShape(QFrame.NoFrame)
        scroll_area.setWidgetResizable(True)
        scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll_area.setWidget(panel)
        return scroll_area

    def _add_quote_row(self, layout: QVBoxLayout, instrument: MarketInstrument) -> None:
        """Create and register one quote row widget."""
        row = QuoteRow(instrument)
        self.rows[instrument.key] = row
        layout.addWidget(row)

    def _set_search_status(self, text: str) -> None:
        """Update the search panel status label when it exists."""
        panel = getattr(self, "search_panel", None)
        if panel is not None:
            panel.set_status(text)

    def _start_longbridge_search(self) -> None:
        """Launch a background Longbridge search for the current query."""
        query = self.search_panel.query()
        if not query:
            self._set_search_status("输入代码或名称后搜索")
            return

        self.search_panel.set_busy()
        thread = threading.Thread(
            target=self._search_longbridge_worker,
            args=(query,),
            daemon=True,
        )
        thread.start()

    def _search_longbridge_worker(self, query: str) -> None:
        """Run Longbridge search off the UI thread and enqueue the result."""
        try:
            results = search_securities(query, limit=20)
        except Exception as exc:
            self.search_queue.put(("error", query, str(exc) or exc.__class__.__name__))
        else:
            self.search_queue.put(("results", query, results))

    def _drain_search_results(self) -> None:
        """Apply completed search results to the search panel."""
        while True:
            try:
                kind, query, payload = self.search_queue.get_nowait()
            except queue.Empty:
                break

            if not hasattr(self, "search_results"):
                continue
            if kind == "error":
                self.search_panel.show_error(str(payload))
                continue

            results = tuple(payload)
            self.last_search_query = query
            self.last_search_results = results
            self.search_panel.show_results(
                query=query,
                results=results,
                is_existing=self._has_longbridge_symbol,
            )

    def _apply_selected_search_result(self) -> None:
        """Dispatch the selected search result to add or remove behavior."""
        result = self.search_panel.selected_result()
        if result is None:
            return
        if self.search_panel.selected_result_exists():
            self._remove_selected_search_result(result)
        else:
            self._add_selected_search_result(result)

    def _add_selected_search_result(self, result: LongbridgeSecurity) -> None:
        """Persist and activate a selected Longbridge symbol."""
        if self._has_longbridge_symbol(result.symbol):
            self._set_search_status(f"{result.symbol} 已在 watchlist")
            self.add_search_button.setText("移除")
            self.add_search_button.setEnabled(True)
            return
        if self.config.source_path is None:
            self._set_search_status("当前不是从 watchlist 文件启动，不能写入")
            return

        try:
            inserted = append_longbridge_symbol_to_watchlist(
                self.config.source_path,
                symbol=result.symbol,
                label=result.default_label,
                group="stocks",
                show_collapsed=True,
            )
        except Exception as exc:
            self._set_search_status(f"写入失败：{exc}")
            return
        if not inserted:
            self._set_search_status(f"{result.symbol} 已在 watchlist")
            self.add_search_button.setText("移除")
            self.add_search_button.setEnabled(True)
            return

        self._add_longbridge_symbol_to_runtime(result)
        self._set_search_status(f"已添加 {result.symbol}")

    def _remove_selected_search_result(self, result: LongbridgeSecurity) -> None:
        """Persistently remove and deactivate a selected Longbridge symbol."""
        if not self._has_longbridge_symbol(result.symbol):
            self._set_search_status(f"{result.symbol} 不在 watchlist")
            self.add_search_button.setText("添加")
            self.add_search_button.setEnabled(True)
            return
        if self.config.source_path is None:
            self._set_search_status("当前不是从 watchlist 文件启动，不能写入")
            return

        try:
            removed = remove_longbridge_symbol_from_watchlist(
                self.config.source_path,
                symbol=result.symbol,
            )
        except Exception as exc:
            self._set_search_status(f"移除失败：{exc}")
            return
        if not removed:
            self._set_search_status(f"{result.symbol} 不在 watchlist")
            self.add_search_button.setText("添加")
            self.add_search_button.setEnabled(True)
            return

        self._remove_longbridge_symbol_from_runtime(result.symbol)
        self._set_search_status(f"已移除 {result.symbol}")

    def _has_longbridge_symbol(self, symbol: str) -> bool:
        """Check whether a Longbridge symbol is active in the current watchlist."""
        key = f"{LONGBRIDGE_SOURCE}:{symbol.upper()}"
        return any(instrument.key == key for instrument in self.instruments)

    def _add_longbridge_symbol_to_runtime(self, result: LongbridgeSecurity) -> None:
        """Add a Longbridge result to runtime config and resolved instruments."""
        config_entry = InstrumentConfig(
            symbol=result.symbol,
            source=LONGBRIDGE_SOURCE,
            label=result.default_label,
            show_collapsed=True,
            group="stocks",
        )
        instrument = resolve_longbridge((config_entry,))[0]
        self._replace_runtime_watchlist(
            config_entries=self.config.instruments + (config_entry,),
            instruments=self.instruments + (instrument,),
        )

    def _remove_longbridge_symbol_from_runtime(self, symbol: str) -> None:
        """Remove a Longbridge symbol from runtime config and instruments."""
        key = f"{LONGBRIDGE_SOURCE}:{symbol.upper()}"
        config_entries = tuple(
            entry
            for entry in self.config.instruments
            if not (entry.source == LONGBRIDGE_SOURCE and entry.symbol == symbol.upper())
        )
        instruments = tuple(instrument for instrument in self.instruments if instrument.key != key)
        self._replace_runtime_watchlist(config_entries=config_entries, instruments=instruments)

    def _replace_runtime_watchlist(
        self,
        *,
        config_entries: tuple[InstrumentConfig, ...],
        instruments: tuple[MarketInstrument, ...],
    ) -> None:
        """Swap watchlist state and rebuild the controller and visible tabs."""
        self.controller.stop()
        self.config = AppConfig(
            instruments=config_entries,
            display=self.config.display,
            source_path=self.config.source_path,
        )
        self.instruments = instruments
        self.controller = TickerController(config=self.config, instruments=self.instruments)
        self._rebuild_tabs()
        self._restore_search_results()
        self._refresh_rows()
        self._update_status_ui()
        self._update_ticker_text()
        self._apply_collapsed_state()
        if self.auto_start:
            self.controller.start()

    def _restore_search_results(self) -> None:
        """Restore the last search result list after rebuilding the stocks tab."""
        if not self.last_search_results or not hasattr(self, "search_panel"):
            return
        self.search_input.setText(self.last_search_query)
        self.search_panel.show_results(
            query=self.last_search_query,
            results=self.last_search_results,
            is_existing=self._has_longbridge_symbol,
        )

    def _start_timers(self) -> None:
        """Start UI timers for feed events, clock refresh, search results, and marquee motion."""
        self.queue_timer = QTimer(self)
        self.queue_timer.timeout.connect(self._drain_events)
        self.queue_timer.start(90)

        self.clock_timer = QTimer(self)
        self.clock_timer.timeout.connect(self._tick_clock)
        self.clock_timer.start(max(150, self.config.display.refresh_interval_ms))

        self.search_timer = QTimer(self)
        self.search_timer.timeout.connect(self._drain_search_results)
        self.search_timer.start(120)

        self.marquee_timer = QTimer(self)
        self.marquee_timer.timeout.connect(self.ticker_tape.advance)
        self.marquee_timer.start(28)

    def _tick_clock(self) -> None:
        """Refresh row labels and status text on the UI heartbeat."""
        self._refresh_rows()
        self._update_status_ui()
        self._update_ticker_text()

    def _toggle_collapsed(self) -> None:
        """Toggle between expanded panel and collapsed ticker tape states."""
        if not self.collapsed:
            self.expanded_size = self.size()
        self.collapsed = not self.collapsed
        self._apply_collapsed_state()

    def _expand(self) -> None:
        """Expand the ticker when the explicit expand button is used."""
        if self.collapsed:
            self.collapsed = False
            self._apply_collapsed_state()

    def _apply_collapsed_state(self) -> None:
        """Apply widget visibility and sizing for the current collapsed state."""
        self.body.setVisible(not self.collapsed)
        self.resize_grip.setVisible(not self.collapsed)
        self.toggle_button.setText("+" if self.collapsed else "–")
        self.ticker_tape.setVisible(self.collapsed)
        self.info_label.setVisible(not self.collapsed)
        if self.collapsed:
            target_height = HEADER_HEIGHT + 20
            self.setMinimumSize(PANEL_MIN_WIDTH, target_height)
            self.setMaximumHeight(target_height)
            self.resize(self.width(), target_height)
        else:
            target_height = self._expanded_target_height()
            self.setMinimumSize(PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT)
            self.setMaximumHeight(16_777_215)
            if self.expanded_size is None:
                self.resize(max(self.width(), PANEL_GROUPED_WIDTH), target_height)
            else:
                self.resize(
                    max(self.expanded_size.width(), PANEL_MIN_WIDTH),
                    max(self.expanded_size.height(), PANEL_MIN_HEIGHT),
                )

    def _expanded_target_height(self) -> int:
        """Calculate a practical expanded height from visible group sizes."""
        largest_group_size = max(
            (len(group) for group in self.grouped_instruments.values()),
            default=1,
        )
        visible_rows = max(2, min(largest_group_size, 8))
        search_panel_height = 78 if "stocks" in self.grouped_instruments else 0
        target_height = HEADER_HEIGHT + visible_rows * (ROW_HEIGHT + 6) + 78 + search_panel_height
        return max(154, min(target_height, PANEL_MAX_HEIGHT))

    def _drain_events(self) -> None:
        """Drain market data events and refresh rows that changed."""
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
        """Update every quote row from the controller quote cache."""
        for instrument in self.instruments:
            self.rows[instrument.key].update_quote(
                self.controller.quotes[instrument.key],
                stale_after_seconds=self.config.display.stale_after_seconds,
            )

    def _update_ticker_text(self) -> None:
        """Refresh the collapsed marquee items from visible collapsed symbols."""
        items = build_ticker_items(self.instruments, self.controller.quotes)
        self.ticker_tape.set_items(items or ["No collapsed symbols"])

    def _update_status_ui(self) -> None:
        """Render stream status and age in the header controls."""
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

        status_text = format_stream_status(self.controller.stream_status)
        self.status_dot.setStyleSheet(f"color: {dot_color};")
        self.toggle_button.setToolTip(f"{status_text} · {age_text}")
        self.info_label.setText(f"{status_text} · {age_text}")

    def mousePressEvent(self, event) -> None:
        """Start dragging the frameless window with the left mouse button."""
        if event.button() == Qt.LeftButton:
            self.drag_origin = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event) -> None:
        """Move the frameless window while dragging continues."""
        if self.drag_origin is not None and event.buttons() & Qt.LeftButton:
            self.move(event.globalPosition().toPoint() - self.drag_origin)
            event.accept()

    def mouseReleaseEvent(self, event) -> None:
        """Finish a window drag operation."""
        self.drag_origin = None
        event.accept()

    def closeEvent(self, event) -> None:
        """Stop market data before the window closes."""
        self.controller.stop()
        super().closeEvent(event)

    def showEvent(self, event) -> None:
        """Position the window once after it is first shown."""
        super().showEvent(event)
        if not self.positioned_once:
            self.positioned_once = True
            QTimer.singleShot(0, self._position_on_active_screen)

    def _position_on_active_screen(self) -> None:
        """Place the window near the top right of the active screen."""
        from PySide6.QtWidgets import QApplication

        app = QApplication.instance()
        if app is None:
            return
        screen = app.screenAt(QCursor.pos()) or app.primaryScreen()
        if screen is None:
            return
        area = screen.availableGeometry()
        self.move(area.x() + area.width() - self.width() - 24, area.y() + 24)
