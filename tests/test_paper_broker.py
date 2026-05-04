"""Test paper broker fill logic on 1m candles."""
import tempfile
import unittest
from pathlib import Path

from mytradebot.domain.price_action import Candle
from mytradebot.trading import (
    TradeDirection,
    TradeStatus,
    TradeStore,
)
from mytradebot.trading.paper_broker import PaperBroker


SYMBOL = "bitget:BTCUSDT:USDT-FUTURES"


def _candle(open_time_ms: int, *, low: float, high: float, open_: float, close: float) -> Candle:
    return Candle(
        symbol_key=SYMBOL,
        open_time_ms=open_time_ms,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=1.0,
    )


class PaperBrokerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = TradeStore(Path(self._tmp.name) / "t.sqlite3")
        self.broker = PaperBroker(self.store)

    def test_limit_long_fills_on_touch(self) -> None:
        trade = self.store.create_trade(
            instrument_key=SYMBOL,
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=100.0,
            stop_price=95.0,
            target_prices=(110.0,),
        )
        # K 线从 102 下探到 99 再收回 101，触及 100
        events = self.broker.process_candle(
            _candle(1, low=99.0, high=102.0, open_=102.0, close=101.0)
        )
        self.assertEqual(len(events), 1)
        refreshed = self.store.get_trade(trade.id)
        assert refreshed is not None
        self.assertEqual(refreshed.status, TradeStatus.OPEN)
        self.assertEqual(len(refreshed.fills), 1)
        self.assertAlmostEqual(refreshed.fills[0].price, 100.0)

    def test_limit_long_no_fill_when_price_stays_above(self) -> None:
        self.store.create_trade(
            instrument_key=SYMBOL,
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=100.0,
            stop_price=95.0,
            target_prices=(110.0,),
        )
        events = self.broker.process_candle(
            _candle(1, low=101.0, high=105.0, open_=102.0, close=104.0)
        )
        self.assertEqual(events, ())

    def test_market_order_fills_at_open(self) -> None:
        trade = self.store.create_trade(
            instrument_key=SYMBOL,
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=None,
            stop_price=None,
        )
        events = self.broker.process_candle(
            _candle(1, low=99.0, high=101.0, open_=100.5, close=100.0)
        )
        self.assertEqual(len(events), 1)
        refreshed = self.store.get_trade(trade.id)
        assert refreshed is not None
        self.assertEqual(refreshed.fills[0].price, 100.5)

    def test_long_stop_hit_closes_with_loss(self) -> None:
        trade = self.store.create_trade(
            instrument_key=SYMBOL,
            direction=TradeDirection.LONG,
            size=2.0,
            intent_price=100.0,
            stop_price=95.0,
            target_prices=(110.0,),
            status=TradeStatus.OPEN,
        )
        self.store.record_fill(
            trade_id=trade.id,
            kind=__import__("mytradebot.trading", fromlist=["FillKind"]).FillKind.ENTRY,
            price=100.0,
            quantity=2.0,
        )
        events = self.broker.process_candle(
            _candle(2, low=94.0, high=101.0, open_=100.0, close=96.0)
        )
        self.assertEqual(len(events), 1)
        refreshed = self.store.get_trade(trade.id)
        assert refreshed is not None
        self.assertEqual(refreshed.status, TradeStatus.CLOSED)
        # pnl = (95 - 100) * 2 * 1 = -10
        self.assertAlmostEqual(refreshed.realized_pnl, -10.0)

    def test_long_target_hit_closes_with_profit(self) -> None:
        from mytradebot.trading import FillKind
        trade = self.store.create_trade(
            instrument_key=SYMBOL,
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=100.0,
            stop_price=95.0,
            target_prices=(110.0, 120.0),
            status=TradeStatus.OPEN,
        )
        self.store.record_fill(
            trade_id=trade.id, kind=FillKind.ENTRY, price=100.0, quantity=1.0,
        )
        # 触及最低目标 110
        events = self.broker.process_candle(
            _candle(2, low=105.0, high=112.0, open_=106.0, close=111.0)
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, FillKind.TARGET)
        refreshed = self.store.get_trade(trade.id)
        assert refreshed is not None
        self.assertAlmostEqual(refreshed.realized_pnl, 10.0)

    def test_short_stop_hit_when_high_exceeds_stop(self) -> None:
        from mytradebot.trading import FillKind
        trade = self.store.create_trade(
            instrument_key=SYMBOL,
            direction=TradeDirection.SHORT,
            size=1.0,
            intent_price=100.0,
            stop_price=105.0,
            target_prices=(90.0,),
            status=TradeStatus.OPEN,
        )
        self.store.record_fill(
            trade_id=trade.id, kind=FillKind.ENTRY, price=100.0, quantity=1.0,
        )
        events = self.broker.process_candle(
            _candle(2, low=99.0, high=106.0, open_=100.0, close=104.0)
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, FillKind.STOP)
        refreshed = self.store.get_trade(trade.id)
        assert refreshed is not None
        # pnl = (105 - 100) * 1 * -1 = -5
        self.assertAlmostEqual(refreshed.realized_pnl, -5.0)

    def test_stop_and_target_same_bar_stop_wins(self) -> None:
        from mytradebot.trading import FillKind
        trade = self.store.create_trade(
            instrument_key=SYMBOL,
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=100.0,
            stop_price=95.0,
            target_prices=(110.0,),
            status=TradeStatus.OPEN,
        )
        self.store.record_fill(
            trade_id=trade.id, kind=FillKind.ENTRY, price=100.0, quantity=1.0,
        )
        events = self.broker.process_candle(
            _candle(2, low=94.0, high=112.0, open_=100.0, close=100.0)
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, FillKind.STOP)

    def test_on_fill_callback_invoked(self) -> None:
        from mytradebot.trading import FillKind
        received: list[int] = []
        broker = PaperBroker(self.store, on_fill=lambda ev: received.append(ev.trade_id))
        trade = self.store.create_trade(
            instrument_key=SYMBOL,
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=100.0,
            stop_price=95.0,
            target_prices=(110.0,),
        )
        broker.process_candle(_candle(1, low=99.0, high=101.0, open_=101.0, close=100.0))
        self.assertEqual(received, [trade.id])

    def test_ignores_candles_from_other_instruments(self) -> None:
        trade = self.store.create_trade(
            instrument_key=SYMBOL,
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=100.0,
            stop_price=95.0,
        )
        other = Candle(
            symbol_key="alpaca:AAPL",
            open_time_ms=1,
            open=100.0, high=101.0, low=99.0, close=100.0, volume=1.0,
        )
        events = self.broker.process_candle(other)
        self.assertEqual(events, ())
        refreshed = self.store.get_trade(trade.id)
        assert refreshed is not None
        self.assertEqual(refreshed.status, TradeStatus.PLANNED)


if __name__ == "__main__":
    unittest.main()
