import { ToolRegistry, jsonOutput } from "./registry.js";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const FETCH_BODY_LIMIT = 8000;

// ---- Exa MCP types ----

interface ExaMcpRpcResponse {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

interface McpParsedResult {
  title: string;
  url: string;
  content: string;
}

// ---- Exa MCP helpers (adapted from pi-web-access) ----

async function callExaMcp(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
    : AbortSignal.timeout(60000);

  const response = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    signal: requestSignal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Exa MCP error ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const body = await response.text();

  // Exa MCP returns SSE-style data lines or raw JSON
  const dataLines = body.split("\n").filter((line) => line.startsWith("data:"));
  let parsed: ExaMcpRpcResponse | null = null;

  for (const line of dataLines) {
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
      if (candidate?.result || candidate?.error) {
        parsed = candidate;
        break;
      }
    } catch {}
  }

  if (!parsed) {
    try {
      const candidate = JSON.parse(body) as ExaMcpRpcResponse;
      if (candidate?.result || candidate?.error) {
        parsed = candidate;
      }
    } catch {}
  }

  if (!parsed) {
    throw new Error("Exa MCP returned an empty response");
  }

  if (parsed.error) {
    const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
    const message = parsed.error.message || "Unknown error";
    throw new Error(`Exa MCP error${code}: ${message}`);
  }

  if (parsed.result?.isError) {
    const message = parsed.result.content
      ?.find((item) => item.type === "text" && typeof item.text === "string")
      ?.text?.trim();
    throw new Error(message || "Exa MCP returned an error");
  }

  const text = parsed.result?.content
    ?.find((item) => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0)
    ?.text;

  if (!text) {
    throw new Error("Exa MCP returned empty content");
  }

  return text;
}

function parseMcpResults(text: string): McpParsedResult[] | null {
  const blocks = text.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
  const parsed = blocks
    .map((block) => {
      const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
      const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
      let content = "";
      const textStart = block.indexOf("\nText: ");
      if (textStart >= 0) {
        content = block.slice(textStart + 7).trim();
      } else {
        const hlMatch = block.match(/\nHighlights:\s*\n/);
        if (hlMatch?.index != null) {
          content = block.slice(hlMatch.index + hlMatch[0].length).trim();
        }
      }
      content = content.replace(/\n---\s*$/, "").trim();
      return { title, url, content };
    })
    .filter((result) => result.url.length > 0);
  return parsed.length > 0 ? parsed : null;
}

function buildAnswerFromMcpResults(results: McpParsedResult[]): string {
  if (results.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const snippet = result.content.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!snippet) continue;
    const sourceTitle = result.title || `Source ${i + 1}`;
    parts.push(`${snippet}\nSource: ${sourceTitle} (${result.url})`);
  }
  return parts.join("\n\n");
}

// ---- HTML stripping for web_fetch ----

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gis, "")
    .replace(/<style[^>]*>.*?<\/style>/gis, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- Tool builder ----

export function buildWebTools(input: { timeoutSeconds?: number; bodyLimit?: number } = {}): ToolRegistry {
  const timeoutMs = (input.timeoutSeconds ?? 15) * 1000;
  const bodyLimit = input.bodyLimit ?? FETCH_BODY_LIMIT;
  const registry = new ToolRegistry();

  registry.register({
    name: "web_search",
    description:
      "Search the web using Exa. Returns an AI-synthesized answer with source citations. Supports recency and domain filters.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "integer", description: "Max number of results (default 5, max 20)" },
        recency_filter: { type: "string", description: "Filter by recency: day, week, month, year" },
        domain_filter: {
          type: "array",
          items: { type: "string" },
          description: "Limit to domains (prefix with - to exclude)",
        },
      },
      required: ["query"],
    },
    execute: async ({ query, limit, recency_filter, domain_filter }) => {
      const q = String(query || "").trim();
      if (!q) return jsonOutput({ error: "query is empty" });
      const capped = Math.max(1, Math.min(Number(limit) || 5, 20));

      // Build enriched query with domain/recency hints for MCP
      let enrichedQuery = q;
      const domainFilters = Array.isArray(domain_filter) ? domain_filter : [];
      for (const d of domainFilters) {
        const ds = String(d).trim();
        if (ds.startsWith("-")) {
          enrichedQuery += ` -site:${ds.slice(1)}`;
        } else if (ds) {
          enrichedQuery += ` site:${ds}`;
        }
      }
      if (recency_filter) {
        const labels: Record<string, string> = { day: "past 24 hours", week: "past week", month: "past month", year: String(new Date().getFullYear()) };
        const label = labels[String(recency_filter)] || "";
        if (label) enrichedQuery += ` ${label}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const text = await callExaMcp(
          "web_search_exa",
          {
            query: enrichedQuery,
            numResults: capped,
            livecrawl: "fallback",
            type: "auto",
            contextMaxCharacters: 3000,
          },
          controller.signal,
        );

        const parsedResults = parseMcpResults(text);
        if (!parsedResults || parsedResults.length === 0) {
          return jsonOutput({ engine: "exa", query: q, answer: text, results: [] });
        }

        const answer = buildAnswerFromMcpResults(parsedResults);
        const results = parsedResults.map((r, i) => ({
          title: r.title || `Source ${i + 1}`,
          url: r.url,
          snippet: r.content.slice(0, 200),
        }));

        return jsonOutput({ engine: "exa", query: q, answer, results });
      } catch (err) {
        const reason = err instanceof Error
          ? (err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : err.message)
          : String(err);
        console.error(`[web_search] failed for query="${q}": ${reason}`);
        return jsonOutput({ error: `search failed: ${reason}`, query: q, engine: "exa", results: [] });
      } finally {
        clearTimeout(timer);
      }
    },
  });

  registry.register({
    name: "web_fetch",
    description: "Fetch a single URL and return readable text.",
    parameters: { type: "object", properties: { url: { type: "string" }, max_chars: { type: ["integer", "null"] } }, required: ["url"] },
    execute: async ({ url, max_chars }) => {
      const target = String(url || "").trim();
      if (!/^https?:\/\//i.test(target)) return jsonOutput({ error: "unsupported or missing URL", url: target });
      const cap = Math.max(200, Math.min(Number(max_chars) || bodyLimit, bodyLimit));
      try {
        const response = await fetch(target, { redirect: "follow" });
        const text = stripHtml(await response.text());
        return jsonOutput({ url: target, status: response.status, contentType: response.headers.get("content-type") || "", length: text.length, truncated: text.length > cap, text: text.slice(0, cap) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[web_fetch] failed for url="${target}": ${msg}`);
        return jsonOutput({ error: `fetch failed: ${msg}`, url: target });
      }
    },
  });

  return registry;
}
