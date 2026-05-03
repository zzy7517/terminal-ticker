"""文件用途：配置层，解析 watchlist TOML、CLI 覆盖和运行配置。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
import tomllib

from .agent_models import (
    DEFAULT_CODEX_MODEL,
    normalize_api_mode,
    normalize_model,
    normalize_provider,
    normalize_reasoning_effort,
)

BITGET_SOURCE = "bitget"
ALPACA_SOURCE = "alpaca"
SUPPORTED_SOURCES = {BITGET_SOURCE, ALPACA_SOURCE}
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
    """说明：封装界面刷新、过期判断和 provider 轮询配置。"""
    refresh_interval_ms: int = 1000
    stale_after_seconds: int = 20
    reconnect_delay_seconds: float = 3.0
    stock_poll_interval_seconds: int = 5


@dataclass(frozen=True)
class AnalysisConfig:
    """说明：封装本地 price action 分析的周期、窗口和刷新配置。"""
    enabled: bool = True
    interval: str = "5m"
    lookback: int = 40
    poll_interval_seconds: int = 30
    stale_after_seconds: int = 420


@dataclass(frozen=True)
class CacheConfig:
    """说明：封装本地 K 线缓存的开关、路径和保留时间。"""
    enabled: bool = True
    path: Path | None = None
    candle_retention_seconds: int = 86_400


@dataclass(frozen=True)
class AgentConfig:
    """说明：封装 LLM Agent 的 provider、模型和请求参数。"""
    enabled: bool = True
    provider: str = "codex"
    api_mode: str = "codex_responses"
    model: str = DEFAULT_CODEX_MODEL
    timeout_seconds: float = 45.0
    max_candles: int = 40
    reasoning_effort: str = "medium"


@dataclass(frozen=True)
class InstrumentConfig:
    """说明：封装 watchlist 中尚未解析到 provider 的标的配置。"""
    symbol: str
    source: str = BITGET_SOURCE
    inst_type: str | None = None
    label: str | None = None
    show_collapsed: bool = True
    group: str = DEFAULT_GROUP
    analysis_interval: str | None = None

    @property
    def dedupe_key(self) -> tuple[str, str | None, str]:
        """说明：返回用于配置去重的 provider 级键。"""
        return (self.source, self.inst_type, self.symbol)


def _normalize_source(raw_value: Any) -> str:
    """说明：规范化数据源名称并拒绝未知 provider。"""
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
    """说明：封装应用运行所需的全部配置。"""
    instruments: tuple[InstrumentConfig, ...]
    display: DisplayConfig
    source_path: Path | None = None
    analysis: AnalysisConfig = AnalysisConfig()
    cache: CacheConfig = CacheConfig()
    agent: AgentConfig = AgentConfig()


def _normalize_inst_type(raw_value: Any) -> str | None:
    """说明：规范化 Bitget 合约类型。"""
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
    """说明：规范化可选展示标签。"""
    if raw_value is None:
        return None
    if not isinstance(raw_value, str):
        raise ValueError("label must be a string")
    label = raw_value.strip()
    return label or None


def _default_group(source: str) -> str:
    """说明：根据数据源选择默认 UI 分组。"""
    if source == BITGET_SOURCE:
        return "crypto"
    if source == ALPACA_SOURCE:
        return "stocks"
    return DEFAULT_GROUP


def _normalize_group(raw_value: Any, *, source: str) -> str:
    """说明：规范化 UI 分组并应用别名。"""
    if raw_value is None:
        return _default_group(source)
    if not isinstance(raw_value, str):
        raise ValueError("group must be a string")
    group = raw_value.strip().lower().replace("-", "_").replace(" ", "_")
    if not group:
        return _default_group(source)
    return GROUP_ALIASES.get(group, group)


def _normalize_bool(raw_value: Any, field_name: str, default: bool) -> bool:
    """说明：把 TOML 中的布尔类值转换成 bool。"""
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
    """说明：规范化 K 线分析周期。"""
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


def _normalize_optional_analysis_interval(raw_value: Any) -> str | None:
    """说明：规范化单个标的上的可选 K 线周期。"""
    if raw_value in (None, ""):
        return None
    return _normalize_analysis_interval(raw_value)


def _normalize_agent_provider(raw_value: Any) -> str:
    """说明：规范化 LLM provider 名称。"""
    return normalize_provider(raw_value)


def _normalize_reasoning_effort(raw_value: Any) -> str:
    """说明：规范化 Responses 风格模型的推理强度。"""
    return normalize_reasoning_effort(raw_value)


def parse_agent_config(raw_agent: dict[str, Any] | None) -> AgentConfig:
    """说明：把原始 Agent 配置解析为 AgentConfig。"""
    if raw_agent is None:
        raw_agent = {}
    if not isinstance(raw_agent, dict):
        raise ValueError("agent must be a table")
    agent_provider = _normalize_agent_provider(raw_agent.get("provider"))
    return AgentConfig(
        enabled=_normalize_bool(raw_agent.get("enabled"), "agent.enabled", True),
        provider=agent_provider,
        api_mode=normalize_api_mode(agent_provider, raw_agent.get("api_mode")),
        model=normalize_model(agent_provider, raw_agent.get("model")),
        timeout_seconds=_coerce_float(
            raw_agent.get("timeout_seconds"),
            "agent.timeout_seconds",
            45.0,
        ),
        max_candles=_coerce_min_int(raw_agent.get("max_candles"), "agent.max_candles", 40, 10),
        reasoning_effort=_normalize_reasoning_effort(raw_agent.get("reasoning_effort")),
    )


def parse_analysis_config(raw_analysis: dict[str, Any] | None) -> AnalysisConfig:
    """说明：把原始分析配置解析为 AnalysisConfig。"""
    if raw_analysis is None:
        raw_analysis = {}
    if not isinstance(raw_analysis, dict):
        raise ValueError("analysis must be a table")
    return AnalysisConfig(
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


def parse_cache_config(raw_cache: dict[str, Any] | None) -> CacheConfig:
    """说明：把原始缓存配置解析为 CacheConfig。"""
    if raw_cache is None:
        raw_cache = {}
    if not isinstance(raw_cache, dict):
        raise ValueError("cache must be a table")

    raw_path = raw_cache.get("path")
    cache_path = None
    if raw_path not in (None, ""):
        if not isinstance(raw_path, str):
            raise ValueError("cache.path must be a string")
        cache_path = Path(raw_path).expanduser()

    return CacheConfig(
        enabled=_normalize_bool(raw_cache.get("enabled"), "cache.enabled", True),
        path=cache_path,
        candle_retention_seconds=_coerce_int(
            raw_cache.get("candle_retention_seconds"),
            "cache.candle_retention_seconds",
            86_400,
        ),
    )


def _parse_symbol_string(raw_symbol: str, *, source: str = BITGET_SOURCE) -> InstrumentConfig:
    """说明：解析旧格式字符串标的配置。"""
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
    if source == ALPACA_SOURCE and normalized_symbol.endswith(".US"):
        normalized_symbol = normalized_symbol[:-3]
    if not normalized_symbol:
        raise ValueError("symbol entries cannot be blank")
    return InstrumentConfig(
        symbol=normalized_symbol,
        source=source,
        inst_type=inst_type,
        group=_default_group(source),
    )


def _normalize_instruments(symbols: Iterable[Any]) -> tuple[InstrumentConfig, ...]:
    """说明：规范化、校验并去重所有标的配置。"""
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
                analysis_interval=_normalize_optional_analysis_interval(
                    raw_symbol.get("analysis_interval", raw_symbol.get("interval")),
                ),
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
    """说明：把配置值转换成正整数。"""
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
    """说明：把配置值转换成带最小值限制的整数。"""
    value = _coerce_int(raw_value, field_name, default)
    if value < minimum:
        raise ValueError(f"{field_name} must be at least {minimum}")
    return value


def _coerce_float(raw_value: Any, field_name: str, default: float) -> float:
    """说明：把配置值转换成正浮点数。"""
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
    """说明：把原始 TOML 数据解析为应用配置。"""
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
        stock_poll_interval_seconds=_coerce_int(
            raw_display.get("stock_poll_interval_seconds"),
            "display.stock_poll_interval_seconds",
            5,
        ),
    )

    analysis = parse_analysis_config(data.get("analysis", {}))
    cache = parse_cache_config(data.get("cache", {}))

    agent = parse_agent_config(data.get("agent", {}))

    return AppConfig(
        instruments=instruments,
        display=display,
        analysis=analysis,
        cache=cache,
        agent=agent,
        source_path=source_path,
    )


def load_config(path: str | Path) -> AppConfig:
    """说明：读取 watchlist TOML 并解析为 AppConfig。"""
    source_path = Path(path).expanduser().resolve()
    with source_path.open("rb") as handle:
        data = tomllib.load(handle)
    return parse_config(data, source_path=source_path)


def build_runtime_config(
    file_config: AppConfig | None,
    *,
    cli_symbols: list[str] | None = None,
) -> AppConfig:
    """说明：合并文件配置和命令行标的覆盖。"""
    base = file_config or AppConfig(
        instruments=tuple(),
        display=DisplayConfig(),
        analysis=AnalysisConfig(),
        cache=CacheConfig(),
        agent=AgentConfig(),
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
        cache=base.cache,
        agent=base.agent,
        source_path=base.source_path,
    )
