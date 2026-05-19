/**
 * MCP management API routes.
 *
 * Provides endpoints for:
 * - GET  /api/mcp/status         → overall MCP status + server list
 * - POST /api/mcp/servers/:name/connect    → connect a server
 * - POST /api/mcp/servers/:name/disconnect → disconnect a server
 * - GET  /api/mcp/servers/:name/tools      → list tools for a connected server
 * - PUT  /api/mcp/config         → update MCP config (.mcp.json)
 * - POST /api/mcp/servers        → add a new server
 * - DELETE /api/mcp/servers/:name → remove a server
 */

import { Hono } from "hono";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppRuntime } from "../runtime.js";
import { loadMcpConfig } from "../../mcp/config.js";
import type { McpServerEntry, McpSettings } from "../../mcp/types.js";

const MCP_CONFIG_PATH = resolve(process.cwd(), ".mcp.json");

export function mcpRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // GET /api/mcp/status — full status overview
  app.get("/api/mcp/status", (c) => {
    const manager = runtime.mcpManager;
    if (!manager) {
      return c.json({
        enabled: runtime.config.mcp.enabled,
        configured: false,
        servers: [],
        settings: null,
      });
    }

    const config = manager.getConfig();
    const servers = manager.getServerNames().map((name) => {
      const entry = config.mcpServers[name];
      const status = manager.getStatus(name);
      const tools = manager.getAllTools().filter((t) => t.serverName === name);
      return {
        name,
        status,
        type: entry.url ? "http" : "stdio",
        lifecycle: entry.lifecycle ?? "lazy",
        directTools: entry.directTools ?? false,
        toolCount: tools.length,
        command: entry.command ?? null,
        url: entry.url ?? null,
        args: entry.args ?? [],
        env: entry.env ? Object.keys(entry.env) : [],
        cwd: entry.cwd ?? null,
        idleTimeout: entry.idleTimeout ?? null,
      };
    });

    return c.json({
      enabled: true,
      configured: true,
      servers,
      settings: config.settings ?? null,
    });
  });

  // GET /api/mcp/servers/:name/tools — list tools for a server
  app.get("/api/mcp/servers/:name/tools", (c) => {
    const manager = runtime.mcpManager;
    if (!manager) return c.json({ error: "MCP not enabled" }, 400);

    const name = c.req.param("name");
    const tools = manager.getAllTools().filter((t) => t.serverName === name);
    return c.json({
      server: name,
      status: manager.getStatus(name),
      tools: tools.map((t) => ({
        name: t.name,
        originalName: t.originalName,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  });

  // POST /api/mcp/servers/:name/connect — connect to a server
  app.post("/api/mcp/servers/:name/connect", async (c) => {
    const manager = runtime.mcpManager;
    if (!manager) return c.json({ error: "MCP not enabled" }, 400);

    const name = c.req.param("name");
    if (!manager.getServerNames().includes(name)) {
      return c.json({ error: `Server "${name}" not found in config` }, 404);
    }

    try {
      await manager.connect(name);
      const tools = manager.getAllTools().filter((t) => t.serverName === name);
      return c.json({
        server: name,
        status: "connected",
        toolCount: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: t.description.slice(0, 120) })),
      });
    } catch (error) {
      return c.json({
        server: name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  });

  // POST /api/mcp/servers/:name/disconnect — disconnect a server
  app.post("/api/mcp/servers/:name/disconnect", async (c) => {
    const manager = runtime.mcpManager;
    if (!manager) return c.json({ error: "MCP not enabled" }, 400);

    const name = c.req.param("name");
    await manager.disconnect(name);
    return c.json({ server: name, status: "idle" });
  });

  // PUT /api/mcp/config — update global settings
  app.put("/api/mcp/config", async (c) => {
    const body = await c.req.json<{ settings?: McpSettings }>();
    const current = loadMcpConfig(runtime.config.mcp.configPath);
    const updated = { ...current, settings: body.settings ?? current.settings };
    writeMcpConfig(updated);
    return c.json({ ok: true, settings: updated.settings });
  });

  // POST /api/mcp/servers — add a new server
  app.post("/api/mcp/servers", async (c) => {
    const body = await c.req.json<{ name: string; config: McpServerEntry }>();
    if (!body.name?.trim()) return c.json({ error: "Server name is required" }, 400);

    const current = loadMcpConfig(runtime.config.mcp.configPath);
    if (current.mcpServers[body.name]) {
      return c.json({ error: `Server "${body.name}" already exists` }, 409);
    }

    current.mcpServers[body.name] = body.config;
    writeMcpConfig(current);
    return c.json({ ok: true, server: body.name });
  });

  // PUT /api/mcp/servers/:name — update a server config
  app.put("/api/mcp/servers/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<{ config: McpServerEntry }>();

    const current = loadMcpConfig(runtime.config.mcp.configPath);
    if (!current.mcpServers[name]) {
      return c.json({ error: `Server "${name}" not found` }, 404);
    }

    current.mcpServers[name] = body.config;
    writeMcpConfig(current);
    return c.json({ ok: true, server: name });
  });

  // DELETE /api/mcp/servers/:name — remove a server
  app.delete("/api/mcp/servers/:name", async (c) => {
    const name = c.req.param("name");
    const current = loadMcpConfig(runtime.config.mcp.configPath);

    if (!current.mcpServers[name]) {
      return c.json({ error: `Server "${name}" not found` }, 404);
    }

    // Disconnect if connected
    if (runtime.mcpManager) {
      await runtime.mcpManager.disconnect(name);
    }

    delete current.mcpServers[name];
    writeMcpConfig(current);
    return c.json({ ok: true });
  });

  return app;
}

function writeMcpConfig(config: { mcpServers: Record<string, McpServerEntry>; settings?: McpSettings }): void {
  const path = MCP_CONFIG_PATH;
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
