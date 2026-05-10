"""社交流工具：refresh_x_following_feed / get_recent_social_feed / search_x_tweets。"""
from __future__ import annotations

from typing import Any

from .registry import ToolDefinition, ToolRegistry, _json_output

_SEARCH_PRODUCTS = {"Top", "Latest", "Photos", "Videos"}


def build_social_feed_tools(social_feed_service: Any) -> ToolRegistry:
    """构建社交流相关工具集。"""
    registry = ToolRegistry()

    def _disabled_reply(action: str) -> str:
        """返回社交流模块未启用时的错误响应。"""
        return _json_output({
            "enabled": False,
            "error": f"social feed module disabled; cannot {action}",
        })

    def _item_payload(item: Any) -> dict[str, Any]:
        """将社交流条目转换为精简的字典载荷。"""
        payload = item.to_payload()
        return {
            "source": payload.get("source"),
            "externalId": payload.get("externalId"),
            "url": payload.get("url"),
            "author": payload.get("author"),
            "text": payload.get("text"),
            "createdAt": payload.get("createdAt"),
            "metrics": payload.get("metrics"),
            "urls": payload.get("urls", []),
            "isRepost": payload.get("isRepost"),
            "repostedBy": payload.get("repostedBy"),
        }

    async def refresh_x_following_feed(count: int = 20) -> str:
        """触发一次 X Following feed 拉取并写入本地缓存。"""
        if social_feed_service is None:
            return _disabled_reply("refresh X following feed")
        resolved_count = max(1, min(int(count or 20), 100))
        outcome = await social_feed_service.refresh_x_following(count=resolved_count)
        return _json_output({
            "status": outcome.status,
            "inserted": outcome.inserted,
            "totalRecent": outcome.total_recent,
            "error": outcome.error,
        })

    registry.register(ToolDefinition(
        name="refresh_x_following_feed",
        description=(
            "低频读取用户 X/Twitter Following 信息流并写入本地缓存。"
            "需要环境变量 TWITTER_AUTH_TOKEN 和 TWITTER_CT0。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "count": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
            },
        },
        handler=refresh_x_following_feed,
    ))

    async def get_recent_social_feed(
        limit: int = 20,
        since_minutes: int | None = 24 * 60,
        query: str | None = None,
    ) -> str:
        """读取本地缓存的社交流条目。"""
        if social_feed_service is None:
            return _disabled_reply("get recent social feed")
        import time as _time

        resolved_limit = max(1, min(int(limit or 20), 100))
        since_ms = None
        if since_minutes is not None and int(since_minutes) > 0:
            since_ms = int(_time.time() * 1000) - int(since_minutes) * 60_000
        items = social_feed_service.recent_items(
            limit=resolved_limit,
            since_ms=since_ms,
            query=query,
        )
        return _json_output({
            "count": len(items),
            "items": [_item_payload(item) for item in items],
        })

    registry.register(ToolDefinition(
        name="get_recent_social_feed",
        description=(
            "读取本地缓存的 X/Twitter Following 信息流，按发布时间倒序。"
            "可按最近分钟数和关键词过滤，用于交易信息流回顾。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
                "since_minutes": {"type": ["integer", "null"], "default": 1440, "minimum": 1},
                "query": {"type": ["string", "null"], "description": "可选关键词过滤"},
            },
        },
        handler=get_recent_social_feed,
    ))

    async def search_x_tweets(
        query: str,
        count: int = 20,
        product: str = "Latest",
    ) -> str:
        """按关键词实时搜索 X/Twitter 推文，不写入本地缓存。"""
        if social_feed_service is None:
            return _disabled_reply("search X tweets")
        resolved_query = (query or "").strip()
        if not resolved_query:
            return _json_output({
                "status": "error",
                "query": resolved_query,
                "product": product,
                "count": 0,
                "items": [],
                "error": "query is required",
            })
        resolved_count = max(1, min(int(count or 20), 100))
        normalized_product = str(product or "Latest").strip().lower()
        resolved_product = next(
            (candidate for candidate in _SEARCH_PRODUCTS if candidate.lower() == normalized_product),
            "Latest",
        )
        outcome = await social_feed_service.search_x_tweets(
            query=resolved_query,
            count=resolved_count,
            product=resolved_product,
        )
        return _json_output({
            "status": outcome.status,
            "query": resolved_query,
            "product": resolved_product,
            "count": len(outcome.items),
            "error": outcome.error,
            "items": [_item_payload(item) for item in outcome.items],
        })

    registry.register(ToolDefinition(
        name="search_x_tweets",
        description=(
            "实时搜索 X/Twitter 推文，用于按关键词主动查找市场消息。"
            "不会写入本地 Following feed 缓存。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词，例如 BTC liquidation"},
                "count": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
                "product": {
                    "type": "string",
                    "default": "Latest",
                    "enum": ["Top", "Latest", "Photos", "Videos"],
                    "description": "搜索 tab，交易监控默认使用 Latest",
                },
            },
            "required": ["query"],
        },
        handler=search_x_tweets,
    ))

    return registry
