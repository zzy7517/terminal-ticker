"""Test web state serialization and local API routes."""
import asyncio
import json
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from mytradebot.agent import AgentAnalysisResult, AgentSessionStore, ChatResponse
from mytradebot.config import (
    AppConfig,
    DisplayConfig,
    NewsAnalystConfig,
    NewsConfig,
    NewsUniverseEntry,
    load_config,
)
from mytradebot.runtime.controller import DrainResult
from mytradebot.market_data.alpaca import AlpacaAsset, AlpacaInstrument
from mytradebot.market_data.bitget import BitgetInstrument
from mytradebot.market_data.hyperliquid import HyperliquidInstrument
from mytradebot.domain.quotes import QuoteState
from mytradebot.domain.price_action import Candle
from mytradebot.api.app import (
    MarketContextProvider,
    PROJECT_ROOT,
    WEB_DIST,
    MarketRuntime,
    create_app,
    serialize_market_state,
)
from mytradebot.trading import BitgetDemoOrderResult
from mytradebot.trading.store import TradeStore


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
        if not WEB_DIST.is_dir():
            self.skipTest("web dist is not built in this checkout")
        instrument = AlpacaInstrument("AAPL", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            index_response = client.get("/")
            asset_path = next((WEB_DIST / "assets").glob("*.js"), None)
            asset_response = client.get(f"/assets/{asset_path.name}") if asset_path is not None else None

        self.assertEqual(index_response.status_code, 200)
        self.assertEqual(
            index_response.headers["cache-control"],
            "no-store, max-age=0, must-revalidate",
        )
        if asset_response is not None:
            self.assertEqual(asset_response.status_code, 200)
            self.assertEqual(
                asset_response.headers["cache-control"],
                "no-store, max-age=0, must-revalidate",
            )

    def test_serialize_market_state_includes_quotes_and_candles(self) -> None:
        """Verify browser state contains quote labels and chart data."""
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
        self.assertEqual(payload["quotes"][instrument.key]["multiTimeframeIntervals"], [])
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

    def test_bitget_demo_trade_endpoint_records_order(self) -> None:
        """Verify Bitget demo order API writes the external order id locally."""
        instrument = BitgetInstrument(
            "BTCUSDT",
            "USDT-FUTURES",
            "BTC",
            "BTC",
            "USDT",
            "perp",
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            app = create_app(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=(instrument,),
                controller_factory=DummyController,
                auto_start=False,
            )
            runtime = app.state.runtime
            runtime.trade_store = TradeStore(Path(tmp_dir) / "trades.sqlite3")

            with patch(
                "mytradebot.api.app.open_bitget_demo_position",
                return_value=BitgetDemoOrderResult(
                    raw={"code": "00000", "data": {"orderId": "bg-1", "clientOid": "cid-1"}},
                    external_order_id="bg-1",
                    client_order_id="cid-1",
                ),
            ) as placed, TestClient(app) as client:
                response = client.post(
                    "/api/bitget-demo/trades/USDT-FUTURES%3ABTCUSDT",
                    json={
                        "direction": "long",
                        "size": 0.01,
                        "reasoning": "manual demo test",
                        "orderType": "limit",
                        "limitPrice": 60000,
                        "marginMode": "isolated",
                    },
                )

        self.assertEqual(response.status_code, 200)
        placed.assert_called_once()
        _, kwargs = placed.call_args
        self.assertEqual(kwargs["symbol"], "BTCUSDT")
        self.assertEqual(kwargs["inst_type"], "USDT-FUTURES")
        self.assertEqual(kwargs["limit_price"], 60000.0)
        self.assertEqual(kwargs["margin_mode"], "isolated")
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertTrue(body["demo"])
        self.assertEqual(body["trade"]["fillSource"], "bitget-demo")
        self.assertEqual(body["trade"]["externalOrderId"], "bg-1")
        self.assertEqual(body["trade"]["status"], "planned")
        self.assertEqual(body["state"]["openTrades"][0]["externalOrderId"], "bg-1")

    def test_bitget_demo_trade_endpoint_rejects_remote_origin(self) -> None:
        """Verify demo trading endpoints are local-browser only."""
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

        with TestClient(app) as client:
            response = client.post(
                "/api/bitget-demo/trades/USDT-FUTURES%3ABTCUSDT",
                headers={"origin": "https://example.com"},
                json={"direction": "long", "size": 0.01},
            )

        self.assertEqual(response.status_code, 403)
        self.assertIn("trading API origin denied", response.text)

    def test_runtime_wires_news_analyst_at_startup(self) -> None:
        """Verify enabling news analyst does not crash on startup."""
        class FakeProvider:
            async def chat(self, messages):
                return ChatResponse(content="")

        with tempfile.TemporaryDirectory() as tmp_dir:
            instrument = AlpacaInstrument("SPY", "SPY")
            config = AppConfig(
                instruments=tuple(),
                display=DisplayConfig(),
                news=NewsConfig(enabled=True),
                news_analyst=NewsAnalystConfig(
                    enabled=True,
                    universe=(NewsUniverseEntry("alpaca:SPY", ("SPY",)),),
                ),
            )

            with patch("mytradebot.agent.provider.create_llm_provider", return_value=FakeProvider()):
                runtime = MarketRuntime(
                    config=config,
                    instruments=(instrument,),
                    controller_factory=DummyController,
                    trade_store=TradeStore(Path(tmp_dir) / "trades.sqlite3"),
                )
                payload = runtime.snapshot()

        self.assertIsNotNone(runtime.news_analyst)
        self.assertIsNotNone(runtime.news_service)
        self.assertIsNotNone(runtime.news_service.on_top_changed)
        self.assertEqual(
            payload["config"]["newsAnalyst"]["universe"][0]["instrumentKey"],
            "alpaca:SPY",
        )

    def test_enabling_news_service_wires_news_analyst_hook(self) -> None:
        """Verify runtime NewsService rebuilds keep the analyst callback attached."""
        class FakeProvider:
            async def chat(self, messages):
                return ChatResponse(content="")

        with tempfile.TemporaryDirectory() as tmp_dir:
            instrument = AlpacaInstrument("SPY", "SPY")
            config = AppConfig(
                instruments=tuple(),
                display=DisplayConfig(),
                news=NewsConfig(enabled=False),
                news_analyst=NewsAnalystConfig(
                    enabled=True,
                    universe=(NewsUniverseEntry("alpaca:SPY", ("SPY",)),),
                ),
            )
            runtime = MarketRuntime(
                config=config,
                instruments=(instrument,),
                controller_factory=DummyController,
                trade_store=TradeStore(Path(tmp_dir) / "trades.sqlite3"),
            )

            with patch("mytradebot.agent.provider.create_llm_provider", return_value=FakeProvider()):
                asyncio.run(runtime._apply_news_service_state(NewsConfig(enabled=True)))

        self.assertIsNotNone(runtime.news_analyst)
        self.assertIsNotNone(runtime.news_service)
        self.assertIsNotNone(runtime.news_service.on_top_changed)

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
            "mytradebot.api.app.search_alpaca_assets",
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

        with patch("mytradebot.api.app.search_bitget_instruments", return_value=(spot, instrument)):
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

            with patch("mytradebot.api.app.resolve_instruments", return_value=(alpaca, bitget)):
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

    def test_hyperliquid_trade_endpoint_rejects_non_local_origin(self) -> None:
        """Verify real testnet order endpoint rejects cross-site browser calls."""
        instrument = HyperliquidInstrument("BTC", "BTC Perp", "BTC")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            response = client.post(
                "/api/hyperliquid-testnet/trades/hyperliquid-testnet%3ABTC",
                headers={"origin": "https://example.com"},
                json={"direction": "long", "size": 0.1},
            )

        self.assertEqual(response.status_code, 403)

    def test_hyperliquid_limit_order_rejects_missing_price_before_sdk_call(self) -> None:
        """Verify limit order validation runs before attempting a signed order."""
        instrument = HyperliquidInstrument("BTC", "BTC Perp", "BTC")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with patch("mytradebot.api.app.open_hyperliquid_testnet_position") as opened:
            with TestClient(app) as client:
                response = client.post(
                    "/api/hyperliquid-testnet/trades/hyperliquid-testnet%3ABTC",
                    json={"direction": "long", "size": 0.1, "orderType": "limit"},
                )

        self.assertEqual(response.status_code, 400)
        self.assertIn("limitPrice is required", response.json()["detail"])
        opened.assert_not_called()

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

            with patch("mytradebot.api.app.resolve_instruments", return_value=(bitget, alpaca)):
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

            with patch("mytradebot.api.app.resolve_instruments", return_value=(alpaca,)):
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

            with patch("mytradebot.api.app.create_llm_provider", return_value=provider):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/agent/sessions/alpaca:AAPL/messages",
                        json={"message": "What changed since the prior candle?"},
                    )
                    persisted_response = client.get("/api/agent/sessions/alpaca:AAPL")
                    history_response = client.get("/api/agent/sessions/alpaca:AAPL/history")

        payload = response.json()
        persisted_payload = persisted_response.json()
        history_payload = history_response.json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["result"]["available"])
        self.assertEqual(payload["state"]["agentAnalyses"][instrument.key]["summary"], "AAPL is trending.")
        self.assertEqual(payload["session"]["session"]["instrumentKey"], instrument.key)
        self.assertEqual(payload["session"]["session"]["apiMode"], "codex_responses")
        self.assertIn("history", payload)
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
        self.assertEqual(history_response.status_code, 200)
        self.assertEqual(history_payload["sessions"][0]["messageCount"], 2)
        self.assertEqual(history_payload["sessions"][0]["preview"], "What changed since the prior candle?")

    def test_agent_session_history_can_resume_and_delete(self) -> None:
        """Verify history endpoints can restore and delete persisted chart sessions."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            instrument = AlpacaInstrument("AAPL", "AAPL")
            store = AgentSessionStore(Path(tmp_dir) / "agent.sqlite3")
            first = store.create_session(
                instrument_key=instrument.key,
                title="AAPL · AAPL",
                provider="codex",
                model="old-model",
            )
            store.append_message(
                session_id=first.id,
                role="user",
                content="First session prompt",
            )
            store.append_message(
                session_id=first.id,
                role="assistant",
                content="Old analysis.",
                analysis={"summary": "Old analysis.", "bias": "neutral", "confidence": 40},
            )
            second = store.create_session(
                instrument_key=instrument.key,
                title="AAPL · AAPL",
                provider="codex",
                model="new-model",
            )
            store.append_message(
                session_id=second.id,
                role="user",
                content="Second session prompt",
            )
            app = create_app(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=(instrument,),
                controller_factory=DummyController,
                agent_session_store=store,
                auto_start=False,
            )

            with TestClient(app) as client:
                resume_response = client.post(
                    f"/api/agent/sessions/alpaca:AAPL/history/{first.id}/resume",
                )
                delete_response = client.delete(
                    f"/api/agent/sessions/alpaca:AAPL/history/{first.id}",
                )
                missing_response = client.delete(
                    f"/api/agent/sessions/alpaca:AAPL/history/{first.id}",
                )

        resume_payload = resume_response.json()
        delete_payload = delete_response.json()
        self.assertEqual(resume_response.status_code, 200)
        self.assertEqual(resume_payload["session"]["session"]["id"], first.id)
        self.assertEqual(resume_payload["state"]["agentAnalyses"][instrument.key]["summary"], "Old analysis.")
        self.assertEqual(delete_response.status_code, 200)
        self.assertTrue(delete_payload["deleted"])
        self.assertEqual(delete_payload["session"]["session"]["id"], second.id)
        self.assertEqual([item["id"] for item in delete_payload["history"]["sessions"]], [second.id])
        self.assertEqual(missing_response.status_code, 404)

    def test_agent_session_history_delete_last_clears_state(self) -> None:
        """Verify deleting the only session for an instrument clears agentAnalyses and history."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            instrument = AlpacaInstrument("AAPL", "AAPL")
            store = AgentSessionStore(Path(tmp_dir) / "agent.sqlite3")
            only_session = store.create_session(
                instrument_key=instrument.key,
                title="AAPL · AAPL",
                provider="codex",
                model="only-model",
            )
            store.append_message(
                session_id=only_session.id,
                role="user",
                content="Lonely prompt",
            )
            store.append_message(
                session_id=only_session.id,
                role="assistant",
                content="Lonely analysis.",
                analysis={"summary": "Lonely analysis.", "bias": "neutral", "confidence": 30},
            )
            app = create_app(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=(instrument,),
                controller_factory=DummyController,
                agent_session_store=store,
                auto_start=False,
            )

            with TestClient(app) as client:
                # Prime agentAnalyses so we can confirm it gets cleared.
                client.post(f"/api/agent/sessions/alpaca:AAPL/history/{only_session.id}/resume")
                delete_response = client.delete(
                    f"/api/agent/sessions/alpaca:AAPL/history/{only_session.id}",
                )

        delete_payload = delete_response.json()
        self.assertEqual(delete_response.status_code, 200)
        self.assertTrue(delete_payload["deleted"])
        self.assertIsNone(delete_payload["session"]["session"])
        self.assertEqual(delete_payload["session"]["messages"], [])
        self.assertEqual(delete_payload["history"]["sessions"], [])
        self.assertNotIn(instrument.key, delete_payload["state"]["agentAnalyses"])

    def test_agent_loop_prompt_includes_market_context_snapshot(self) -> None:
        """Verify tool loop still gets authoritative market context before any tool calls."""
        class FakeLoopProvider:
            name = "codex"
            model = "fake-loop"

            async def chat(self, messages, tools=None):
                self.messages = messages
                self.tools = tools
                return ChatResponse(
                    content=json.dumps(
                        {
                            "summary": "AAPL context was available.",
                            "bias": "neutral",
                            "confidence": 55,
                            "key_levels": [],
                            "watch_plan": ["Wait for confirmation."],
                            "invalidation": "No context.",
                            "risk_notes": [],
                        }
                    )
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
            provider = FakeLoopProvider()

            with patch("mytradebot.api.app.create_llm_provider", return_value=provider):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/agent/sessions/alpaca:AAPL/messages",
                        json={"message": "Analyze this."},
                    )

        payload = response.json()
        prompt = provider.messages[-1]["content"]
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["result"]["available"])
        self.assertIn("当前行情上下文", prompt)
        self.assertIn('"instrument"', prompt)
        self.assertIn('"candles"', prompt)
        self.assertIn("alpaca:AAPL", prompt)
        self.assertTrue(provider.tools)
        user_messages = [message for message in provider.messages if message["role"] == "user"]
        self.assertEqual(len(user_messages), 1)
        self.assertEqual(user_messages[0]["content"], prompt)

    def test_market_context_provider_accepts_legacy_bitget_key(self) -> None:
        """Verify agent tools can resolve older bitget:* instrument keys."""
        instrument = BitgetInstrument(
            "BTCUSDT",
            "USDT-FUTURES",
            "BTCUSDT",
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
        quote = app.state.runtime.controller.quotes[instrument.key]
        quote.apply_payload({"price": 81672.3})
        quote.apply_candles(
            candles=(Candle(instrument.key, 1776846000000, 81000, 82000, 80500, 81672.3, 12345),),
        )

        context_provider = MarketContextProvider(app.state.runtime)

        self.assertIs(context_provider.get_quote("bitget:BTCUSDT:USDT-FUTURES"), quote)
        self.assertEqual(
            len(context_provider.get_candles("bitget:BTCUSDT:USDT-FUTURES")),
            1,
        )

    def test_agent_loop_error_is_reported_without_json_parse_masking(self) -> None:
        """Verify provider errors are surfaced instead of being replaced by JSON parse errors."""
        class FailingLoopProvider:
            name = "codex"
            model = "fake-loop"

            async def chat(self, messages, tools=None):
                raise RuntimeError("provider exploded")

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

            with patch("mytradebot.api.app.create_llm_provider", return_value=FailingLoopProvider()):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/agent/sessions/alpaca:AAPL/messages",
                        json={"message": "Analyze this."},
                    )

        result = response.json()["result"]
        self.assertEqual(response.status_code, 200)
        self.assertFalse(result["available"])
        self.assertIn("provider exploded", result["error"])
        self.assertNotIn("JSON", result["error"])
        self.assertEqual(result["loopResult"]["error"], "provider exploded")

    def test_agent_loop_empty_output_reports_clear_error(self) -> None:
        """Verify empty model output is not reported as a JSON parse failure."""
        class EmptyLoopProvider:
            name = "codex"
            model = "fake-loop"

            async def chat(self, messages, tools=None):
                return ChatResponse(content="")

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

            with patch("mytradebot.api.app.create_llm_provider", return_value=EmptyLoopProvider()):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/agent/sessions/alpaca:AAPL/messages",
                        json={"message": "Analyze this."},
                    )

        result = response.json()["result"]
        self.assertEqual(response.status_code, 200)
        self.assertFalse(result["available"])
        self.assertEqual(result["error"], "Agent returned no output text.")
        self.assertNotIn("JSON", result["error"])

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
            "mytradebot.api.app.list_available_agent_models",
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
        """Verify browser can save agent provider and shared settings (in-memory)."""
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
                provider_response = client.post(
                    "/api/agent/providers/codex",
                    json={
                        "enabled": True,
                        "models": ["gpt-5.4"],
                        "reasoningEffort": "high",
                    },
                )
                shared_response = client.post(
                    "/api/agent/config",
                    json={
                        "enabled": False,
                        "maxCandles": 30,
                    },
                )

        self.assertEqual(provider_response.status_code, 200)
        self.assertEqual(shared_response.status_code, 200)
        shared_state = shared_response.json()["state"]["config"]["agent"]
        self.assertFalse(shared_state["enabled"])
        self.assertEqual(shared_state["maxCandles"], 30)
        provider_state = shared_state["providerProfiles"]["codex"]
        self.assertTrue(provider_state["enabled"])
        self.assertIn("gpt-5.4", provider_state["models"])

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

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["state"]["config"]["analysis"]["interval"], "15m")

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

    def test_news_endpoint_returns_empty_when_disabled(self) -> None:
        """Verify /api/news and snapshot behave when news module is disabled."""
        instrument = AlpacaInstrument("AAPL", "AAPL")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )
        with TestClient(app) as client:
            response = client.get("/api/news")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload, {"news": [], "enabled": False})

            refresh = client.post("/api/news/refresh")
            self.assertEqual(refresh.status_code, 409)

            state = client.get("/api/state").json()
            self.assertIn("recentNews", state)
            self.assertEqual(state["recentNews"], [])
            self.assertFalse(state["config"]["news"]["enabled"])

    def test_news_endpoint_returns_cached_items_when_enabled(self) -> None:
        """Verify /api/news returns cached items and refresh calls the service."""
        from mytradebot.config import NewsConfig
        from mytradebot.news import NewsItem, NewsStore
        from mytradebot.news.providers.reuters import FetchResult

        instrument = AlpacaInstrument("AAPL", "AAPL")
        app = create_app(
            config=AppConfig(
                instruments=tuple(),
                display=DisplayConfig(),
                news=NewsConfig(enabled=True),
            ),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )
        runtime = app.state.runtime
        self.assertIsNotNone(runtime.news_service)

        # Replace the default store with a fresh temp-backed one to isolate from other tests.
        tmp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(tmp_dir.cleanup)
        runtime.news_service.store = NewsStore(Path(tmp_dir.name) / "news.sqlite3")

        unique_url = f"https://r/{id(self)}"

        class _FakeProvider:
            source_name = "reuters"

            async def fetch(self, *, etag=None, last_modified=None):
                return FetchResult(
                    status="ok",
                    items=(
                        NewsItem(
                            url=unique_url,
                            source="reuters",
                            title="headline a",
                            summary="",
                            published_at_ms=1_700_000_000_000,
                            fetched_at_ms=1_700_000_001_000,
                            keywords=("Markets",),
                        ),
                    ),
                    etag='"e"',
                    last_modified="lm",
                )

        runtime.news_service.provider = _FakeProvider()

        with TestClient(app) as client:
            refresh = client.post("/api/news/refresh")
            self.assertEqual(refresh.status_code, 200)
            body = refresh.json()
            self.assertEqual(body["status"], "ok")
            self.assertEqual(body["inserted"], 1)
            self.assertEqual(len(body["news"]), 1)

            news = client.get("/api/news?limit=10").json()
            self.assertEqual(len(news["news"]), 1)
            self.assertEqual(news["news"][0]["title"], "headline a")


if __name__ == "__main__":
    unittest.main()
