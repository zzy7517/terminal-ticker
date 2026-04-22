from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
from pathlib import Path

from rich.table import Table
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container
from textual.widgets import Footer, Header, Static
from yfinance import AsyncWebSocket

from .config import AppConfig, build_runtime_config, load_config
from .models import QuoteState
from .snapshot import fetch_snapshot_payloads


class PriceTable(Static):
    def render(self) -> Table:
        app = self.app
        table = Table(expand=True, box=None, pad_edge=False)
        table.add_column("Symbol", ratio=2)
        table.add_column("Price", justify="right", ratio=2)
        table.add_column("Chg", justify="right", ratio=2)
        table.add_column("%", justify="right", ratio=2)
        table.add_column("State", justify="center", ratio=1)
        table.add_column("Age", justify="right", ratio=1)

        now = datetime.now(timezone.utc)
        for symbol in app.config.symbols:
            quote = app.quotes[symbol]
            is_stale = quote.is_stale(app.config.display.stale_after_seconds, now=now)
            symbol_text = Text(quote.symbol, style="bold")
            if is_stale:
                symbol_text.stylize("dim")

            price_text = Text(quote.price_label())
            change_text = Text(quote.change_label())
            percent_text = Text(quote.percent_label())
            status_text = Text(quote.status.upper())
            age_text = Text(quote.age_label(now=now))

            if quote.change is not None:
                if quote.change > 0:
                    change_text.stylize("green")
                    percent_text.stylize("green")
                elif quote.change < 0:
                    change_text.stylize("red")
                    percent_text.stylize("red")
                else:
                    change_text.stylize("yellow")
                    percent_text.stylize("yellow")

            if is_stale:
                for item in (price_text, change_text, percent_text, status_text, age_text):
                    item.stylize("dim")

            if quote.status == "open":
                status_text.stylize("green")
            elif quote.status == "pre":
                status_text.stylize("yellow")
            elif quote.status == "post":
                status_text.stylize("magenta")
            elif quote.status == "snap":
                status_text.stylize("cyan")
            elif quote.status == "waiting":
                status_text.stylize("dim")

            table.add_row(
                symbol_text,
                price_text,
                change_text,
                percent_text,
                status_text,
                age_text,
            )

        return table


class PriceViewerApp(App[None]):
    CSS = """
    Screen {
        layout: vertical;
    }

    #body {
        height: 1fr;
    }

    #status {
        height: auto;
        padding: 0 1;
    }

    #price-table {
        height: 1fr;
        padding: 0 1;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("r", "restart_stream", "Reconnect"),
    ]

    def __init__(self, config: AppConfig) -> None:
        super().__init__()
        self.config = config
        self.quotes = {symbol: QuoteState.placeholder(symbol) for symbol in config.symbols}
        self.stream_status = "idle"
        self.last_status_detail = "waiting to connect"
        self.last_message_at: datetime | None = None
        self.stream_task: asyncio.Task[None] | None = None
        self.snapshot_task: asyncio.Task[None] | None = None
        self.refresh_timer = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Container(id="body"):
            yield Static(id="status")
            yield PriceTable(id="price-table")
        yield Footer()

    def on_mount(self) -> None:
        self.title = self.config.title
        self.sub_title = ", ".join(self.config.symbols)
        self._update_status_line()
        interval_seconds = max(0.2, self.config.display.refresh_interval_ms / 1000)
        self.refresh_timer = self.set_interval(interval_seconds, self._refresh_clock)
        self.snapshot_task = asyncio.create_task(self._load_snapshot())
        self._restart_stream()

    async def on_unmount(self) -> None:
        if self.snapshot_task is not None:
            self.snapshot_task.cancel()
            try:
                await self.snapshot_task
            except asyncio.CancelledError:
                pass
        await self._stop_stream()

    async def action_restart_stream(self) -> None:
        await self._stop_stream()
        self._restart_stream()

    def _restart_stream(self) -> None:
        self.stream_task = asyncio.create_task(self._stream_loop())

    async def _stop_stream(self) -> None:
        if self.stream_task is None:
            return
        task = self.stream_task
        self.stream_task = None
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    def _refresh_clock(self) -> None:
        self._update_status_line()
        self.query_one(PriceTable).refresh()

    async def _load_snapshot(self) -> None:
        try:
            payloads = await asyncio.to_thread(
                fetch_snapshot_payloads,
                list(self.config.symbols),
            )
        except Exception as exc:
            detail = str(exc) or exc.__class__.__name__
            if self.stream_status in {"idle", "connecting"}:
                self._set_stream_status("snapshot-failed", detail)
            return

        for symbol, payload in payloads.items():
            if symbol in self.quotes:
                quote = self.quotes[symbol]
                if quote.update_count == 0:
                    quote.apply_snapshot(payload)

        if self.stream_status in {"idle", "connecting", "subscribed"}:
            self._set_stream_status("snapshot-ready", "loaded initial snapshot")
        self.query_one(PriceTable).refresh()

    def _set_stream_status(self, status: str, detail: str) -> None:
        self.stream_status = status
        self.last_status_detail = detail
        self._update_status_line()

    def _update_status_line(self) -> None:
        status_widget = self.query_one("#status", Static)
        symbol_count = len(self.config.symbols)
        last_message = "never"
        if self.last_message_at is not None:
            elapsed = int((datetime.now(timezone.utc) - self.last_message_at).total_seconds())
            last_message = f"{elapsed}s ago"
        config_label = (
            str(self.config.source_path)
            if self.config.source_path is not None
            else "cli symbols"
        )
        status_widget.update(
            f"stream={self.stream_status}  symbols={symbol_count}  last={last_message}  "
            f"detail={self.last_status_detail}  config={config_label}"
        )

    def _handle_stream_message(self, payload: dict) -> None:
        symbol = str(payload.get("id") or "").upper()
        if not symbol or symbol not in self.quotes:
            return
        self.quotes[symbol].apply_payload(payload)
        self.last_message_at = datetime.now(timezone.utc)
        self._set_stream_status("live", f"streaming {len(self.config.symbols)} symbols")
        self.query_one(PriceTable).refresh()

    async def _stream_loop(self) -> None:
        while True:
            socket = AsyncWebSocket(verbose=False)
            try:
                self._set_stream_status("connecting", "opening Yahoo Finance stream")
                await socket.subscribe(list(self.config.symbols))
                self._set_stream_status("subscribed", f"watching {len(self.config.symbols)} symbols")
                await socket.listen(self._handle_stream_message)
            except asyncio.CancelledError:
                self._set_stream_status("stopped", "stream stopped")
                try:
                    await socket.close()
                finally:
                    raise
            except Exception as exc:
                detail = str(exc) or exc.__class__.__name__
                for quote in self.quotes.values():
                    quote.mark_error(detail)
                self._set_stream_status("retrying", detail)
                try:
                    await socket.close()
                except Exception:
                    pass
                await asyncio.sleep(self.config.display.reconnect_delay_seconds)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="terminal_ticker",
        description="Small terminal price viewer using yfinance WebSocket",
    )
    parser.add_argument(
        "--config",
        default="watchlist.toml",
        help="path to a TOML watchlist config (default: watchlist.toml)",
    )
    parser.add_argument(
        "--symbols",
        nargs="+",
        help="override the config and watch these Yahoo Finance symbols",
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
    PriceViewerApp(config).run()
    return 0
