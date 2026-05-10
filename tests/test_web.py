"""Test web state serialization and local API routes."""
import asyncio
import json
import os
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from tradex.agent import AgentSessionStore, ChatResponse
from tradex.config import (
    AgentConfig,
    AppConfig,
    DisplayConfig,
    MemoryConfig,
    NewsConfig,
    TradingConfig,
    load_config,
)
from tradex.runtime.controller import DrainResult
from tradex.market_data.bitget import BitgetInstrument
from tradex.market_data.hyperliquid import HyperliquidInstrument
from tradex.domain.quotes import QuoteState
from tradex.domain.price_action import Candle
from tradex.api.app import (
    PROJECT_ROOT,
    WEB_DIST,
    create_app,
)
from tradex.api.runtime import MarketContextProvider, MarketRuntime
from tradex.api.serializers import serialize_market_state
from tradex.memory import MemoryStateStore, SOURCE_MANUAL_NOTE
from tradex.trading import BitgetDemoOrderResult
from tradex.trading.store import TradeStore


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


def _bitget_btc() -> BitgetInstrument:
    """Return a stable Bitget fixture instrument used across API tests."""
    return BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp")


def _bitget_eth() -> BitgetInstrument:
    """Return a second Bitget fixture instrument for multi-symbol tests."""
    return BitgetInstrument("ETHUSDT", "USDT-FUTURES", "ETH", "ETH", "USDT", "perp")


class WebTests(unittest.TestCase):
    """Group tests for the web app."""

    def test_runtime_start_skips_memory_generation_when_agent_disabled(self) -> None:
        """Verify disabled agent config does not turn memory startup into failed jobs."""

        class FakeMemoryPipeline:
            def __init__(self) -> None:
                self.kickoff_count = 0
                self.policy = type("Policy", (), {"generate_memories": True})()

            def kickoff_startup(self) -> None:
                self.kickoff_count += 1

            async def shutdown(self) -> None:
                return None

        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                tmp_path = Path(tmp_dir)
                with patch.dict(os.environ, {"XDG_DATA_HOME": str(tmp_path)}, clear=False):
                    runtime = MarketRuntime(
                        config=AppConfig(
                            instruments=tuple(),
                            display=DisplayConfig(),
                            agent=AgentConfig(enabled=False),
                            memory=MemoryConfig(enabled=True),
                        ),
                        instruments=tuple(),
                        controller_factory=DummyController,
                        agent_session_store=AgentSessionStore(tmp_path / "agent.sqlite3"),
                        trade_store=TradeStore(tmp_path / "trades.sqlite3"),
                    )
                fake_pipeline = FakeMemoryPipeline()
                runtime.memory_pipeline = fake_pipeline  # type: ignore[assignment]

                with patch(
                    "tradex.api.runtime.load_bitget_instrument_catalog",
                    return_value={},
                ), patch(
                    "tradex.api.runtime.load_hyperliquid_instrument_catalog",
                    return_value={},
                ):
                    await runtime.start()
                    try:
                        self.assertEqual(fake_pipeline.kickoff_count, 0)
                    finally:
                        await runtime.stop()

        asyncio.run(scenario())

    def test_web_dist_points_to_vite_output_directory(self) -> None:
        """Verify the backend serves the Vite build output after package refactors."""
        self.assertTrue((PROJECT_ROOT / "vite.config.ts").is_file())
        self.assertEqual(WEB_DIST, PROJECT_ROOT / "web" / "dist")

    def test_web_dist_responses_disable_browser_cache(self) -> None:
        """Verify local web responses do not reuse stale frontend bundles."""
        if not (WEB_DIST / "index.html").is_file():
            self.skipTest("web dist is not built in this checkout")
        instrument = _bitget_btc()
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

    def test_websocket_endpoint_accepts_live_state_connection(self) -> None:
        """Verify the browser state socket receives the initial snapshot."""
        instrument = _bitget_btc()
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            with client.websocket_connect("/ws") as websocket:
                payload = websocket.receive_json()

        self.assertEqual(payload["type"], "state")
        self.assertIn(instrument.key, payload["quotes"])

    def test_serialize_market_state_includes_quotes_and_candles(self) -> None:
        """Verify browser state contains quote labels and chart data."""
        instrument = _bitget_btc()
        config = AppConfig(instruments=tuple(), display=DisplayConfig())
        quote = QuoteState.placeholder("AAPL")
        quote.apply_payload({"short_name": "AAPL", "price": 201.25, "change_percent": 0.72})
        candle = Candle("USDT-FUTURES:BTCUSDT", 1776846000000, 200, 202, 199, 201.25, 12345)
        thumbnail_candle = Candle("USDT-FUTURES:BTCUSDT", 1776849600000, 201, 203, 200, 202.25, 14000)
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

        self.assertEqual(payload["instruments"][0]["key"], "USDT-FUTURES:BTCUSDT")
        self.assertEqual(payload["instruments"][0]["instType"], "USDT-FUTURES")
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
        instrument = _bitget_btc()
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            response = client.get("/api/state")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["instruments"][0]["key"], "USDT-FUTURES:BTCUSDT")

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
                "tradex.api.runtime.open_bitget_demo_position",
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

    def test_load_older_candles_endpoint_merges_history(self) -> None:
        """Verify browser can request earlier candles for the selected chart."""
        instrument = _bitget_btc()
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )
        runtime = app.state.runtime
        existing = Candle("USDT-FUTURES:BTCUSDT", 1777406400000, 200, 202, 199, 201.25, 12345)
        older = Candle("USDT-FUTURES:BTCUSDT", 1777406100000, 199, 201, 198.5, 200.0, 12000)
        runtime.controller.quotes[instrument.key].apply_candles(candles=(existing,))
        runtime.controller.older_candles = (older,)

        with TestClient(app) as client:
            response = client.post("/api/instruments/USDT-FUTURES%3ABTCUSDT/candles/older")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["added"], 1)
        self.assertEqual(
            runtime.controller.older_requests,
            [("USDT-FUTURES:BTCUSDT", "5m", 1777406400000, 200)],
        )
        self.assertEqual(
            [item["time"] for item in payload["state"]["quotes"]["USDT-FUTURES:BTCUSDT"]["candles"]],
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

    def test_catalog_endpoint_returns_preloaded_symbols(self) -> None:
        """Verify preloaded instrument catalog reports source, inst_type, and active state."""
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
        runtime = app.state.runtime
        usdc = BitgetInstrument("BTCPERP", "USDC-FUTURES", "BTCPERP", "BTC", "USDC", "perp")
        hyperliquid = HyperliquidInstrument("ETH", "ETH Perp", "ETH")
        runtime.instrument_catalog = (usdc, instrument, hyperliquid)
        runtime.instrument_catalog_loaded_at = "2026-05-09T00:00:00+00:00"

        with TestClient(app) as client:
            response = client.get("/api/instruments/catalog")

        payload = response.json()["items"]
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload[0]["instType"], "USDC-FUTURES")
        self.assertFalse(payload[0]["exists"])
        self.assertTrue(payload[1]["exists"])
        self.assertEqual(payload[2]["source"], "hyperliquid")

    def test_runtime_start_preloads_instrument_catalog(self) -> None:
        """Verify app startup warms the provider catalogs before serving the UI."""
        bitget = BitgetInstrument("BTCUSDT", "USDT-FUTURES", "BTC", "BTC", "USDT", "perp")
        hyperliquid = HyperliquidInstrument("BTC", "BTC Perp", "BTC")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(bitget,),
            controller_factory=DummyController,
            auto_start=True,
        )

        with patch(
            "tradex.api.runtime.load_bitget_instrument_catalog",
            return_value={("USDT-FUTURES", "BTCUSDT"): bitget},
        ), patch(
            "tradex.api.runtime.load_hyperliquid_instrument_catalog",
            return_value={"BTC": hyperliquid},
        ):
            with TestClient(app) as client:
                response = client.get("/api/instruments/catalog")

        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["errors"], {})
        self.assertEqual([item["key"] for item in payload["items"]], ["USDT-FUTURES:BTCUSDT", "hyperliquid:BTC"])

    def test_bitget_add_endpoint_persists_symbol(self) -> None:
        """Verify browser can add Bitget symbols to the watchlist."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "ETHUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "ETH" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            eth = _bitget_eth()
            bitget = _bitget_btc()
            app = create_app(
                config=config,
                instruments=(eth,),
                controller_factory=DummyController,
                auto_start=False,
            )

            with patch("tradex.api.runtime.resolve_instruments", return_value=(eth, bitget)):
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
        """Verify real Hyperliquid order endpoint rejects cross-site browser calls."""
        instrument = HyperliquidInstrument("BTC", "BTC Perp", "BTC")
        app = create_app(
            config=AppConfig(
                instruments=tuple(),
                display=DisplayConfig(),
                trading=TradingConfig(hyperliquid_enabled=True),
            ),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            response = client.post(
                "/api/hyperliquid/trades/hyperliquid%3ABTC",
                headers={"origin": "https://example.com"},
                json={"direction": "long", "size": 0.1},
            )

        self.assertEqual(response.status_code, 403)

    def test_exchange_order_endpoint_rejects_non_local_origin(self) -> None:
        """Verify generic exchange mutation route uses the trading local-only guard."""
        instrument = HyperliquidInstrument("BTC", "BTC Perp", "BTC")
        app = create_app(
            config=AppConfig(
                instruments=tuple(),
                display=DisplayConfig(),
                trading=TradingConfig(hyperliquid_enabled=True),
            ),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            response = client.post(
                "/api/exchange/orders",
                headers={"origin": "https://example.com"},
                json={"instrumentKey": "hyperliquid:BTC", "direction": "long", "size": 0.1},
            )

        self.assertEqual(response.status_code, 403)

    def test_exchange_cancel_endpoint_rejects_non_local_origin(self) -> None:
        """Verify generic exchange cancel route uses the trading local-only guard."""
        instrument = HyperliquidInstrument("BTC", "BTC Perp", "BTC")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with TestClient(app) as client:
            response = client.delete(
                "/api/exchange/orders/hyperliquid/123?symbol=BTC",
                headers={"origin": "https://example.com"},
            )

        self.assertEqual(response.status_code, 403)

    def test_hyperliquid_limit_order_rejects_missing_price_before_sdk_call(self) -> None:
        """Verify limit order validation runs before attempting a signed order."""
        instrument = HyperliquidInstrument("BTC", "BTC Perp", "BTC")
        app = create_app(
            config=AppConfig(
                instruments=tuple(),
                display=DisplayConfig(),
                trading=TradingConfig(hyperliquid_enabled=True),
            ),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with patch("tradex.api.runtime.open_hyperliquid_position") as opened:
            with TestClient(app) as client:
                response = client.post(
                    "/api/hyperliquid/trades/hyperliquid%3ABTC",
                    json={"direction": "long", "size": 0.1, "orderType": "limit"},
                )

        self.assertEqual(response.status_code, 400)
        self.assertIn("limitPrice is required", response.json()["detail"])
        opened.assert_not_called()

    def test_hyperliquid_trade_endpoint_respects_trading_config(self) -> None:
        """Verify platform trading config blocks manual Hyperliquid execution."""
        instrument = HyperliquidInstrument("BTC", "BTC Perp", "BTC")
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with patch("tradex.api.runtime.open_hyperliquid_position") as opened:
            with TestClient(app) as client:
                response = client.post(
                    "/api/hyperliquid/trades/hyperliquid%3ABTC",
                    json={"direction": "long", "size": 0.1},
                )

        self.assertEqual(response.status_code, 409)
        self.assertIn("disabled by config", response.json()["detail"])
        opened.assert_not_called()

    def test_hyperliquid_add_endpoint_persists_symbol(self) -> None:
        """Verify browser can add Hyperliquid symbols to the watchlist."""
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
            bitget = _bitget_btc()
            hyperliquid = HyperliquidInstrument("ETH", "ETH Perp", "ETH")
            app = create_app(
                config=config,
                instruments=(bitget,),
                controller_factory=DummyController,
                auto_start=False,
            )

            with patch("tradex.api.runtime.resolve_instruments", return_value=(bitget, hyperliquid)):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/watchlist/hyperliquid",
                        json={"symbol": "ETH", "label": "ETH"},
                    )
            persisted = load_config(config_path)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["changed"])
        self.assertEqual(persisted.instruments[1].symbol, "ETH")
        self.assertEqual(persisted.instruments[1].source, "hyperliquid")

    def test_remove_instrument_endpoint_persists_bitget_symbol(self) -> None:
        """Verify browser can remove any active watchlist instrument by key."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "ETHUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "ETH" },
                      { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            eth = _bitget_eth()
            bitget = _bitget_btc()
            app = create_app(
                config=config,
                instruments=(eth, bitget),
                controller_factory=DummyController,
                auto_start=False,
            )

            with patch("tradex.api.runtime.resolve_instruments", return_value=(eth,)):
                with TestClient(app) as client:
                    response = client.delete("/api/watchlist/instruments/USDT-FUTURES%3ABTCUSDT")
            persisted_text = config_path.read_text()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["changed"])
        self.assertNotIn("BTCUSDT", persisted_text)
        self.assertIn("ETHUSDT", persisted_text)

    def test_remove_instrument_endpoint_persists_hyperliquid_builder_symbol(self) -> None:
        """Verify browser can remove a Hyperliquid builder DEX instrument by key."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "xyz:VIX", source = "hyperliquid", label = "VIX Perp (xyz)", group = "indices" },
                      { symbol = "xyz:SP500", source = "hyperliquid", label = "SP500 Perp (xyz)", group = "indices" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            vix = HyperliquidInstrument("xyz:VIX", "VIX Perp (xyz)", "VIX", group="indices")
            sp500 = HyperliquidInstrument("xyz:SP500", "SP500 Perp (xyz)", "SP500", group="indices")
            app = create_app(
                config=config,
                instruments=(vix, sp500),
                controller_factory=DummyController,
                auto_start=False,
            )

            with patch("tradex.api.runtime.resolve_instruments", return_value=(sp500,)):
                with TestClient(app) as client:
                    response = client.delete(
                        "/api/watchlist/instruments/hyperliquid%3Axyz%3AVIX"
                    )
            payload = response.json()
            persisted_text = config_path.read_text()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["changed"])
        self.assertNotIn("xyz:VIX", persisted_text)
        self.assertIn("xyz:SP500", persisted_text)
        self.assertEqual(
            [instrument["key"] for instrument in payload["state"]["instruments"]],
            ["hyperliquid:xyz:SP500"],
        )

    def test_remove_instrument_endpoint_logs_and_500s_when_file_remove_noops(self) -> None:
        """Verify runtime/file mismatches are surfaced instead of returning changed=false."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "watchlist.toml"
            config_path.write_text(
                textwrap.dedent(
                    """
                    symbols = [
                      { symbol = "xyz:VIX", source = "hyperliquid", label = "VIX Perp (xyz)", group = "indices" },
                      { symbol = "xyz:SP500", source = "hyperliquid", label = "SP500 Perp (xyz)", group = "indices" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            vix = HyperliquidInstrument("xyz:VIX", "VIX Perp (xyz)", "VIX", group="indices")
            sp500 = HyperliquidInstrument("xyz:SP500", "SP500 Perp (xyz)", "SP500", group="indices")
            app = create_app(
                config=config,
                instruments=(vix, sp500),
                controller_factory=DummyController,
                auto_start=False,
            )

            with patch("tradex.api.runtime.remove_symbol_from_watchlist", return_value=False):
                with self.assertLogs("tradex.api.runtime", level="ERROR") as captured:
                    with TestClient(app) as client:
                        response = client.delete(
                            "/api/watchlist/instruments/hyperliquid%3Axyz%3AVIX"
                        )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "Watchlist remove failed.")
        self.assertIn("watchlist remove failed after runtime match", captured.output[0])
        self.assertIn("hyperliquid:xyz:VIX", captured.output[0])

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
        """Verify manual agent endpoint appends generic transcript messages."""
        class FakeProvider:
            """Return a deterministic agent result."""

            name = "codex"
            model = "fake"

            async def chat(self, messages, tools=None):
                self.messages = messages
                self.tools = tools
                return ChatResponse(content="AAPL is trending.")

        with tempfile.TemporaryDirectory() as tmp_dir:
            instrument = _bitget_btc()
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
                candles=(Candle("USDT-FUTURES:BTCUSDT", 1776846000000, 200, 202, 199, 201.25, 12345),),
            )
            provider = FakeProvider()

            with patch("tradex.api.runtime.create_llm_provider", return_value=provider):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/agent/sessions/USDT-FUTURES:BTCUSDT/messages",
                        json={"message": "What changed since the prior candle?"},
                    )
                    persisted_response = client.get("/api/agent/sessions/USDT-FUTURES:BTCUSDT")
                    history_response = client.get("/api/agent/sessions/USDT-FUTURES:BTCUSDT/history")

        payload = response.json()
        persisted_payload = persisted_response.json()
        history_payload = history_response.json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["result"]["available"])
        self.assertEqual(payload["result"]["content"], "AAPL is trending.")
        self.assertNotIn(instrument.key, payload["state"]["agentAnalyses"])
        self.assertEqual(payload["session"]["session"]["instrumentKey"], instrument.key)
        self.assertEqual(payload["session"]["session"]["apiMode"], "codex_responses")
        self.assertIn("history", payload)
        self.assertEqual(
            [message["role"] for message in payload["session"]["messages"]],
            ["user", "assistant"],
        )
        self.assertEqual(payload["session"]["messages"][1]["content"], "AAPL is trending.")
        self.assertEqual(
            provider.messages[-1]["content"].splitlines()[-1],
            "What changed since the prior candle?",
        )
        self.assertEqual(persisted_response.status_code, 200)
        self.assertEqual(persisted_payload["messages"][1]["content"], "AAPL is trending.")
        self.assertEqual(history_response.status_code, 200)
        self.assertEqual(history_payload["sessions"][0]["messageCount"], 2)
        self.assertEqual(history_payload["sessions"][0]["preview"], "What changed since the prior candle?")

    def test_memory_note_endpoint_queues_manual_note(self) -> None:
        """Verify the REST path creates a manual memory source."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "tradex" / "memories"
            with patch.dict(os.environ, {"XDG_DATA_HOME": str(Path(tmp_dir))}, clear=False):
                app = create_app(
                    config=AppConfig(
                        instruments=tuple(),
                        display=DisplayConfig(),
                        agent=AgentConfig(enabled=False),
                        memory=MemoryConfig(enabled=True),
                    ),
                    instruments=tuple(),
                    controller_factory=DummyController,
                    auto_start=False,
                )
                with TestClient(app) as client:
                    response = client.post(
                        "/api/memory/notes",
                        json={"id": "note-1", "text": "记住：只把已发生的交易写成事实。"},
                    )

            payload = response.json()
            note_path = root / "extensions" / "ad_hoc" / "notes" / "note-1.json"
            stored_note = json.loads(note_path.read_text())
            state_store = MemoryStateStore(root / "state.sqlite3")
            with state_store._get_conn() as conn:
                row = conn.execute(
                    "SELECT id FROM memory_sources WHERE source_type = ? AND source_ref = ?",
                    (SOURCE_MANUAL_NOTE, "note-1"),
                ).fetchone()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["queued"])
        self.assertEqual(payload["noteId"], "note-1")
        self.assertEqual(stored_note["text"], "记住：只把已发生的交易写成事实。")
        self.assertIsNotNone(row)

    def test_agent_session_history_can_resume_and_delete(self) -> None:
        """Verify history endpoints can restore and delete persisted chart sessions."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            instrument = _bitget_btc()
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
                    f"/api/agent/sessions/USDT-FUTURES:BTCUSDT/history/{first.id}/resume",
                )
                delete_response = client.delete(
                    f"/api/agent/sessions/USDT-FUTURES:BTCUSDT/history/{first.id}",
                )
                missing_response = client.delete(
                    f"/api/agent/sessions/USDT-FUTURES:BTCUSDT/history/{first.id}",
                )

        resume_payload = resume_response.json()
        delete_payload = delete_response.json()
        self.assertEqual(resume_response.status_code, 200)
        self.assertEqual(resume_payload["session"]["session"]["id"], first.id)
        self.assertNotIn(instrument.key, resume_payload["state"]["agentAnalyses"])
        self.assertEqual(delete_response.status_code, 200)
        self.assertTrue(delete_payload["deleted"])
        self.assertEqual(delete_payload["session"]["session"]["id"], second.id)
        self.assertEqual([item["id"] for item in delete_payload["history"]["sessions"]], [second.id])
        self.assertEqual(missing_response.status_code, 404)

    def test_agent_session_history_delete_last_clears_state(self) -> None:
        """Verify deleting the only session for an instrument clears agentAnalyses and history."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            instrument = _bitget_btc()
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
            )
            app = create_app(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=(instrument,),
                controller_factory=DummyController,
                agent_session_store=store,
                auto_start=False,
            )

            with TestClient(app) as client:
                # Resume first so delete exercises active-session cleanup.
                client.post(f"/api/agent/sessions/USDT-FUTURES:BTCUSDT/history/{only_session.id}/resume")
                delete_response = client.delete(
                    f"/api/agent/sessions/USDT-FUTURES:BTCUSDT/history/{only_session.id}",
                )

        delete_payload = delete_response.json()
        self.assertEqual(delete_response.status_code, 200)
        self.assertTrue(delete_payload["deleted"])
        self.assertIsNone(delete_payload["session"]["session"])
        self.assertEqual(delete_payload["session"]["messages"], [])
        self.assertEqual(delete_payload["history"]["sessions"], [])
        self.assertNotIn(instrument.key, delete_payload["state"]["agentAnalyses"])

    def test_agent_sessions_endpoint_preloads_first_ten_chat_payloads(self) -> None:
        """Verify global chat listing includes the first ten full session payloads."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            store = AgentSessionStore(Path(tmp_dir) / "agent.sqlite3")
            for index in range(12):
                session = store.create_global_session(
                    title=f"Session {index}",
                    provider="codex",
                    model="gpt-test",
                )
                store.append_message(
                    session_id=session.id,
                    role="user",
                    content=f"Prompt {index}",
                )
                store.append_message(
                    session_id=session.id,
                    role="assistant",
                    content=f"Answer {index}",
                )
            app = create_app(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=tuple(),
                controller_factory=DummyController,
                agent_session_store=store,
                auto_start=False,
            )

            with TestClient(app) as client:
                response = client.get("/api/agent/sessions?limit=12&preload=10")

        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(payload["sessions"]), 12)
        self.assertEqual(len(payload["preloadedSessions"]), 10)
        self.assertEqual(
            [item["session"]["id"] for item in payload["preloadedSessions"]],
            [item["id"] for item in payload["sessions"][:10]],
        )
        self.assertTrue(all(len(item["messages"]) == 2 for item in payload["preloadedSessions"]))
        self.assertEqual(payload["preloadedSessions"][0]["run"]["status"], "idle")

    def test_agent_stream_reports_running_status_and_rejects_overlap(self) -> None:
        """Verify streaming runs expose per-session status and reject overlapping runs."""
        class BlockingProvider:
            name = "codex"
            model = "blocking"

            async def chat(self, messages, tools=None):
                started.set()
                await release.wait()
                return ChatResponse(content="stream complete")

        async def scenario(runtime, session_id: str) -> None:
            stream = await runtime.stream_agent_message(session_id, {"message": "First"})
            first_frame = await stream.__anext__()
            self.assertIn('"sessionId"', first_frame)
            await asyncio.wait_for(started.wait(), timeout=2)

            history = await runtime.list_agent_sessions()
            self.assertEqual(history["sessions"][0]["run"]["status"], "running")
            with self.assertRaises(HTTPException) as raised:
                await runtime.stream_agent_message(session_id, {"message": "Second"})
            self.assertEqual(raised.exception.status_code, 409)
            with self.assertRaises(HTTPException) as delete_raised:
                await runtime.delete_agent_session_by_id(session_id)
            self.assertEqual(delete_raised.exception.status_code, 409)

            release.set()
            async for _ in stream:
                pass
            payload = await runtime._agent_session_payload(session_id)
            self.assertEqual(payload["run"]["status"], "idle")
            self.assertEqual(payload["messages"][-1]["content"], "stream complete")

        with tempfile.TemporaryDirectory() as tmp_dir:
            store = AgentSessionStore(Path(tmp_dir) / "agent.sqlite3")
            session = store.create_global_session(
                title="Streaming",
                provider="codex",
                model="blocking",
            )
            app = create_app(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=tuple(),
                controller_factory=DummyController,
                agent_session_store=store,
                auto_start=False,
            )
            started = asyncio.Event()
            release = asyncio.Event()
            with patch("tradex.api.runtime.create_llm_provider", return_value=BlockingProvider()):
                asyncio.run(scenario(app.state.runtime, session.id))

    def test_agent_stream_disconnect_does_not_cancel_background_run(self) -> None:
        """Verify closing a stream subscriber leaves the session run alive."""
        class BlockingProvider:
            name = "codex"
            model = "blocking"

            async def chat(self, messages, tools=None):
                started.set()
                await release.wait()
                return ChatResponse(content="finished after disconnect")

        async def scenario(runtime, session_id: str) -> None:
            stream = await runtime.stream_agent_message(session_id, {"message": "Run"})
            await stream.__anext__()
            await asyncio.wait_for(started.wait(), timeout=2)
            await stream.aclose()
            self.assertTrue(await runtime.agent_runs.is_running(session_id))

            release.set()
            for _ in range(20):
                if not await runtime.agent_runs.is_running(session_id):
                    break
                await asyncio.sleep(0.05)
            payload = await runtime._agent_session_payload(session_id)
            self.assertEqual(payload["messages"][-1]["content"], "finished after disconnect")
            self.assertEqual(payload["run"]["status"], "idle")

        with tempfile.TemporaryDirectory() as tmp_dir:
            store = AgentSessionStore(Path(tmp_dir) / "agent.sqlite3")
            session = store.create_global_session(
                title="Disconnect",
                provider="codex",
                model="blocking",
            )
            app = create_app(
                config=AppConfig(instruments=tuple(), display=DisplayConfig()),
                instruments=tuple(),
                controller_factory=DummyController,
                agent_session_store=store,
                auto_start=False,
            )
            started = asyncio.Event()
            release = asyncio.Event()
            with patch("tradex.api.runtime.create_llm_provider", return_value=BlockingProvider()):
                asyncio.run(scenario(app.state.runtime, session.id))

    def test_agent_loop_prompt_uses_market_context_tool(self) -> None:
        """Verify tool loop uses explicit market-context tools instead of prompt injection."""
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
            instrument = _bitget_btc()
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
                candles=(Candle("USDT-FUTURES:BTCUSDT", 1776846000000, 200, 202, 199, 201.25, 12345),),
            )
            provider = FakeLoopProvider()

            with patch("tradex.api.runtime.create_llm_provider", return_value=provider):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/agent/sessions/USDT-FUTURES:BTCUSDT/messages",
                        json={"message": "Analyze this."},
                    )

        payload = response.json()
        prompt = provider.messages[-1]["content"]
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["result"]["available"])
        self.assertNotIn("当前行情上下文", prompt)
        self.assertNotIn('"candles"', prompt)
        self.assertIn("USDT-FUTURES:BTCUSDT", prompt)
        self.assertIn("get_candles", prompt)
        self.assertTrue(provider.tools)
        tool_names = {tool["function"]["name"] for tool in provider.tools}
        self.assertIn("get_candles", tool_names)
        self.assertIn("get_quote", tool_names)
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
            instrument = _bitget_btc()
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
                candles=(Candle("USDT-FUTURES:BTCUSDT", 1776846000000, 200, 202, 199, 201.25, 12345),),
            )

            with patch("tradex.api.runtime.create_llm_provider", return_value=FailingLoopProvider()):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/agent/sessions/USDT-FUTURES:BTCUSDT/messages",
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
            instrument = _bitget_btc()
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
                candles=(Candle("USDT-FUTURES:BTCUSDT", 1776846000000, 200, 202, 199, 201.25, 12345),),
            )

            with patch("tradex.api.runtime.create_llm_provider", return_value=EmptyLoopProvider()):
                with TestClient(app) as client:
                    response = client.post(
                        "/api/agent/sessions/USDT-FUTURES:BTCUSDT/messages",
                        json={"message": "Analyze this."},
                    )

        result = response.json()["result"]
        self.assertEqual(response.status_code, 200)
        self.assertFalse(result["available"])
        self.assertEqual(result["error"], "Agent returned no output text.")
        self.assertNotIn("JSON", result["error"])

    def test_agent_models_endpoint_returns_provider_models(self) -> None:
        """Verify model discovery endpoint forwards provider model metadata."""
        instrument = _bitget_btc()
        app = create_app(
            config=AppConfig(instruments=tuple(), display=DisplayConfig()),
            instruments=(instrument,),
            controller_factory=DummyController,
            auto_start=False,
        )

        with patch(
            "tradex.api.runtime.list_available_agent_models",
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
                      { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            instrument = _bitget_btc()
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
                anthropic_response = client.post(
                    "/api/agent/providers/anthropic",
                    json={
                        "enabled": True,
                        "apiKey": "sk-ant-test",
                        "baseUrl": "https://example.test/v1",
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
        self.assertEqual(anthropic_response.status_code, 200)
        self.assertEqual(shared_response.status_code, 200)
        shared_state = shared_response.json()["state"]["config"]["agent"]
        self.assertFalse(shared_state["enabled"])
        self.assertEqual(shared_state["maxCandles"], 30)
        provider_state = shared_state["providerProfiles"]["codex"]
        self.assertTrue(provider_state["enabled"])
        self.assertIn("gpt-5.4", provider_state["models"])
        anthropic_state = shared_state["providerProfiles"]["anthropic"]
        self.assertTrue(anthropic_state["apiKeyConfigured"])
        self.assertEqual(anthropic_state["baseUrl"], "https://example.test/v1")
        self.assertNotIn("apiKey", anthropic_state)

    def test_analysis_config_endpoint_persists_interval(self) -> None:
        """Verify browser can switch K-line intervals through the runtime."""
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
            instrument = _bitget_btc()
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
                      { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC" },
                      { symbol = "ETHUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "ETH" },
                    ]
                    """
                ).strip()
            )
            config = load_config(config_path)
            instruments = (
                _bitget_btc(),
                _bitget_eth(),
            )
            app = create_app(
                config=config,
                instruments=instruments,
                controller_factory=DummyController,
                auto_start=False,
            )

            with TestClient(app) as client:
                response = client.post(
                    "/api/instruments/USDT-FUTURES%3ABTCUSDT/analysis-interval",
                    json={"interval": "15m"},
                )

            persisted = load_config(config_path)

        self.assertEqual(response.status_code, 200)
        state = response.json()["state"]
        intervals = {item["key"]: item["analysisInterval"] for item in state["instruments"]}
        self.assertEqual(intervals["USDT-FUTURES:BTCUSDT"], "15m")
        self.assertEqual(intervals["USDT-FUTURES:ETHUSDT"], "5m")
        self.assertEqual(persisted.instruments[0].analysis_interval, "15m")
        self.assertIsNone(persisted.instruments[1].analysis_interval)

    def test_news_endpoint_returns_empty_when_disabled(self) -> None:
        """Verify /api/news and snapshot behave when news module is disabled."""
        instrument = _bitget_btc()
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
        from tradex.news import NewsItem, NewsStore
        from tradex.news.providers.reuters import FetchResult

        instrument = _bitget_btc()
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
