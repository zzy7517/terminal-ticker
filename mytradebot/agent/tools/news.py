"""新闻工具：get_recent_news / refresh_news。"""
from __future__ import annotations

from typing import Any

from .registry import ToolDefinition, ToolRegistry, _json_output


def build_news_tools(news_service: Any) -> ToolRegistry:
    """构建新闻相关工具集。news_service 为 None 时工具提示功能未启用。"""
    registry = ToolRegistry()

    def _disabled_reply(action: str) -> str:
        """返回新闻模块未启用时的错误响应。"""
        return _json_output({
            "enabled": False,
            "error": f"news module disabled; cannot {action}",
        })

    def _item_payload(item: Any) -> dict[str, Any]:
        """将新闻条目转换为精简的字典载荷。"""
        payload = item.to_payload()
        return {
            "url": payload.get("url"),
            "source": payload.get("source"),
            "title": payload.get("title"),
            "summary": payload.get("summary"),
            "publishedAt": payload.get("publishedAt"),
            "keywords": payload.get("keywords", []),
        }

    async def get_recent_news(limit: int = 10, since_minutes: int | None = 120) -> str:
        """返回最近的新闻条目。"""
        if news_service is None:
            return _disabled_reply("get recent news")
        resolved_limit = max(1, min(int(limit or 10), 50))
        items = news_service.recent(limit=resolved_limit)
        if since_minutes is not None and since_minutes > 0:
            import time as _time
            cutoff = int(_time.time() * 1000) - int(since_minutes) * 60_000
            items = [item for item in items if item.published_at_ms >= cutoff]
        return _json_output({
            "count": len(items),
            "items": [_item_payload(item) for item in items],
        })

    async def refresh_news() -> str:
        """触发一次同步刷新并返回摘要。"""
        if news_service is None:
            return _disabled_reply("refresh news")
        outcome = await news_service.refresh_now()
        return _json_output({
            "status": outcome.status,
            "inserted": outcome.inserted,
            "totalRecent": outcome.total_recent,
            "error": outcome.error,
        })

    registry.register(ToolDefinition(
        name="get_recent_news",
        description=(
            "读取本地缓存的路透最新新闻条目（按发布时间倒序）。"
            "可选限制返回条数和最近时间窗口（分钟）。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 50},
                "since_minutes": {"type": ["integer", "null"], "default": 120, "minimum": 1},
            },
        },
        handler=get_recent_news,
    ))

    registry.register(ToolDefinition(
        name="refresh_news",
        description=(
            "立即向路透拉取最新 sitemap 并写入本地缓存。"
            "返回本次新增条数以及总缓存条数。"
        ),
        parameters={
            "type": "object",
            "properties": {},
        },
        handler=refresh_news,
    ))

    return registry
