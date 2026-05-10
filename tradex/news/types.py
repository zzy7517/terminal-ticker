"""文件用途：新闻条目的领域类型。"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class NewsItem:
    """说明：单条新闻的标准表示。"""

    url: str
    source: str
    title: str
    summary: str
    published_at_ms: int
    fetched_at_ms: int
    keywords: tuple[str, ...] = field(default_factory=tuple)

    def to_payload(self) -> dict[str, Any]:
        """说明：序列化成 API / WebSocket snapshot 可用的字典。"""
        published_iso = datetime.fromtimestamp(self.published_at_ms / 1000, tz=timezone.utc).isoformat()
        return {
            "url": self.url,
            "source": self.source,
            "title": self.title,
            "summary": self.summary,
            "publishedAt": published_iso,
            "publishedAtMs": self.published_at_ms,
            "fetchedAtMs": self.fetched_at_ms,
            "keywords": list(self.keywords),
        }
