"""web_tools 单元测试：DDG 解析 / search / fetch / registry 集成。"""
import asyncio
import ipaddress
import json
import unittest
from unittest.mock import patch

from tradex.agent import build_web_tools
from tradex.agent.tools.web import (
    _extract_exa_mcp_text,
    _http_get,
    _parse_exa_mcp_results,
    _parse_ddg_html,
    _strip_html,
    _normalize_search_backend,
    _unwrap_ddg_redirect,
)


class HelperTests(unittest.TestCase):
    def test_strip_html_basic(self) -> None:
        self.assertEqual(_strip_html("<b>Hello&nbsp;World</b>"), "Hello\xa0World")

    def test_unwrap_ddg_redirect(self) -> None:
        href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x"
        self.assertEqual(_unwrap_ddg_redirect(href), "https://example.com/a")

    def test_unwrap_passthrough_for_normal_href(self) -> None:
        self.assertEqual(_unwrap_ddg_redirect("https://example.com/x"), "https://example.com/x")

    def test_unwrap_protocol_relative(self) -> None:
        self.assertEqual(_unwrap_ddg_redirect("//example.com/x"), "https://example.com/x")

    def test_parse_ddg_html_extracts_results(self) -> None:
        html = """
        <html><body>
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2F1">Title One</a>
          <a class="result__snippet" href="x">Snippet one</a>
          <a class="result__a" href="https://b.com/2">Title Two &amp; Co</a>
          <a class="result__snippet" href="x">Snippet <b>two</b></a>
        </body></html>
        """
        out = _parse_ddg_html(html, limit=5)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["url"], "https://a.com/1")
        self.assertEqual(out[0]["title"], "Title One")
        self.assertEqual(out[0]["snippet"], "Snippet one")
        self.assertEqual(out[1]["url"], "https://b.com/2")
        self.assertEqual(out[1]["title"], "Title Two & Co")
        self.assertEqual(out[1]["snippet"], "Snippet two")

    def test_parse_ddg_respects_limit(self) -> None:
        html = "".join(
            f'<a class="result__a" href="https://x/{i}">T{i}</a>'
            f'<a class="result__snippet" href="x">S{i}</a>'
            for i in range(10)
        )
        self.assertEqual(len(_parse_ddg_html(html, limit=3)), 3)

    def test_normalize_search_backend_aliases(self) -> None:
        self.assertEqual(_normalize_search_backend(""), "auto")
        self.assertEqual(_normalize_search_backend("ddg"), "duckduckgo")
        self.assertEqual(_normalize_search_backend("exa"), "exa_mcp")

    def test_extract_exa_mcp_text_from_sse(self) -> None:
        body = (
            'event: message\n'
            'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}]}}\n\n'
        )
        self.assertEqual(_extract_exa_mcp_text(body), "hello")

    def test_parse_exa_mcp_results(self) -> None:
        text = (
            "Title: Source One\n"
            "URL: https://example.com/one\n"
            "Text: First result body.\n"
            "---\n"
            "Title: Source Two\n"
            "URL: https://example.com/two\n"
            "Highlights:\n"
            "Second result body.\n"
        )
        out = _parse_exa_mcp_results(text, limit=5)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["url"], "https://example.com/one")
        self.assertEqual(out[0]["title"], "Source One")
        self.assertEqual(out[0]["snippet"], "First result body.")


class WebSearchTests(unittest.TestCase):
    def _run(self, coro):
        return asyncio.run(coro)

    def _duckduckgo_backend(self):
        return patch.dict("os.environ", {"WEB_SEARCH_BACKEND": "duckduckgo"}, clear=False)

    def _auto_backend(self):
        return patch.dict("os.environ", {"WEB_SEARCH_BACKEND": "auto"}, clear=False)

    def test_search_happy_path(self) -> None:
        sample_html = (
            '<a class="result__a" href="https://reuters.com/x">Fed rate news</a>'
            '<a class="result__snippet" href="x">Fed cuts rates by 50bp</a>'
        )

        async def fake_post(query, timeout):
            self.assertEqual(query, "fed rate cut")
            return 200, sample_html

        registry = build_web_tools()
        with self._duckduckgo_backend(), patch("tradex.agent.tools.web._http_post_ddg", fake_post):
            tool = registry.get("web_search")
            assert tool is not None
            out = self._run(tool.handler(query="fed rate cut", limit=5))
        data = json.loads(out)
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["results"][0]["url"], "https://reuters.com/x")
        self.assertEqual(data["results"][0]["title"], "Fed rate news")
        self.assertEqual(data["engine"], "duckduckgo")

    def test_search_auto_uses_exa_mcp_first(self) -> None:
        body = (
            'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":'
            '"Title: Fed rate news\\nURL: https://reuters.com/x\\nText: Fed cuts rates by 50bp.\\n---"}]}}\n\n'
        )

        async def fake_exa(query, limit, timeout):
            self.assertEqual(query, "fed rate cut")
            self.assertEqual(limit, 5)
            return 200, body

        async def fail_ddg(query, timeout):
            raise AssertionError("DDG should not be called when Exa MCP returns results")

        registry = build_web_tools()
        with (
            self._auto_backend(),
            patch("tradex.agent.tools.web._http_post_exa_mcp", fake_exa),
            patch("tradex.agent.tools.web._http_post_ddg", fail_ddg),
        ):
            out = self._run(registry.get("web_search").handler(query="fed rate cut", limit=5))
        data = json.loads(out)
        self.assertEqual(data["engine"], "exa_mcp")
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["results"][0]["snippet"], "Fed cuts rates by 50bp.")

    def test_search_auto_falls_back_to_ddg_when_exa_fails(self) -> None:
        async def fake_exa(query, limit, timeout):
            raise RuntimeError("exa unavailable")

        async def fake_ddg(query, timeout):
            return 200, '<a class="result__a" href="https://reuters.com/x">Fed</a>'

        registry = build_web_tools()
        with (
            self._auto_backend(),
            patch("tradex.agent.tools.web._http_post_exa_mcp", fake_exa),
            patch("tradex.agent.tools.web._http_post_ddg", fake_ddg),
        ):
            out = self._run(registry.get("web_search").handler(query="fed", limit=5))
        data = json.loads(out)
        self.assertEqual(data["engine"], "duckduckgo")
        self.assertEqual(data["fallbackFrom"], "exa_mcp")
        self.assertIn("exa unavailable", data["fallbackReason"])

    def test_search_explicit_exa_mcp_does_not_fallback(self) -> None:
        async def fake_exa(query, limit, timeout):
            raise RuntimeError("exa unavailable")

        async def fail_ddg(query, timeout):
            raise AssertionError("DDG should not be called when backend is exa_mcp")

        registry = build_web_tools()
        with (
            patch.dict("os.environ", {"WEB_SEARCH_BACKEND": "exa_mcp"}, clear=False),
            patch("tradex.agent.tools.web._http_post_exa_mcp", fake_exa),
            patch("tradex.agent.tools.web._http_post_ddg", fail_ddg),
        ):
            out = self._run(registry.get("web_search").handler(query="fed", limit=5))
        data = json.loads(out)
        self.assertEqual(data["engine"], "exa_mcp")
        self.assertIn("exa unavailable", data["error"])

    def test_search_empty_query_returns_error(self) -> None:
        registry = build_web_tools()
        tool = registry.get("web_search")
        out = self._run(tool.handler(query="   ", limit=5))
        self.assertIn("query is empty", out)

    def test_search_http_error_returns_error_json(self) -> None:
        async def fake_post(query, timeout):
            return 502, ""

        registry = build_web_tools()
        with self._duckduckgo_backend(), patch("tradex.agent.tools.web._http_post_ddg", fake_post):
            out = self._run(registry.get("web_search").handler(query="x"))
        data = json.loads(out)
        self.assertEqual(data["error"], "HTTP 502")

    def test_search_zero_results_includes_note(self) -> None:
        async def fake_post(query, timeout):
            return 200, "<html><body>no matches</body></html>"

        registry = build_web_tools()
        with self._duckduckgo_backend(), patch("tradex.agent.tools.web._http_post_ddg", fake_post):
            out = self._run(registry.get("web_search").handler(query="x"))
        data = json.loads(out)
        self.assertEqual(data["count"], 0)
        self.assertIn("rate-limited", data["note"])

    def test_search_exception_softfails(self) -> None:
        async def fake_post(query, timeout):
            raise RuntimeError("connection refused")

        registry = build_web_tools()
        with self._duckduckgo_backend(), patch("tradex.agent.tools.web._http_post_ddg", fake_post):
            out = self._run(registry.get("web_search").handler(query="x"))
        data = json.loads(out)
        self.assertIn("connection refused", data["error"])

    def test_search_clamps_limit(self) -> None:
        async def fake_post(query, timeout):
            return 200, ""

        registry = build_web_tools()
        with self._duckduckgo_backend(), patch("tradex.agent.tools.web._http_post_ddg", fake_post):
            # limit=999 should be clamped silently and return 0 results
            out = self._run(registry.get("web_search").handler(query="x", limit=999))
        # 不抛异常，正常返回 0 结果
        self.assertEqual(json.loads(out)["count"], 0)

    def test_search_bad_limit_softfails_as_json(self) -> None:
        registry = build_web_tools()
        out = self._run(registry.get("web_search").handler(query="x", limit="many"))
        data = json.loads(out)
        self.assertEqual(data["error"], "limit must be an integer")


class WebFetchTests(unittest.TestCase):
    def _run(self, coro):
        return asyncio.run(coro)

    def _allow_fetch_validation(self):
        async def allow_fetch(url):
            return None

        return patch("tradex.agent.tools.web._fetch_target_validation_error", allow_fetch)

    def test_fetch_happy_path_strips_scripts_and_tags(self) -> None:
        async def fake_get(url, timeout):
            body = (
                "<html><head><script>var x=1;</script>"
                "<style>body{color:red}</style></head>"
                "<body><p>Hello <b>World</b></p></body></html>"
            )
            return 200, "text/html; charset=utf-8", body, False

        registry = build_web_tools()
        with self._allow_fetch_validation(), patch("tradex.agent.tools.web._http_get", fake_get):
            out = self._run(registry.get("web_fetch").handler(url="https://example.com/p"))
        data = json.loads(out)
        self.assertEqual(data["status"], 200)
        self.assertIn("text/html", data["contentType"])
        self.assertEqual(data["text"], "Hello World")
        self.assertFalse(data["truncated"])

    def test_fetch_rejects_empty_url(self) -> None:
        registry = build_web_tools()
        out = self._run(registry.get("web_fetch").handler(url=""))
        self.assertIn("url is empty", out)

    def test_fetch_rejects_non_http_scheme(self) -> None:
        registry = build_web_tools()
        out = self._run(registry.get("web_fetch").handler(url="file:///etc/passwd"))
        data = json.loads(out)
        self.assertIn("unsupported scheme", data["error"])

    def test_fetch_rejects_missing_host(self) -> None:
        registry = build_web_tools()
        out = self._run(registry.get("web_fetch").handler(url="https:///nohost"))
        data = json.loads(out)
        self.assertIn("missing host", data["error"])

    def test_fetch_rejects_localhost(self) -> None:
        async def fail_get(url, timeout):
            raise AssertionError("web_fetch should reject localhost before HTTP")

        registry = build_web_tools()
        with patch("tradex.agent.tools.web._http_get", fail_get):
            out = self._run(registry.get("web_fetch").handler(url="http://localhost:8000/x"))
        data = json.loads(out)
        self.assertIn("blocked private/internal host", data["error"])

    def test_fetch_rejects_link_local_metadata_ip(self) -> None:
        async def fail_get(url, timeout):
            raise AssertionError("web_fetch should reject metadata IP before HTTP")

        registry = build_web_tools()
        with patch("tradex.agent.tools.web._http_get", fail_get):
            out = self._run(
                registry.get("web_fetch").handler(url="http://169.254.169.254/latest/meta-data/")
            )
        data = json.loads(out)
        self.assertIn("blocked private/internal address", data["error"])

    def test_fetch_rejects_hostname_resolving_to_private_ip(self) -> None:
        async def fail_get(url, timeout):
            raise AssertionError("web_fetch should reject private DNS before HTTP")

        def fake_resolve(host):
            self.assertEqual(host, "example.com")
            return [ipaddress.ip_address("127.0.0.1")]

        registry = build_web_tools()
        with (
            patch("tradex.agent.tools.web._resolve_host_ips", fake_resolve),
            patch("tradex.agent.tools.web._http_get", fail_get),
        ):
            out = self._run(registry.get("web_fetch").handler(url="https://example.com/x"))
        data = json.loads(out)
        self.assertIn("blocked private/internal address", data["error"])

    def test_fetch_truncates_at_max_chars(self) -> None:
        big_text = "<p>" + ("X" * 5000) + "</p>"

        async def fake_get(url, timeout):
            return 200, "text/html", big_text, False

        registry = build_web_tools(body_limit=8000)
        with self._allow_fetch_validation(), patch("tradex.agent.tools.web._http_get", fake_get):
            out = self._run(
                registry.get("web_fetch").handler(url="https://example.com/x", max_chars=500)
            )
        data = json.loads(out)
        self.assertEqual(len(data["text"]), 500)
        self.assertTrue(data["truncated"])
        self.assertEqual(data["length"], 5000)

    def test_fetch_http_error_returns_error_json(self) -> None:
        async def fake_get(url, timeout):
            return 404, "text/html", "not found", False

        registry = build_web_tools()
        with self._allow_fetch_validation(), patch("tradex.agent.tools.web._http_get", fake_get):
            out = self._run(registry.get("web_fetch").handler(url="https://example.com/x"))
        data = json.loads(out)
        self.assertEqual(data["error"], "HTTP 404")

    def test_fetch_pdf_short_circuits_with_error(self) -> None:
        """PDF 拒绝处理，返回 error JSON 让 LLM 另寻它路。"""
        async def fake_get(url, timeout):
            return 200, "application/pdf", "%PDF-1.6 \x00\x01\x02 binary garbage", False

        registry = build_web_tools()
        with self._allow_fetch_validation(), patch("tradex.agent.tools.web._http_get", fake_get):
            out = self._run(
                registry.get("web_fetch").handler(url="https://example.com/x.pdf")
            )
        data = json.loads(out)
        self.assertIn("non-text content", data["error"])
        self.assertEqual(data["contentType"], "application/pdf")
        # text 字段不应存在（避免 LLM 看到二进制乱码）
        self.assertNotIn("text", data)

    def test_fetch_image_rejected(self) -> None:
        async def fake_get(url, timeout):
            return 200, "image/png", "\x89PNG\r\n", False

        registry = build_web_tools()
        with self._allow_fetch_validation(), patch("tradex.agent.tools.web._http_get", fake_get):
            out = self._run(
                registry.get("web_fetch").handler(url="https://example.com/x.png")
            )
        self.assertIn("non-text content", json.loads(out)["error"])

    def test_fetch_json_is_readable(self) -> None:
        async def fake_get(url, timeout):
            return 200, "application/json", '{"k": "v"}', False

        registry = build_web_tools()
        with self._allow_fetch_validation(), patch("tradex.agent.tools.web._http_get", fake_get):
            out = self._run(
                registry.get("web_fetch").handler(url="https://api.example.com/x")
            )
        data = json.loads(out)
        self.assertNotIn("error", data)
        self.assertIn('"k"', data["text"])

    def test_fetch_missing_content_type_assumed_html(self) -> None:
        """很多老站点不发 Content-Type；仍尝试解析（不要无谓 short-circuit）。"""
        async def fake_get(url, timeout):
            return 200, "", "<p>plain html</p>", False

        registry = build_web_tools()
        with self._allow_fetch_validation(), patch("tradex.agent.tools.web._http_get", fake_get):
            out = self._run(
                registry.get("web_fetch").handler(url="https://example.com/x")
            )
        data = json.loads(out)
        self.assertNotIn("error", data)
        self.assertEqual(data["text"], "plain html")

    def test_fetch_exception_softfails(self) -> None:
        async def fake_get(url, timeout):
            raise RuntimeError("dns boom")

        registry = build_web_tools()
        with self._allow_fetch_validation(), patch("tradex.agent.tools.web._http_get", fake_get):
            out = self._run(registry.get("web_fetch").handler(url="https://example.com/x"))
        data = json.loads(out)
        self.assertIn("dns boom", data["error"])

    def test_fetch_bad_max_chars_softfails_as_json(self) -> None:
        async def fake_get(url, timeout):
            return 200, "text/html", "<p>Hello</p>", False

        registry = build_web_tools()
        with self._allow_fetch_validation(), patch("tradex.agent.tools.web._http_get", fake_get):
            out = self._run(
                registry.get("web_fetch").handler(url="https://example.com/x", max_chars="wide")
            )
        data = json.loads(out)
        self.assertEqual(data["error"], "max_chars must be an integer")

    def test_http_get_rejects_redirect_to_private_ip(self) -> None:
        case = self

        class FakeResponse:
            status_code = 302
            headers = {"location": "http://127.0.0.1/private"}
            text = ""

        class FakeStream:
            async def __aenter__(self):
                return FakeResponse()

            async def __aexit__(self, exc_type, exc, tb):
                return None

        class FakeSession:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return None

            def stream(self, method, url, allow_redirects):
                case.assertEqual(method, "GET")
                case.assertEqual(allow_redirects, False)
                return FakeStream()

        with patch("tradex.agent.tools.web._CurlAsyncSession", FakeSession):
            with self.assertRaisesRegex(ValueError, "blocked redirect target"):
                self._run(_http_get("https://example.com/start", timeout=1))

    def test_http_get_stops_reading_after_byte_limit(self) -> None:
        class FakeResponse:
            status_code = 200
            headers = {"content-type": "text/html"}
            encoding = "utf-8"

            async def aiter_content(self):
                yield b"hello"
                yield b"world"

        class FakeStream:
            async def __aenter__(self):
                return FakeResponse()

            async def __aexit__(self, exc_type, exc, tb):
                return None

        class FakeSession:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return None

            def stream(self, method, url, allow_redirects):
                return FakeStream()

        with (
            patch("tradex.agent.tools.web._CurlAsyncSession", FakeSession),
            patch("tradex.agent.tools.web._FETCH_READ_LIMIT_BYTES", 5),
        ):
            status, content_type, body, truncated = self._run(
                _http_get("https://example.com/start", timeout=1)
            )
        self.assertEqual(status, 200)
        self.assertEqual(content_type, "text/html")
        self.assertEqual(body, "hello")
        self.assertTrue(truncated)


class RegistryIntegrationTests(unittest.TestCase):
    """build_web_tools 的 ToolDefinition 元数据是否能被现有 ToolRegistry 消费。"""

    def test_registry_lists_both_tools_with_schema(self) -> None:
        registry = build_web_tools()
        names = sorted(t.name for t in registry.list_tools())
        self.assertEqual(names, ["web_fetch", "web_search"])
        for tool in registry.list_tools():
            self.assertIn("type", tool.parameters)
            self.assertEqual(tool.parameters["type"], "object")
            self.assertIn("required", tool.parameters)
            self.assertTrue(callable(tool.handler))

    def test_package_all_exports_build_web_tools(self) -> None:
        import tradex.agent as agent

        self.assertIn("build_web_tools", agent.__all__)

    def test_merge_with_other_registries(self) -> None:
        from tradex.agent import merge_registries, build_news_tools

        merged = merge_registries(build_web_tools(), build_news_tools(news_service=None))
        names = sorted(t.name for t in merged.list_tools())
        self.assertIn("web_search", names)
        self.assertIn("web_fetch", names)
        self.assertIn("get_recent_news", names)


if __name__ == "__main__":
    unittest.main()
