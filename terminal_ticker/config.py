from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
import tomllib


@dataclass(frozen=True)
class DisplayConfig:
    refresh_interval_ms: int = 1000
    stale_after_seconds: int = 20
    reconnect_delay_seconds: float = 3.0


@dataclass(frozen=True)
class AppConfig:
    title: str
    symbols: tuple[str, ...]
    display: DisplayConfig
    source_path: Path | None = None


def _normalize_symbols(symbols: Iterable[Any]) -> tuple[str, ...]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_symbol in symbols:
        if not isinstance(raw_symbol, str):
            raise ValueError("symbols must be strings")
        symbol = raw_symbol.strip().upper()
        if not symbol:
            continue
        if symbol not in seen:
            normalized.append(symbol)
            seen.add(symbol)
    if not normalized:
        raise ValueError("at least one symbol is required")
    return tuple(normalized)


def _coerce_int(raw_value: Any, field_name: str, default: int) -> int:
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{field_name} must be positive")
    return value


def _coerce_float(raw_value: Any, field_name: str, default: float) -> float:
    if raw_value is None:
        return default
    try:
        value = float(raw_value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a number") from exc
    if value <= 0:
        raise ValueError(f"{field_name} must be positive")
    return value


def parse_config(data: dict[str, Any], *, source_path: Path | None = None) -> AppConfig:
    title = data.get("title", "Price Viewer")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("title must be a non-empty string")

    raw_symbols = data.get("symbols")
    if not isinstance(raw_symbols, list):
        raise ValueError("symbols must be a list of Yahoo Finance symbols")
    symbols = _normalize_symbols(raw_symbols)

    raw_display = data.get("display", {})
    if raw_display is None:
        raw_display = {}
    if not isinstance(raw_display, dict):
        raise ValueError("display must be a table")

    display = DisplayConfig(
        refresh_interval_ms=_coerce_int(
            raw_display.get("refresh_interval_ms"),
            "display.refresh_interval_ms",
            1000,
        ),
        stale_after_seconds=_coerce_int(
            raw_display.get("stale_after_seconds"),
            "display.stale_after_seconds",
            20,
        ),
        reconnect_delay_seconds=_coerce_float(
            raw_display.get("reconnect_delay_seconds"),
            "display.reconnect_delay_seconds",
            3.0,
        ),
    )

    return AppConfig(
        title=title.strip(),
        symbols=symbols,
        display=display,
        source_path=source_path,
    )


def load_config(path: str | Path) -> AppConfig:
    source_path = Path(path).expanduser().resolve()
    with source_path.open("rb") as handle:
        data = tomllib.load(handle)
    return parse_config(data, source_path=source_path)


def build_runtime_config(
    file_config: AppConfig | None,
    *,
    cli_symbols: list[str] | None = None,
    cli_title: str | None = None,
) -> AppConfig:
    base = file_config or AppConfig(
        title="Price Viewer",
        symbols=tuple(),
        display=DisplayConfig(),
        source_path=None,
    )

    symbols = base.symbols
    if cli_symbols:
        symbols = _normalize_symbols(cli_symbols)
    if not symbols:
        raise ValueError("no symbols configured; use a config file or --symbols")

    title = base.title
    if cli_title and cli_title.strip():
        title = cli_title.strip()
    return AppConfig(
        title=title,
        symbols=symbols,
        display=base.display,
        source_path=base.source_path,
    )
