"""Test web state serialization and local API routes."""
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from terminal_ticker.agent import AgentAnalysisResult, AgentSessionStore
from terminal_ticker.config import AppConfig, DisplayConfig, load_config
from terminal_ticker.runtime.controller import DrainResult
from terminal_ticker.market_data.alpaca import AlpacaAsset, AlpacaInstrument
from terminal_ticker.market_data.bitget import BitgetInstrument
from terminal_ticker.domain.quotes import QuoteState
from terminal_ticker.domain.price_action import Candle
from terminal_ticker.api.app import PROJECT_ROOT, WEB_DIST, create_app, serialize_market_state


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
        self.older_candles = tuple()
        self.older_requests = []

    def start(self) -> None:
        """Record start calls."""
        self.started = True

    def stop(self) -> None:
        """Record stop calls."""
        self.started = False

    def drain_events(self) -> DrainResult:
        """Report no queued changes."""
        return DrainResult(dirty=False, flash_directions={})

    def fetch_older_candles(
        self,
        instrument,
        *,
        interval,
        before_open_time_ms,
        limit,
    ):
        """Return fixture older candles for API tests."""
        self.older_requests.append((instrument.key, interval, before_open_time_ms, limit))
        return self.older_candles


class WebTests(unittest.TestCase):
    """Group tests for the web app."""

    def test_web_dist_points_to_vite_output_directory(self) -> None:
        """Verify the backend serves the Vite build output after package refactors."""
        self.assertTrue((PROJECT_ROOT / "vite.config.ts").is_file())
        self.assertEqual(WEB_DIST, PROJECT_ROOT / "web" / "dist")

    def test_web_dist_responses_disable_browser_cache(self) -> None:
        """Verify local web responses do not reuse stale frontend bundles."""
        instrument = AlpacaInstrument("AAPL", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            index_response = client.get("/")
            asset_path = next((WEB_DIST / "assets").glob("*.js"))
            asset_response = client.get(f"/assets/{asset_path.name}")

        self.assertEqual(index_response.status_code, 200)
        self.assertEqual(asset_response.status_code, 200)
        self.assertEqual(
            index_response.headers["cache-control"],
            "no-store, max-age=0, must-revalidate",
        )
        self.assertEqual(
            asset_response.headers["cache-control"],
            "no-store, max-age=0, must-revalidate",
        )

    def test_serialize_market_state_includes_analysis_and_candles(self) -> None:
        """Verify browser state contains quote, analysis, and chart data."""
        instrument = AlpacaInstrument("AAPL", "AAPL")
        config = AppConfig(instruments=tuple(), display=DisplayConfig())
        quote = QuoteState.placeholder("AAPL")
        quote.apply_payload({"short_name": "AAPL", "price": 201.25, "change_percent": 0.72})
        candle = Candle("alpaca:AAPL", 1776846000000, 200, 202, 199, 201.25, 12345)
        thumbnail_candle = Candle("alpaca:AAPL", 1776849600000, 201, 203, 200, 202.25, 14000)
        quote.apply_candles(
            candles=(candle,),
            thumbnail_candles=(thumbnail_candle,),
        )

        payload = serialize_market_state(
            config=config,
            instruments=(instrument,),
            quotes={instrument.key: quote},
            stream_status="live",
        )

        self.assertEqual(payload["instruments"][0]["key"], "alpaca:AAPL")
        self.assertIsNone(payload["instruments"][0]["instType"])
        self.assertEqual(payload["quotes"][instrument.key]["priceLabel"], "201.25")
        self.assertNotIn("priceAction", payload["quotes"][instrument.key])
        self.assertFalse(payload["quotes"][instrument.key]["strategySignal"]["available"])
        self.assertEqual(payload["quotes"][instrument.key]["candles"][0]["time"], 1776846000)
        self.assertEqual(payload["quotes"][instrument.key]["thumbnailCandles"][0]["time"], 1776849600)
        self.assertEqual(payload["instruments"][0]["analysisInterval"], "5m")
        self.assertEqual(payload["config"]["agent"]["provider"], "codex")
        self.assertNotIn("baseUrl", payload["config"]["agent"])
        self.assertEqual(payload["agentAnalyses"], {})

    def test_state_endpoint_uses_runtime_snapshot(self) -> None:
        """Verify the local API exposes runtime state."""
        instrument = AlpacaInstrument("AAPL", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            response = client.get("/api/state")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["instruments"][0]["key"], "alpaca:AAPL")

    def test_load_older_candles_endpoint_merges_history(self) -> None:
        """Verify browser can request earlier candles for the selected chart."""
        instrument = AlpacaInstrument("AAPL", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )
        runtime = app.state.runtime
        existing = Candle("alpaca:AAPL", 1777406400000, 200, 202, 199, 201.25, 12345)
        older = Candle("alpaca:AAPL", 1777406100000, 199, 201, 198.5, 200.0, 12000)
        runtime.controller.quotes[instrument.key].apply_candles(candles=(existing,))
        runtime.controller.older_candles = (older,)

        with TestClient(app) as client:
            response = client.post("/api/instruments/alpaca%3AAAPL/candles/older")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["added"], 1)
        self.assertEqual(
            runtime.controller.older_requests,
            [("alpaca:AAPL", "5m", 1777406400000, 200)],
        )
        self.assertEqual(
            [item["time"] for item in payload["state"]["quotes"]["alpaca:AAPL"]["candles"]],
            [1777406100, 1777406400],
        )

    def test_load_older_candles_rejects_unsupported_provider(self) -> None:
        """Verify unsupported providers do not issue ambiguous history requests."""
        class UnsupportedInstrument:
            symbol = "TEST"
            label = "TEST"
            source = "paper"
            group = "other"
            analysis_interval = None
            key = "paper:TEST"

        instrument = UnsupportedInstrument()
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            response = client.post("/api/instruments/paper%3ATEST/candles/older")

        self.assertEqual(response.status_code, 400)

    def test_search_endpoint_marks_existing_symbols(self) -> None:
        """Verify default securities search uses Alpaca and marks active symbols."""
        instrument = AlpacaInstrument("AAPL", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with patch(
            "terminal_ticker.api.app.search_alpaca_assets",
            return_value=(AlpacaAsset("AAPL", name="Apple Inc.", exchange="NASDAQ"),),
        ):
            with TestClient(app) as client:
                response = client.get("/api/securities/search", params={"q": "apple"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["results"][0]["exists"])
        self.assertEqual(response.json()["results"][0]["source"], "alpaca")

    def test_bitget_search_endpoint_marks_existing_symbols(self) -> None:
        """Verify Bitget search reports source, inst_type, and active state."""
        instrument = BitgetInstrument(
            "BTCUSDT",
            "USDT-FUTURES",
            "BTC",
            "BTC",
            "USDT",
            "perp",
        )
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )
        spot = BitgetInstrument("BTCUSDT", "SPOT", "BTCUSDT", "BTC", "USDT", "spot")

        with patch("terminal_ticker.api.app.search_bitget_instruments", return_value=(spot, instrument)):
            with TestClient(app) as client:
                response = client.get(
                    "/api/instruments/search",
                    params={"source": "bitget", "q": "btc"},
                )

        payload = response.json()["results"]
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload[0]["instType"], "SPOT")
        self.assertFalse(payload[0]["exists"])
        self.assertTrue(payload[1]["exists"])

    def test_bitget_add_endpoint_persists_symbol(self) -> None:
        """Verify browser can add Bitget symbols to the watchlist."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "AAPL", source = "alpaca", label = "AAPL" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            alpaca = AlpacaInstrument("AAPL", "AAPL")
            bitget = BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp")
            app = create_app(
                config=config,
                instruments=(alpaca,),
                controller_factory=DummyController,
                auto_start=False,
            )

            with patch("terminal_ticker.api.app.resolve_instruments", return_value=(alpaca, bitget)):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/watchlist/bitget",
                        json={"symbol": "BTCUSDT", "instType": "USDT-FUTURES", "label": "BTC"},
                    )
            persisted = load_config(config_path)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["changed"])
        self.assertEqual(persisted.instruments[1].source, "bitget")
        self.assertEqual(persisted.instruments[1].inst_type, "USDT-FUTURES")

    def test_alpaca_add_endpoint_persists_symbol(self) -> None:
        """Verify browser can add Alpaca symbols to the watchlist."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            bitget = BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp")
            alpaca = AlpacaInstrument("AAPL", "AAPL")
            app = create_app(
                config=config,
                instruments=(bitget,),
                controller_factory=DummyController,
                auto_start=False,
            )

            with patch("terminal_ticker.api.app.resolve_instruments", return_value=(bitget, alpaca)):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/watchlist/alpaca",
                        json={"symbol": "AAPL.US", "label": "AAPL"},
                    )
            persisted = load_config(config_path)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["changed"])
        self.assertEqual(persisted.instruments[1].symbol, "AAPL")
        self.assertEqual(persisted.instruments[1].source, "alpaca")

    def test_remove_instrument_endpoint_persists_bitget_symbol(self) -> None:
        """Verify browser can remove any active watchlist instrument by key."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "AAPL", source = "alpaca", label = "AAPL" },
                      { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            alpaca = AlpacaInstrument("AAPL", "AAPL")
            bitget = BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp")
            app = create_app(
                config=config,
                instruments=(alpaca, bitget),
                controller_factory=DummyController,
                auto_start=False,
            )

            with patch("terminal_ticker.api.app.resolve_instruments", return_value=(alpaca,)):
                with TestClient(app) as client:
                    response = client.delete("/api/watchlist/instruments/USDT-FUTURES%3ABTCUSDT")
            persisted_text = config_path.read_text()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["changed"])
        self.assertNotIn("BTCUSDT", persisted_text)
        self.assertIn("AAPL", persisted_text)

    def test_remove_instrument_endpoint_rejects_last_symbol(self) -> None:
        """Verify browser cannot remove the final active watchlist instrument."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            instrument = BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp")
            app = create_app(
                config=config,
                instruments=(instrument,),
                controller_factory=DummyController,
                auto_start=False,
            )

            with TestClient(app) as client:
                response = client.delete("/api/watchlist/instruments/USDT-FUTURES%3ABTCUSDT")
            persisted_text = config_path.read_text()

        self.assertEqual(response.status_code, 409)
        self.assertIn("cannot remove the last watchlist symbol", response.json()["detail"])
        self.assertIn("BTCUSDT", persisted_text)

    def test_agent_analysis_endpoint_runs_provider_and_caches_result(self) -> None:
        """Verify manual agent endpoint analyzes current candles."""
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

        with tempfile.TemporaryDirectory() as tmp_dir:
            instrument = AlpacaInstrument("AAPL", "AAPL")
            store = AgentSessionStore(Path(tmp_dir) / "agent.sqlite3")
            app = create_app(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=(instrument,),
                controller_factory=DummyController,
                agent_session_store=store,
                auto_start=False,
            )
            quote = app.state.runtime.controller.quotes[instrument.key]
            quote.apply_payload({"price": 201.25})
            quote.apply_candles(
                candles=(Candle("alpaca:AAPL", 1776846000000, 200, 202, 199, 201.25, 12345),),
            )
            provider = FakeProvider()

            with patch("terminal_ticker.api.app.create_llm_provider", return_value=provider):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/agent/sessions/alpaca:AAPL/messages",
                        json={"message": "What changed since the prior candle?"},
                    )
                    persisted_response = client.get("/api/agent/sessions/alpaca:AAPL")

        payload = response.json()
        persisted_payload = persisted_response.json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["result"]["available"])
        self.assertEqual(payload["state"]["agentAnalyses"][instrument.key]["summary"], "AAPL is trending.")
        self.assertEqual(payload["session"]["session"]["instrumentKey"], instrument.key)
        self.assertEqual(
            [message["role"] for message in payload["session"]["messages"]],
            ["user", "assistant"],
        )
        self.assertEqual(
            provider.context["session"]["recent_history"][0]["content"],
            "What changed since the prior candle?",
        )
        self.assertEqual(persisted_response.status_code, 200)
        self.assertEqual(persisted_payload["messages"][1]["analysis"]["summary"], "AAPL is trending.")

    def test_agent_models_endpoint_returns_provider_models(self) -> None:
        """Verify model discovery endpoint forwards provider model metadata."""
        instrument = AlpacaInstrument("AAPL", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with patch(
            "terminal_ticker.api.app.list_available_agent_models",
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
                      { symbol = "AAPL", source = "alpaca", label = "AAPL" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            instrument = AlpacaInstrument("AAPL", "AAPL")
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
                      { symbol = "AAPL", source = "alpaca", label = "AAPL" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            instrument = AlpacaInstrument("AAPL", "AAPL")
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
                      { symbol = "AAPL", source = "alpaca", label = "AAPL" },
                      { symbol = "SPY", source = "alpaca", label = "SPY" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            instruments = (
                AlpacaInstrument("AAPL", "AAPL"),
                AlpacaInstrument("SPY", "SPY"),
            )
            app = create_app(
                config=config,
                instruments=instruments,
                controller_factory=DummyController,
                auto_start=False,
            )

            with TestClient(app) as client:
                response = client.post(
                    "/api/instruments/alpaca%3AAAPL/analysis-interval",
                    json={"interval": "15m"},
                )

            persisted = load_config(config_path)

        self.assertEqual(response.status_code, 200)
        state = response.json()["state"]
        intervals = {item["key"]: item["analysisInterval"] for item in state["instruments"]}
        self.assertEqual(intervals["alpaca:AAPL"], "15m")
        self.assertEqual(intervals["alpaca:SPY"], "5m")
        self.assertEqual(persisted.instruments[0].analysis_interval, "15m")
        self.assertIsNone(persisted.instruments[1].analysis_interval)


if __name__ == "__main__":
    unittest.main()
