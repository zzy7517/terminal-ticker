"""Test agent-facing trading tools backed by TradeStore."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mytradebot.agent.tools import ToolCall, build_trading_tools
from mytradebot.trading import TradeStore, TradeStatus
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
        )

    def _exec(self, name: str, args: dict) -> dict:
        call = ToolCall(id="c1", name=name, arguments=args)
        result = _run(self.registry.execute(call))
        self.assertFalse(result.error, result.output)
        return json.loads(result.output)

    def test_registry_exposes_real_testnet_tool_not_local_paper_entry_tools(self) -> None:
        names = {tool.name for tool in self.registry.list_tools()}
        self.assertIn("open_hyperliquid_testnet_trade", names)
        self.assertIn("open_bitget_demo_trade", names)
        self.assertNotIn("open_paper_trade", names)
        self.assertNotIn("cancel_paper_trade", names)
        self.assertNotIn("adjust_paper_trade", names)

    def test_open_hyperliquid_trade_records_real_fill_snapshot_and_session(self) -> None:
        fake_result = HyperliquidOrderResult(
            raw={"status": "ok"},
            external_order_id="oid-1",
            average_price=100.5,
            filled_size=0.25,
        )
        with patch(
            "mytradebot.agent.tools.trading.open_hyperliquid_testnet_position",
            return_value=fake_result,
        ) as opened:
            data = self._exec(
                "open_hyperliquid_testnet_trade",
                {
                    "instrument_key": "hyperliquid-testnet:BTC",
                    "direction": "long",
                    "size": 0.25,
                    "reasoning": "testnet execution",
                    "order_type": "market",
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
        )
        trade = data["trade"]
        self.assertEqual(trade["status"], "open")
        self.assertEqual(trade["sessionId"], "sess-1")
        self.assertEqual(trade["fillSource"], "hyperliquid-testnet")
        self.assertEqual(trade["externalOrderId"], "oid-1")
        self.assertIsNotNone(trade["snapshotId"])
        self.assertEqual(data["fill"]["fillSource"], "hyperliquid-testnet")
        self.assertEqual(data["fill"]["externalOrderId"], "oid-1")
        snap = self.store.get_snapshot(trade["snapshotId"])
        assert snap is not None
        self.assertEqual(snap.payload["key"], "hyperliquid-testnet:BTC")

    def test_hyperliquid_trade_rejects_non_testnet_instrument(self) -> None:
        data = self._exec(
            "open_hyperliquid_testnet_trade",
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
            "open_hyperliquid_testnet_trade",
            {
                "instrument_key": "hyperliquid-testnet:BTC",
                "direction": "sideways",
                "size": 1.0,
                "reasoning": "?",
            },
        )
        self.assertIn("error", data)

    def test_limit_requires_limit_price(self) -> None:
        data = self._exec(
            "open_hyperliquid_testnet_trade",
            {
                "instrument_key": "hyperliquid-testnet:BTC",
                "direction": "long",
                "size": 1.0,
                "reasoning": "?",
                "order_type": "limit",
            },
        )
        self.assertIn("error", data)

    def test_list_open_trades_excludes_closed(self) -> None:
        self.store.create_trade(
            instrument_key="alpaca:AAPL",
            direction=__import__("mytradebot.trading", fromlist=["TradeDirection"]).TradeDirection.LONG,
            size=1.0,
            intent_price=100.0,
            stop_price=95.0,
        )
        t = self.store.create_trade(
            instrument_key="alpaca:AAPL",
            direction=__import__("mytradebot.trading", fromlist=["TradeDirection"]).TradeDirection.LONG,
            size=1.0, intent_price=None, stop_price=None,
            status=TradeStatus.OPEN,
        )
        self.store.mark_closed(t.id, realized_pnl=1.0)
        listed = self._exec("list_open_trades", {"instrument_key": "alpaca:AAPL"})
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["status"], "planned")

    def test_trade_history_returns_closed_and_cancelled(self) -> None:
        from mytradebot.trading import TradeDirection
        t = self.store.create_trade(
            instrument_key="alpaca:AAPL",
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
                },
            )

        placed.assert_called_once()
        _, kwargs = placed.call_args
        self.assertEqual(kwargs["symbol"], "BTCUSDT")
        self.assertEqual(kwargs["product_type"], "USDT-FUTURES")
        self.assertTrue(data["ok"])
        self.assertEqual(data["exchange"], "bitget-demo")
        trade = data["trade"]
        self.assertEqual(trade["fillSource"], "bitget-demo")
        self.assertEqual(trade["externalOrderId"], "bg-1")
        self.assertEqual(trade["status"], "planned")

    def test_open_bitget_demo_trade_rejects_non_bitget_key(self) -> None:
        data = self._exec(
            "open_bitget_demo_trade",
            {
                "instrument_key": "hyperliquid-testnet:BTC",
                "direction": "long",
                "size": 0.01,
                "reasoning": "wrong venue",
            },
        )
        self.assertIn("error", data)


if __name__ == "__main__":
    unittest.main()
