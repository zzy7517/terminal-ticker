"""Test agent-facing trading tools backed by TradeStore."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from mytradebot.agent.tools import ToolCall, build_trading_tools
from mytradebot.trading import TradeStore, TradeStatus


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

    def test_open_limit_trade_freezes_snapshot_and_session(self) -> None:
        data = self._exec(
            "open_paper_trade",
            {
                "instrument_key": "bitget:BTCUSDT:USDT-FUTURES",
                "direction": "long",
                "size": 0.1,
                "reasoning": "bullish BOS on 1H",
                "entry_type": "limit",
                "entry_price": 60000.0,
                "stop_price": 59000.0,
                "target_prices": [61000.0, 62000.0],
            },
        )
        self.assertTrue(data["ok"])
        trade = data["trade"]
        self.assertEqual(trade["status"], "planned")
        self.assertEqual(trade["sessionId"], "sess-1")
        self.assertIsNotNone(trade["snapshotId"])
        snap = self.store.get_snapshot(trade["snapshotId"])
        assert snap is not None
        self.assertEqual(snap.payload["key"], "bitget:BTCUSDT:USDT-FUTURES")

    def test_market_trade_creates_planned_order(self) -> None:
        data = self._exec(
            "open_paper_trade",
            {
                "instrument_key": "alpaca:AAPL",
                "direction": "short",
                "size": 5.0,
                "reasoning": "rejection at prior swing",
                "entry_type": "market",
                "stop_price": 210.0,
                "target_prices": [195.0],
            },
        )
        trade = data["trade"]
        self.assertEqual(trade["status"], "planned")
        self.assertIsNone(trade["intentPrice"])

    def test_reject_invalid_direction(self) -> None:
        data = self._exec(
            "open_paper_trade",
            {
                "instrument_key": "x",
                "direction": "sideways",
                "size": 1.0,
                "reasoning": "?",
            },
        )
        self.assertIn("error", data)

    def test_limit_requires_entry_price(self) -> None:
        data = self._exec(
            "open_paper_trade",
            {
                "instrument_key": "x",
                "direction": "long",
                "size": 1.0,
                "reasoning": "?",
                "entry_type": "limit",
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

    def test_cancel_and_adjust_flow(self) -> None:
        opened = self._exec(
            "open_paper_trade",
            {
                "instrument_key": "x",
                "direction": "long",
                "size": 1.0,
                "reasoning": "r",
                "entry_type": "limit",
                "entry_price": 100.0,
                "stop_price": 95.0,
                "target_prices": [110.0],
            },
        )
        trade_id = opened["trade"]["id"]
        adjusted = self._exec(
            "adjust_paper_trade",
            {"trade_id": trade_id, "stop_price": 96.0},
        )
        self.assertEqual(adjusted["trade"]["stopPrice"], 96.0)
        cancelled = self._exec("cancel_paper_trade", {"trade_id": trade_id})
        self.assertEqual(cancelled["trade"]["status"], "cancelled")

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


if __name__ == "__main__":
    unittest.main()
