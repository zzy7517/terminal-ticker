"""文件用途：路透 sitemap_news.xml 抓取与解析。"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from xml.etree import ElementTree as ET

import httpx

try:
    from curl_cffi.requests import AsyncSession as _CurlAsyncSession
    from curl_cffi.requests.exceptions import RequestException as _CurlRequestException
except ImportError:  # pragma: no cover - curl_cffi is a runtime dependency
    _CurlAsyncSession = None
    _CurlRequestException = Exception

from ..types import NewsItem

LOGGER = logging.getLogger(__name__)

REUTERS_SOURCE = "reuters"
# 老的 /sitemap_news.xml 已被 Reuters 下线（对非 Googlebot 一律 401）。
# 现在用 Arc CMS 出口：news-sitemap 是分页 sitemap，第一页是最近 50 条，
# 后端 Cache-Control: max-age=6 → 数据非常新鲜。
DEFAULT_SITEMAP_URL = "https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml"

_NS = {
    "sm": "http://www.sitemaps.org/schemas/sitemap/0.9",
    "news": "http://www.google.com/schemas/sitemap-news/0.9",
    "image": "http://www.google.com/schemas/sitemap-image/1.1",
}

# Reuters 新 endpoint 的 <news:keywords> 是 NewsML 内部 GUID 串，不是人类可读的标签。
# 完整 token 类似：
#   GUID:tag:reuters.com,2026:newsml_KBN3PN1D5
# 但是整个字段又用逗号分隔多个 token，所以按 ',' 切完会得到两类碎片：
#   "GUID:tag:reuters.com"      ← 以 GUID/VGUID/USN: 起头
#   "2026:newsml_KBN3PN1D5"     ← 残留的右半部分
# 两类都不是关键词，统一过滤掉。
_NEWSML_GUID_PREFIXES = ("GUID:", "VGUID:", "USN:")
_NEWSML_GUID_FRAGMENT_MARKERS = ("newsml_", "tag:reuters.com")

# Reuters sits behind Cloudflare; a plain httpx client gets fingerprinted and
# returns 401 even with a browser UA. curl_cffi impersonates a real browser's
# TLS+HTTP2 handshake. 实测 chrome/firefox 指纹仍被拒，safari 通过。
_IMPERSONATE_TARGET = "safari17_0"

_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
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
            "Accept": "application/xml,application/xhtml+xml,text/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
        }
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified

        if self._external_client is not None:
            return await self._fetch_via_httpx(self._external_client, headers, etag, last_modified)
        if _CurlAsyncSession is not None:
            return await self._fetch_via_curl_cffi(headers, etag, last_modified)
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            return await self._fetch_via_httpx(client, headers, etag, last_modified)

    async def _fetch_via_httpx(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
        etag: str | None,
        last_modified: str | None,
    ) -> FetchResult:
        """说明：测试或 fallback 路径，使用注入的 httpx client。"""
        try:
            response = await client.get(self.url, headers=headers)
        except httpx.HTTPError as exc:
            return FetchResult(status="error", error=f"http error: {exc}")
        return _build_result(
            status_code=response.status_code,
            text=response.text,
            response_etag=response.headers.get("ETag"),
            response_last_modified=response.headers.get("Last-Modified"),
            request_etag=etag,
            request_last_modified=last_modified,
        )

    async def _fetch_via_curl_cffi(
        self,
        headers: dict[str, str],
        etag: str | None,
        last_modified: str | None,
    ) -> FetchResult:
        """说明：默认路径。curl_cffi 伪装 Chrome 指纹绕 Cloudflare。"""
        assert _CurlAsyncSession is not None  # narrowed by caller
        try:
            async with _CurlAsyncSession(
                impersonate=_IMPERSONATE_TARGET,
                timeout=self.timeout_seconds,
            ) as session:
                response = await session.get(self.url, headers=headers)
        except _CurlRequestException as exc:
            return FetchResult(status="error", error=f"curl error: {exc}")

        return _build_result(
            status_code=response.status_code,
            text=response.text,
            response_etag=response.headers.get("ETag"),
            response_last_modified=response.headers.get("Last-Modified"),
            request_etag=etag,
            request_last_modified=last_modified,
        )


def _build_result(
    *,
    status_code: int,
    text: str,
    response_etag: str | None,
    response_last_modified: str | None,
    request_etag: str | None,
    request_last_modified: str | None,
) -> FetchResult:
    """说明：把 HTTP 响应统一翻译成 FetchResult，避免 httpx/curl_cffi 双路径分叉。"""
    if status_code == 304:
        return FetchResult(
            status="not_modified",
            etag=response_etag or request_etag,
            last_modified=response_last_modified or request_last_modified,
            http_status=304,
        )
    # Cloudflare 拒访问可能用 401/403/429，统一按 rate_limited 处理走指数退避
    if status_code in (401, 403, 429):
        return FetchResult(
            status="rate_limited",
            error=f"HTTP {status_code}",
            http_status=status_code,
        )
    if status_code >= 400:
        return FetchResult(
            status="error",
            error=f"HTTP {status_code}",
            http_status=status_code,
        )
    try:
        items = tuple(parse_sitemap(text))
    except ET.ParseError as exc:
        return FetchResult(status="error", error=f"xml parse: {exc}")
    return FetchResult(
        status="ok",
        items=items,
        etag=response_etag,
        last_modified=response_last_modified,
        http_status=status_code,
    )


def parse_sitemap(xml_text: str) -> list[NewsItem]:
    """说明：把 sitemap XML 文本解析成 NewsItem 列表。

    新 endpoint (/arc/outboundfeeds/news-sitemap) 与老 endpoint (/sitemap_news.xml)
    XML 结构相同，但语义有差：
    - news:keywords 退化成 NewsML 内部 GUID（GUID/VGUID/USN: 前缀），需要丢弃
    - 多了 image:caption，常常是真人写的一句话，更适合当 summary
    所以：summary 优先取 image:caption；keywords 从 URL path 推类目（world/us、
    sports/baseball、legal/transactional），丢掉 GUID 噪声。
    """
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
        published_at_ms = _parse_iso_to_ms(pub_date_raw) or fetched_at_ms

        keywords_raw = _find_text(news_elem, "news:keywords") or ""
        keywords = _extract_keywords(keywords_raw, loc)

        image_caption = _find_text(url_elem, "image:image/image:caption") or ""
        summary = image_caption.strip()

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


def _extract_keywords(raw: str, url: str) -> tuple[str, ...]:
    """说明：拿一组人类可读的标签。

    若 raw 里有非 GUID 的逗号分隔标签（老 endpoint 风格），直接用；
    否则从 URL path 推类目（如 world/us、sports/baseball）。
    """
    cleaned = tuple(
        token
        for token in (segment.strip() for segment in raw.split(","))
        if token and not _is_newsml_fragment(token)
    )
    if cleaned:
        return cleaned
    return _categories_from_url(url)


def _is_newsml_fragment(token: str) -> bool:
    """说明：判断一个 token 是否属于 NewsML GUID 字符串（包括它的右半碎片）。"""
    if token.startswith(_NEWSML_GUID_PREFIXES):
        return True
    return any(marker in token for marker in _NEWSML_GUID_FRAGMENT_MARKERS)


def _categories_from_url(url: str) -> tuple[str, ...]:
    """说明：把 https://www.reuters.com/world/us/foo-2026-05-05/ 推成 ('world', 'us')。

    Reuters 文章 URL 倒数第一段是 slug + 日期，前面的段是分类层级。最多取前 3 段。
    """
    try:
        from urllib.parse import urlparse

        path = urlparse(url).path
    except Exception:  # noqa: BLE001
        return ()
    segments = [seg for seg in path.split("/") if seg]
    # 最后一段是 article slug，丢弃
    category_segments = segments[:-1] if len(segments) > 1 else []
    return tuple(category_segments[:3])


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
