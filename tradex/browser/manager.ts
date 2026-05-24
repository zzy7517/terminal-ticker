import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  OpenBrowserUseClient,
  type JsonValue,
} from "open-browser-use-sdk";
import type { BrowserConfig } from "../config/index.js";

/** Socket registry written by the OBU native host */
const DEFAULT_REGISTRY_PATH = "/tmp/open-browser-use/active.json";

/** How long to cache a successful status probe before re-pinging */
const STATUS_CACHE_TTL_MS = 1500;

/** Ping timeout — short enough to avoid hanging the status endpoint */
const PING_TIMEOUT_MS = 2_000;

export interface BrowserStatus {
  enabled: boolean;
  connected: boolean;
  socketPath: string | null;
  error: string | null;
}

interface CachedStatus {
  status: BrowserStatus;
  expiresAt: number;
}

/**
 * Manages connectivity probes against the Open Browser Use local socket.
 *
 * Tools (browser_open_page / browser_screenshot) open their own short-lived
 * SDK clients per call. This manager only owns:
 *   - config (enabled flag, socket override, default timeout for tools)
 *   - socket discovery (config override or OBU registry)
 *   - liveness probes (ping + status)
 */
export class BrowserManager {
  private config: BrowserConfig;
  private cachedStatus: CachedStatus | null = null;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Default per-call timeout for SDK clients spawned by tools */
  get timeoutMs(): number {
    return this.config.timeoutMs;
  }

  /** Update config at runtime (e.g. from settings UI) */
  updateConfig(config: BrowserConfig): void {
    this.config = config;
    // Invalidate cache so the next status() call reflects the new config
    this.cachedStatus = null;
  }

  /** Resolve the socket path — either from config or from OBU's active registry */
  private async resolveSocketPath(): Promise<string | null> {
    if (this.config.socketPath) {
      return this.config.socketPath;
    }
    if (!existsSync(DEFAULT_REGISTRY_PATH)) {
      return null;
    }
    try {
      const raw = await readFile(DEFAULT_REGISTRY_PATH, "utf8");
      const registry = JSON.parse(raw);
      return registry.socketPath ?? registry.socket_path ?? null;
    } catch {
      return null;
    }
  }

  /** Ping the OBU host to verify connectivity. Always opens a short-lived client. */
  async ping(): Promise<{ ok: boolean; info?: JsonValue; error?: string }> {
    if (!this.config.enabled) {
      return { ok: false, error: "Browser automation is disabled" };
    }

    const socketPath = await this.resolveSocketPath();
    if (!socketPath) {
      return {
        ok: false,
        error:
          "No OBU socket found. Run: npm i -g open-browser-use && open-browser-use setup",
      };
    }

    let client: OpenBrowserUseClient | null = null;
    try {
      client = new OpenBrowserUseClient({
        socketPath,
        sessionId: "tradex-ping",
        timeoutMs: PING_TIMEOUT_MS,
      });
      await client.connect();
      const info = await client.getInfo();
      client.close();
      return { ok: true, info };
    } catch (e) {
      client?.close();
      return { ok: false, error: e instanceof Error ? e.message : "Ping failed" };
    }
  }

  /**
   * Get current status. `connected` reflects whether OBU is actually reachable
   * right now (cached for STATUS_CACHE_TTL_MS to avoid hammering the native
   * host when the UI polls and tools probe concurrently).
   */
  async status(): Promise<BrowserStatus> {
    const now = Date.now();
    if (this.cachedStatus && this.cachedStatus.expiresAt > now) {
      return this.cachedStatus.status;
    }

    const socketPath = await this.resolveSocketPath();

    if (!this.config.enabled) {
      const status: BrowserStatus = {
        enabled: false,
        connected: false,
        socketPath,
        error: null,
      };
      this.cachedStatus = { status, expiresAt: now + STATUS_CACHE_TTL_MS };
      return status;
    }

    if (!socketPath) {
      const status: BrowserStatus = {
        enabled: true,
        connected: false,
        socketPath: null,
        error:
          "No OBU socket found. Is Chrome with the Open Browser Use extension running?",
      };
      this.cachedStatus = { status, expiresAt: now + STATUS_CACHE_TTL_MS };
      return status;
    }

    const ping = await this.ping();
    const status: BrowserStatus = {
      enabled: true,
      connected: ping.ok,
      socketPath,
      error: ping.ok ? null : ping.error ?? null,
    };
    this.cachedStatus = { status, expiresAt: now + STATUS_CACHE_TTL_MS };
    return status;
  }

  // ─── Chart Capture (TODO) ─────────────────────────────────────────────────
  // TODO: Implement captureChart(symbol, interval) → Buffer
  // This will:
  // 1. Open/navigate TradingView chart URL via short-lived SDK client
  // 2. Wait for canvas render (Page.bringToFront + poll canvas size)
  // 3. Page.captureScreenshot with clip region
  // 4. Return PNG buffer
  // 5. Finalize tabs

  // ─── Page Scraping (TODO) ──────────────────────────────────────────────────
  // TODO: Implement scrapePage(url) → { title, text, screenshot? }
  // Generic page content extraction using real Chrome session
}
