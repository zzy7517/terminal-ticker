"""Parse watchlist TOML and CLI overrides into runtime configuration."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
import tomllib

BITGET_SOURCE = "bitget"
LONGBRIDGE_SOURCE = "longbridge"
SUPPORTED_SOURCES = {BITGET_SOURCE, LONGBRIDGE_SOURCE}
SUPPORTED_INST_TYPES = {"SPOT", "USDT-FUTURES"}
SUPPORTED_ANALYSIS_INTERVALS = {
    "1m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1H",
    "4H",
    "6H",
    "12H",
    "1D",
    "3D",
    "1W",
    "1M",
}
DEFAULT_GROUP = "other"
GROUP_ALIASES = {
    "crypto": "crypto",
    "cryptos": "crypto",
    "coin": "crypto",
    "coins": "crypto",
    "stock": "stocks",
    "stocks": "stocks",
    "equity": "stocks",
    "equities": "stocks",
    "metal": "metals",
    "metals": "metals",
    "commodity": "metals",
    "commodities": "metals",
    "index": "indices",
    "indices": "indices",
    "watch": "watchlist",
    "watchlist": "watchlist",
    "custom": "watchlist",
    "other": DEFAULT_GROUP,
}


@dataclass(frozen=True)
class DisplayConfig:
    """Hold display timing and provider polling settings."""
    refresh_interval_ms: int = 1000
    stale_after_seconds: int = 20
    reconnect_delay_seconds: float = 3.0
    longbridge_poll_interval_seconds: int = 2


@dataclass(frozen=True)
class AnalysisConfig:
    """Hold local price action analysis settings."""
    enabled: bool = True
    interval: str = "5m"
    lookback: int = 40
    poll_interval_seconds: int = 30
    stale_after_seconds: int = 420


@dataclass(frozen=True)
class InstrumentConfig:
    """Represent one normalized watchlist entry before provider resolution."""
    symbol: str
    source: str = BITGET_SOURCE
    inst_type: str | None = None
    label: str | None = None
    show_collapsed: bool = True
    group: str = DEFAULT_GROUP

    @property
    def dedupe_key(self) -> tuple[str, str | None, str]:
        """Return the provider-specific key used to drop duplicate config entries."""
        return (self.source, self.inst_type, self.symbol)


def _normalize_source(raw_value: Any) -> str:
    """Normalize a raw provider source value and reject unsupported providers."""
    if raw_value is None:
        return BITGET_SOURCE
    if not isinstance(raw_value, str):
        raise ValueError("source must be a string")
    source = raw_value.strip().lower()
    if not source:
        return BITGET_SOURCE
    if source not in SUPPORTED_SOURCES:
        supported = ", ".join(sorted(SUPPORTED_SOURCES))
        raise ValueError(f"source must be one of: {supported}")
    return source


@dataclass(frozen=True)
class AppConfig:
    """Bundle normalized instruments, display settings, and the source config path."""
    instruments: tuple[InstrumentConfig, ...]
    display: DisplayConfig
    source_path: Path | None = None
    analysis: AnalysisConfig = AnalysisConfig()


def _normalize_inst_type(raw_value: Any) -> str | None:
    """Normalize a Bitget instrument type and reject unsupported types."""
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
    """Normalize an optional display label from TOML."""
    if raw_value is None:
        return None
    if not isinstance(raw_value, str):
        raise ValueError("label must be a string")
    label = raw_value.strip()
    return label or None


def _default_group(source: str) -> str:
    """Choose the default UI group for a provider source."""
    if source == BITGET_SOURCE:
        return "crypto"
    if source == LONGBRIDGE_SOURCE:
        return "stocks"
    return DEFAULT_GROUP


def _normalize_group(raw_value: Any, *, source: str) -> str:
    """Normalize a UI group name and apply known aliases."""
    if raw_value is None:
        return _default_group(source)
    if not isinstance(raw_value, str):
        raise ValueError("group must be a string")
    group = raw_value.strip().lower().replace("-", "_").replace(" ", "_")
    if not group:
        return _default_group(source)
    return GROUP_ALIASES.get(group, group)


def _normalize_bool(raw_value: Any, field_name: str, default: bool) -> bool:
    """Coerce a TOML boolean-like value into a Python bool."""
    if raw_value is None:
        return default
    if isinstance(raw_value, bool):
        return raw_value
    if isinstance(raw_value, str):
        normalized = raw_value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    raise ValueError(f"{field_name} must be a boolean")


def _normalize_analysis_interval(raw_value: Any) -> str:
    """Normalize a configured candle interval."""
    if raw_value is None:
        return "5m"
    if not isinstance(raw_value, str):
        raise ValueError("analysis.interval must be a string")
    value = raw_value.strip()
    aliases = {
        "1min": "1m",
        "3min": "3m",
        "5min": "5m",
        "15min": "15m",
        "30min": "30m",
        "1h": "1H",
        "4h": "4H",
        "6h": "6H",
        "12h": "12H",
        "1d": "1D",
        "3d": "3D",
        "1w": "1W",
        "1month": "1M",
    }
    normalized = aliases.get(value.lower(), value)
    if normalized not in SUPPORTED_ANALYSIS_INTERVALS:
        supported = ", ".join(sorted(SUPPORTED_ANALYSIS_INTERVALS))
        raise ValueError(f"analysis.interval must be one of: {supported}")
    return normalized


def _parse_symbol_string(raw_symbol: str, *, source: str = BITGET_SOURCE) -> InstrumentConfig:
    """Parse legacy string symbol entries into instrument config rows."""
    candidate = raw_symbol.strip()
    if not candidate:
        raise ValueError("symbol entries cannot be blank")

    inst_type = None
    symbol = candidate
    if source == BITGET_SOURCE and ":" in candidate:
        maybe_inst_type, maybe_symbol = candidate.split(":", 1)
        normalized_inst_type = _normalize_inst_type(maybe_inst_type)
        if normalized_inst_type is not None:
            inst_type = normalized_inst_type
            symbol = maybe_symbol

    normalized_symbol = symbol.strip().upper()
    if not normalized_symbol:
        raise ValueError("symbol entries cannot be blank")
    return InstrumentConfig(
        symbol=normalized_symbol,
        source=source,
        inst_type=inst_type,
        group=_default_group(source),
    )


def _normalize_instruments(symbols: Iterable[Any]) -> tuple[InstrumentConfig, ...]:
    """Normalize, validate, and deduplicate all configured symbols."""
    normalized: list[InstrumentConfig] = []
    seen: set[tuple[str, str | None, str]] = set()

    for raw_symbol in symbols:
        if isinstance(raw_symbol, str):
            instrument = _parse_symbol_string(raw_symbol)
        elif isinstance(raw_symbol, dict):
            source = _normalize_source(raw_symbol.get("source"))
            raw_symbol_value = raw_symbol.get("symbol")
            if raw_symbol_value is None:
                raise ValueError("symbol entries cannot be blank")
            parsed = _parse_symbol_string(str(raw_symbol_value), source=source)
            instrument = InstrumentConfig(
                symbol=parsed.symbol,
                source=source,
                inst_type=_normalize_inst_type(raw_symbol.get("inst_type"))
                if source == BITGET_SOURCE
                else None,
                label=_normalize_label(raw_symbol.get("label")),
                show_collapsed=_normalize_bool(
                    raw_symbol.get("show_collapsed"),
                    "show_collapsed",
                    True,
                ),
                group=_normalize_group(raw_symbol.get("group"), source=source),
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
    """Coerce a positive integer display setting."""
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{field_name} must be positive")
    return value


def _coerce_min_int(raw_value: Any, field_name: str, default: int, minimum: int) -> int:
    """Coerce an integer setting with a minimum accepted value."""
    value = _coerce_int(raw_value, field_name, default)
    if value < minimum:
        raise ValueError(f"{field_name} must be at least {minimum}")
    return value


def _coerce_float(raw_value: Any, field_name: str, default: float) -> float:
    """Coerce a positive float display setting."""
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
    """Parse raw TOML data into an application configuration."""
    raw_symbols = data.get("symbols")
    if not isinstance(raw_symbols, list):
        raise ValueError("symbols must be a list of symbol entries")
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
        longbridge_poll_interval_seconds=_coerce_int(
            raw_display.get("longbridge_poll_interval_seconds"),
            "display.longbridge_poll_interval_seconds",
            2,
        ),
    )

    raw_analysis = data.get("analysis", {})
    if raw_analysis is None:
        raw_analysis = {}
    if not isinstance(raw_analysis, dict):
        raise ValueError("analysis must be a table")
    analysis = AnalysisConfig(
        enabled=_normalize_bool(raw_analysis.get("enabled"), "analysis.enabled", True),
        interval=_normalize_analysis_interval(raw_analysis.get("interval")),
        lookback=_coerce_min_int(raw_analysis.get("lookback"), "analysis.lookback", 40, 10),
        poll_interval_seconds=_coerce_int(
            raw_analysis.get("poll_interval_seconds"),
            "analysis.poll_interval_seconds",
            30,
        ),
        stale_after_seconds=_coerce_int(
            raw_analysis.get("stale_after_seconds"),
            "analysis.stale_after_seconds",
            420,
        ),
    )

    return AppConfig(
        instruments=instruments,
        display=display,
        analysis=analysis,
        source_path=source_path,
    )


def load_config(path: str | Path) -> AppConfig:
    """Read a watchlist TOML file and parse it into AppConfig."""
    source_path = Path(path).expanduser().resolve()
    with source_path.open("rb") as handle:
        data = tomllib.load(handle)
    return parse_config(data, source_path=source_path)


def build_runtime_config(
    file_config: AppConfig | None,
    *,
    cli_symbols: list[str] | None = None,
) -> AppConfig:
    """Combine file config with optional CLI symbol overrides."""
    base = file_config or AppConfig(
        instruments=tuple(),
        display=DisplayConfig(),
        analysis=AnalysisConfig(),
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
        analysis=base.analysis,
        source_path=base.source_path,
    )
