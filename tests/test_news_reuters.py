"""Test Reuters sitemap provider."""
import asyncio
import unittest
from pathlib import Path

import httpx

from tradex.news.providers.reuters import (
    REUTERS_SOURCE,
    ReutersSitemapProvider,
    parse_sitemap,
)

FIXTURE = Path(__file__).parent / "fixtures" / "reuters_sitemap.xml"


class ParseSitemapTests(unittest.TestCase):
    def test_parses_urls_titles_and_keywords(self) -> None:
        items = parse_sitemap(FIXTURE.read_text())
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0].url, "https://www.reuters.com/world/europe/example-headline-1-2026-05-05/")
        self.assertEqual(items[0].title, "Example headline one about markets")
        self.assertEqual(items[0].keywords, ("Markets", "Europe", "Rates"))
        self.assertEqual(items[0].source, REUTERS_SOURCE)
        self.assertGreater(items[0].published_at_ms, 0)
        self.assertGreater(items[1].published_at_ms, items[0].published_at_ms)

    def test_handles_empty_urlset(self) -> None:
        xml = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>'
        self.assertEqual(parse_sitemap(xml), [])


class ReutersFetchTests(unittest.TestCase):
    def setUp(self) -> None:
        self._loop = asyncio.new_event_loop()
        self.addCleanup(self._loop.close)

    def _make_provider(self, handler) -> ReutersSitemapProvider:
        transport = httpx.MockTransport(handler)
        client = httpx.AsyncClient(transport=transport)
        provider = ReutersSitemapProvider(url="https://example.test/sitemap.xml", client=client)
        return provider

    def _run(self, coro):
        return self._loop.run_until_complete(coro)

    def test_ok_returns_items_and_etag(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/sitemap.xml")
            return httpx.Response(
                200,
                text=FIXTURE.read_text(),
                headers={"ETag": '"abc"', "Last-Modified": "Tue, 05 May 2026 15:00:00 GMT"},
            )

        provider = self._make_provider(handler)
        try:
            result = self._run(provider.fetch())
        finally:
            self._run(provider._external_client.aclose())
        self.assertEqual(result.status, "ok")
        self.assertEqual(len(result.items), 2)
        self.assertEqual(result.etag, '"abc"')
        self.assertEqual(result.last_modified, "Tue, 05 May 2026 15:00:00 GMT")

    def test_sends_conditional_headers(self) -> None:
        captured: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["If-None-Match"] = request.headers.get("If-None-Match", "")
            captured["If-Modified-Since"] = request.headers.get("If-Modified-Since", "")
            return httpx.Response(304)

        provider = self._make_provider(handler)
        try:
            result = self._run(provider.fetch(etag='"abc"', last_modified="GMT-date"))
        finally:
            self._run(provider._external_client.aclose())
        self.assertEqual(captured["If-None-Match"], '"abc"')
        self.assertEqual(captured["If-Modified-Since"], "GMT-date")
        self.assertEqual(result.status, "not_modified")

    def test_rate_limited_status_on_429(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, text="too many")

        provider = self._make_provider(handler)
        try:
            result = self._run(provider.fetch())
        finally:
            self._run(provider._external_client.aclose())
        self.assertEqual(result.status, "rate_limited")
        self.assertEqual(result.http_status, 429)

    def test_error_on_bad_xml(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<not-xml")

        provider = self._make_provider(handler)
        try:
            result = self._run(provider.fetch())
        finally:
            self._run(provider._external_client.aclose())
        self.assertEqual(result.status, "error")


if __name__ == "__main__":
    unittest.main()
