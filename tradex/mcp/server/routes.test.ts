import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../agent/tools/registry.js";
import { McpRunGrantStore } from "./grants.js";
import { tradexMcpRoutes } from "./routes.js";

describe("Tradex MCP endpoint", () => {
  it("rejects missing run grants", async () => {
    const response = await tradexMcpRoutes(new McpRunGrantStore()).request("/mcp/tradex", {
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
    const app = tradexMcpRoutes(grants);
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
});
