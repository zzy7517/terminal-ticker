"""Test local trading SQLite store."""
import tempfile
import unittest
from pathlib import Path

from mytradebot.trading import (
    FillKind,
    TradeDirection,
    TradeStatus,
    TradeStore,
)


class TradeStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = TradeStore(Path(self._tmp.name) / "trades.sqlite3")

    def test_creates_planned_trade_with_defaults(self) -> None:
        trade = self.store.create_trade(
            instrument_key="bitget:BTCUSDT:USDT-FUTURES",
            direction=TradeDirection.LONG,
            size=0.1,
            intent_price=50000.0,
            stop_price=49000.0,
            target_prices=(51000.0, 52000.0),
            reasoning_text="test setup",
        )
        self.assertEqual(trade.status, TradeStatus.PLANNED)
        self.assertIsNone(trade.opened_at_ms)
        self.assertEqual(trade.target_prices, (51000.0, 52000.0))
        self.assertEqual(trade.fill_source, "simulated")
        self.assertEqual(trade.fills, ())

    def test_rejects_non_positive_size(self) -> None:
        with self.assertRaises(ValueError):
            self.store.create_trade(
                instrument_key="alpaca:AAPL",
                direction=TradeDirection.LONG,
                size=0.0,
                intent_price=None,
                stop_price=None,
            )

    def test_planned_to_open_via_entry_fill(self) -> None:
        trade = self.store.create_trade(
            instrument_key="alpaca:AAPL",
            direction=TradeDirection.LONG,
            size=10.0,
            intent_price=180.0,
            stop_price=175.0,
        )
        self.store.record_fill(
            trade_id=trade.id,
            kind=FillKind.ENTRY,
            price=180.5,
            quantity=10.0,
            trigger_reason="limit crossed",
        )
        opened = self.store.mark_open(trade.id)
        self.assertEqual(opened.status, TradeStatus.OPEN)
        self.assertIsNotNone(opened.opened_at_ms)
        self.assertEqual(len(opened.fills), 1)
        self.assertEqual(opened.average_entry_price, 180.5)

    def test_stop_hit_closes_trade_with_loss(self) -> None:
        trade = self.store.create_trade(
            instrument_key="bitget:ETHUSDT:USDT-FUTURES",
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=3000.0,
            stop_price=2900.0,
            status=TradeStatus.OPEN,
        )
        self.store.record_fill(
            trade_id=trade.id, kind=FillKind.ENTRY, price=3000.0, quantity=1.0,
        )
        self.store.record_fill(
            trade_id=trade.id, kind=FillKind.STOP, price=2900.0, quantity=1.0,
            trigger_reason="stop hit",
        )
        closed = self.store.mark_closed(trade.id, realized_pnl=-100.0)
        self.assertEqual(closed.status, TradeStatus.CLOSED)
        self.assertEqual(closed.realized_pnl, -100.0)
        self.assertEqual(closed.average_exit_price, 2900.0)

    def test_target_hit_closes_short_trade_with_profit(self) -> None:
        trade = self.store.create_trade(
            instrument_key="bitget:BTCUSDT:USDT-FUTURES",
            direction=TradeDirection.SHORT,
            size=0.5,
            intent_price=60000.0,
            stop_price=61000.0,
            target_prices=(58000.0,),
            status=TradeStatus.OPEN,
        )
        self.store.record_fill(
            trade_id=trade.id, kind=FillKind.ENTRY, price=60000.0, quantity=0.5,
        )
        self.store.record_fill(
            trade_id=trade.id, kind=FillKind.TARGET, price=58000.0, quantity=0.5,
        )
        pnl = (60000.0 - 58000.0) * 0.5
        closed = self.store.mark_closed(trade.id, realized_pnl=pnl)
        self.assertEqual(closed.realized_pnl, 1000.0)

    def test_cancel_planned_only(self) -> None:
        trade = self.store.create_trade(
            instrument_key="alpaca:AAPL",
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=180.0,
            stop_price=175.0,
        )
        cancelled = self.store.cancel_trade(trade.id)
        self.assertEqual(cancelled.status, TradeStatus.CANCELLED)

        trade2 = self.store.create_trade(
            instrument_key="alpaca:AAPL",
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=None,
            stop_price=None,
            status=TradeStatus.OPEN,
        )
        with self.assertRaises(ValueError):
            self.store.cancel_trade(trade2.id)

    def test_adjust_levels(self) -> None:
        trade = self.store.create_trade(
            instrument_key="alpaca:SPY",
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=500.0,
            stop_price=495.0,
            target_prices=(510.0,),
        )
        adjusted = self.store.adjust_levels(
            trade.id, stop_price=498.0, target_prices=(511.0, 515.0),
        )
        self.assertEqual(adjusted.stop_price, 498.0)
        self.assertEqual(adjusted.target_prices, (511.0, 515.0))

    def test_snapshot_roundtrip(self) -> None:
        snap = self.store.save_snapshot(
            instrument_key="alpaca:AAPL",
            payload={"timeframes": {"5m": [1, 2, 3]}, "bias": "bullish"},
        )
        loaded = self.store.get_snapshot(snap.id)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertEqual(loaded.payload["bias"], "bullish")

    def test_list_filters_by_instrument_and_status(self) -> None:
        a = self.store.create_trade(
            instrument_key="alpaca:AAPL",
            direction=TradeDirection.LONG,
            size=1.0, intent_price=180.0, stop_price=175.0,
        )
        b = self.store.create_trade(
            instrument_key="alpaca:MSFT",
            direction=TradeDirection.SHORT,
            size=1.0, intent_price=400.0, stop_price=405.0,
            status=TradeStatus.OPEN,
        )
        open_only = self.store.list_trades(statuses=[TradeStatus.OPEN])
        self.assertEqual({t.id for t in open_only}, {b.id})
        aapl_only = self.store.list_trades(instrument_key="alpaca:AAPL")
        self.assertEqual({t.id for t in aapl_only}, {a.id})

    def test_fills_cascade_on_trade_delete(self) -> None:
        trade = self.store.create_trade(
            instrument_key="alpaca:AAPL",
            direction=TradeDirection.LONG,
            size=1.0, intent_price=180.0, stop_price=175.0,
        )
        self.store.record_fill(
            trade_id=trade.id, kind=FillKind.ENTRY, price=180.0, quantity=1.0,
        )
        loaded = self.store.get_trade(trade.id)
        assert loaded is not None
        self.assertEqual(len(loaded.fills), 1)


if __name__ == "__main__":
    unittest.main()
