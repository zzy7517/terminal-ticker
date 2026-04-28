"""Persist Longbridge search additions and removals in watchlist TOML."""
from __future__ import annotations

from pathlib import Path
import re
import tomllib

from .config import (
    AgentConfig,
    AnalysisConfig,
    BITGET_SOURCE,
    GROUP_ALIASES,
    LONGBRIDGE_SOURCE,
    load_config,
)


def _toml_string(value: str) -> str:
    """Quote a string safely for the project TOML writer."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _normalize_longbridge_symbol(symbol: str) -> str:
    """Normalize a Longbridge symbol before writing or deleting it."""
    normalized = symbol.strip().upper()
    if not normalized:
        raise ValueError("symbol entries cannot be blank")
    return normalized


def _normalize_group(group: str | None) -> str:
    """Normalize a watchlist group before writing it."""
    if group is None:
        return "stocks"
    normalized = group.strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return "stocks"
    return GROUP_ALIASES.get(normalized, normalized)


def _format_longbridge_entry(
    *,
    symbol: str,
    label: str | None,
    group: str,
    show_collapsed: bool,
) -> str:
    """Render one inline TOML entry for a Longbridge symbol."""
    label_text = label or symbol.split(".", 1)[0]
    collapsed_text = "true" if show_collapsed else "false"
    return (
        "  { "
        f"symbol = {_toml_string(symbol)}, "
        'source = "longbridge", '
        f"label = {_toml_string(label_text)}, "
        f"group = {_toml_string(group)}, "
        f"show_collapsed = {collapsed_text}"
        " },"
    )


def _parse_inline_symbol_entry(line: str) -> dict | None:
    """Parse one inline TOML symbol entry when possible."""
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


def _is_longbridge_symbol_entry(line: str, symbol: str) -> bool:
    """Return whether a TOML line is the exact Longbridge symbol entry."""
    entry = _parse_inline_symbol_entry(line)
    if entry is None:
        return False
    source = str(entry.get("source") or "").strip().lower()
    raw_symbol = str(entry.get("symbol") or "").strip().upper()
    return source == LONGBRIDGE_SOURCE and raw_symbol == symbol


def _entry_source(entry: dict) -> str:
    """Return the normalized source for a parsed symbol entry."""
    return str(entry.get("source") or BITGET_SOURCE).strip().lower() or BITGET_SOURCE


def _entry_inst_type(entry: dict) -> str | None:
    """Return the normalized Bitget inst_type for a parsed symbol entry."""
    raw_inst_type = str(entry.get("inst_type") or "").strip().upper()
    return raw_inst_type or None


def _is_symbol_entry(
    line: str,
    *,
    source: str,
    symbol: str,
    inst_type: str | None,
) -> bool:
    """Return whether a TOML line is the exact provider symbol entry."""
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
    """Insert or replace analysis_interval in one inline TOML symbol entry."""
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


def append_longbridge_symbol_to_watchlist(
    path: str | Path,
    *,
    symbol: str,
    label: str | None = None,
    group: str = "stocks",
    show_collapsed: bool = True,
) -> bool:
    """Append a Longbridge symbol to the symbols array if it is absent."""
    source_path = Path(path).expanduser().resolve()
    normalized_symbol = _normalize_longbridge_symbol(symbol)
    normalized_group = _normalize_group(group)

    config = load_config(source_path)
    for instrument in config.instruments:
        if instrument.source == LONGBRIDGE_SOURCE and instrument.symbol == normalized_symbol:
            return False

    entry = _format_longbridge_entry(
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


def remove_longbridge_symbol_from_watchlist(
    path: str | Path,
    *,
    symbol: str,
) -> bool:
    """Remove the exact inline Longbridge symbol entry from a watchlist file."""
    source_path = Path(path).expanduser().resolve()
    normalized_symbol = _normalize_longbridge_symbol(symbol)

    config = load_config(source_path)
    exists = any(
        instrument.source == LONGBRIDGE_SOURCE and instrument.symbol == normalized_symbol
        for instrument in config.instruments
    )
    if not exists:
        return False

    lines = source_path.read_text().splitlines()
    for index, line in enumerate(lines):
        if _is_longbridge_symbol_entry(line, normalized_symbol):
            del lines[index]
            source_path.write_text("\n".join(lines) + "\n")
            return True

    raise ValueError(f"{normalized_symbol} exists but is not an inline longbridge symbol entry")


def update_instrument_analysis_interval_in_watchlist(
    path: str | Path,
    *,
    source: str,
    symbol: str,
    inst_type: str | None,
    interval: str,
) -> bool:
    """Persist a per-instrument K-line interval override in the symbols array."""
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
    """Render the agent config as a top-level TOML table."""
    lines = [
        "[agent]",
        f"enabled = {'true' if config.enabled else 'false'}",
        f"provider = {_toml_string(config.provider)}",
        f"api_mode = {_toml_string(config.api_mode)}",
        f"model = {_toml_string(config.model)}",
    ]
    if config.base_url:
        lines.append(f"base_url = {_toml_string(config.base_url)}")
    lines.extend(
        [
            f"timeout_seconds = {config.timeout_seconds:g}",
            f"max_candles = {config.max_candles}",
            f"reasoning_effort = {_toml_string(config.reasoning_effort)}",
        ]
    )
    return lines


def _replace_top_level_table(text: str, table_name: str, next_lines: list[str]) -> str:
    """Insert or replace one top-level TOML table."""
    lines = text.splitlines()
    start_index: int | None = None
    end_index: int | None = None
    header = f"[{table_name}]"
    for index, line in enumerate(lines):
        if line.strip() == header:
            start_index = index
            end_index = len(lines)
            for next_index in range(index + 1, len(lines)):
                stripped = lines[next_index].strip()
                if stripped.startswith("[") and stripped.endswith("]"):
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
    """Insert or replace the top-level [agent] table in a watchlist file."""
    source_path = Path(path).expanduser().resolve()
    text = source_path.read_text()
    rendered = _replace_top_level_table(text, "agent", _format_agent_config(config))
    if rendered == text:
        return False
    source_path.write_text(rendered)
    return True


def _format_analysis_config(config: AnalysisConfig) -> list[str]:
    """Render the analysis config as a top-level TOML table."""
    return [
        "[analysis]",
        f"enabled = {'true' if config.enabled else 'false'}",
        f"interval = {_toml_string(config.interval)}",
        f"lookback = {config.lookback}",
        f"poll_interval_seconds = {config.poll_interval_seconds}",
        f"stale_after_seconds = {config.stale_after_seconds}",
    ]


def update_analysis_config_in_watchlist(path: str | Path, config: AnalysisConfig) -> bool:
    """Insert or replace the top-level [analysis] table in a watchlist file."""
    source_path = Path(path).expanduser().resolve()
    text = source_path.read_text()
    rendered = _replace_top_level_table(text, "analysis", _format_analysis_config(config))
    if rendered == text:
        return False
    source_path.write_text(rendered)
    return True
