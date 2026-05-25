/**
 * Jin10 Service.
 *
 * Manages flash/calendar/quotes polling via MCP bridge.
 * Uses the existing McpClientManager to call jin10 tools.
 */
import type { McpClientManager } from "../mcp/index.js";
import type { NewsStore } from "../news/store.js";
import type { Jin10CalendarEvent, Jin10Config, Jin10Quote, Jin10Status } from "./types.js";
import { parseFlashResponse, flashToNewsItems } from "./flash.js";
import { parseCalendarResponse } from "./calendar.js";
import { parseQuoteResponse } from "./quotes.js";

const JIN10_SERVER = "jin10";

export class Jin10Service {
  readonly config: Jin10Config;
  private mcpManager: McpClientManager | null;
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
    mcpManager: McpClientManager | null;
    newsStore: NewsStore | null;
  }) {
    this.config = input.config;
    this.mcpManager = input.mcpManager;
    this.newsStore = input.newsStore;
  }

  /**
   * Check if jin10 server is configured in MCP.
   */
  get available(): boolean {
    return !!this.mcpManager && this.mcpManager.getServerNames().includes(JIN10_SERVER);
  }

  /**
   * Check if connected to the jin10 MCP server.
   */
  get connected(): boolean {
    if (!this.mcpManager) return false;
    return this.mcpManager.getStatus(JIN10_SERVER) === "connected";
  }

  /**
   * Start all enabled pollers.
   */
  async start(): Promise<void> {
    if (!this.config.enabled || !this.available) return;

    // Try to connect first
    try {
      await this.mcpManager!.connect(JIN10_SERVER);
    } catch (error) {
      console.warn("[jin10] Failed to connect:", error instanceof Error ? error.message : error);
      return;
    }

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
    if (!this.mcpManager) throw new Error("MCP manager not available");
    return this.mcpManager.callTool(JIN10_SERVER, name, args);
  }
}
