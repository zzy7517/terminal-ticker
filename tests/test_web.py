"""Test web state serialization and local API routes."""
import tempfile
import textwrap
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from terminal_ticker.agent import AgentAnalysisResult
from terminal_ticker.config import AppConfig, DisplayConfig, load_config
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
        self.assertEqual(payload["instruments"][0]["analysisInterval"], "5m")
        self.assertEqual(payload["config"]["agent"]["provider"], "codex")
        self.assertEqual(payload["config"]["agent"]["baseUrl"], None)
        self.assertEqual(payload["agentAnalyses"], {})

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

    def test_agent_analysis_endpoint_runs_provider_and_caches_result(self) -> None:
        """Verify manual agent endpoint analyzes current candles."""
        instrument = LongbridgeInstrument("AAPL.US", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )
        quote = app.state.runtime.controller.quotes[instrument.key]
        quote.apply_payload({"price": 201.25})
        quote.apply_price_action(
            PriceActionState(
                label="trend",
                bias="bullish",
                marker="TR+",
                reason="收盘持续上行",
                strength=70,
            ),
            candles=(Candle("longbridge:AAPL.US", 1776846000000, 200, 202, 199, 201.25, 12345),),
        )

        class FakeProvider:
            """Return a deterministic agent result."""

            async def analyze(self, context):
                self.context = context
                return AgentAnalysisResult(
                    available=True,
                    provider="codex",
                    model="fake",
                    updated_at="2026-04-28T00:00:00+00:00",
                    summary="AAPL is trending.",
                    bias="bullish",
                    confidence=70,
                )

        with patch("terminal_ticker.web.create_llm_provider", return_value=FakeProvider()):
            with TestClient(app) as client:
                response = client.post("/api/agent/analyze/longbridge:AAPL.US")

        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["result"]["available"])
        self.assertEqual(payload["state"]["agentAnalyses"][instrument.key]["summary"], "AAPL is trending.")

    def test_agent_models_endpoint_returns_provider_models(self) -> None:
        """Verify model discovery endpoint forwards provider model metadata."""
        instrument = LongbridgeInstrument("AAPL.US", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with patch(
            "terminal_ticker.web.list_available_agent_models",
            return_value=[
                {
                    "slug": "gpt-5.4-mini",
                    "displayName": "GPT-5.4-Mini",
                    "supportedInApi": True,
                }
            ],
        ):
            with TestClient(app) as client:
                response = client.get("/api/agent/models")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["models"][0]["slug"], "gpt-5.4-mini")

    def test_agent_config_endpoint_persists_settings(self) -> None:
        """Verify browser can save agent provider settings."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "AAPL.US", source = "longbridge", label = "AAPL" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            instrument = LongbridgeInstrument("AAPL.US", "AAPL")
            app = create_app(
                config=config,
                instruments=(instrument,),
                controller_factory=DummyController,
                auto_start=False,
            )

            with TestClient(app) as client:
                response = client.post(
                    "/api/agent/config",
                    json={
                        "enabled": False,
                        "provider": "codex",
                        "apiMode": "codex_responses",
                        "model": "gpt-5.4",
                        "maxCandles": 30,
                        "reasoningEffort": "high",
                    },
                )

            persisted = load_config(config_path)

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["state"]["config"]["agent"]["enabled"])
        self.assertEqual(persisted.agent.model, "gpt-5.4")
        self.assertEqual(persisted.agent.max_candles, 30)

    def test_analysis_config_endpoint_persists_interval(self) -> None:
        """Verify browser can switch K-line intervals through the runtime."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "AAPL.US", source = "longbridge", label = "AAPL" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            instrument = LongbridgeInstrument("AAPL.US", "AAPL")
            app = create_app(
                config=config,
                instruments=(instrument,),
                controller_factory=DummyController,
                auto_start=False,
            )

            with TestClient(app) as client:
                response = client.post("/api/analysis/config", json={"interval": "15m"})

            persisted = load_config(config_path)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["state"]["config"]["analysis"]["interval"], "15m")
        self.assertEqual(persisted.analysis.interval, "15m")

    def test_instrument_interval_endpoint_only_updates_selected_symbol(self) -> None:
        """Verify browser can switch the selected symbol's K-line interval."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "AAPL.US", source = "longbridge", label = "AAPL" },
                      { symbol = "SPY.US", source = "longbridge", label = "SPY" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            instruments = (
                LongbridgeInstrument("AAPL.US", "AAPL"),
                LongbridgeInstrument("SPY.US", "SPY"),
            )
            app = create_app(
                config=config,
                instruments=instruments,
                controller_factory=DummyController,
                auto_start=False,
            )

            with TestClient(app) as client:
                response = client.post(
                    "/api/instruments/longbridge%3AAAPL.US/analysis-interval",
                    json={"interval": "15m"},
                )

            persisted = load_config(config_path)

        self.assertEqual(response.status_code, 200)
        state = response.json()["state"]
        intervals = {item["key"]: item["analysisInterval"] for item in state["instruments"]}
        self.assertEqual(intervals["longbridge:AAPL.US"], "15m")
        self.assertEqual(intervals["longbridge:SPY.US"], "5m")
        self.assertEqual(persisted.instruments[0].analysis_interval, "15m")
        self.assertIsNone(persisted.instruments[1].analysis_interval)


if __name__ == "__main__":
    unittest.main()
