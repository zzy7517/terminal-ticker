import { describe, expect, it } from "vitest";
import { CliRunGrantStore } from "../../agent/runtime/cli-tools.js";
import { ToolRegistry } from "../../agent/tools/registry.js";
import { tradexCliRoutes } from "./cli.js";

const loopback = { remoteAddress: () => "127.0.0.1" };

function setup(input: { includeFailingTool?: boolean } = {}) {
  const registry = new ToolRegistry();
  registry.register({
    name: "quote",
    description: "Read quote",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
    policy: { access: "read", domain: "market", runtimeExposure: ["claude-code"] },
    execute: ({ symbol }) => JSON.stringify({ symbol, price: 100 }),
  });
  if (input.includeFailingTool) {
    registry.register({
      name: "failing_tool",
      description: "Always fails",
      parameters: { type: "object" },
      policy: { access: "read", domain: "other", runtimeExposure: ["claude-code"] },
      execute: () => { throw new Error("tool failed"); },
    });
  }
  const grants = new CliRunGrantStore();
  const issued = grants.issue({ tradexSessionId: "s1", registry, ttlMs: 60_000, runtime: "claude-code" });
  return {
    app: tradexCliRoutes(grants, loopback),
    headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
  };
}

describe("Tradex CLI gateway", () => {
  it("lists and invokes only tools captured by the run grant", async () => {
    const { app, headers } = setup();
    const manifest = await app.request("/cli/tradex/manifest", { headers });
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ sessionId: "s1", tools: [{ name: "quote" }] });

    const invoked = await app.request("/cli/tradex/invoke", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "quote", args: { symbol: "BTCUSDT" } }),
    });
    expect(invoked.status).toBe(200);
    expect(await invoked.json()).toEqual({
      content: [{ type: "text", text: JSON.stringify({ symbol: "BTCUSDT", price: 100 }) }],
    });

    const denied = await app.request("/cli/tradex/invoke", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "place_order", args: {} }),
    });
    expect(denied.status).toBe(403);
  });

  it("requires both loopback and a live grant", async () => {
    const { app } = setup();
    expect((await app.request("/cli/tradex/manifest")).status).toBe(401);
    const remote = tradexCliRoutes(new CliRunGrantStore(), { remoteAddress: () => "192.168.1.20" });
    expect((await remote.request("/cli/tradex/manifest")).status).toBe(403);
  });

  it("returns a failing HTTP status when tool execution throws", async () => {
    const { app, headers } = setup({ includeFailingTool: true });
    const response = await app.request("/cli/tradex/invoke", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "failing_tool", args: {} }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      content: [{ type: "text", text: "tool failed" }],
      isError: true,
    });
  });
});
