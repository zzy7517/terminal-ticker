from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
import tomllib

SUPPORTED_INST_TYPES = {"SPOT", "USDT-FUTURES"}


@dataclass(frozen=True)
class DisplayConfig:
    refresh_interval_ms: int = 1000
    stale_after_seconds: int = 20
    reconnect_delay_seconds: float = 3.0


@dataclass(frozen=True)
class InstrumentConfig:
    symbol: str
    inst_type: str | None = None
    label: str | None = None

    @property
    def dedupe_key(self) -> tuple[str | None, str]:
        return (self.inst_type, self.symbol)


@dataclass(frozen=True)
class AppConfig:
    instruments: tuple[InstrumentConfig, ...]
    display: DisplayConfig
    source_path: Path | None = None


def _normalize_inst_type(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    if not isinstance(raw_value, str):
        raise ValueError("inst_type must be a string")
    inst_type = raw_value.strip().upper()
    if not inst_type:
        return None
    if inst_type not in SUPPORTED_INST_TYPES:
        supported = ", ".join(sorted(SUPPORTED_INST_TYPES))
        raise ValueError(f"inst_type must be one of: {supported}")
    return inst_type


def _normalize_label(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    if not isinstance(raw_value, str):
        raise ValueError("label must be a string")
    label = raw_value.strip()
    return label or None


def _parse_symbol_string(raw_symbol: str) -> InstrumentConfig:
    candidate = raw_symbol.strip()
    if not candidate:
        raise ValueError("symbol entries cannot be blank")

    inst_type = None
    symbol = candidate
    if ":" in candidate:
        maybe_inst_type, maybe_symbol = candidate.split(":", 1)
        normalized_inst_type = _normalize_inst_type(maybe_inst_type)
        if normalized_inst_type is not None:
            inst_type = normalized_inst_type
            symbol = maybe_symbol

    normalized_symbol = symbol.strip().upper()
    if not normalized_symbol:
        raise ValueError("symbol entries cannot be blank")
    return InstrumentConfig(symbol=normalized_symbol, inst_type=inst_type)


def _normalize_instruments(symbols: Iterable[Any]) -> tuple[InstrumentConfig, ...]:
    normalized: list[InstrumentConfig] = []
    seen: set[tuple[str | None, str]] = set()

    for raw_symbol in symbols:
        if isinstance(raw_symbol, str):
            instrument = _parse_symbol_string(raw_symbol)
        elif isinstance(raw_symbol, dict):
            instrument = InstrumentConfig(
                symbol=_parse_symbol_string(str(raw_symbol.get("symbol", ""))).symbol,
                inst_type=_normalize_inst_type(raw_symbol.get("inst_type")),
                label=_normalize_label(raw_symbol.get("label")),
            )
        else:
            raise ValueError("symbols entries must be strings or tables")

        if instrument.dedupe_key not in seen:
            normalized.append(instrument)
            seen.add(instrument.dedupe_key)

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
    raw_symbols = data.get("symbols")
    if not isinstance(raw_symbols, list):
        raise ValueError("symbols must be a list of Bitget symbol entries")
    instruments = _normalize_instruments(raw_symbols)

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
        instruments=instruments,
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
) -> AppConfig:
    base = file_config or AppConfig(
        instruments=tuple(),
        display=DisplayConfig(),
        source_path=None,
    )

    instruments = base.instruments
    if cli_symbols:
        instruments = _normalize_instruments(cli_symbols)
    if not instruments:
        raise ValueError("no symbols configured; use a config file or --symbols")

    return AppConfig(
        instruments=instruments,
        display=base.display,
        source_path=base.source_path,
    )
