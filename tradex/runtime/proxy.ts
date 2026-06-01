import net from "node:net";
import tls from "node:tls";
import { Agent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { SocksClient, type SocksProxy } from "socks";
import type { ProxyConfig } from "../config/index.js";

// The dispatcher Node uses by default before we ever touch it. We capture it
// once so disabling the proxy can fully restore direct-connect behaviour.
let baselineDispatcher: Dispatcher | null = null;
// The proxy dispatcher we installed (if any), so we can destroy it on swap.
let installedDispatcher: Dispatcher | null = null;

/**
 * Build an undici-compatible URL string from a ProxyConfig. Returns null when
 * the host is blank (nothing to connect to).
 */
function buildProxyUrl(config: ProxyConfig): string | null {
  const host = config.host.trim();
  if (!host) return null;
  const scheme = config.type === "socks5" ? "socks5" : config.type; // http | https | socks5
  const auth =
    config.username || config.password
      ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
      : "";
  return `${scheme}://${auth}${host}:${config.port}`;
}

/**
 * Strip any embedded `user:pass@` credentials from a proxy URL so it is safe to
 * log. `socks5://u:p@127.0.0.1:1086` -> `socks5://127.0.0.1:1086`.
 */
export function redactProxyUrl(url: string | null): string | null {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^/@]*@/, "//");
  }
}

/**
 * Construct an undici Dispatcher for the given proxy. HTTP/HTTPS proxies use
 * undici's native ProxyAgent; SOCKS5 tunnels each connection through the
 * low-level `socks` client wired into an undici Agent via the connect hook.
 */
function buildDispatcher(config: ProxyConfig, url: string): Dispatcher {
  if (config.type === "socks5") return buildSocks5Dispatcher(config);
  return new ProxyAgent(url);
}

/**
 * Build an undici Agent whose `connect` hook tunnels each connection through a
 * SOCKS5 proxy using the low-level `socks` client. For TLS targets the raw
 * tunnelled socket is upgraded with `tls.connect`, mirroring what undici's own
 * connector does for direct connections. Using the typed `socks` API directly
 * avoids depending on any agent library's internal connect signature.
 */
function buildSocks5Dispatcher(config: ProxyConfig): Dispatcher {
  const proxy: SocksProxy = {
    host: config.host,
    port: config.port,
    type: 5,
    ...(config.username ? { userId: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
  };

  return new Agent({
    connect: (opts, callback) => {
      // undici's connector options carry the target host/port/protocol and,
      // for TLS, the servername to validate against.
      const target = opts as unknown as {
        host?: string;
        hostname?: string;
        port?: string | number;
        protocol?: string;
        servername?: string | null;
      };
      const host = target.host || target.hostname || "";
      const secureEndpoint = target.protocol === "https:";
      const port = Number(target.port) || (secureEndpoint ? 443 : 80);

      SocksClient.createConnection({
        proxy,
        command: "connect",
        destination: { host, port },
      })
        .then(({ socket }) => {
          if (!secureEndpoint) {
            callback(null, socket as never);
            return;
          }
          // Upgrade the tunnelled TCP socket to TLS for https targets.
          const servername = target.servername || (net.isIP(host) ? undefined : host);
          const tlsSocket = tls.connect({ socket, servername });
          tlsSocket.once("secureConnect", () => callback(null, tlsSocket as never));
          tlsSocket.once("error", (err) => {
            socket.destroy();
            callback(err, null);
          });
        })
        .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), null));
    },
  });
}

/**
 * Apply (or remove) a global outbound proxy for all undici-based `fetch()`
 * calls in the process. Idempotent: calling repeatedly swaps the dispatcher
 * and cleans up the previous one. When the proxy is disabled or has no host,
 * the original direct-connect dispatcher is restored.
 */
export function applyProxyConfig(config: ProxyConfig): { applied: boolean; url: string | null; error?: string } {
  if (baselineDispatcher === null) baselineDispatcher = getGlobalDispatcher();

  const url = config.enabled ? buildProxyUrl(config) : null;

  // Disable path — restore the baseline dispatcher and tear down ours.
  if (!url) {
    if (installedDispatcher) {
      setGlobalDispatcher(baselineDispatcher);
      void installedDispatcher.destroy().catch(() => {});
      installedDispatcher = null;
    }
    return { applied: false, url: null };
  }

  try {
    const dispatcher = buildDispatcher(config, url);
    setGlobalDispatcher(dispatcher);
    if (installedDispatcher) void installedDispatcher.destroy().catch(() => {});
    installedDispatcher = dispatcher;
    return { applied: true, url };
  } catch (error) {
    return { applied: false, url, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ProxyTestResult {
  ok: boolean;
  url: string | null;
  status?: number;
  latencyMs?: number;
  error?: string;
}

/**
 * Probe a proxy without mutating the global dispatcher. Issues a single GET to
 * `testUrl` through a one-off dispatcher built from the supplied config.
 */
export async function testProxyConfig(
  config: ProxyConfig,
  testUrl = "https://api.ipify.org?format=json",
  timeoutMs = 8000,
): Promise<ProxyTestResult> {
  const url = buildProxyUrl(config);
  if (!url) return { ok: false, url: null, error: "Proxy server (host) is required" };

  let dispatcher: Dispatcher;
  try {
    dispatcher = buildDispatcher(config, url);
  } catch (error) {
    return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(testUrl, {
      // @ts-expect-error — undici accepts `dispatcher` on RequestInit at runtime.
      dispatcher,
      signal: controller.signal,
      redirect: "follow",
    });
    const latencyMs = Date.now() - startedAt;
    // Drain the body so the connection can be released.
    await response.text().catch(() => "");
    return { ok: response.ok, url, status: response.status, latencyMs };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "AbortError"
          ? `Timed out after ${timeoutMs}ms`
          : error.message
        : String(error);
    return { ok: false, url, error: message };
  } finally {
    clearTimeout(timer);
    void dispatcher.destroy().catch(() => {});
  }
}
