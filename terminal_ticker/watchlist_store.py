"""Persist Longbridge search additions and removals in watchlist TOML."""
from __future__ import annotations

from pathlib import Path
import tomllib

from .config import AgentConfig, GROUP_ALIASES, LONGBRIDGE_SOURCE, load_config


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


def update_agent_config_in_watchlist(path: str | Path, config: AgentConfig) -> bool:
    """Insert or replace the top-level [agent] table in a watchlist file."""
    source_path = Path(path).expanduser().resolve()
    text = source_path.read_text()
    lines = text.splitlines()
    next_lines = _format_agent_config(config)

    start_index: int | None = None
    end_index: int | None = None
    for index, line in enumerate(lines):
        if line.strip() == "[agent]":
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

    rendered = "\n".join(lines).rstrip() + "\n"
    if rendered == text:
        return False
    source_path.write_text(rendered)
    return True
