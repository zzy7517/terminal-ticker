"""Provide the command line entry point for the web price action app."""
from __future__ import annotations

import argparse
import logging
from pathlib import Path

import uvicorn

from .config import AppConfig, build_runtime_config, load_config
from .logging_config import DEFAULT_LOG_LEVEL, configure_logging
from .providers import resolve_instruments
from .web import create_app

LOGGER = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    """Parse CLI options for the watchlist path and web server."""
    parser = argparse.ArgumentParser(
        prog="terminal_ticker",
        description="Local web UI for price action monitoring",
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
    parser.add_argument("--host", default="127.0.0.1", help="server host")
    parser.add_argument("--port", default=8765, type=int, help="server port")
    parser.add_argument(
        "--log-level",
        default=DEFAULT_LOG_LEVEL,
        choices=("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"),
        help=f"application log level (default: {DEFAULT_LOG_LEVEL})",
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
    """Resolve instruments and run the local web server."""
    args = parse_args()
    configure_logging(args.log_level)
    config = resolve_config(args)
    instruments = resolve_instruments(config.instruments)
    app = create_app(config=config, instruments=instruments)
    LOGGER.info("Starting terminal_ticker on %s:%s with %s instruments", args.host, args.port, len(instruments))
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level.lower())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
