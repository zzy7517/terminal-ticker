"""文件用途：命令行入口，解析配置并启动本地 Web 服务。"""
from __future__ import annotations

import argparse
import logging
from collections.abc import Sequence
from pathlib import Path

import uvicorn

from .config import AppConfig, build_runtime_config, load_config
from .logging_config import DEFAULT_LOG_LEVEL, configure_logging, normalize_log_level, uvicorn_log_level
from .market_data.router import resolve_instruments
from .api.app import create_app

LOGGER = logging.getLogger(__name__)


def _parse_log_level(value: str) -> str:
    try:
        return normalize_log_level(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """说明：解析命令行参数。"""
    parser = argparse.ArgumentParser(
        prog="mytradebot",
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
        type=_parse_log_level,
        metavar="{debug,info,warning,error,critical}",
        help=f"application log level (default: {DEFAULT_LOG_LEVEL})",
    )
    return parser.parse_args(argv)


def resolve_config(args: argparse.Namespace) -> AppConfig:
    """说明：加载 watchlist 配置并合并命令行覆盖。"""
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
    """说明：解析配置、解析标的，并启动本地 Web 服务。"""
    args = parse_args()
    configure_logging(args.log_level)
    config = resolve_config(args)
    instruments = resolve_instruments(config.instruments)
    app = create_app(config=config, instruments=instruments)
    LOGGER.info("Starting mytradebot on %s:%s with %s instruments", args.host, args.port, len(instruments))
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level=uvicorn_log_level(args.log_level),
        log_config=None,
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
