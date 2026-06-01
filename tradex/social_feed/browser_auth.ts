import type { BrowserManager } from "../browser/manager.js";
import type { XAuthStore, XAuthStatus } from "./auth.js";

const X_COOKIE_URLS = ["https://x.com/", "https://twitter.com/"];
const X_COOKIE_DOMAIN_RE = /(^|\.)((x\.com)|(twitter\.com))$/i;

export interface XBrowserAuthImportResult {
  ok: boolean;
  status: XAuthStatus;
  error: string | null;
}

interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
}

export async function importXAuthFromBrowser(input: {
  browserManager: BrowserManager;
  authStore: XAuthStore;
}): Promise<XBrowserAuthImportResult> {
  const { browserManager, authStore } = input;
  const browserStatus = await browserManager.status();

  if (!browserStatus.enabled) {
    return fail(authStore, "Browser automation is disabled. Enable it in Settings -> Browser first.");
  }
  if (!browserStatus.connected || !browserStatus.socketPath) {
    return fail(
      authStore,
      browserStatus.error || "Open Browser Use is not connected. Start Chrome with the OBU extension, then try again.",
    );
  }

  const { connectOpenBrowserUse } = await import("open-browser-use-sdk");
  let browser: Awaited<ReturnType<typeof connectOpenBrowserUse>> | null = null;
  let tabId: number | null = null;
  let keepTabForLogin = false;

  try {
    browser = await connectOpenBrowserUse({
      socketPath: browserStatus.socketPath,
      sessionId: `tradex-x-auth-${Date.now()}`,
      timeoutMs: browserManager.timeoutMs,
    });
    await browser.client.nameSession("Tradex X Auth Import - OBU");

    const tab = await browser.newTab({ url: "https://x.com/home", waitUntil: "domcontentloaded" });
    tabId = tab.id;
    await browser.cdp.call(tab.id, "Page.bringToFront");
    await sleep(1500);
    await browser.cdp.call(tab.id, "Network.enable").catch(() => null);

    const cookiePayload = await browser.cdp.call(tab.id, "Network.getCookies", { urls: X_COOKIE_URLS });
    const cookies = parseCookies(cookiePayload);
    const authToken = findCookieValue(cookies, "auth_token");
    const ct0 = findCookieValue(cookies, "ct0");

    if (!authToken || !ct0) {
      keepTabForLogin = true;
      return fail(
        authStore,
        "X login cookies were not found. Log in to x.com in the opened Chrome tab, then click Import from Chrome again.",
      );
    }

    return { ok: true, status: authStore.save({ authToken, ct0 }), error: null };
  } catch (error) {
    return fail(authStore, error instanceof Error ? error.message : String(error));
  } finally {
    if (browser) {
      const keep = keepTabForLogin && tabId !== null ? [{ tabId, status: "handoff" }] : [];
      await browser.client.finalizeTabs(keep).catch(() => null);
      browser.close();
    }
  }
}

function fail(authStore: XAuthStore, error: string): XBrowserAuthImportResult {
  return { ok: false, status: authStore.status(), error };
}

function parseCookies(payload: unknown): BrowserCookie[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rawCookies = (payload as Record<string, unknown>).cookies;
  if (!Array.isArray(rawCookies)) return [];

  return rawCookies.flatMap((cookie): BrowserCookie[] => {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) return [];
    const record = cookie as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const value = typeof record.value === "string" ? record.value : "";
    const domain = typeof record.domain === "string" ? record.domain : "";
    return name && value ? [{ name, value, domain }] : [];
  });
}

function findCookieValue(cookies: BrowserCookie[], name: string): string | null {
  return cookies.find((cookie) => cookie.name === name && X_COOKIE_DOMAIN_RE.test(cookie.domain))?.value ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
