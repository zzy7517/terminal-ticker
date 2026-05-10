"""Test agent-facing trading tools backed by TradeStore."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mytradebot.agent.tools import ToolCall, build_trading_tools
from mytradebot.config import TradingConfig
from mytradebot.trading import ExchangeRouter, TradeStore, TradeStatus
from mytradebot.trading.exchange_models import OrderResult
from mytradebot.trading.hyperliquid import HyperliquidOrderResult


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


class TradingToolsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = TradeStore(Path(self._tmp.name) / "t.sqlite3")
        self.captured_snapshots: list[str] = []

        def snap(key: str) -> dict:
            self.captured_snapshots.append(key)
            return {"timeframes": {"5m": [{"open": 1}]}, "key": key}

        self.registry = build_trading_tools(
            store=self.store,
            snapshot_provider=snap,
            session_id_provider=lambda: "sess-1",
            trading_config=TradingConfig(hyperliquid_enabled=True, bitget_demo_enabled=True),
        )

    def _exec(self, name: str, args: dict) -> dict:
        call = ToolCall(id="c1", name=name, arguments=args)
        result = _run(self.registry.execute(call))
        self.assertFalse(result.error, result.output)
        return json.loads(result.output)

    def test_registry_exposes_real_hyperliquid_tool_not_local_paper_entry_tools(self) -> None:
        names = {tool.name for tool in self.registry.list_tools()}
        self.assertIn("open_hyperliquid_trade", names)
        self.assertIn("open_bitget_demo_trade", names)
        self.assertNotIn("open_paper_trade", names)
        self.assertNotIn("cancel_paper_trade", names)
        self.assertNotIn("adjust_paper_trade", names)

    def test_disabled_platforms_hide_mutation_tools(self) -> None:
        registry = build_trading_tools(
            store=self.store,
            trading_config=TradingConfig(hyperliquid_enabled=False, bitget_demo_enabled=False),
        )

        names = {tool.name for tool in registry.list_tools()}
        self.assertNotIn("open_hyperliquid_trade", names)
        self.assertNotIn("open_bitget_demo_trade", names)
        self.assertNotIn("modify_tpsl", names)
        self.assertNotIn("close_position", names)
        self.assertIn("get_exchange_positions", names)
        self.assertIn("list_open_trades", names)

    def test_exchange_router_rejects_disabled_platform_mutations(self) -> None:
        router = ExchangeRouter(
            trade_store=self.store,
            trading_config=TradingConfig(hyperliquid_enabled=False, bitget_demo_enabled=False),
        )

        result = router.place_order(
            instrument_key="hyperliquid:BTC",
            direction="long",
            size=0.01,
        )

        self.assertFalse(result.ok)
        self.assertIn("disabled by config", result.error or "")
        self.assertFalse(router.cancel_order(exchange="hyperliquid", order_id="1", symbol="BTC"))

    def test_open_hyperliquid_trade_records_real_fill_snapshot_and_session(self) -> None:
        fake_result = HyperliquidOrderResult(
            raw={"status": "ok"},
            external_order_id="oid-1",
            average_price=100.5,
            filled_size=0.25,
        )
        with patch(
            "mytradebot.agent.tools.trading.open_hyperliquid_position",
            return_value=fake_result,
        ) as opened:
            data = self._exec(
                "open_hyperliquid_trade",
                {
                    "instrument_key": "hyperliquid:BTC",
                    "direction": "long",
                    "size": 0.25,
                    "reasoning": "live execution",
                    "order_type": "market",
                    "take_profit_price": 120.0,
                    "stop_loss_price": 90.0,
                },
            )

        self.assertTrue(data["ok"])
        opened.assert_called_once_with(
            coin="BTC",
            is_buy=True,
            size=0.25,
            order_type="market",
            limit_price=None,
            slippage=0.05,
            take_profit_price=120.0,
            stop_loss_price=90.0,
        )
        trade = data["trade"]
        self.assertEqual(trade["status"], "open")
        self.assertEqual(trade["targetPrices"], [120.0])
        self.assertEqual(trade["stopPrice"], 90.0)
        self.assertEqual(trade["sessionId"], "sess-1")
        self.assertEqual(trade["fillSource"], "hyperliquid")
        self.assertEqual(trade["externalOrderId"], "oid-1")
        self.assertIsNotNone(trade["snapshotId"])
        self.assertEqual(data["fill"]["fillSource"], "hyperliquid")
        self.assertEqual(data["fill"]["externalOrderId"], "oid-1")
        snap = self.store.get_snapshot(trade["snapshotId"])
        assert snap is not None
        self.assertEqual(snap.payload["key"], "hyperliquid:BTC")

    def test_hyperliquid_trade_rejects_non_hyperliquid_instrument(self) -> None:
        data = self._exec(
            "open_hyperliquid_trade",
            {
                "instrument_key": "bitget:BTCUSDT:USDT-FUTURES",
                "direction": "long",
                "size": 0.1,
                "reasoning": "wrong venue",
            },
        )
        self.assertIn("error", data)

    def test_reject_invalid_direction(self) -> None:
        data = self._exec(
            "open_hyperliquid_trade",
            {
                "instrument_key": "hyperliquid:BTC",
                "direction": "sideways",
                "size": 1.0,
                "reasoning": "?",
            },
        )
        self.assertIn("error", data)

    def test_limit_requires_limit_price(self) -> None:
        data = self._exec(
            "open_hyperliquid_trade",
            {
                "instrument_key": "hyperliquid:BTC",
                "direction": "long",
                "size": 1.0,
                "reasoning": "?",
                "order_type": "limit",
            },
        )
        self.assertIn("error", data)

    def test_list_open_trades_excludes_closed(self) -> None:
        self.store.create_trade(
            instrument_key="USDT-FUTURES:BTCUSDT",
            direction=__import__("mytradebot.trading", fromlist=["TradeDirection"]).TradeDirection.LONG,
            size=1.0,
            intent_price=100.0,
            stop_price=95.0,
        )
        t = self.store.create_trade(
            instrument_key="USDT-FUTURES:BTCUSDT",
            direction=__import__("mytradebot.trading", fromlist=["TradeDirection"]).TradeDirection.LONG,
            size=1.0, intent_price=None, stop_price=None,
            status=TradeStatus.OPEN,
        )
        self.store.mark_closed(t.id, realized_pnl=1.0)
        listed = self._exec("list_open_trades", {"instrument_key": "USDT-FUTURES:BTCUSDT"})
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["status"], "planned")

    def test_trade_history_returns_closed_and_cancelled(self) -> None:
        from mytradebot.trading import TradeDirection
        t = self.store.create_trade(
            instrument_key="USDT-FUTURES:BTCUSDT",
            direction=TradeDirection.LONG, size=1.0,
            intent_price=None, stop_price=None,
            status=TradeStatus.OPEN,
        )
        self.store.mark_closed(t.id, realized_pnl=5.0)
        history = self._exec("get_trade_history", {"limit": 10})
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["realizedPnl"], 5.0)

    def test_open_bitget_demo_trade_records_external_order(self) -> None:
        with patch(
            "mytradebot.agent.tools.trading.bitget_trading.place_order",
            return_value=OrderResult(
                exchange="bitget-demo",
                order_id="bg-1",
                raw={"code": "00000", "data": {"orderId": "bg-1"}},
            ),
        ) as placed:
            data = self._exec(
                "open_bitget_demo_trade",
                {
                    "instrument_key": "USDT-FUTURES:BTCUSDT",
                    "direction": "long",
                    "size": 0.01,
                    "reasoning": "demo breakout",
                    "order_type": "limit",
                    "limit_price": 60000.0,
                    "take_profit_price": 63000.0,
                    "stop_loss_price": 58500.0,
                },
            )

        placed.assert_called_once()
        _, kwargs = placed.call_args
        self.assertEqual(kwargs["symbol"], "BTCUSDT")
        self.assertEqual(kwargs["product_type"], "USDT-FUTURES")
        self.assertEqual(kwargs["preset_stop_surplus_price"], 63000.0)
        self.assertEqual(kwargs["preset_stop_loss_price"], 58500.0)
        self.assertTrue(data["ok"])
        self.assertEqual(data["exchange"], "bitget-demo")
        trade = data["trade"]
        self.assertEqual(trade["fillSource"], "bitget-demo")
        self.assertEqual(trade["externalOrderId"], "bg-1")
        self.assertEqual(trade["status"], "planned")
        self.assertEqual(trade["targetPrices"], [63000.0])
        self.assertEqual(trade["stopPrice"], 58500.0)

    def test_open_bitget_demo_trade_rejects_non_bitget_key(self) -> None:
        data = self._exec(
            "open_bitget_demo_trade",
            {
                "instrument_key": "hyperliquid:BTC",
                "direction": "long",
                "size": 0.01,
                "reasoning": "wrong venue",
            },
        )
        self.assertIn("error", data)


if __name__ == "__main__":
    unittest.main()
