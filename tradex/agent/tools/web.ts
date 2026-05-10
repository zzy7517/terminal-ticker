import { ToolRegistry, jsonOutput } from "./registry.js";

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const FETCH_BODY_LIMIT = 8000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gis, "")
    .replace(/<style[^>]*>.*?<\/style>/gis, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDdgHtml(html: string, limit: number): Array<Record<string, string>> {
  const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
  const out: Array<Record<string, string>> = [];
  for (const match of html.matchAll(linkRe)) {
    if (out.length >= limit) break;
    out.push({ url: unwrapDdgRedirect(match[1]), title: stripHtml(match[2]), snippet: "" });
  }
  return out;
}

function unwrapDdgRedirect(href: string): string {
  if (href.startsWith("//duckduckgo.com/l/?")) {
    const url = new URL(`https:${href}`);
    return decodeURIComponent(url.searchParams.get("uddg") || href);
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

export function buildWebTools(input: { timeoutSeconds?: number; bodyLimit?: number } = {}): ToolRegistry {
  const timeoutMs = (input.timeoutSeconds ?? 15) * 1000;
  const bodyLimit = input.bodyLimit ?? FETCH_BODY_LIMIT;
  const registry = new ToolRegistry();

  registry.register({
    name: "web_search",
    description: "Search the open web using DuckDuckGo HTML endpoint.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
    handler: async ({ query, limit }) => {
      const q = String(query || "").trim();
      if (!q) return jsonOutput({ error: "query is empty" });
      const capped = Math.max(1, Math.min(Number(limit) || 5, 20));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(DDG_HTML_URL, { method: "POST", body: new URLSearchParams({ q }), signal: controller.signal });
        const html = await response.text();
        return jsonOutput({ engine: "duckduckgo", query: q, results: parseDdgHtml(html, capped) });
      } finally {
        clearTimeout(timer);
      }
    },
  });

  registry.register({
    name: "web_fetch",
    description: "Fetch a single URL and return readable text.",
    parameters: { type: "object", properties: { url: { type: "string" }, max_chars: { type: ["integer", "null"] } }, required: ["url"] },
    handler: async ({ url, max_chars }) => {
      const target = String(url || "").trim();
      if (!/^https?:\/\//i.test(target)) return jsonOutput({ error: "unsupported or missing URL", url: target });
      const cap = Math.max(200, Math.min(Number(max_chars) || bodyLimit, bodyLimit));
      const response = await fetch(target, { redirect: "follow" });
      const text = stripHtml(await response.text());
      return jsonOutput({ url: target, status: response.status, contentType: response.headers.get("content-type") || "", length: text.length, truncated: text.length > cap, text: text.slice(0, cap) });
    },
  });

  return registry;
}
