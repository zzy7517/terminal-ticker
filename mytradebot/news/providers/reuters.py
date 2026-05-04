"""文件用途：路透 sitemap_news.xml 抓取与解析。"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from xml.etree import ElementTree as ET

import httpx

from ..types import NewsItem

LOGGER = logging.getLogger(__name__)

REUTERS_SOURCE = "reuters"
DEFAULT_SITEMAP_URL = "https://www.reuters.com/sitemap_news.xml"

_NS = {
    "sm": "http://www.sitemaps.org/schemas/sitemap/0.9",
    "news": "http://www.google.com/schemas/sitemap-news/0.9",
}

_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
)


FetchStatus = Literal["ok", "not_modified", "rate_limited", "error"]


@dataclass(frozen=True)
class FetchResult:
    """说明：一次抓取的标准结果。"""

    status: FetchStatus
    items: tuple[NewsItem, ...] = ()
    etag: str | None = None
    last_modified: str | None = None
    error: str | None = None
    http_status: int | None = None


class ReutersSitemapProvider:
    """说明：从路透 Google News sitemap 抓取最新头条元数据。"""

    def __init__(
        self,
        url: str = DEFAULT_SITEMAP_URL,
        *,
        timeout_seconds: float = 10.0,
        user_agent: str = _DEFAULT_USER_AGENT,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        """说明：初始化 provider。client 仅供测试注入 MockTransport。"""
        self.url = url
        self.timeout_seconds = timeout_seconds
        self.user_agent = user_agent
        self._external_client = client

    @property
    def source_name(self) -> str:
        """说明：返回此 provider 的稳定标识。"""
        return REUTERS_SOURCE

    async def fetch(
        self,
        *,
        etag: str | None = None,
        last_modified: str | None = None,
    ) -> FetchResult:
        """说明：执行一次抓取，带上条件请求头以减少流量。"""
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
        }
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified

        client = self._external_client or httpx.AsyncClient(timeout=self.timeout_seconds)
        close_client = self._external_client is None
        try:
            try:
                response = await client.get(self.url, headers=headers)
            except httpx.HTTPError as exc:
                return FetchResult(status="error", error=f"http error: {exc}")

            new_etag = response.headers.get("ETag")
            new_last_modified = response.headers.get("Last-Modified")

            if response.status_code == 304:
                return FetchResult(
                    status="not_modified",
                    etag=new_etag or etag,
                    last_modified=new_last_modified or last_modified,
                    http_status=304,
                )
            if response.status_code in (403, 429):
                return FetchResult(
                    status="rate_limited",
                    error=f"HTTP {response.status_code}",
                    http_status=response.status_code,
                )
            if response.status_code >= 400:
                return FetchResult(
                    status="error",
                    error=f"HTTP {response.status_code}",
                    http_status=response.status_code,
                )

            try:
                items = tuple(parse_sitemap(response.text))
            except ET.ParseError as exc:
                return FetchResult(status="error", error=f"xml parse: {exc}")

            return FetchResult(
                status="ok",
                items=items,
                etag=new_etag,
                last_modified=new_last_modified,
                http_status=response.status_code,
            )
        finally:
            if close_client:
                await client.aclose()


def parse_sitemap(xml_text: str) -> list[NewsItem]:
    """说明：把 sitemap_news.xml 文本解析成 NewsItem 列表。"""
    fetched_at_ms = int(time.time() * 1000)
    root = ET.fromstring(xml_text)
    items: list[NewsItem] = []
    for url_elem in root.findall("sm:url", _NS):
        loc = _find_text(url_elem, "sm:loc")
        if not loc:
            continue
        news_elem = url_elem.find("news:news", _NS)
        if news_elem is None:
            continue
        title = _find_text(news_elem, "news:title") or ""
        pub_date_raw = _find_text(news_elem, "news:publication_date") or ""
        keywords_raw = _find_text(news_elem, "news:keywords") or ""
        published_at_ms = _parse_iso_to_ms(pub_date_raw) or fetched_at_ms
        keywords = tuple(
            kw.strip() for kw in keywords_raw.split(",") if kw.strip()
        )
        summary = ", ".join(keywords) if keywords else ""
        items.append(
            NewsItem(
                url=loc,
                source=REUTERS_SOURCE,
                title=title,
                summary=summary,
                published_at_ms=published_at_ms,
                fetched_at_ms=fetched_at_ms,
                keywords=keywords,
            )
        )
    return items


def _find_text(element: ET.Element, path: str) -> str | None:
    """说明：安全地读取子元素文本。"""
    found = element.find(path, _NS)
    if found is None or found.text is None:
        return None
    return found.text.strip()


def _parse_iso_to_ms(value: str) -> int | None:
    """说明：把 ISO-8601 时间戳转换成 Unix 毫秒，失败时返回 None。"""
    if not value:
        return None
    candidate = value.strip()
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)
