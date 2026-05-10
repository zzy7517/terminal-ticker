"""文件用途：校验 tradex 记忆中的事实和复盘假设边界。"""
from __future__ import annotations

from typing import Any

INFERENCE_TERMS = (
    "因为",
    "导致",
    "容易",
    "应该",
    "总是",
    "倾向",
    "说明",
    "证明",
    "caused",
    "because",
    "should",
    "always",
    "likely",
    "proves",
)


class MemoryValidationError(ValueError):
    """说明：事实或复盘内容越过记忆边界。"""


def validate_fact_text(text: str) -> None:
    """说明：拒绝包含因果或建议推断的事实文本。"""
    content = text.strip()
    if not content:
        raise MemoryValidationError("fact text must not be empty")
    lowered = content.lower()
    # 事实只能记录发生了什么；原因、建议和模式判断必须放到复盘。
    for term in INFERENCE_TERMS:
        if term.lower() in lowered:
            raise MemoryValidationError(f"fact text contains inference term: {term}")


def validate_review_metadata(metadata: dict[str, Any]) -> None:
    """说明：复盘必须引用事实并声明样本数量。"""
    based_on = metadata.get("based_on")
    # 复盘可以包含假设，但必须有事实锚点，避免假设悄悄变成长期交易规则。
    if not isinstance(based_on, list) or not based_on or not all(isinstance(item, str) and item for item in based_on):
        raise MemoryValidationError("review metadata must include non-empty based_on fact ids")
    sample_count = metadata.get("sample_count")
    if not isinstance(sample_count, int) or sample_count < 1:
        raise MemoryValidationError("review metadata sample_count must be a positive integer")
