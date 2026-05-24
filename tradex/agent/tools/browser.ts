import { ToolRegistry, jsonOutput } from "./registry.js";
import type { BrowserManager } from "../../browser/manager.js";
import type { BrowserUseRequestParams } from "open-browser-use-sdk";

export function buildBrowserTools(browserManager: BrowserManager): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: "browser_open_page",
    description:
      "Open a URL in the real local Chrome browser via Open Browser Use. " +
      "Returns the page title and visible text content. Use this to browse websites, " +
      "read pages that require JavaScript rendering, or check live web content. " +
      "The browser must be running with the OBU extension enabled.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to open" },
        wait_seconds: {
          type: "integer",
          description: "Seconds to wait for page load (default 5, max 15)",
        },
      },
      required: ["url"],
    },
    handler: async ({ url, wait_seconds }) => {
      const targetUrl = String(url || "").trim();
      if (!targetUrl) return jsonOutput({ error: "url is required" });

      const { connectOpenBrowserUse } = await import("open-browser-use-sdk");
      const socketPath = await resolveSocket(browserManager);
      if (!socketPath) {
        return jsonOutput({
          error: "Browser automation not available. Enable it in Settings → Browser and ensure Chrome + OBU extension is running.",
        });
      }

      const waitMs = Math.min(Math.max(Number(wait_seconds) || 5, 1), 15) * 1000;

      let browser: Awaited<ReturnType<typeof connectOpenBrowserUse>> | null = null;
      try {
        browser = await connectOpenBrowserUse({
          socketPath,
          sessionId: `tradex-agent-${Date.now()}`,
          timeoutMs: browserManager.timeoutMs,
        });

        await browser.client.nameSession("Tradex Agent - OBU");
        const tab = await browser.newTab({ url: targetUrl, waitUntil: "load" });

        // Bring to front so canvas/JS renders properly
        await browser.cdp.call(tab.id, "Page.bringToFront");
        await sleep(waitMs);

        // Get page info
        const title = await browser.cdp.evaluate(tab.id, "document.title") as string;
        const text = await browser.cdp.evaluate(
          tab.id,
          "(function(){ return document.body?.innerText?.slice(0, 6000) ?? ''; })()",
        ) as string;
        const currentUrl = await browser.cdp.evaluate(tab.id, "window.location.href") as string;

        await browser.client.finalizeTabs([]);
        browser.close();

        return jsonOutput({
          url: currentUrl || targetUrl,
          title: title || "",
          text: (text || "").slice(0, 6000),
          length: (text || "").length,
        });
      } catch (e) {
        browser?.close();
        return jsonOutput({ error: e instanceof Error ? e.message : String(e), url: targetUrl });
      }
    },
  });

  registry.register({
    name: "browser_screenshot",
    description:
      "Take a screenshot of the current page or a specific URL in the real local Chrome browser. " +
      "Returns a base64-encoded PNG image. Useful for capturing charts, dashboards, or any visual content. " +
      "For TradingView charts, use the tradingview_url parameter format: " +
      "https://cn.tradingview.com/chart/?symbol=TVC:US30Y&interval=D",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to and screenshot" },
        wait_seconds: {
          type: "integer",
          description: "Seconds to wait for rendering after page load (default 6, max 20). TradingView charts need 6-8s.",
        },
        clip: {
          type: "object",
          description: "Optional clip region {x, y, width, height} to capture only part of the page",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
        },
      },
      required: ["url"],
    },
    handler: async ({ url, wait_seconds, clip }) => {
      const targetUrl = String(url || "").trim();
      if (!targetUrl) return jsonOutput({ error: "url is required" });

      const { connectOpenBrowserUse } = await import("open-browser-use-sdk");
      const socketPath = await resolveSocket(browserManager);
      if (!socketPath) {
        return jsonOutput({
          error: "Browser automation not available. Enable it in Settings → Browser and ensure Chrome + OBU extension is running.",
        });
      }

      const waitMs = Math.min(Math.max(Number(wait_seconds) || 6, 1), 20) * 1000;

      let browser: Awaited<ReturnType<typeof connectOpenBrowserUse>> | null = null;
      try {
        browser = await connectOpenBrowserUse({
          socketPath,
          sessionId: `tradex-screenshot-${Date.now()}`,
          timeoutMs: browserManager.timeoutMs,
        });

        await browser.client.nameSession("Tradex Screenshot - OBU");
        const tab = await browser.newTab({ url: targetUrl, waitUntil: "load" });

        // Bring to front — critical for TradingView canvas rendering
        await browser.cdp.call(tab.id, "Page.bringToFront");

        // Wait for canvas/content to render
        await waitForRender(browser, tab.id, waitMs);

        // Capture screenshot
        const params: BrowserUseRequestParams = { format: "png" };
        if (clip && typeof clip === "object") {
          const c = clip as Record<string, number>;
          params.clip = {
            x: Number(c.x) || 0,
            y: Number(c.y) || 0,
            width: Number(c.width) || 1280,
            height: Number(c.height) || 720,
            scale: 2,
          };
        }

        const result = await browser.cdp.call(tab.id, "Page.captureScreenshot", params);
        const data = (result as Record<string, unknown>)?.data as string | undefined;

        // Get page title for context
        const title = await browser.cdp.evaluate(tab.id, "document.title") as string;

        await browser.client.finalizeTabs([]);
        browser.close();

        if (!data) {
          return jsonOutput({ error: "Screenshot capture returned no data", url: targetUrl });
        }

        return jsonOutput({
          url: targetUrl,
          title: title || "",
          format: "png",
          base64: data,
          size_bytes: Math.round(data.length * 0.75), // approximate decoded size
        });
      } catch (e) {
        browser?.close();
        return jsonOutput({ error: e instanceof Error ? e.message : String(e), url: targetUrl });
      }
    },
  });

  registry.register({
    name: "browser_status",
    description: "Check if browser automation (Open Browser Use) is available and connected.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const status = await browserManager.status();
      // status.connected already reflects a live OBU ping (see BrowserManager.status)
      return jsonOutput(status);
    },
  });

  return registry;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveSocket(manager: BrowserManager): Promise<string | null> {
  // Access the private resolveSocketPath via status check
  const status = await manager.status();
  return status.socketPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for canvas to render (important for TradingView).
 * Polls canvas size until it exceeds 500px width or timeout.
 */
async function waitForRender(
  browser: { cdp: { evaluate: (tabId: number, expr: string) => Promise<unknown> } },
  tabId: number,
  maxWaitMs: number,
): Promise<void> {
  const start = Date.now();
  const pollInterval = 1000;

  while (Date.now() - start < maxWaitMs) {
    try {
      const size = await browser.cdp.evaluate(
        tabId,
        "(function(){ const c = document.querySelector('canvas'); return c ? c.width : -1; })()",
      );
      // If there's a canvas and it's rendered (>500px), or there's no canvas at all (-1 means no canvas element)
      if (typeof size === "number" && (size > 500 || size === -1)) {
        // Give a little extra time for final paint
        await sleep(1000);
        return;
      }
    } catch {
      // ignore eval errors during load
    }
    await sleep(pollInterval);
  }
  // Timeout — proceed anyway
}
