"""Store and format normalized quote state for display."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .price_action import PriceActionState


def _to_float(raw_value: Any) -> float | None:
    """Convert a raw quote value into a float when possible."""
    if raw_value in (None, ""):
        return None
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def _to_int(raw_value: Any) -> int | None:
    """Convert a raw quote value into an integer when possible."""
    if raw_value in (None, ""):
        return None
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        return None


def _coalesce(new_value: Any, old_value: Any) -> Any:
    """Keep the previous value when a new payload field is missing."""
    return old_value if new_value is None else new_value


def _compact_number(value: float | int | None) -> str:
    """Format large numbers with compact K, M, and B suffixes."""
    if value is None:
        return "-"
    number = float(value)
    absolute = abs(number)
    if absolute >= 1_000_000_000:
        return f"{number / 1_000_000_000:.2f}B"
    if absolute >= 1_000_000:
        return f"{number / 1_000_000:.2f}M"
    if absolute >= 1_000:
        return f"{number / 1_000:.2f}K"
    if float(number).is_integer():
        return f"{int(number)}"
    return f"{number:.2f}"


def _format_signed(value: float | None, suffix: str = "") -> str:
    """Format a signed numeric change label."""
    if value is None:
        return "-"
    return f"{value:+.2f}{suffix}"


def _status_label(raw_market_hours: Any) -> str:
    """Convert market-hours codes into short status labels."""
    market_hours = _to_int(raw_market_hours)
    if market_hours == 0:
        return "pre"
    if market_hours == 1:
        return "open"
    if market_hours == 2:
        return "post"
    return "live"


def _age_label(last_update_at: datetime | None, *, now: datetime | None = None) -> str:
    """Format the elapsed time since the last quote update."""
    if last_update_at is None:
        return "waiting"
    if now is None:
        now = datetime.now(timezone.utc)
    elapsed_ms = max(0, int((now - last_update_at).total_seconds() * 1000))
    if elapsed_ms < 1000:
        return f"{elapsed_ms}ms"
    if elapsed_ms < 10_000:
        return f"{elapsed_ms / 1000:.1f}s"
    elapsed = elapsed_ms // 1000
    if elapsed < 60:
        return f"{elapsed}s"
    minutes, seconds = divmod(elapsed, 60)
    return f"{minutes}m{seconds:02d}s"


@dataclass
class QuoteState:
    """Hold one instrument quote and expose UI-friendly labels."""
    symbol: str
    display_name: str
    price: float | None = None
    change: float | None = None
    change_percent: float | None = None
    previous_close: float | None = None
    day_high: float | None = None
    day_low: float | None = None
    volume: float | None = None
    currency: str = ""
    exchange: str = ""
    status: str = "waiting"
    last_trade_epoch: int | None = None
    last_update_at: datetime | None = None
    update_count: int = 0
    last_error: str | None = None
    price_action: PriceActionState | None = None

    @classmethod
    def placeholder(cls, symbol: str) -> "QuoteState":
        """Create a waiting quote state before data arrives."""
        return cls(symbol=symbol, display_name=symbol)

    def apply_payload(self, payload: dict[str, Any]) -> None:
        """Apply a live quote payload to this quote state."""
        self.display_name = payload.get("short_name") or self.display_name or self.symbol
        self.price = _coalesce(_to_float(payload.get("price")), self.price)
        self.change = _to_float(payload.get("change"))
        self.change_percent = _to_float(payload.get("change_percent"))
        self.previous_close = _coalesce(
            _to_float(payload.get("previous_close")),
            self.previous_close,
        )
        self.day_high = _coalesce(_to_float(payload.get("day_high")), self.day_high)
        self.day_low = _coalesce(_to_float(payload.get("day_low")), self.day_low)
        self.volume = _coalesce(_to_float(payload.get("day_volume")), self.volume)
        self.currency = str(payload.get("currency") or self.currency or "")
        self.exchange = str(payload.get("exchange") or self.exchange or "")
        if isinstance(payload.get("status"), str) and payload.get("status"):
            self.status = str(payload["status"]).lower()
        else:
            self.status = _status_label(payload.get("market_hours"))
        self.last_trade_epoch = _coalesce(
            _to_int(payload.get("time") or payload.get("ts")),
            self.last_trade_epoch,
        )
        self.last_update_at = datetime.now(timezone.utc)
        self.update_count += 1
        self.last_error = None

    def apply_snapshot(self, payload: dict[str, Any]) -> None:
        """Apply an initial snapshot payload without requiring live data."""
        self.display_name = payload.get("display_name") or self.display_name or self.symbol
        self.price = _coalesce(_to_float(payload.get("price")), self.price)
        self.change = _to_float(payload.get("change"))
        self.change_percent = _to_float(payload.get("change_percent"))
        self.previous_close = _coalesce(
            _to_float(payload.get("previous_close")),
            self.previous_close,
        )
        self.day_high = _coalesce(_to_float(payload.get("day_high")), self.day_high)
        self.day_low = _coalesce(_to_float(payload.get("day_low")), self.day_low)
        self.volume = _coalesce(_to_float(payload.get("volume")), self.volume)
        self.currency = str(payload.get("currency") or self.currency or "")
        self.exchange = str(payload.get("exchange") or self.exchange or "")
        self.status = "snap" if self.status == "waiting" else self.status
        self.last_update_at = datetime.now(timezone.utc)
        self.update_count += 1
        self.last_error = None

    def mark_error(self, detail: str) -> None:
        """Record the latest quote error detail."""
        self.last_error = detail

    def apply_price_action(self, state: PriceActionState) -> None:
        """Apply derived price action state."""
        self.price_action = state

    def price_action_label(
        self,
        *,
        stale_after_seconds: int | None = None,
        now: datetime | None = None,
    ) -> str:
        """Return a compact price action marker when analysis is fresh."""
        if self.price_action is None or not self.price_action.is_available():
            return ""
        if stale_after_seconds is not None and self.price_action.is_stale(
            stale_after_seconds,
            now=now,
        ):
            return ""
        return self.price_action.marker

    def price_action_reason(
        self,
        *,
        stale_after_seconds: int | None = None,
        now: datetime | None = None,
    ) -> str:
        """Return a short analysis reason when analysis is fresh."""
        if self.price_action is None or not self.price_action.is_available():
            return ""
        if stale_after_seconds is not None and self.price_action.is_stale(
            stale_after_seconds,
            now=now,
        ):
            return ""
        return self.price_action.reason

    def is_stale(self, stale_after_seconds: int, *, now: datetime | None = None) -> bool:
        """Return whether the quote is older than the stale threshold."""
        if self.last_update_at is None:
            return True
        if now is None:
            now = datetime.now(timezone.utc)
        return (now - self.last_update_at).total_seconds() > stale_after_seconds

    def price_label(self) -> str:
        """Format the current price for display."""
        return "-" if self.price is None else f"{self.price:.2f}"

    def change_label(self) -> str:
        """Format the absolute price change for display."""
        return _format_signed(self.change)

    def percent_label(self) -> str:
        """Format the percent price change for display."""
        return _format_signed(self.change_percent, "%")

    def volume_label(self) -> str:
        """Format the volume for display."""
        return _compact_number(self.volume)

    def age_label(self, *, now: datetime | None = None) -> str:
        """Format how long ago this quote was updated."""
        return _age_label(self.last_update_at, now=now)
