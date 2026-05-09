"""文件用途：配置层，解析 watchlist TOML、CLI 覆盖和运行配置。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
import tomllib

from dataclasses import field

from .agent_models import (
    ANTHROPIC_PROVIDER,
    CODEX_PROVIDER,
    DEFAULT_ANTHROPIC_MODEL,
    DEFAULT_CODEX_MODEL,
    normalize_api_mode,
    normalize_model,
    normalize_provider,
    normalize_reasoning_effort,
)

BITGET_SOURCE = "bitget"
HYPERLIQUID_TESTNET_SOURCE = "hyperliquid-testnet"
SUPPORTED_SOURCES = {BITGET_SOURCE, HYPERLIQUID_TESTNET_SOURCE}
SUPPORTED_INST_TYPES = {"USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"}

# Reuters 现役新闻 sitemap。老的 /sitemap_news.xml 已下线（401/404）。
# 这里和 mytradebot.news.providers.reuters.DEFAULT_SITEMAP_URL 必须一致。
_DEFAULT_REUTERS_URL = "https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml"

# 旧 URL 集合——从用户 TOML 里读到这些会自动迁移到新 URL，
# 避免老 watchlist.toml 升级后一直 404。
_DEPRECATED_REUTERS_URLS = frozenset(
    {
        "https://www.reuters.com/sitemap_news.xml",
        "http://www.reuters.com/sitemap_news.xml",
    }
)
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
class ProviderProfile:
    """说明：单个 LLM provider 的启用状态和已选模型列表。"""
    enabled: bool = False
    models: tuple[str, ...] = ()
    model_efforts: tuple[tuple[str, str], ...] = ()

    @property
    def model(self) -> str:
        """说明：首选模型（向后兼容）。"""
        return self.models[0] if self.models else ""

    @property
    def reasoning_effort(self) -> str:
        """说明：首选模型的 reasoning effort（向后兼容）。"""
        return self.effort_for(self.model)

    def effort_for(self, model: str) -> str:
        """说明：返回指定模型的 reasoning effort，默认 medium。"""
        for slug, effort in self.model_efforts:
            if slug == model:
                return effort
        return "medium"


def _default_provider_profiles() -> dict[str, ProviderProfile]:
    return {
        CODEX_PROVIDER: ProviderProfile(enabled=True, models=(DEFAULT_CODEX_MODEL,)),
        ANTHROPIC_PROVIDER: ProviderProfile(enabled=False, models=(DEFAULT_ANTHROPIC_MODEL,)),
    }


@dataclass(frozen=True)
class AgentConfig:
    """说明：封装 LLM Agent 的 provider、模型和请求参数。"""
    enabled: bool = True
    provider: str = "codex"
    api_mode: str = "codex_responses"
    model: str = DEFAULT_CODEX_MODEL
    max_candles: int = 40
    reasoning_effort: str = "medium"
    provider_profiles: dict[str, ProviderProfile] = field(default_factory=_default_provider_profiles)


@dataclass(frozen=True)
class MemoryConfig:
    """说明：封装本地持久记忆的读写开关。"""
    enabled: bool = False
    use_memories: bool = True
    generate_memories: bool = True


@dataclass(frozen=True)
class NewsConfig:
    """说明：封装新闻抓取的开关、源地址和轮询参数。"""
    enabled: bool = False
    poll_interval_seconds: int = 30
    max_interval_seconds: int = 600
    reuters_url: str = _DEFAULT_REUTERS_URL
    request_timeout_seconds: float = 10.0
    retention_days: int = 30
    recent_limit: int = 50


@dataclass(frozen=True)
class SocialFeedConfig:
    """说明：封装社交流读取与本地缓存配置。"""

    enabled: bool = False
    recent_limit: int = 100
    retention_days: int = 30
    max_items: int = 2000


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
    memory: MemoryConfig = MemoryConfig()
    news: NewsConfig = NewsConfig()
    social_feed: SocialFeedConfig = SocialFeedConfig()


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
    if source in {BITGET_SOURCE, HYPERLIQUID_TESTNET_SOURCE}:
        return "crypto"
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


def _parse_models_field(name: str, raw: dict[str, Any]) -> tuple[str, ...]:
    """说明：从 provider 子表读取 models（数组）或 model（字符串），返回模型元组。"""
    raw_models = raw.get("models")
    if isinstance(raw_models, list):
        return tuple(normalize_model(name, m) for m in raw_models if m)
    raw_model = raw.get("model")
    if raw_model is not None:
        return (normalize_model(name, raw_model),)
    return (normalize_model(name, None),)


def _parse_model_efforts(name: str, raw: dict[str, Any]) -> tuple[tuple[str, str], ...]:
    """说明：解析 per-model reasoning effort 映射。"""
    raw_efforts = raw.get("model_efforts")
    if isinstance(raw_efforts, dict):
        return tuple(
            (str(k), _normalize_reasoning_effort(v))
            for k, v in raw_efforts.items()
            if isinstance(k, str) and k
        )
    # 旧格式兼容：全局 reasoning_effort → 应用到所有 models
    legacy = raw.get("reasoning_effort")
    if legacy is not None:
        models = _parse_models_field(name, raw)
        effort = _normalize_reasoning_effort(legacy)
        return tuple((m, effort) for m in models)
    return ()


def _parse_provider_profiles(
    raw_agent: dict[str, Any],
) -> dict[str, ProviderProfile]:
    """说明：从 [agent.providers.*] 子表或旧格式迁移出 per-provider 配置。"""
    raw_providers = raw_agent.get("providers")
    if isinstance(raw_providers, dict) and raw_providers:
        profiles: dict[str, ProviderProfile] = {}
        for name in (CODEX_PROVIDER, ANTHROPIC_PROVIDER):
            raw = raw_providers.get(name, {})
            if not isinstance(raw, dict):
                raw = {}
            profiles[name] = ProviderProfile(
                enabled=_normalize_bool(raw.get("enabled"), f"agent.providers.{name}.enabled", False),
                models=_parse_models_field(name, raw),
                model_efforts=_parse_model_efforts(name, raw),
            )
        return profiles

    # 旧格式迁移：单一 provider/model 字段 → 对应 profile 启用
    legacy_provider = raw_agent.get("provider")
    legacy_model = raw_agent.get("model")
    legacy_effort = raw_agent.get("reasoning_effort")
    defaults = _default_provider_profiles()
    if legacy_provider is not None:
        prov = _normalize_agent_provider(legacy_provider)
        model_slug = normalize_model(prov, legacy_model)
        effort = _normalize_reasoning_effort(legacy_effort)
        for name in defaults:
            if name == prov:
                defaults[name] = ProviderProfile(
                    enabled=True,
                    models=(model_slug,),
                    model_efforts=((model_slug, effort),),
                )
            else:
                defaults[name] = ProviderProfile(
                    enabled=False,
                    models=(normalize_model(name, None),),
                )
    return defaults


def _primary_from_profiles(profiles: dict[str, ProviderProfile]) -> tuple[str, str, str]:
    """说明：从 profiles 中选出首个启用的 provider，返回 (provider, model, reasoning_effort)。"""
    for name in (CODEX_PROVIDER, ANTHROPIC_PROVIDER):
        profile = profiles.get(name)
        if profile and profile.enabled:
            return name, profile.model, profile.reasoning_effort
    return CODEX_PROVIDER, DEFAULT_CODEX_MODEL, "medium"


def parse_agent_config(raw_agent: dict[str, Any] | None) -> AgentConfig:
    """说明：把原始 Agent 配置解析为 AgentConfig。"""
    if raw_agent is None:
        raw_agent = {}
    if not isinstance(raw_agent, dict):
        raise ValueError("agent must be a table")
    profiles = _parse_provider_profiles(raw_agent)
    primary_provider, primary_model, primary_effort = _primary_from_profiles(profiles)
    return AgentConfig(
        enabled=_normalize_bool(raw_agent.get("enabled"), "agent.enabled", True),
        provider=primary_provider,
        api_mode=normalize_api_mode(primary_provider, None),
        model=primary_model,
        max_candles=_coerce_min_int(raw_agent.get("max_candles"), "agent.max_candles", 40, 10),
        reasoning_effort=primary_effort,
        provider_profiles=profiles,
    )


def parse_memory_config(raw_memory: dict[str, Any] | None) -> MemoryConfig:
    """说明：把原始 memory 配置解析为 MemoryConfig。"""
    if raw_memory is None:
        raw_memory = {}
    if not isinstance(raw_memory, dict):
        raise ValueError("memory must be a table")
    return MemoryConfig(
        enabled=_normalize_bool(raw_memory.get("enabled"), "memory.enabled", False),
        use_memories=_normalize_bool(raw_memory.get("use_memories"), "memory.use_memories", True),
        generate_memories=_normalize_bool(
            raw_memory.get("generate_memories"),
            "memory.generate_memories",
            True,
        ),
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


def parse_news_config(raw_news: dict[str, Any] | None) -> NewsConfig:
    """说明：把原始新闻配置解析为 NewsConfig。"""
    if raw_news is None:
        raw_news = {}
    if not isinstance(raw_news, dict):
        raise ValueError("news must be a table")
    raw_url = raw_news.get("reuters_url")
    if raw_url is not None and not isinstance(raw_url, str):
        raise ValueError("news.reuters_url must be a string")
    reuters_url = raw_url.strip() if isinstance(raw_url, str) and raw_url.strip() else _DEFAULT_REUTERS_URL
    if reuters_url in _DEPRECATED_REUTERS_URLS:
        # 老 URL 已被 Reuters 下线，自动迁移到新 endpoint。
        reuters_url = _DEFAULT_REUTERS_URL
    return NewsConfig(
        enabled=_normalize_bool(raw_news.get("enabled"), "news.enabled", False),
        poll_interval_seconds=_coerce_min_int(
            raw_news.get("poll_interval_seconds"),
            "news.poll_interval_seconds",
            30,
            5,
        ),
        max_interval_seconds=_coerce_min_int(
            raw_news.get("max_interval_seconds"),
            "news.max_interval_seconds",
            600,
            30,
        ),
        reuters_url=reuters_url,
        request_timeout_seconds=_coerce_float(
            raw_news.get("request_timeout_seconds"),
            "news.request_timeout_seconds",
            10.0,
        ),
        retention_days=_coerce_min_int(
            raw_news.get("retention_days"),
            "news.retention_days",
            30,
            1,
        ),
        recent_limit=_coerce_min_int(
            raw_news.get("recent_limit"),
            "news.recent_limit",
            50,
            1,
        ),
    )


def parse_social_feed_config(raw_social_feed: dict[str, Any] | None) -> SocialFeedConfig:
    """说明：把原始 social_feed 配置解析为 SocialFeedConfig。"""
    if raw_social_feed is None:
        raw_social_feed = {}
    if not isinstance(raw_social_feed, dict):
        raise ValueError("social_feed must be a table")
    return SocialFeedConfig(
        enabled=_normalize_bool(raw_social_feed.get("enabled"), "social_feed.enabled", False),
        recent_limit=_coerce_min_int(
            raw_social_feed.get("recent_limit"),
            "social_feed.recent_limit",
            100,
            1,
        ),
        retention_days=_coerce_min_int(
            raw_social_feed.get("retention_days"),
            "social_feed.retention_days",
            30,
            1,
        ),
        max_items=_coerce_min_int(
            raw_social_feed.get("max_items"),
            "social_feed.max_items",
            2000,
            100,
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
            instrument_inst_type = (
                _normalize_inst_type(raw_symbol.get("inst_type"))
                if source == BITGET_SOURCE
                else None
            )
            instrument = InstrumentConfig(
                symbol=parsed.symbol,
                source=source,
                inst_type=instrument_inst_type,
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
    memory = parse_memory_config(data.get("memory", {}))
    news = parse_news_config(data.get("news", {}))
    social_feed = parse_social_feed_config(data.get("social_feed", {}))

    return AppConfig(
        instruments=instruments,
        display=display,
        analysis=analysis,
        cache=cache,
        agent=agent,
        memory=memory,
        news=news,
        social_feed=social_feed,
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
        memory=MemoryConfig(),
        news=NewsConfig(),
        social_feed=SocialFeedConfig(),
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
        memory=base.memory,
        news=base.news,
        social_feed=base.social_feed,
        source_path=base.source_path,
    )
