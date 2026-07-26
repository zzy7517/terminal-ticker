/**
 * Jin10 Service.
 *
 * Manages flash/calendar/quotes polling. Jin10 is configured as a data source
 * (`[jin10]` in the watchlist TOML) and owns its own MCP connection via
 * {@link Jin10Client}, independent of `.mcp.json` and the `[mcp]` toggle.
 */
import type { NewsStore } from "../news/store.js";
import type { McpResourceReadResult } from "../mcp/types.js";
import type { Jin10CalendarEvent, Jin10Config, Jin10Quote, Jin10Status } from "./types.js";
import { Jin10Client } from "./client.js";
import { parseFlashResponse, flashToNewsItems } from "./flash.js";
import { parseCalendarResponse } from "./calendar.js";
import { parseQuoteResponse } from "./quotes.js";

export class Jin10Service {
  readonly config: Jin10Config;
  private client: Jin10Client | null;
  private newsStore: NewsStore | null;

  // State
  private calendar: Jin10CalendarEvent[] = [];
  private quotes = new Map<string, Jin10Quote>();

  // Polling timers
  private flashTimer: NodeJS.Timeout | null = null;
  private calendarTimer: NodeJS.Timeout | null = null;
  private quotesTimer: NodeJS.Timeout | null = null;

  // Status tracking
  private flashLastFetchedAtMs: number | null = null;
  private flashLastError: string | null = null;
  private calendarLastFetchedAtMs: number | null = null;
  private calendarLastError: string | null = null;
  private quotesLastFetchedAtMs: number | null = null;
  private quotesLastError: string | null = null;

  constructor(input: {
    config: Jin10Config;
    newsStore: NewsStore | null;
  }) {
    this.config = input.config;
    this.newsStore = input.newsStore;
    this.client = input.config.enabled && input.config.token
      ? new Jin10Client({ url: input.config.url, token: input.config.token })
      : null;
  }

  /**
   * Whether Jin10 is usable — enabled with a token. Depends only on the
   * `[jin10]` config block, not on `.mcp.json` or the global `[mcp]` toggle.
   */
  get available(): boolean {
    return this.client !== null;
  }

  /**
   * Whether a live connection to the Jin10 MCP server is currently held.
   */
  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /**
   * Start all enabled pollers.
   */
  async start(): Promise<void> {
    if (!this.available) return;

    if (this.config.flashEnabled) {
      void this.fetchFlash();
      this.flashTimer = setInterval(
        () => void this.fetchFlash(),
        this.config.flashPollIntervalSeconds * 1000,
      );
    }

    if (this.config.calendarEnabled) {
      void this.fetchCalendar();
      this.calendarTimer = setInterval(
        () => void this.fetchCalendar(),
        this.config.calendarPollIntervalSeconds * 1000,
      );
    }

    if (this.config.quotesEnabled && this.config.quotesCodes.length > 0) {
      void this.fetchAllQuotes();
      this.quotesTimer = setInterval(
        () => void this.fetchAllQuotes(),
        this.config.quotesPollIntervalSeconds * 1000,
      );
    }
  }

  /**
   * Stop all pollers.
   */
  async stop(): Promise<void> {
    if (this.flashTimer) { clearInterval(this.flashTimer); this.flashTimer = null; }
    if (this.calendarTimer) { clearInterval(this.calendarTimer); this.calendarTimer = null; }
    if (this.quotesTimer) { clearInterval(this.quotesTimer); this.quotesTimer = null; }
    await this.client?.close();
  }

  /**
   * Read a Jin10 MCP resource (e.g. `quote://codes`).
   */
  async readResource(uri: string): Promise<McpResourceReadResult> {
    if (!this.client) throw new Error("Jin10 is not configured");
    return this.client.readResource(uri);
  }

  /**
   * Manual refresh: flash.
   */
  async refreshFlash(): Promise<{ inserted: number; error: string | null }> {
    return this.fetchFlash();
  }

  /**
   * Manual refresh: calendar.
   */
  async refreshCalendar(): Promise<{ count: number; error: string | null }> {
    return this.fetchCalendar();
  }

  /**
   * Manual refresh: quotes.
   */
  async refreshQuotes(): Promise<{ count: number; error: string | null }> {
    return this.fetchAllQuotes();
  }

  /**
   * Get current calendar events.
   */
  getCalendar(): Jin10CalendarEvent[] {
    return this.calendar;
  }

  /**
   * Get current quotes.
   */
  getQuotes(): Jin10Quote[] {
    return [...this.quotes.values()];
  }

  /**
   * Get single quote by code.
   */
  getQuote(code: string): Jin10Quote | null {
    return this.quotes.get(code.toUpperCase()) ?? null;
  }

  /**
   * Full status snapshot.
   */
  getStatus(): Jin10Status {
    return {
      available: this.available,
      connected: this.connected,
      enabled: this.config.enabled,
      tokenConfigured: !!this.config.token,
      flash: {
        enabled: this.config.flashEnabled,
        lastFetchedAtMs: this.flashLastFetchedAtMs,
        lastError: this.flashLastError,
        itemCount: this.newsStore ? 0 : 0, // count from store if needed
      },
      calendar: {
        enabled: this.config.calendarEnabled,
        lastFetchedAtMs: this.calendarLastFetchedAtMs,
        lastError: this.calendarLastError,
        eventCount: this.calendar.length,
      },
      quotes: {
        enabled: this.config.quotesEnabled,
        lastFetchedAtMs: this.quotesLastFetchedAtMs,
        lastError: this.quotesLastError,
        codes: this.config.quotesCodes,
      },
    };
  }

  // ── Private polling methods ─────────────────────────────────────────────────

  private async fetchFlash(): Promise<{ inserted: number; error: string | null }> {
    try {
      const raw = await this.callTool("list_flash", {});
      const parsed = JSON.parse(raw);
      const flashes = parseFlashResponse(parsed);
      const newsItems = flashToNewsItems(flashes);
      const inserted = this.newsStore ? this.newsStore.upsertItems(newsItems).length : 0;
      this.flashLastFetchedAtMs = Date.now();
      this.flashLastError = null;
      return { inserted, error: null };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.flashLastError = msg;
      console.warn("[jin10] flash fetch error:", msg);
      return { inserted: 0, error: msg };
    }
  }

  private async fetchCalendar(): Promise<{ count: number; error: string | null }> {
    try {
      const raw = await this.callTool("list_calendar", {});
      const parsed = JSON.parse(raw);
      this.calendar = parseCalendarResponse(parsed);
      this.calendarLastFetchedAtMs = Date.now();
      this.calendarLastError = null;
      return { count: this.calendar.length, error: null };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.calendarLastError = msg;
      console.warn("[jin10] calendar fetch error:", msg);
      return { count: 0, error: msg };
    }
  }

  private async fetchAllQuotes(): Promise<{ count: number; error: string | null }> {
    let count = 0;
    const errors: string[] = [];

    await Promise.allSettled(
      this.config.quotesCodes.map(async (code) => {
        try {
          const raw = await this.callTool("get_quote", { code });
          const parsed = JSON.parse(raw);
          const quote = parseQuoteResponse(parsed);
          if (quote) {
            this.quotes.set(quote.code.toUpperCase(), quote);
            count++;
          }
        } catch (error) {
          errors.push(`${code}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );

    this.quotesLastFetchedAtMs = Date.now();
    this.quotesLastError = errors.length > 0 ? errors.join("; ") : null;
    return { count, error: this.quotesLastError };
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("Jin10 is not configured");
    return this.client.callTool(name, args);
  }
}
