import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../agent/tools/registry.js";
import { McpRunGrantStore } from "./grants.js";
import { isLoopbackAddress, tradexMcpRoutes } from "./routes.js";

const loopback = { remoteAddress: () => "127.0.0.1" };

describe("Tradex MCP endpoint", () => {
  it("rejects missing run grants", async () => {
    const response = await tradexMcpRoutes(new McpRunGrantStore(), loopback).request("/mcp/tradex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    });
    expect(response.status).toBe(401);
  });

  it("serves only tools captured by the grant", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "quote",
      description: "Read quote",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      policy: { access: "read", domain: "market", runtimeExposure: ["claude-code"] },
      execute: ({ symbol }) => JSON.stringify({ symbol, price: 100 }),
    });
    const grants = new McpRunGrantStore();
    const { token } = grants.issue({ tradexSessionId: "s1", registry, ttlMs: 60_000 });
    const app = tradexMcpRoutes(grants, loopback);
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };

    const initialized = await app.request("/mcp/tradex", {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    });
    expect(initialized.status).toBe(200);

    const listed = await app.request("/mcp/tradex", {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual(["quote"]);
  });

  it("rejects non-loopback connections before authenticating grants", async () => {
    const response = await tradexMcpRoutes(new McpRunGrantStore(), {
      remoteAddress: () => "192.168.1.20",
    }).request("/mcp/tradex", { method: "POST" });

    expect(response.status).toBe(403);
  });

  it("recognizes IPv4 and IPv6 loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.12.3.4")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
  });
});
