/**
 * Jin10 data types.
 *
 * Represents flash news, calendar events, and quotes fetched via MCP tools.
 */

// ── Flash (快讯) ──────────────────────────────────────────────────────────────

export interface Jin10FlashItem {
  id: string;
  content: string;
  time: string;          // ISO timestamp from Jin10
  important: boolean;    // derived from star/type
  type?: string;
  raw: Record<string, unknown>;
}

// ── Calendar (财经日历) ───────────────────────────────────────────────────────

export interface Jin10CalendarEvent {
  pubTime: string;       // publication/event time
  star: number;          // importance 1-5
  title: string;
  country?: string;
  previous: string;      // 前值
  consensus: string;     // 预期
  actual: string;        // 实际值
  revised: string;       // 修正值
  affectTxt: string;     // 影响说明
  raw: Record<string, unknown>;
}

// ── Quotes (行情) ─────────────────────────────────────────────────────────────

export interface Jin10Quote {
  code: string;
  name: string;
  time: string;
  open: number;
  close: number;         // current/latest price
  high: number;
  low: number;
  volume: number;
  change: number;        // ups_price
  changePercent: number; // ups_percent
}

// ── Config ────────────────────────────────────────────────────────────────────

/** Default endpoint for Jin10's hosted MCP server. */
export const DEFAULT_JIN10_URL = "https://mcp.jin10.com/mcp";

export interface Jin10Config {
  enabled: boolean;
  /** Jin10 MCP endpoint. Defaults to {@link DEFAULT_JIN10_URL}. */
  url: string;
  token: string;
  flashEnabled: boolean;
  flashPollIntervalSeconds: number;
  calendarEnabled: boolean;
  calendarPollIntervalSeconds: number;
  quotesEnabled: boolean;
  quotesPollIntervalSeconds: number;
  quotesCodes: string[];
  /** Whether Jin10 instruments are included in agent analysis context. Default: false */
  agentAnalysis: boolean;
}

// ── Service Status ────────────────────────────────────────────────────────────

export interface Jin10Status {
  available: boolean;    // jin10 found in .mcp.json
  connected: boolean;    // successfully connected to MCP
  enabled: boolean;      // user toggle
  tokenConfigured: boolean;
  flash: {
    enabled: boolean;
    lastFetchedAtMs: number | null;
    lastError: string | null;
    itemCount: number;
  };
  calendar: {
    enabled: boolean;
    lastFetchedAtMs: number | null;
    lastError: string | null;
    eventCount: number;
  };
  quotes: {
    enabled: boolean;
    lastFetchedAtMs: number | null;
    lastError: string | null;
    codes: string[];
  };
}
