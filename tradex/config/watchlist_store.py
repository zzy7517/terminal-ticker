"""文件用途：配置写入层，把前端 watchlist 和分析设置变更持久化到 TOML。"""
from __future__ import annotations

from pathlib import Path
import re
import tomllib

from . import (
    AgentConfig,
    AnalysisConfig,
    MemoryConfig,
    NewsConfig,
    SocialFeedConfig,
    TradingConfig,
    BITGET_SOURCE,
    GROUP_ALIASES,
    HYPERLIQUID_SOURCE,
    SUPPORTED_INST_TYPES,
    load_config,
)


def _toml_string(value: str) -> str:
    """说明：把字符串安全地写成 TOML 字面量。"""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _normalize_bitget_symbol(symbol: str) -> str:
    """说明：写入或删除前规范化 Bitget 标的代码。"""
    normalized = symbol.strip().upper()
    if not normalized:
        raise ValueError("symbol entries cannot be blank")
    return normalized


def _normalize_hyperliquid_symbol(symbol: str) -> str:
    """说明：写入或删除前规范化 Hyperliquid coin 名称。"""
    value = symbol.strip()
    if ":" in value:
        dex, coin = value.split(":", 1)
        normalized = f"{dex.strip().lower()}:{coin.strip().upper()}"
    else:
        normalized = value.upper()
    if not normalized:
        raise ValueError("symbol entries cannot be blank")
    return normalized


def _normalize_bitget_inst_type(inst_type: str | None) -> str:
    """说明：写入或删除前规范化 Bitget 合约类型。"""
    normalized = str(inst_type or "").strip().upper()
    if normalized not in SUPPORTED_INST_TYPES:
        supported = ", ".join(sorted(SUPPORTED_INST_TYPES))
        raise ValueError(f"inst_type must be one of: {supported}")
    return normalized


def _normalize_group(group: str | None) -> str:
    """说明：规范化 UI 分组并应用别名。"""
    if group is None:
        return "stocks"
    normalized = group.strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return "stocks"
    return GROUP_ALIASES.get(normalized, normalized)


def _format_bitget_entry(
    *,
    symbol: str,
    inst_type: str,
    label: str | None,
    group: str,
    show_collapsed: bool,
) -> str:
    """说明：渲染一行 Bitget inline TOML 标的配置。"""
    label_text = label or symbol
    collapsed_text = "true" if show_collapsed else "false"
    return (
        "  { "
        f"symbol = {_toml_string(symbol)}, "
        'source = "bitget", '
        f"inst_type = {_toml_string(inst_type)}, "
        f"label = {_toml_string(label_text)}, "
        f"group = {_toml_string(group)}, "
        f"show_collapsed = {collapsed_text}"
        " },"
    )


def _format_hyperliquid_entry(
    *,
    symbol: str,
    label: str | None,
    group: str,
    show_collapsed: bool,
) -> str:
    """说明：渲染一行 Hyperliquid inline TOML 标的配置。"""
    label_text = label or f"{symbol} Perp"
    collapsed_text = "true" if show_collapsed else "false"
    return (
        "  { "
        f"symbol = {_toml_string(symbol)}, "
        f"source = {_toml_string(HYPERLIQUID_SOURCE)}, "
        f"label = {_toml_string(label_text)}, "
        f"group = {_toml_string(group)}, "
        f"show_collapsed = {collapsed_text}"
        " },"
    )


def _parse_inline_symbol_entry(line: str) -> dict | None:
    """说明：尽量解析一行 inline TOML 标的配置。"""
    stripped = line.strip()
    if not stripped.startswith("{"):
        return None
    candidate = stripped.rstrip(",")
    try:
        parsed = tomllib.loads(f"symbols = [{candidate}]\n")
    except tomllib.TOMLDecodeError:
        return None
    symbols = parsed.get("symbols")
    if not isinstance(symbols, list) or len(symbols) != 1:
        return None
    entry = symbols[0]
    return entry if isinstance(entry, dict) else None


def _entry_source(entry: dict) -> str:
    """说明：读取 inline 标的配置的数据源。"""
    return str(entry.get("source") or BITGET_SOURCE).strip().lower() or BITGET_SOURCE


def _entry_inst_type(entry: dict) -> str | None:
    """说明：读取 inline 标的配置的 Bitget 合约类型。"""
    raw_inst_type = str(entry.get("inst_type") or "").strip().upper()
    return raw_inst_type or None


def _is_symbol_entry(
    line: str,
    *,
    source: str,
    symbol: str,
    inst_type: str | None,
) -> bool:
    """说明：判断一行 TOML 是否为指定 provider 标的。"""
    entry = _parse_inline_symbol_entry(line)
    if entry is None:
        return False
    raw_symbol = str(entry.get("symbol") or "").strip().upper()
    return (
        _entry_source(entry) == source
        and raw_symbol == symbol
        and _entry_inst_type(entry) == inst_type
    )


def _set_inline_analysis_interval(line: str, interval: str) -> str:
    """说明：在一行 inline TOML 标的配置中插入或替换分析周期。"""
    replacement = f"analysis_interval = {_toml_string(interval)}"
    if _parse_inline_symbol_entry(line) is None:
        raise ValueError("symbol entry is not an inline TOML table")
    if "analysis_interval" in line:
        return re.sub(r"analysis_interval\s*=\s*[^,}]+", replacement, line, count=1)

    stripped = line.rstrip()
    has_trailing_comma = stripped.endswith(",")
    body = stripped[:-1].rstrip() if has_trailing_comma else stripped
    close_index = body.rfind("}")
    if close_index < 0:
        raise ValueError("symbol entry is not an inline TOML table")
    prefix = body[:close_index].rstrip()
    suffix = body[close_index:]
    separator = "" if prefix.endswith("{") else ","
    updated = f"{prefix}{separator} {replacement} {suffix}"
    return f"{updated}," if has_trailing_comma else updated


def append_bitget_symbol_to_watchlist(
    path: str | Path,
    *,
    symbol: str,
    inst_type: str,
    label: str | None = None,
    group: str = "crypto",
    show_collapsed: bool = True,
) -> bool:
    """说明：不存在时把 Bitget 标的追加到 symbols 数组。"""
    source_path = Path(path).expanduser().resolve()
    normalized_symbol = _normalize_bitget_symbol(symbol)
    normalized_inst_type = _normalize_bitget_inst_type(inst_type)
    normalized_group = _normalize_group(group)

    config = load_config(source_path)
    for instrument in config.instruments:
        if (
            instrument.source == BITGET_SOURCE
            and instrument.symbol == normalized_symbol
            and instrument.inst_type == normalized_inst_type
        ):
            return False

    entry = _format_bitget_entry(
        symbol=normalized_symbol,
        inst_type=normalized_inst_type,
        label=label,
        group=normalized_group,
        show_collapsed=show_collapsed,
    )
    text = source_path.read_text()
    lines = text.splitlines()

    start_index: int | None = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("symbols") and "[" in stripped:
            start_index = index
            break

    if start_index is None:
        if text and not text.endswith("\n"):
            text += "\n"
        text += f"\nsymbols = [\n{entry}\n]\n"
        source_path.write_text(text)
        return True

    for index in range(start_index + 1, len(lines)):
        if lines[index].strip() == "]":
            lines.insert(index, entry)
            source_path.write_text("\n".join(lines) + "\n")
            return True

    raise ValueError("symbols array is not closed")


def append_hyperliquid_symbol_to_watchlist(
    path: str | Path,
    *,
    symbol: str,
    label: str | None = None,
    group: str = "crypto",
    show_collapsed: bool = True,
) -> bool:
    """说明：不存在时把 Hyperliquid 标的追加到 symbols 数组。"""
    source_path = Path(path).expanduser().resolve()
    normalized_symbol = _normalize_hyperliquid_symbol(symbol)
    normalized_group = _normalize_group(group)

    config = load_config(source_path)
    for instrument in config.instruments:
        if (
            instrument.source == HYPERLIQUID_SOURCE
            and instrument.symbol == normalized_symbol
        ):
            return False

    entry = _format_hyperliquid_entry(
        symbol=normalized_symbol,
        label=label,
        group=normalized_group,
        show_collapsed=show_collapsed,
    )
    text = source_path.read_text()
    lines = text.splitlines()

    start_index: int | None = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("symbols") and "[" in stripped:
            start_index = index
            break

    if start_index is None:
        if text and not text.endswith("\n"):
            text += "\n"
        text += f"\nsymbols = [\n{entry}\n]\n"
        source_path.write_text(text)
        return True

    for index in range(start_index + 1, len(lines)):
        if lines[index].strip() == "]":
            lines.insert(index, entry)
            source_path.write_text("\n".join(lines) + "\n")
            return True

    raise ValueError("symbols array is not closed")


def remove_symbol_from_watchlist(
    path: str | Path,
    *,
    source: str,
    symbol: str,
    inst_type: str | None,
) -> bool:
    """说明：从 watchlist 文件中删除指定 provider 标的。"""
    source_path = Path(path).expanduser().resolve()
    normalized_source = source.strip().lower()
    normalized_symbol = symbol.strip().upper()
    normalized_inst_type = inst_type.strip().upper() if inst_type else None

    config = load_config(source_path)
    exists = any(
        instrument.source == normalized_source
        and instrument.symbol == normalized_symbol
        and instrument.inst_type == normalized_inst_type
        for instrument in config.instruments
    )
    if not exists:
        return False
    if len(config.instruments) <= 1:
        raise ValueError("cannot remove the last watchlist symbol")

    lines = source_path.read_text().splitlines()
    for index, line in enumerate(lines):
        if _is_symbol_entry(
            line,
            source=normalized_source,
            symbol=normalized_symbol,
            inst_type=normalized_inst_type,
        ):
            del lines[index]
            source_path.write_text("\n".join(lines) + "\n")
            return True

    raise ValueError(f"{normalized_source}:{normalized_symbol} exists but is not an inline symbol entry")


def update_instrument_analysis_interval_in_watchlist(
    path: str | Path,
    *,
    source: str,
    symbol: str,
    inst_type: str | None,
    interval: str,
) -> bool:
    """说明：持久化单个标的的 K 线周期覆盖。"""
    source_path = Path(path).expanduser().resolve()
    normalized_source = source.strip().lower()
    normalized_symbol = symbol.strip().upper()
    normalized_inst_type = inst_type.strip().upper() if inst_type else None

    lines = source_path.read_text().splitlines()
    for index, line in enumerate(lines):
        if _is_symbol_entry(
            line,
            source=normalized_source,
            symbol=normalized_symbol,
            inst_type=normalized_inst_type,
        ):
            next_line = _set_inline_analysis_interval(line, interval)
            if next_line == line:
                return False
            lines[index] = next_line
            source_path.write_text("\n".join(lines) + "\n")
            return True

    raise ValueError(f"{normalized_source}:{normalized_symbol} exists but is not an inline symbol entry")


def _format_agent_config(config: AgentConfig) -> list[str]:
    """说明：把 AgentConfig 渲染成顶层 TOML 表（含 per-provider 子表）。"""
    lines = [
        "[agent]",
        f"enabled = {'true' if config.enabled else 'false'}",
        f"max_candles = {config.max_candles}",
    ]
    for name, profile in config.provider_profiles.items():
        lines.append("")
        lines.append(f"[agent.providers.{name}]")
        lines.append(f"enabled = {'true' if profile.enabled else 'false'}")
        if profile.api_key:
            lines.append(f"api_key = {_toml_string(profile.api_key)}")
        if profile.base_url:
            lines.append(f"base_url = {_toml_string(profile.base_url)}")
        models_arr = ", ".join(_toml_string(m) for m in profile.models)
        lines.append(f"models = [{models_arr}]")
        if profile.model_efforts:
            efforts_parts = ", ".join(
                f"{_toml_string(slug)} = {_toml_string(effort)}"
                for slug, effort in profile.model_efforts
            )
            lines.append(f"model_efforts = {{{efforts_parts}}}")
    return lines


def _replace_top_level_table(text: str, table_name: str, next_lines: list[str]) -> str:
    """说明：插入或替换一个顶层 TOML 表（含子表）。"""
    lines = text.splitlines()
    start_index: int | None = None
    end_index: int | None = None
    header = f"[{table_name}]"
    sub_prefix = f"[{table_name}."
    for index, line in enumerate(lines):
        if line.strip() == header:
            start_index = index
            end_index = len(lines)
            for next_index in range(index + 1, len(lines)):
                stripped = lines[next_index].strip()
                if stripped.startswith("[") and stripped.endswith("]"):
                    if stripped.startswith(sub_prefix):
                        continue
                    end_index = next_index
                    break
            break

    if start_index is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend(next_lines)
    else:
        lines[start_index:end_index] = next_lines

    return "\n".join(lines).rstrip() + "\n"


def update_agent_config_in_watchlist(path: str | Path, config: AgentConfig) -> bool:
    """说明：在 watchlist 文件中插入或替换 agent 配置表。"""
    source_path = Path(path).expanduser().resolve()
    text = source_path.read_text()
    rendered = _replace_top_level_table(text, "agent", _format_agent_config(config))
    if rendered == text:
        return False
    source_path.write_text(rendered)
    return True


def _format_analysis_config(config: AnalysisConfig) -> list[str]:
    """说明：把 AnalysisConfig 渲染成顶层 TOML 表。"""
    return [
        "[analysis]",
        f"enabled = {'true' if config.enabled else 'false'}",
        f"interval = {_toml_string(config.interval)}",
        f"lookback = {config.lookback}",
        f"poll_interval_seconds = {config.poll_interval_seconds}",
        f"stale_after_seconds = {config.stale_after_seconds}",
    ]


def update_analysis_config_in_watchlist(path: str | Path, config: AnalysisConfig) -> bool:
    """说明：在 watchlist 文件中插入或替换 analysis 配置表。"""
    source_path = Path(path).expanduser().resolve()
    text = source_path.read_text()
    rendered = _replace_top_level_table(text, "analysis", _format_analysis_config(config))
    if rendered == text:
        return False
    source_path.write_text(rendered)
    return True


def _format_news_config(config: NewsConfig) -> list[str]:
    """说明：把 NewsConfig 渲染成顶层 TOML 表。"""
    return [
        "[news]",
        f"enabled = {'true' if config.enabled else 'false'}",
        f"poll_interval_seconds = {config.poll_interval_seconds}",
        f"max_interval_seconds = {config.max_interval_seconds}",
        f"reuters_url = {_toml_string(config.reuters_url)}",
        f"request_timeout_seconds = {config.request_timeout_seconds:g}",
        f"retention_days = {config.retention_days}",
        f"recent_limit = {config.recent_limit}",
    ]


def update_news_config_in_watchlist(path: str | Path, config: NewsConfig) -> bool:
    """说明：在 watchlist 文件中插入或替换 news 配置表。"""
    source_path = Path(path).expanduser().resolve()
    text = source_path.read_text()
    rendered = _replace_top_level_table(text, "news", _format_news_config(config))
    if rendered == text:
        return False
    source_path.write_text(rendered)
    return True


def _format_social_feed_config(config: SocialFeedConfig) -> list[str]:
    """说明：把 SocialFeedConfig 渲染成顶层 TOML 表。"""
    return [
        "[social_feed]",
        f"enabled = {'true' if config.enabled else 'false'}",
        f"recent_limit = {config.recent_limit}",
        f"retention_days = {config.retention_days}",
        f"max_items = {config.max_items}",
    ]


def update_social_feed_config_in_watchlist(path: str | Path, config: SocialFeedConfig) -> bool:
    """说明：在 watchlist 文件中插入或替换 social_feed 配置表。"""
    source_path = Path(path).expanduser().resolve()
    text = source_path.read_text()
    rendered = _replace_top_level_table(text, "social_feed", _format_social_feed_config(config))
    if rendered == text:
        return False
    source_path.write_text(rendered)
    return True


def _format_memory_config(config: MemoryConfig) -> list[str]:
    """说明：把 MemoryConfig 渲染成顶层 TOML 表。"""
    lines = [
        "[memory]",
        f"enabled = {'true' if config.enabled else 'false'}",
        f"use_memories = {'true' if config.use_memories else 'false'}",
        f"generate_memories = {'true' if config.generate_memories else 'false'}",
        f"max_raw_memories_for_consolidation = {config.max_raw_memories_for_consolidation}",
        f"max_unused_days = {config.max_unused_days}",
        f"max_source_age_days = {config.max_source_age_days}",
        f"max_rollouts_per_startup = {config.max_rollouts_per_startup}",
        f"min_session_idle_hours = {config.min_session_idle_hours}",
        f"extension_retention_days = {config.extension_retention_days}",
    ]
    if config.storage_path:
        lines.append(f"storage_path = {_toml_string(config.storage_path)}")
    if config.extract_model:
        lines.append(f"extract_model = {_toml_string(config.extract_model)}")
    if config.consolidation_model:
        lines.append(f"consolidation_model = {_toml_string(config.consolidation_model)}")
    return lines


def update_memory_config_in_watchlist(path: str | Path, config: MemoryConfig) -> bool:
    """说明：在 watchlist 文件中插入或替换 memory 配置表。"""
    source_path = Path(path).expanduser().resolve()
    text = source_path.read_text()
    rendered = _replace_top_level_table(text, "memory", _format_memory_config(config))
    if rendered == text:
        return False
    source_path.write_text(rendered)
    return True


def _format_trading_config(config: TradingConfig) -> list[str]:
    """说明：把 TradingConfig 渲染成顶层 TOML 表。"""
    return [
        "[trading]",
        f"hyperliquid_enabled = {'true' if config.hyperliquid_enabled else 'false'}",
        f"bitget_demo_enabled = {'true' if config.bitget_demo_enabled else 'false'}",
    ]


def update_trading_config_in_watchlist(path: str | Path, config: TradingConfig) -> bool:
    """说明：在 watchlist 文件中插入或替换 trading 配置表。"""
    source_path = Path(path).expanduser().resolve()
    text = source_path.read_text()
    rendered = _replace_top_level_table(text, "trading", _format_trading_config(config))
    if rendered == text:
        return False
    source_path.write_text(rendered)
    return True
