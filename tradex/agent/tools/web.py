"""文件用途：给 agent loop 加 web_search / web_fetch 两个工具。

# 后端策略
# - web_search: 默认 auto，先走 Exa MCP（零配置 / 不需 API key），失败后退回
#   DuckDuckGo HTML 端点。可用 WEB_SEARCH_BACKEND=duckduckgo/exa_mcp
#   强制指定后端。
# - web_fetch: 用 curl_cffi 伪装 Safari 指纹拉取任意 URL，跟 Reuters
#   sitemap provider 同样的反爬策略，一致体验。
#
# # 已知限制
# - Exa MCP 是远程服务，网络或服务不可用时 auto 会退回 DDG。
# - DDG HTML 抓取被反爬时报错，工具返回 error JSON 让 LLM 自行决定要不要重试或换 query
# - web_fetch 不做 HTML→Markdown 渲染，只剥 <script>/<style> 后返回纯文本片段
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import re
import socket
from html import unescape
from typing import Any
from urllib.parse import urljoin, urlparse

try:
    from curl_cffi.requests import AsyncSession as _CurlAsyncSession
    from curl_cffi.requests.exceptions import RequestException as _CurlRequestException
except ImportError:  # pragma: no cover
    _CurlAsyncSession = None
    _CurlRequestException = Exception

from .registry import ToolDefinition, ToolRegistry

LOGGER = logging.getLogger(__name__)

DDG_HTML_URL = "https://html.duckduckgo.com/html/"
EXA_MCP_URL = "https://mcp.exa.ai/mcp"
WEB_SEARCH_BACKEND_ENV = "WEB_SEARCH_BACKEND"
_IMPERSONATE_TARGET = "safari17_0"
_DEFAULT_TIMEOUT = 15.0
_FETCH_BODY_LIMIT = 8000   # 单次 fetch 返回的纯文本上限（避免 LLM context 爆炸）
_FETCH_READ_LIMIT_BYTES = _FETCH_BODY_LIMIT * 4
_MAX_FETCH_REDIRECTS = 5
_REDIRECT_STATUSES = {301, 302, 303, 307, 308}

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
_LOCAL_HOSTNAMES = {"localhost"}


def _json_output(data: Any) -> str:
    """与 tools._json_output 同形态，独立一份避免下游引用模块私有 API。"""
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _bounded_int(value: Any, *, default: int, low: int, high: int, field: str) -> int:
    """把工具参数收敛到整数区间；模型传错类型时返回清晰错误。"""
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer") from exc
    return max(low, min(parsed, high))


def _is_readable_content_type(content_type_lower: str) -> bool:
    """说明：判断 contentType 是否值得 web_fetch 处理。

    text/* 和 application/json / xhtml / xml 都是 LLM 能消费的；
    application/pdf, image/*, video/*, audio/*, application/octet-stream 等
    走二进制流，剥标签会产生乱码，LLM 拿到无用信息且消耗 token。
    contentType 缺省 (空串) 时假设是 HTML（很多老站点不发 Content-Type）。
    """
    if not content_type_lower:
        return True
    if content_type_lower.startswith("text/"):
        return True
    return any(
        marker in content_type_lower
        for marker in ("json", "xml", "xhtml", "javascript", "ecmascript")
    )


def _strip_html(html: str) -> str:
    """剥 HTML 标签 + 解码实体，返回紧凑文本。"""
    text = _HTML_TAG_RE.sub("", html)
    return unescape(text).strip()


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """web_fetch 只能读公网内容，避免模型访问本机/内网/metadata 地址。"""
    return ip.is_multicast or not ip.is_global


def _literal_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """尝试把主机名解析为 IP 地址对象。"""
    normalized = host.strip("[]")
    try:
        return ipaddress.ip_address(normalized)
    except ValueError:
        return None


def _resolve_host_ips(host: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """DNS 解析主机名返回 IP 列表。"""
    infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    out: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for family, *_rest, sockaddr in infos:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        raw_ip = str(sockaddr[0])
        try:
            out.append(ipaddress.ip_address(raw_ip))
        except ValueError:
            continue
    return out


def _decode_limited_body(response: Any, body: bytes) -> str:
    """按响应编码解码截断后的 body bytes。"""
    encoding = getattr(response, "encoding", None) or "utf-8"
    try:
        return body.decode(str(encoding), errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


async def _read_limited_body(response: Any, byte_limit: int) -> tuple[str, bool]:
    """流式读取响应 body 并截断到字节上限。"""
    chunks: list[bytes] = []
    total = 0
    truncated = False
    async for chunk in response.aiter_content():
        if not chunk:
            continue
        chunk_bytes = bytes(chunk)
        remaining = byte_limit - total
        if len(chunk_bytes) > remaining:
            if remaining > 0:
                chunks.append(chunk_bytes[:remaining])
            truncated = True
            break
        chunks.append(chunk_bytes)
        total += len(chunk_bytes)
    return _decode_limited_body(response, b"".join(chunks)), truncated


async def _fetch_target_validation_error(url: str) -> str | None:
    """校验 URL 是否允许 fetch（禁止内网/本机）。"""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return f"unsupported scheme: {parsed.scheme!r}"
    if not parsed.netloc:
        return "missing host"

    host = parsed.hostname
    if not host:
        return "missing host"

    normalized_host = host.rstrip(".").lower()
    if normalized_host in _LOCAL_HOSTNAMES or normalized_host.endswith(".localhost"):
        return f"blocked private/internal host: {host}"

    literal = _literal_ip(host)
    if literal is not None:
        if _is_blocked_ip(literal):
            return f"blocked private/internal address: {host}"
        return None

    try:
        resolved = await asyncio.to_thread(_resolve_host_ips, host)
    except socket.gaierror as exc:
        return f"host is not resolvable: {host} ({exc})"
    except OSError as exc:
        return f"host resolution failed: {host} ({exc})"

    if not resolved:
        return f"host is not resolvable: {host}"
    if any(_is_blocked_ip(ip) for ip in resolved):
        return f"blocked private/internal address: {host}"
    return None


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


def _normalize_search_backend(value: str | None) -> str:
    """说明：解析 web_search backend；默认 auto 先 Exa MCP，失败退回 DDG。"""
    raw = (value or "auto").strip().lower().replace("-", "_")
    if not raw or raw == "auto":
        return "auto"
    if raw in {"ddg", "duck", "duckduckgo"}:
        return "duckduckgo"
    if raw in {"exa", "exa_mcp", "examcp"}:
        return "exa_mcp"
    raise ValueError(f"{WEB_SEARCH_BACKEND_ENV} must be one of: auto, duckduckgo, exa_mcp")


def _resolve_search_backend() -> str:
    return _normalize_search_backend(os.getenv(WEB_SEARCH_BACKEND_ENV))


def _iter_exa_mcp_payloads(body: str):
    """说明：Exa MCP 可能返回 JSON，也可能以 SSE data: 行返回 JSON-RPC。"""
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("data:"):
            continue
        payload = stripped[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            continue
        yield parsed

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return
    yield parsed


def _extract_exa_mcp_text(body: str) -> str:
    rpc: dict[str, Any] | None = None
    for candidate in _iter_exa_mcp_payloads(body):
        if isinstance(candidate, dict) and ("result" in candidate or "error" in candidate):
            rpc = candidate
            break
    if rpc is None:
        raise RuntimeError("Exa MCP returned an empty response")

    error = rpc.get("error")
    if isinstance(error, dict):
        code = error.get("code")
        code_label = f" {code}" if isinstance(code, int) else ""
        message = error.get("message") if isinstance(error.get("message"), str) else "Unknown error"
        raise RuntimeError(f"Exa MCP error{code_label}: {message}")

    result = rpc.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("Exa MCP returned no result")
    if result.get("isError") is True:
        content = result.get("content")
        message = ""
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                    message = item["text"].strip()
                    break
        raise RuntimeError(message or "Exa MCP returned an error")

    content = result.get("content")
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                text = item["text"].strip()
                if text:
                    return text
    raise RuntimeError("Exa MCP returned empty content")


def _parse_exa_mcp_results(text: str, limit: int) -> list[dict[str, str]]:
    """说明：解析 Exa MCP web_search_exa 的 Title/URL/Text 块。"""
    blocks = re.split(r"(?=^Title: )", text, flags=re.MULTILINE)
    out: list[dict[str, str]] = []
    for block in blocks:
        if len(out) >= limit:
            break
        title_match = re.search(r"^Title:\s*(.+)", block, flags=re.MULTILINE)
        url_match = re.search(r"^URL:\s*(.+)", block, flags=re.MULTILINE)
        if not title_match or not url_match:
            continue
        title = _strip_html(title_match.group(1)).strip()
        result_url = url_match.group(1).strip()
        content = ""
        text_start = block.find("\nText: ")
        if text_start >= 0:
            content = block[text_start + len("\nText: "):].strip()
        else:
            highlights_match = re.search(r"\nHighlights:\s*\n", block)
            if highlights_match and highlights_match.end() < len(block):
                content = block[highlights_match.end():].strip()
        content = re.sub(r"\n---\s*$", "", content).strip()
        snippet = re.sub(r"\s+", " ", _strip_html(content)).strip()
        if len(snippet) > 500:
            snippet = snippet[:497] + "..."
        if title and result_url:
            out.append({"url": result_url, "title": title, "snippet": snippet})
    return out


async def _http_post_ddg(query: str, timeout: float) -> tuple[int, str]:
    """说明：POST 到 DDG HTML 端点。返回 (status_code, body)。"""
    if _CurlAsyncSession is None:
        raise RuntimeError("curl_cffi not installed; web_search requires it")
    async with _CurlAsyncSession(impersonate=_IMPERSONATE_TARGET, timeout=timeout) as s:
        r = await s.post(DDG_HTML_URL, data={"q": query})
        return int(r.status_code), str(r.text or "")


async def _http_post_exa_mcp(query: str, limit: int, timeout: float) -> tuple[int, str]:
    """说明：调用 Exa 远程 MCP 的 web_search_exa tool。"""
    if _CurlAsyncSession is None:
        raise RuntimeError("curl_cffi not installed; web_search requires it")
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "web_search_exa",
            "arguments": {
                "query": query,
                "numResults": limit,
                "livecrawl": "fallback",
                "type": "auto",
                "contextMaxCharacters": 3000,
            },
        },
    }
    async with _CurlAsyncSession(timeout=timeout) as s:
        r = await s.post(
            EXA_MCP_URL,
            json=payload,
            headers={
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
        )
        return int(r.status_code), str(r.text or "")


async def _http_get(url: str, timeout: float) -> tuple[int, str, str, bool]:
    """说明：拉单个 URL 的内容。返回 (status_code, content_type, body, truncated)。"""
    if _CurlAsyncSession is None:
        raise RuntimeError("curl_cffi not installed; web_fetch requires it")
    current_url = url
    async with _CurlAsyncSession(impersonate=_IMPERSONATE_TARGET, timeout=timeout) as s:
        for _ in range(_MAX_FETCH_REDIRECTS + 1):
            async with s.stream("GET", current_url, allow_redirects=False) as r:
                status = int(r.status_code)
                if status in _REDIRECT_STATUSES:
                    location = r.headers.get("location", "") or r.headers.get("Location", "")
                    if not location:
                        break
                    next_url = urljoin(current_url, str(location))
                    validation_error = await _fetch_target_validation_error(next_url)
                    if validation_error:
                        raise ValueError(f"blocked redirect target: {validation_error}")
                    current_url = next_url
                    continue
                ct = r.headers.get("content-type", "") or r.headers.get("Content-Type", "")
                body, truncated = await _read_limited_body(r, _FETCH_READ_LIMIT_BYTES)
                return status, str(ct), body, truncated
    raise RuntimeError("too many redirects")


async def _search_duckduckgo(query: str, limit: int, timeout_seconds: float) -> dict[str, Any]:
    """执行 DuckDuckGo 搜索并返回结构化结果。"""
    try:
        status, body = await _http_post_ddg(query, timeout_seconds)
    except _CurlRequestException as exc:
        return {"error": f"http error: {exc}", "engine": "duckduckgo"}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"search failed: {exc}", "engine": "duckduckgo"}

    if status >= 400:
        return {"error": f"HTTP {status}", "engine": "duckduckgo"}

    results = _parse_ddg_html(body, limit)
    if not results:
        # DDG 返反爬页或空结果时常返回 200 + 极少 HTML，留个明显信号给 LLM
        return {
            "engine": "duckduckgo",
            "query": query,
            "count": 0,
            "results": [],
            "note": "no results (possibly rate-limited or blocked)",
        }
    return {
        "engine": "duckduckgo",
        "query": query,
        "count": len(results),
        "results": results,
    }


async def _search_exa_mcp(query: str, limit: int, timeout_seconds: float) -> dict[str, Any]:
    """执行 Exa MCP 搜索并返回结构化结果。"""
    try:
        status, body = await _http_post_exa_mcp(query, limit, timeout_seconds)
    except _CurlRequestException as exc:
        return {"error": f"http error: {exc}", "engine": "exa_mcp"}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"search failed: {exc}", "engine": "exa_mcp"}

    if status >= 400:
        return {"error": f"HTTP {status}", "engine": "exa_mcp"}

    try:
        text = _extract_exa_mcp_text(body)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"search failed: {exc}", "engine": "exa_mcp"}

    results = _parse_exa_mcp_results(text, limit)
    if not results:
        return {
            "engine": "exa_mcp",
            "query": query,
            "count": 0,
            "results": [],
            "note": "no parseable results from Exa MCP",
        }
    return {
        "engine": "exa_mcp",
        "query": query,
        "count": len(results),
        "results": results,
    }


def _search_failure_reason(result: dict[str, Any]) -> str:
    """从搜索结果提取失败原因字符串。"""
    error = result.get("error")
    if isinstance(error, str) and error:
        return error
    note = result.get("note")
    if isinstance(note, str) and note:
        return note
    return "no results"


def _search_has_results(result: dict[str, Any]) -> bool:
    """判断搜索结果是否包含有效条目。"""
    return "error" not in result and int(result.get("count") or 0) > 0


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
        """说明：搜索网页；默认 Exa MCP，失败退回 DuckDuckGo。"""
        q = (query or "").strip()
        if not q:
            return _json_output({"error": "query is empty"})
        try:
            capped = _bounded_int(limit, default=5, low=1, high=20, field="limit")
        except ValueError as exc:
            return _json_output({"error": str(exc)})

        try:
            backend = _resolve_search_backend()
        except ValueError as exc:
            return _json_output({"error": str(exc)})

        if backend == "duckduckgo":
            return _json_output(await _search_duckduckgo(q, capped, timeout_seconds))
        if backend == "exa_mcp":
            return _json_output(await _search_exa_mcp(q, capped, timeout_seconds))

        exa_result = await _search_exa_mcp(q, capped, timeout_seconds)
        if _search_has_results(exa_result):
            return _json_output(exa_result)

        ddg_result = await _search_duckduckgo(q, capped, timeout_seconds)
        if "error" not in ddg_result:
            ddg_result["fallbackFrom"] = "exa_mcp"
            ddg_result["fallbackReason"] = _search_failure_reason(exa_result)
            return _json_output(ddg_result)

        return _json_output({
            "engine": "auto",
            "query": q,
            "count": 0,
            "results": [],
            "errors": {
                "exa_mcp": _search_failure_reason(exa_result),
                "duckduckgo": _search_failure_reason(ddg_result),
            },
        })

    registry.register(ToolDefinition(
        name="web_search",
        description=(
            "Search the open web. Defaults to Exa MCP with DuckDuckGo fallback; "
            "set WEB_SEARCH_BACKEND to auto, exa_mcp, or duckduckgo. "
            "Returns up to N hits with {url, title, snippet}. Use this to discover "
            "sources or check facts; follow up with web_fetch to read a specific URL in full."
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
        validation_error = await _fetch_target_validation_error(target)
        if validation_error:
            return _json_output({"error": validation_error, "url": target})

        try:
            status, content_type, body, body_truncated = await _http_get(
                target,
                timeout_seconds,
            )
        except _CurlRequestException as exc:
            return _json_output({"error": f"http error: {exc}", "url": target})
        except Exception as exc:  # noqa: BLE001
            return _json_output({"error": f"fetch failed: {exc}", "url": target})

        if status >= 400:
            return _json_output({"error": f"HTTP {status}", "url": target})

        # 二进制/不可读类型直接短路：HTML 剥标签对 PDF/图片/视频毫无用处，
        # 返回的 "%PDF-1.6 %����" 这种乱码只会污染 LLM context。让模型知情后另寻它路。
        normalized_ct = (content_type or "").lower()
        if not _is_readable_content_type(normalized_ct):
            return _json_output({
                "error": (
                    f"non-text content ({content_type or 'unknown'}); "
                    f"web_fetch can only return HTML/text/json. Try a different URL."
                ),
                "url": target,
                "status": status,
                "contentType": content_type,
                "length": len(body),
            })

        # 剥 <script>/<style> + 标签，给 LLM 干净文本
        cleaned = re.sub(r"<script[^>]*>.*?</script>", "", body, flags=re.DOTALL | re.IGNORECASE)
        cleaned = re.sub(r"<style[^>]*>.*?</style>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
        text = _strip_html(cleaned)
        # 折叠多空白
        text = re.sub(r"\s+", " ", text).strip()

        try:
            cap = (
                body_limit
                if max_chars is None
                else _bounded_int(
                    max_chars,
                    default=body_limit,
                    low=200,
                    high=body_limit,
                    field="max_chars",
                )
            )
        except ValueError as exc:
            return _json_output({"error": str(exc), "url": target})
        truncated = text[:cap]
        return _json_output({
            "url": target,
            "status": status,
            "contentType": content_type,
            "length": len(text),
            "truncated": body_truncated or len(text) > cap,
            "text": truncated,
        })

    registry.register(ToolDefinition(
        name="web_fetch",
        description=(
            "Fetch a single URL and return its readable text (HTML stripped). "
            "Use after web_search when you want the full body of a hit. "
            "Truncated at ~8KB by default to keep LLM context lean. "
            "Limitations: only handles text/HTML/JSON/XML responses (PDFs and "
            "binary content return an error). Some major news sites (e.g. "
            "Reuters main pages) sit behind Cloudflare and may return HTTP 401/403; "
            "in that case rely on the web_search snippet or pick another source."
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
