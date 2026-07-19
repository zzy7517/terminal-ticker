import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../agent/tools/registry.js";
import { McpRunGrantStore } from "./grants.js";

describe("MCP run grants", () => {
  it("binds a short-lived token to collaboration tools including message writes, never trading writes", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "quote",
      description: "quote",
      parameters: { type: "object", properties: {} },
      policy: { access: "read", domain: "market", runtimeExposure: ["pi", "claude-code"] },
      execute: () => "ok",
    });
    registry.register({
      name: "message_send",
      description: "send",
      parameters: { type: "object", properties: {} },
      policy: { access: "write", domain: "other", runtimeExposure: ["pi", "claude-code"] },
      execute: () => "ok",
    });
    registry.register({
      name: "place_order",
      description: "write",
      parameters: { type: "object", properties: {} },
      policy: { access: "write", domain: "trading", runtimeExposure: ["pi", "claude-code"] },
      execute: () => "no",
    });

    const store = new McpRunGrantStore({ now: () => 1_000 });
    const issued = store.issue({ tradexSessionId: "s1", registry, ttlMs: 500 });
    const grant = store.resolve(issued.token);

    expect(grant?.tradexSessionId).toBe("s1");
    expect(grant?.tools.map((tool) => tool.name).sort()).toEqual(["message_send", "quote"]);
    expect(store.resolve("wrong")).toBeNull();
    store.revoke(issued.token);
    expect(store.resolve(issued.token)).toBeNull();
  });

  it("expires grants", () => {
    let now = 1_000;
    const store = new McpRunGrantStore({ now: () => now });
    const issued = store.issue({ tradexSessionId: "s1", registry: new ToolRegistry(), ttlMs: 10 });
    now = 1_011;
    expect(store.resolve(issued.token)).toBeNull();
  });
});
