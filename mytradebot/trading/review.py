"""文件用途：关闭交易的复盘编排，生成 lesson 写入 store。"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from .models import Trade, TradeStatus
from .store import TradeStore

LOGGER = logging.getLogger(__name__)

ReviewLLM = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class ReviewResult:
    """说明：一次 review 任务的结果。"""

    trade_id: int
    lesson_id: int | None
    success: bool
    error: str | None = None


REVIEW_INSTRUCTIONS = """你是一个 price action 交易复盘助手。
根据一笔已关闭的虚拟交易的开单上下文、执行结果和盈亏，写出简短、可执行的教训。
输出一个 JSON object，字段必须是：
lesson: string (一两句话，聚焦下次能改进的点)
category: string ("entry" | "exit" | "risk" | "patience" | "bias" 之一)
tags: array of string (最多 4 个小标签，例如 ["fvg", "1H", "late_entry"])
"""


async def review_trade(
    *,
    trade: Trade,
    snapshot_payload: dict[str, Any] | None,
    llm: ReviewLLM,
) -> dict[str, Any]:
    """说明：用 LLM 对一笔 closed trade 生成 lesson。"""
    summary: dict[str, Any] = {
        "instruction": REVIEW_INSTRUCTIONS,
        "trade": trade.to_payload(include_fills=True),
        "snapshot_at_open": snapshot_payload,
    }
    return await llm(summary)


async def review_pending(
    *,
    store: TradeStore,
    llm: ReviewLLM,
    limit: int = 5,
) -> tuple[ReviewResult, ...]:
    """说明：扫描尚无 lesson 的 closed trade，逐个生成并存储。"""
    ids = store.trade_ids_without_review(limit=limit)
    results: list[ReviewResult] = []
    for trade_id in ids:
        trade = store.get_trade(trade_id)
        if trade is None or trade.status is not TradeStatus.CLOSED:
            continue
        snapshot_payload = None
        if trade.snapshot_id is not None:
            snap = store.get_snapshot(trade.snapshot_id)
            if snap is not None:
                snapshot_payload = snap.payload
        try:
            parsed = await review_trade(
                trade=trade,
                snapshot_payload=snapshot_payload,
                llm=llm,
            )
        except Exception as exc:
            LOGGER.exception("trade review failed for %s", trade_id)
            results.append(ReviewResult(
                trade_id=trade_id, lesson_id=None, success=False,
                error=str(exc) or exc.__class__.__name__,
            ))
            continue
        lesson_text = _extract_text(parsed)
        if not lesson_text:
            results.append(ReviewResult(
                trade_id=trade_id, lesson_id=None, success=False,
                error="empty lesson from LLM",
            ))
            continue
        category = str(parsed.get("category") or "")
        tags_raw = parsed.get("tags")
        tags = [str(t) for t in tags_raw] if isinstance(tags_raw, list) else []
        lesson_id = store.save_lesson(
            trade_id=trade.id,
            instrument_key=trade.instrument_key,
            text=lesson_text,
            category=category,
            tags=tags,
        )
        results.append(ReviewResult(
            trade_id=trade_id, lesson_id=lesson_id, success=True,
        ))
    return tuple(results)


def _extract_text(parsed: Any) -> str:
    """说明：从 LLM 输出里取出 lesson 文本，容忍多种包装形式。"""
    if isinstance(parsed, dict):
        for key in ("lesson", "text", "content"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        # 有时 LLM 会返回 {"summary": {...}}
        if "summary" in parsed and isinstance(parsed["summary"], str):
            return parsed["summary"].strip()
    if isinstance(parsed, str):
        try:
            decoded = json.loads(parsed)
        except json.JSONDecodeError:
            return parsed.strip()
        return _extract_text(decoded)
    return ""
