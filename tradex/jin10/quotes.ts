/**
 * Jin10 Quotes provider.
 *
 * Calls `get_quote` via MCP bridge for each subscribed code.
 */
import type { Jin10Quote } from "./types.js";

/**
 * Parse raw MCP response from `get_quote` into Jin10Quote.
 */
export function parseQuoteResponse(raw: unknown): Jin10Quote | null {
  if (!raw || typeof raw !== "object") return null;

  const data = extractData(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const obj = data as Record<string, unknown>;
  const code = String(obj.code ?? "");
  const name = String(obj.name ?? code);
  if (!code) return null;

  return {
    code,
    name,
    time: String(obj.time ?? ""),
    open: Number(obj.open ?? 0),
    close: Number(obj.close ?? obj.price ?? 0),
    high: Number(obj.high ?? 0),
    low: Number(obj.low ?? 0),
    volume: Number(obj.volume ?? 0),
    change: Number(obj.ups_price ?? obj.change ?? 0),
    changePercent: Number(obj.ups_percent ?? obj.change_percent ?? 0),
  };
}

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default quote codes to subscribe — broad coverage of key assets */
export const DEFAULT_QUOTE_CODES = [
  "XAUUSD",  // 现货黄金
  "XAGUSD",  // 现货白银
  "USOIL",   // WTI 原油
  "EURUSD",  // 欧元/美元
  "USDJPY",  // 美元/日元
  "USDCNH",  // 美元/离岸人民币
];

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractData(raw: unknown): unknown {
  const obj = raw as Record<string, unknown>;
  if (obj.data !== undefined) return obj.data;
  if (obj.result && typeof obj.result === "object") {
    const result = obj.result as Record<string, unknown>;
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return (result.structuredContent as Record<string, unknown>).data ?? result.structuredContent;
    }
    return result.data ?? result;
  }
  return obj;
}
