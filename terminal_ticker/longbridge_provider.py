"""Resolve Longbridge instruments and fetch searchable US quote data."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
import os
import re
import time
from typing import Any

from .config import InstrumentConfig, LONGBRIDGE_SOURCE
from .price_action import Candle

LONGBRIDGE_ENV_VARS = (
    "LONGBRIDGE_APP_KEY",
    "LONGBRIDGE_APP_SECRET",
    "LONGBRIDGE_ACCESS_TOKEN",
)
DEFAULT_LONGBRIDGE_REGION = "cn"
SECURITY_LIST_CACHE_TTL_SECONDS = 15 * 60
US_SYMBOL_QUERY_RE = re.compile(r"^[A-Z0-9][A-Z0-9.-]{0,15}$")
_security_list_cache: tuple[float, tuple["LongbridgeSecurity", ...]] | None = None


@dataclass(frozen=True)
class LongbridgeInstrument:
    """Describe one resolved Longbridge quote instrument."""
    symbol: str
    label: str
    show_collapsed: bool = True
    source: str = LONGBRIDGE_SOURCE
    group: str = "stocks"

    @property
    def key(self) -> str:
        """Return the stable quote key used for Longbridge rows and events."""
        return f"{self.source}:{self.symbol}"


@dataclass(frozen=True)
class LongbridgeSecurity:
    """Represent one searchable Longbridge security list item."""
    symbol: str
    name_cn: str = ""
    name_hk: str = ""
    name_en: str = ""

    @property
    def default_label(self) -> str:
        """Return the default short label for a Longbridge security."""
        return self.symbol.split(".", 1)[0]

    def display_text(self) -> str:
        """Format a security for display in the search results list."""
        names = [name for name in (self.name_cn, self.name_hk, self.name_en) if name]
        suffix = f"  {' / '.join(names[:2])}" if names else ""
        return f"{self.symbol}{suffix}"


def resolve_instruments(
    configured: tuple[InstrumentConfig, ...],
) -> tuple[LongbridgeInstrument, ...]:
    """Map configured Longbridge rows into resolved instruments."""
    resolved: list[LongbridgeInstrument] = []
    for requested in configured:
        resolved.append(
            LongbridgeInstrument(
                symbol=requested.symbol,
                label=requested.label or requested.symbol,
                show_collapsed=requested.show_collapsed,
                group=requested.group,
            )
        )
    return tuple(resolved)


def _openapi() -> tuple[Any, Any]:
    """Import Longbridge OpenAPI classes and report a clear dependency error."""
    try:
        from longbridge.openapi import Config, QuoteContext
    except ImportError as exc:
        raise RuntimeError("longbridge package is required for Longbridge symbols") from exc
    return Config, QuoteContext


def _build_quote_context() -> Any:
    """Create a Longbridge quote context from environment credentials."""
    Config, QuoteContext = _openapi()
    # Credentials stay in environment variables, never in watchlist.toml.
    # The CN endpoint is materially faster for this user's setup; callers can
    # still override it with their own LONGBRIDGE_REGION before launching.
    os.environ.setdefault("LONGBRIDGE_REGION", DEFAULT_LONGBRIDGE_REGION)
    config_factory = getattr(Config, "from_apikey_env", None) or getattr(Config, "from_env")
    return QuoteContext(config_factory())


def _market_us() -> Any:
    """Return the Longbridge enum value for the US market."""
    try:
        from longbridge.openapi import Market
    except ImportError as exc:
        raise RuntimeError("longbridge package is required for Longbridge symbols") from exc
    return Market.US


def _security_list_category() -> Any:
    """Return the required Longbridge category for US security lists."""
    try:
        from longbridge.openapi import SecurityListCategory
    except ImportError as exc:
        raise RuntimeError("longbridge package is required for Longbridge symbols") from exc
    # Longbridge marks category as required for the security list endpoint.
    # As of the current API, US only supports the Overnight category.
    return SecurityListCategory.Overnight


def _as_float(raw_value: Any) -> float | None:
    """Convert a raw Longbridge numeric field into a float when possible."""
    if raw_value in (None, ""):
        return None
    if isinstance(raw_value, Decimal):
        return float(raw_value)
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def _as_int(raw_value: Any) -> int | None:
    """Convert a raw Longbridge integer field into an int when possible."""
    if raw_value in (None, ""):
        return None
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        return None


def _timestamp_to_ms(raw_value: Any) -> int | None:
    """Convert SDK candle timestamps into epoch milliseconds."""
    if raw_value in (None, ""):
        return None
    if isinstance(raw_value, datetime):
        return int(raw_value.timestamp() * 1000)
    value = _as_int(raw_value)
    if value is None:
        return None
    if value > 10_000_000_000:
        return value
    return value * 1000


def _field(quote: Any, name: str) -> Any:
    """Read a field from either a dict or SDK object."""
    if isinstance(quote, dict):
        return quote.get(name)
    return getattr(quote, name, None)


def _period_for_interval(interval: str) -> Any:
    """Map app intervals onto Longbridge SDK Period values."""
    try:
        from longbridge.openapi import Period
    except ImportError as exc:
        raise RuntimeError("longbridge package is required for Longbridge symbols") from exc
    mapping = {
        "1m": Period.Min_1,
        "3m": Period.Min_3,
        "5m": Period.Min_5,
        "15m": Period.Min_15,
        "30m": Period.Min_30,
        "1H": Period.Min_60,
        "4H": Period.Min_240,
        "1D": Period.Day,
        "1W": Period.Week,
        "1M": Period.Month,
    }
    period = mapping.get(interval)
    if period is None:
        raise ValueError(f"Longbridge candles do not support interval: {interval}")
    return period


def _no_adjust_type() -> Any:
    """Return the Longbridge no-adjust candle setting."""
    try:
        from longbridge.openapi import AdjustType
    except ImportError as exc:
        raise RuntimeError("longbridge package is required for Longbridge symbols") from exc
    return AdjustType.NoAdjust


def _all_trade_sessions() -> Any:
    """Return the Longbridge setting that includes pre, regular, post, and overnight sessions."""
    try:
        from longbridge.openapi import TradeSessions
    except ImportError as exc:
        raise RuntimeError("longbridge package is required for Longbridge symbols") from exc
    return TradeSessions.All


def _as_text(raw_value: Any) -> str:
    """Convert a raw SDK field into stripped display text."""
    if raw_value is None:
        return ""
    return str(raw_value).strip()


def _security_from_item(item: Any) -> LongbridgeSecurity | None:
    """Normalize an SDK security object into LongbridgeSecurity."""
    symbol = _as_text(_field(item, "symbol")).upper()
    if not symbol:
        return None
    return LongbridgeSecurity(
        symbol=symbol,
        name_cn=_as_text(_field(item, "name_cn")),
        name_hk=_as_text(_field(item, "name_hk")),
        name_en=_as_text(_field(item, "name_en")),
    )


def _candidate_us_symbol(query: str) -> str | None:
    """Convert a ticker-like query into a US symbol candidate."""
    compact = query.strip().upper()
    if not compact or any(char.isspace() for char in compact):
        return None
    if compact.endswith(".US"):
        candidate = compact
    else:
        candidate = f"{compact}.US"
    if US_SYMBOL_QUERY_RE.fullmatch(candidate):
        return candidate
    return None


def _is_explicit_us_symbol_query(query: str) -> bool:
    """Return whether a query explicitly names a suffixed market symbol."""
    compact = query.strip().upper()
    return compact.endswith(".US") or "." in compact


def clear_security_list_cache() -> None:
    """Clear the process-local Longbridge security list cache."""
    global _security_list_cache
    _security_list_cache = None


def fetch_security_static_info(
    symbol: str,
    *,
    quote_context: Any | None = None,
) -> tuple[LongbridgeSecurity, ...]:
    """Fetch exact Longbridge static info for one symbol."""
    ctx = quote_context or _build_quote_context()
    matches: list[LongbridgeSecurity] = []
    # Exact ticker searches should not download the whole US security list.
    # Longbridge static_info is keyed by symbol and is cheap enough for one-off lookup.
    for item in ctx.static_info([symbol]):
        security = _security_from_item(item)
        if security is not None:
            matches.append(security)
    return tuple(matches)


def fetch_security_list(
    *,
    quote_context: Any | None = None,
    now: float | None = None,
) -> tuple[LongbridgeSecurity, ...]:
    """Fetch and cache the Longbridge US Overnight security list."""
    global _security_list_cache

    current_time = time.monotonic() if now is None else now
    if quote_context is None and _security_list_cache is not None:
        cached_at, cached_items = _security_list_cache
        if current_time - cached_at < SECURITY_LIST_CACHE_TTL_SECONDS:
            return cached_items

    ctx = quote_context or _build_quote_context()
    securities: list[LongbridgeSecurity] = []
    # Longbridge exposes security_list rather than a keyword search endpoint.
    # The UI fetches the US Overnight list once, then filters by symbol/name locally.
    for item in ctx.security_list(_market_us(), _security_list_category()):
        security = _security_from_item(item)
        if security is not None:
            securities.append(security)

    result = tuple(securities)
    if quote_context is None:
        _security_list_cache = (current_time, result)
    return result


def _search_score(security: LongbridgeSecurity, query: str) -> tuple[int, str]:
    """Rank search matches by exactness and prefix quality."""
    symbol = security.symbol.upper()
    compact_symbol = symbol.split(".", 1)[0]
    query_upper = query.upper()
    query_lower = query.lower()
    names = (security.name_cn, security.name_hk, security.name_en)

    if query_upper in {symbol, compact_symbol}:
        return (0, symbol)
    if symbol.startswith(query_upper) or compact_symbol.startswith(query_upper):
        return (1, symbol)
    if query_upper in symbol:
        return (2, symbol)
    if any(name.lower().startswith(query_lower) for name in names if name):
        return (3, symbol)
    return (4, symbol)


def search_securities(
    query: str,
    *,
    limit: int = 20,
    quote_context: Any | None = None,
) -> tuple[LongbridgeSecurity, ...]:
    """Search Longbridge securities by exact ticker or cached local list filtering."""
    normalized = query.strip()
    if not normalized:
        return tuple()

    candidate_symbol = _candidate_us_symbol(normalized)
    if candidate_symbol is not None:
        try:
            exact_matches = fetch_security_static_info(
                candidate_symbol,
                quote_context=quote_context,
            )
        except Exception:
            if _is_explicit_us_symbol_query(normalized):
                raise
            exact_matches = tuple()
        if exact_matches or _is_explicit_us_symbol_query(normalized):
            return exact_matches[:limit]

    query_upper = normalized.upper()
    query_lower = normalized.lower()
    matches: list[LongbridgeSecurity] = []
    for security in fetch_security_list(quote_context=quote_context):
        haystack = " ".join(
            (
                security.symbol.upper(),
                security.symbol.lower(),
                security.name_cn.lower(),
                security.name_hk.lower(),
                security.name_en.lower(),
            )
        )
        if query_upper in haystack.upper() or query_lower in haystack:
            matches.append(security)

    matches.sort(key=lambda item: _search_score(item, normalized))
    return tuple(matches[:limit])


def _normalize_quote_payload(
    quote: Any,
    instrument: LongbridgeInstrument,
) -> dict[str, Any]:
    """Convert a Longbridge quote into the app quote payload shape."""
    price = _as_float(_field(quote, "last_done"))
    previous_close = _as_float(_field(quote, "prev_close"))
    change = None
    change_percent = None
    if price is not None and previous_close not in (None, 0):
        change = price - previous_close
        change_percent = (change / previous_close) * 100

    return {
        "id": instrument.key,
        "short_name": instrument.label,
        "display_name": instrument.label,
        "price": price,
        "change": change,
        "change_percent": change_percent,
        "previous_close": previous_close,
        "day_high": _as_float(_field(quote, "high")),
        "day_low": _as_float(_field(quote, "low")),
        "day_volume": _as_float(_field(quote, "volume")),
        "volume": _as_float(_field(quote, "volume")),
        "currency": "",
        "exchange": "Longbridge",
        "status": str(_field(quote, "trade_status") or "longbridge").lower(),
        "time": _as_int(_field(quote, "timestamp")),
    }


def _normalize_candle_payload(
    candle: Any,
    instrument: LongbridgeInstrument,
) -> Candle:
    """Convert one Longbridge candle object into the app candle shape."""
    open_time_ms = _timestamp_to_ms(_field(candle, "timestamp"))
    open_ = _as_float(_field(candle, "open"))
    high = _as_float(_field(candle, "high"))
    low = _as_float(_field(candle, "low"))
    close = _as_float(_field(candle, "close"))
    volume = _as_float(_field(candle, "volume"))
    if None in (open_time_ms, open_, high, low, close, volume):
        raise RuntimeError("Longbridge candle returned unexpected payload")
    return Candle(
        symbol_key=instrument.key,
        open_time_ms=open_time_ms,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume,
    )


def fetch_candles(
    instrument: LongbridgeInstrument,
    *,
    interval: str,
    limit: int,
    quote_context: Any | None = None,
) -> tuple[Candle, ...]:
    """Fetch recent Longbridge candles for one instrument."""
    ctx = quote_context or _build_quote_context()
    rows = ctx.candlesticks(
        instrument.symbol,
        _period_for_interval(interval),
        min(limit, 1000),
        _no_adjust_type(),
        _all_trade_sessions(),
    )
    candles = tuple(_normalize_candle_payload(row, instrument) for row in rows)
    return tuple(sorted(candles, key=lambda candle: candle.open_time_ms))


def fetch_quote_payloads(
    instruments: tuple[LongbridgeInstrument, ...],
    *,
    quote_context: Any | None = None,
) -> dict[str, dict[str, Any]]:
    """Fetch Longbridge quote payloads for configured instruments."""
    payloads: dict[str, dict[str, Any]] = {}
    if not instruments:
        return payloads

    ctx = quote_context or _build_quote_context()
    instruments_by_symbol = {instrument.symbol: instrument for instrument in instruments}
    # Longbridge accepts up to 500 symbols per quote request.
    for quote in ctx.quote(list(instruments_by_symbol)):
        symbol = str(_field(quote, "symbol") or "")
        instrument = instruments_by_symbol.get(symbol)
        if instrument is not None:
            payloads[instrument.key] = _normalize_quote_payload(quote, instrument)
    return payloads
