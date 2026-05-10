"""文件用途：社交信息流条目的领域类型。"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class SocialAuthor:
    """说明：社交平台作者的标准表示。"""

    id: str
    name: str
    handle: str
    profile_image_url: str = ""
    verified: bool = False

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "handle": self.handle,
            "profileImageUrl": self.profile_image_url,
            "verified": self.verified,
        }


@dataclass(frozen=True)
class SocialMetrics:
    """说明：社交条目的互动指标。"""

    likes: int = 0
    reposts: int = 0
    replies: int = 0
    quotes: int = 0
    views: int = 0
    bookmarks: int = 0

    def to_payload(self) -> dict[str, int]:
        return {
            "likes": self.likes,
            "reposts": self.reposts,
            "replies": self.replies,
            "quotes": self.quotes,
            "views": self.views,
            "bookmarks": self.bookmarks,
        }


@dataclass(frozen=True)
class SocialFeedItem:
    """说明：一条社交信息流内容，当前主要承载 X/Twitter 推文。"""

    source: str
    external_id: str
    url: str
    author: SocialAuthor
    text: str
    created_at_ms: int
    fetched_at_ms: int
    metrics: SocialMetrics = field(default_factory=SocialMetrics)
    urls: tuple[str, ...] = field(default_factory=tuple)
    lang: str = ""
    is_repost: bool = False
    reposted_by: str | None = None
    quoted_item: "SocialFeedItem | None" = None
    raw: dict[str, Any] = field(default_factory=dict)

    def to_payload(self, *, include_raw: bool = False) -> dict[str, Any]:
        created_iso = datetime.fromtimestamp(
            self.created_at_ms / 1000,
            tz=timezone.utc,
        ).isoformat()
        payload: dict[str, Any] = {
            "source": self.source,
            "externalId": self.external_id,
            "url": self.url,
            "author": self.author.to_payload(),
            "text": self.text,
            "createdAt": created_iso,
            "createdAtMs": self.created_at_ms,
            "fetchedAtMs": self.fetched_at_ms,
            "metrics": self.metrics.to_payload(),
            "urls": list(self.urls),
            "lang": self.lang,
            "isRepost": self.is_repost,
            "repostedBy": self.reposted_by,
            "quotedItem": (
                self.quoted_item.to_payload(include_raw=False)
                if self.quoted_item is not None
                else None
            ),
        }
        if include_raw:
            payload["raw"] = self.raw
        return payload
