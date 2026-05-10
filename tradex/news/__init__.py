"""文件用途：新闻抓取与存储模块入口，导出公共类型。"""
from __future__ import annotations

from .types import NewsItem
from .store import NewsStore, default_news_store_path
from .service import NewsService

__all__ = [
    "NewsItem",
    "NewsStore",
    "NewsService",
    "default_news_store_path",
]
