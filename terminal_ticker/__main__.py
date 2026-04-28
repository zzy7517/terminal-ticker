"""Provide the command line entry point for the floating ticker app."""
from __future__ import annotations

import argparse
import signal
import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication

from .config import AppConfig, build_runtime_config, load_config
from .floating import FloatingTickerWindow
from .providers import resolve_instruments


def parse_args() -> argparse.Namespace:
    """Parse CLI options for the watchlist path and optional symbol override."""
    parser = argparse.ArgumentParser(
        prog="terminal_ticker",
        description="Compact floating market ticker window",
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
    """Load the TOML watchlist and apply any CLI symbol override."""
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
    """Create the Qt application, resolve instruments, and show the ticker window."""
    args = parse_args()
    config = resolve_config(args)
    instruments = resolve_instruments(config.instruments)

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(True)

    window = FloatingTickerWindow(config, instruments)

    def _request_quit(*_args) -> None:
        """Close the window cleanly when the process receives a quit signal."""
        window.close()
        app.quit()

    signal.signal(signal.SIGINT, _request_quit)
    signal.signal(signal.SIGTERM, _request_quit)

    window.show()
    window.raise_()
    window.activateWindow()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
