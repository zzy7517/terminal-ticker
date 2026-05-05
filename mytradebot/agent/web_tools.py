"""文件用途：给 agent loop 加 web_search / web_fetch 两个工具。

# 后端策略
# - web_search: 走 DuckDuckGo HTML 端点（零配置 / 免费 / 不需 API key）。
#   后续如要升级到 Brave / Tavily / Exa，只需新增 _search_<backend> 函数
#   并在 _resolve_backend() 里加 env 探测分支。
# - web_fetch: 用 curl_cffi 伪装 Safari 指纹拉取任意 URL，跟 Reuters
#   sitemap provider 同样的反爬策略，一致体验。
#
# # 已知限制
# - DDG HTML 抓取被反爬时报错，工具返回 error JSON 让 LLM 自行决定要不要重试或换 query
# - web_fetch 不做 HTML→Markdown 渲染，只剥 <script>/<style> 后返回纯文本片段
"""
from __future__ import annotations

import json
import logging
import re
from html import unescape
from typing import Any
from urllib.parse import urlparse

try:
    from curl_cffi.requests import AsyncSession as _CurlAsyncSession
    from curl_cffi.requests.exceptions import RequestException as _CurlRequestException
except ImportError:  # pragma: no cover
    _CurlAsyncSession = None
    _CurlRequestException = Exception

from .tools import ToolDefinition, ToolRegistry

LOGGER = logging.getLogger(__name__)

DDG_HTML_URL = "https://html.duckduckgo.com/html/"
_IMPERSONATE_TARGET = "safari17_0"
_DEFAULT_TIMEOUT = 15.0
_FETCH_BODY_LIMIT = 8000   # 单次 fetch 返回的纯文本上限（避免 LLM context 爆炸）

_DDG_RESULT_RE = re.compile(
    r'<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
    re.DOTALL,
)
_DDG_SNIPPET_RE = re.compile(
    r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
    re.DOTALL,
)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_DDG_REDIRECT_PREFIX = "//duckduckgo.com/l/?uddg="


def _json_output(data: Any) -> str:
    """与 tools._json_output 同形态，独立一份避免下游引用模块私有 API。"""
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _strip_html(html: str) -> str:
    """剥 HTML 标签 + 解码实体，返回紧凑文本。"""
    text = _HTML_TAG_RE.sub("", html)
    return unescape(text).strip()


def _unwrap_ddg_redirect(href: str) -> str:
    """DDG 的结果 href 经常是 //duckduckgo.com/l/?uddg=<encoded>&...，还原。"""
    if href.startswith(_DDG_REDIRECT_PREFIX):
        from urllib.parse import parse_qs, unquote, urlparse as _p

        try:
            query = _p("https:" + href).query
            params = parse_qs(query)
            target = params.get("uddg", [""])[0]
            if target:
                return unquote(target)
        except Exception:  # noqa: BLE001
            pass
    if href.startswith("//"):
        return "https:" + href
    return href


def _parse_ddg_html(html: str, limit: int) -> list[dict[str, str]]:
    """从 DDG HTML 里抽出最多 N 条 {url, title, snippet}。"""
    titles = _DDG_RESULT_RE.findall(html)
    snippets = _DDG_SNIPPET_RE.findall(html)
    out: list[dict[str, str]] = []
    for idx, (href, title_html) in enumerate(titles[:limit]):
        url = _unwrap_ddg_redirect(href)
        title = _strip_html(title_html)
        snippet = _strip_html(snippets[idx]) if idx < len(snippets) else ""
        if url and title:
            out.append({"url": url, "title": title, "snippet": snippet})
    return out


async def _http_post_ddg(query: str, timeout: float) -> tuple[int, str]:
    """说明：POST 到 DDG HTML 端点。返回 (status_code, body)。"""
    if _CurlAsyncSession is None:
        raise RuntimeError("curl_cffi not installed; web_search requires it")
    async with _CurlAsyncSession(impersonate=_IMPERSONATE_TARGET, timeout=timeout) as s:
        r = await s.post(DDG_HTML_URL, data={"q": query})
        return int(r.status_code), str(r.text or "")


async def _http_get(url: str, timeout: float) -> tuple[int, str, str]:
    """说明：拉单个 URL 的内容。返回 (status_code, content_type, body)。"""
    if _CurlAsyncSession is None:
        raise RuntimeError("curl_cffi not installed; web_fetch requires it")
    async with _CurlAsyncSession(impersonate=_IMPERSONATE_TARGET, timeout=timeout) as s:
        r = await s.get(url)
        ct = r.headers.get("content-type", "") or r.headers.get("Content-Type", "")
        return int(r.status_code), str(ct), str(r.text or "")


def build_web_tools(
    *,
    timeout_seconds: float = _DEFAULT_TIMEOUT,
    body_limit: int = _FETCH_BODY_LIMIT,
) -> ToolRegistry:
    """构建 web 工具集（web_search / web_fetch）。

    timeout_seconds 控制每次 HTTP 请求的上限；body_limit 控制 fetch 返回的
    纯文本截断长度（防止 LLM context 爆炸）。两个都暴露成参数方便测试注入。
    """
    registry = ToolRegistry()

    async def web_search(query: str, limit: int = 5) -> str:
        """说明：DuckDuckGo 搜索，返回最多 N 条 {url, title, snippet}。"""
        q = (query or "").strip()
        if not q:
            return _json_output({"error": "query is empty"})
        capped = max(1, min(int(limit or 5), 20))
        try:
            status, body = await _http_post_ddg(q, timeout_seconds)
        except _CurlRequestException as exc:
            return _json_output({"error": f"http error: {exc}"})
        except Exception as exc:  # noqa: BLE001
            return _json_output({"error": f"search failed: {exc}"})

        if status >= 400:
            return _json_output({"error": f"HTTP {status}", "engine": "duckduckgo"})

        results = _parse_ddg_html(body, capped)
        if not results:
            # DDG 返反爬页或空结果时常返回 200 + 极少 HTML，留个明显信号给 LLM
            return _json_output({
                "engine": "duckduckgo",
                "query": q,
                "count": 0,
                "results": [],
                "note": "no results (possibly rate-limited or blocked)",
            })
        return _json_output({
            "engine": "duckduckgo",
            "query": q,
            "count": len(results),
            "results": results,
        })

    registry.register(ToolDefinition(
        name="web_search",
        description=(
            "Search the open web via DuckDuckGo. Returns up to N hits with "
            "{url, title, snippet}. Use this to discover sources or check facts; "
            "follow up with web_fetch to read a specific URL in full."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query in any language"},
                "limit": {
                    "type": "integer",
                    "description": "Max results (1–20, default 5)",
                    "default": 5,
                },
            },
            "required": ["query"],
        },
        handler=web_search,
    ))

    async def web_fetch(url: str, max_chars: int | None = None) -> str:
        """说明：抓取单个 URL，返回剥标签后的纯文本（截断到 max_chars 或默认上限）。"""
        target = (url or "").strip()
        if not target:
            return _json_output({"error": "url is empty"})
        parsed = urlparse(target)
        if parsed.scheme not in {"http", "https"}:
            return _json_output({"error": f"unsupported scheme: {parsed.scheme!r}"})
        if not parsed.netloc:
            return _json_output({"error": "missing host"})

        try:
            status, content_type, body = await _http_get(target, timeout_seconds)
        except _CurlRequestException as exc:
            return _json_output({"error": f"http error: {exc}", "url": target})
        except Exception as exc:  # noqa: BLE001
            return _json_output({"error": f"fetch failed: {exc}", "url": target})

        if status >= 400:
            return _json_output({"error": f"HTTP {status}", "url": target})

        # 剥 <script>/<style> + 标签，给 LLM 干净文本
        cleaned = re.sub(r"<script[^>]*>.*?</script>", "", body, flags=re.DOTALL | re.IGNORECASE)
        cleaned = re.sub(r"<style[^>]*>.*?</style>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
        text = _strip_html(cleaned)
        # 折叠多空白
        text = re.sub(r"\s+", " ", text).strip()

        cap = body_limit if max_chars is None else max(200, min(int(max_chars), body_limit))
        truncated = text[:cap]
        return _json_output({
            "url": target,
            "status": status,
            "contentType": content_type,
            "length": len(text),
            "truncated": len(text) > cap,
            "text": truncated,
        })

    registry.register(ToolDefinition(
        name="web_fetch",
        description=(
            "Fetch a single URL and return its readable text (HTML stripped). "
            "Use after web_search when you want the full body of a hit. "
            "Truncated at ~8KB by default to keep LLM context lean."
        ),
        parameters={
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Absolute http(s) URL"},
                "max_chars": {
                    "type": ["integer", "null"],
                    "description": "Optional override for the truncation cap (200..8000)",
                },
            },
            "required": ["url"],
        },
        handler=web_fetch,
    ))

    return registry
