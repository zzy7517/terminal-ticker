"""Test web state serialization and local API routes."""
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient

from terminal_ticker.config import AppConfig, DisplayConfig
from terminal_ticker.controller import DrainResult
from terminal_ticker.longbridge_provider import LongbridgeInstrument, LongbridgeSecurity
from terminal_ticker.models import QuoteState
from terminal_ticker.price_action import Candle, PriceActionState
from terminal_ticker.web import create_app, serialize_market_state


class DummyController:
    """Avoid starting real provider threads in web tests."""

    def __init__(self, *, config, instruments) -> None:
        """Create placeholder quotes like the real controller."""
        self.config = config
        self.instruments = instruments
        self.quotes = {
            instrument.key: QuoteState.placeholder(instrument.label)
            for instrument in instruments
        }
        self.stream_status = "idle"
        self.started = False

    def start(self) -> None:
        """Record start calls."""
        self.started = True

    def stop(self) -> None:
        """Record stop calls."""
        self.started = False

    def drain_events(self) -> DrainResult:
        """Report no queued changes."""
        return DrainResult(dirty=False, flash_directions={})


class WebTests(unittest.TestCase):
    """Group tests for the web app."""

    def test_serialize_market_state_includes_analysis_and_candles(self) -> None:
        """Verify browser state contains quote, analysis, and chart data."""
        instrument = LongbridgeInstrument("AAPL.US", "AAPL")
        config = AppConfig(instruments=tuple(), display=DisplayConfig())
        quote = QuoteState.placeholder("AAPL")
        quote.apply_payload({"short_name": "AAPL", "price": 201.25, "change_percent": 0.72})
        candle = Candle("longbridge:AAPL.US", 1776846000000, 200, 202, 199, 201.25, 12345)
        quote.apply_price_action(
            PriceActionState(
                label="trend",
                bias="bullish",
                marker="TR+",
                reason="收盘持续上行",
                strength=70,
            ),
            candles=(candle,),
        )

        payload = serialize_market_state(
            config=config,
            instruments=(instrument,),
            quotes={instrument.key: quote},
            stream_status="live",
        )

        self.assertEqual(payload["instruments"][0]["key"], "longbridge:AAPL.US")
        self.assertEqual(payload["quotes"][instrument.key]["priceLabel"], "201.25")
        self.assertEqual(payload["quotes"][instrument.key]["priceAction"]["marker"], "TR+")
        self.assertEqual(payload["quotes"][instrument.key]["candles"][0]["time"], 1776846000)

    def test_stale_analysis_is_not_marked_available(self) -> None:
        """Verify stale price action markers do not appear as active signals."""
        instrument = LongbridgeInstrument("AAPL.US", "AAPL")
        config = AppConfig(instruments=tuple(), display=DisplayConfig())
        quote = QuoteState.placeholder("AAPL")
        old_time = datetime.now(timezone.utc) - timedelta(minutes=20)
        quote.apply_price_action(
            PriceActionState(
                label="breakout",
                bias="bullish",
                marker="BO+",
                reason="突破近期区间",
                strength=80,
                updated_at=old_time,
            )
        )

        payload = serialize_market_state(
            config=config,
            instruments=(instrument,),
            quotes={instrument.key: quote},
            stream_status="live",
        )

        analysis = payload["quotes"][instrument.key]["priceAction"]
        self.assertFalse(analysis["available"])
        self.assertEqual(analysis["marker"], "")

    def test_state_endpoint_uses_runtime_snapshot(self) -> None:
        """Verify the local API exposes runtime state."""
        instrument = LongbridgeInstrument("AAPL.US", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            response = client.get("/api/state")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["instruments"][0]["key"], "longbridge:AAPL.US")

    def test_search_endpoint_marks_existing_symbols(self) -> None:
        """Verify Longbridge search reports whether a result is already active."""
        instrument = LongbridgeInstrument("AAPL.US", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with patch(
            "terminal_ticker.web.search_securities",
            return_value=(LongbridgeSecurity("AAPL.US", name_en="Apple Inc."),),
        ):
            with TestClient(app) as client:
                response = client.get("/api/securities/search", params={"q": "apple"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["results"][0]["exists"])


if __name__ == "__main__":
    unittest.main()
