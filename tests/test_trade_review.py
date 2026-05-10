"""Test trade review loop and lessons storage."""
import asyncio
import tempfile
import unittest
from pathlib import Path

from tradex.trading import (
    FillKind,
    TradeDirection,
    TradeStatus,
    TradeStore,
)
from tradex.trading.review import review_pending


def _run(coro):
    return asyncio.run(coro)


class TradeReviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = TradeStore(Path(self._tmp.name) / "t.sqlite3")

    def _make_closed_trade(
        self,
        *,
        instrument_key: str = "bitget:BTCUSDT:USDT-FUTURES",
        realized_pnl: float = -50.0,
    ) -> int:
        snap = self.store.save_snapshot(
            instrument_key=instrument_key,
            payload={"bias": "bullish", "timeframes": {"5m": []}},
        )
        trade = self.store.create_trade(
            instrument_key=instrument_key,
            direction=TradeDirection.LONG,
            size=1.0,
            intent_price=100.0,
            stop_price=95.0,
            target_prices=(110.0,),
            snapshot_id=snap.id,
            status=TradeStatus.OPEN,
            reasoning_text="BOS on 1H",
        )
        self.store.record_fill(
            trade_id=trade.id, kind=FillKind.ENTRY, price=100.0, quantity=1.0,
        )
        self.store.record_fill(
            trade_id=trade.id, kind=FillKind.STOP, price=95.0, quantity=1.0,
        )
        self.store.mark_closed(trade.id, realized_pnl=realized_pnl)
        return trade.id

    def test_review_stores_lesson_for_closed_trade(self) -> None:
        trade_id = self._make_closed_trade()

        async def fake_llm(payload):
            # 确认 snapshot 被传入
            self.assertIsNotNone(payload["snapshot_at_open"])
            self.assertEqual(payload["trade"]["id"], trade_id)
            return {
                "lesson": "Entry was late; wait for pullback into OB.",
                "category": "entry",
                "tags": ["ob", "late_entry"],
            }

        results = _run(review_pending(store=self.store, llm=fake_llm))
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].success)
        lessons = self.store.list_lessons()
        self.assertEqual(len(lessons), 1)
        self.assertEqual(lessons[0]["category"], "entry")
        self.assertEqual(lessons[0]["tags"], ["ob", "late_entry"])

    def test_review_skips_already_reviewed(self) -> None:
        trade_id = self._make_closed_trade()
        self.store.save_lesson(
            trade_id=trade_id,
            instrument_key="bitget:BTCUSDT:USDT-FUTURES",
            text="prior lesson",
        )

        async def fail_llm(_payload):
            self.fail("LLM should not be invoked when trade already reviewed")

        results = _run(review_pending(store=self.store, llm=fail_llm))
        self.assertEqual(results, ())

    def test_review_records_error_without_crashing(self) -> None:
        self._make_closed_trade()

        async def broken_llm(_payload):
            raise RuntimeError("quota exceeded")

        results = _run(review_pending(store=self.store, llm=broken_llm))
        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].success)
        self.assertIn("quota", results[0].error or "")
        self.assertEqual(self.store.list_lessons(), ())

    def test_list_lessons_filters_by_instrument(self) -> None:
        self._make_closed_trade(instrument_key="USDT-FUTURES:BTCUSDT")
        self._make_closed_trade(instrument_key="bitget:ETHUSDT:USDT-FUTURES")
        self.store.save_lesson(
            trade_id=None, instrument_key="USDT-FUTURES:BTCUSDT", text="L1",
        )
        self.store.save_lesson(
            trade_id=None, instrument_key="bitget:ETHUSDT:USDT-FUTURES", text="L2",
        )
        aapl = self.store.list_lessons(instrument_key="USDT-FUTURES:BTCUSDT")
        self.assertEqual(len(aapl), 1)
        self.assertEqual(aapl[0]["text"], "L1")


if __name__ == "__main__":
    unittest.main()
