/**
 * MCP Bridge — connects McpClientManager to tradex ToolRegistry.
 *
 * Two modes:
 * 1. Proxy mode: One "mcp" tool that the agent uses to search/describe/call any MCP tool.
 *    Saves context tokens (~200 tokens instead of thousands).
 * 2. Direct mode: Each MCP tool is registered as a separate ToolDefinition in ToolRegistry.
 */
import { ToolRegistry, jsonOutput } from "../agent/tools/registry.js";
import type { McpClientManager } from "./client.js";
import type { McpConfig, McpServerEntry, McpToolMeta } from "./types.js";

/**
 * Build a ToolRegistry containing MCP tools.
 * Respects directTools config per server and globally.
 */
export function buildMcpToolRegistry(manager: McpClientManager, config: McpConfig): ToolRegistry {
  const registry = new ToolRegistry();
  const globalDirect = config.settings?.directTools ?? false;

  // Always register the proxy tool (handles search/describe/connect/status + calls for non-direct servers)
  registerProxyTool(registry, manager, config);

  // Register direct tools for servers that opt in
  for (const [serverName, entry] of Object.entries(config.mcpServers)) {
    if (shouldRegisterDirect(entry, globalDirect)) {
      registerDirectToolsForServer(registry, manager, serverName, entry);
    }
  }

  return registry;
}

function shouldRegisterDirect(entry: McpServerEntry, globalDirect: boolean): boolean {
  if (entry.directTools === true) return true;
  if (Array.isArray(entry.directTools) && entry.directTools.length > 0) return true;
  if (entry.directTools === false) return false;
  return globalDirect;
}

// --- Proxy Tool ---

function registerProxyTool(registry: ToolRegistry, manager: McpClientManager, config: McpConfig): void {
  const serverNames = Object.keys(config.mcpServers);
  const serverList = serverNames.length > 0 ? serverNames.join(", ") : "(none configured)";

  registry.register({
    name: "mcp",
    description:
      `MCP gateway — connect to external MCP servers and call their tools/resources. ` +
      `Configured servers: ${serverList}. ` +
      `Modes: status (no args) | connect (server name) | search (query) | describe (tool name) | ` +
      `call (tool + args) | resources/resourceTemplates (server or all) | readResource (URI + server).`,
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Tool name to call" },
        args: { type: "string", description: "Arguments as JSON string" },
        connect: { type: "string", description: "Server name to connect" },
        describe: { type: "string", description: "Tool name to describe (shows parameters)" },
        search: { type: "string", description: "Search tools by name/description" },
        server: { type: "string", description: "Filter to specific server, or required server for readResource" },
        resources: { type: "string", description: "List MCP resources. Pass a server name, or 'all' for every configured server." },
        resourceTemplates: { type: "string", description: "List MCP resource templates. Pass a server name, or 'all' for every configured server." },
        readResource: { type: "string", description: "Resource URI to read, e.g. quote://codes. Requires server." },
        cursor: { type: "string", description: "Pagination cursor returned by resources/resourceTemplates for a specific server" },
      },
    },
    handler: async (params: Record<string, unknown>) => {
      const tool = stringParam(params.tool);
      const args = stringParam(params.args);
      const connect = stringParam(params.connect);
      const describe = stringParam(params.describe);
      const search = stringParam(params.search);
      const server = normalizeServerName(stringParam(params.server));
      const resources = params.resources === undefined ? undefined : normalizeServerName(stringParam(params.resources) ?? server ?? "all");
      const resourceTemplates = params.resourceTemplates === undefined
        ? undefined
        : normalizeServerName(stringParam(params.resourceTemplates) ?? server ?? "all");
      const readResource = stringParam(params.readResource);
      const cursor = stringParam(params.cursor);

      // Call a tool
      if (tool) {
        return executeCall(manager, tool, args, server);
      }
      // Connect to a server
      if (connect) {
        return executeConnect(manager, connect);
      }
      // Describe a tool
      if (describe) {
        return executeDescribe(manager, describe);
      }
      // Search tools
      if (search) {
        return executeSearch(manager, search, server);
      }
      // Read a resource
      if (readResource) {
        return executeReadResource(manager, readResource, server);
      }
      // List resources
      if (params.resources !== undefined) {
        return executeListResources(manager, resources, cursor);
      }
      // List resource templates
      if (params.resourceTemplates !== undefined) {
        return executeListResourceTemplates(manager, resourceTemplates, cursor);
      }
      // Status (default)
      return executeStatus(manager);
    },
  });
}

function stringParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeServerName(serverName: string | undefined): string | undefined {
  if (!serverName || serverName === "all" || serverName === "*") return undefined;
  return serverName;
}

async function executeStatus(manager: McpClientManager): Promise<string> {
  const servers = manager.getServerNames();
  if (servers.length === 0) return jsonOutput({ status: "no MCP servers configured" });

  const statuses = servers.map((name) => ({
    name,
    status: manager.getStatus(name),
  }));

  const connectedTools = manager.getAllTools().length;
  return jsonOutput({ servers: statuses, connectedTools });
}

async function executeConnect(manager: McpClientManager, serverName: string): Promise<string> {
  try {
    const conn = await manager.connect(serverName);
    const tools = manager.getAllTools().filter((t) => t.serverName === serverName);
    return jsonOutput({
      connected: serverName,
      tools: tools.map((t) => ({ name: t.name, description: t.description.slice(0, 100) })),
    });
  } catch (error) {
    return jsonOutput({ error: `Failed to connect to "${serverName}": ${error instanceof Error ? error.message : error}` });
  }
}

async function executeSearch(manager: McpClientManager, query: string, serverFilter?: string): Promise<string> {
  // Connect to servers that aren't connected yet to get their tool lists
  const serverNames = serverFilter ? [serverFilter] : manager.getServerNames();
  for (const name of serverNames) {
    if (manager.getStatus(name) === "idle") {
      try {
        await manager.connect(name);
      } catch {
        // Skip servers that fail to connect
      }
    }
  }

  const allTools = manager.getAllTools();
  const q = query.toLowerCase();
  const matches = allTools.filter((t) => {
    if (serverFilter && t.serverName !== serverFilter) return false;
    return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
  });

  return jsonOutput({
    query,
    results: matches.map((t) => ({
      name: t.name,
      server: t.serverName,
      description: t.description.slice(0, 200),
    })),
  });
}

async function executeDescribe(manager: McpClientManager, toolName: string): Promise<string> {
  // Find the tool in connected servers
  const allTools = manager.getAllTools();
  const tool = allTools.find((t) => t.name === toolName || t.originalName === toolName);

  if (!tool) {
    // Try connecting all idle servers to find it
    for (const name of manager.getServerNames()) {
      if (manager.getStatus(name) === "idle") {
        try {
          await manager.connect(name);
        } catch { continue; }
      }
    }
    const retried = manager.getAllTools().find((t) => t.name === toolName || t.originalName === toolName);
    if (!retried) return jsonOutput({ error: `Tool "${toolName}" not found` });
    return jsonOutput({ name: retried.name, server: retried.serverName, description: retried.description, inputSchema: retried.inputSchema });
  }

  return jsonOutput({ name: tool.name, server: tool.serverName, description: tool.description, inputSchema: tool.inputSchema });
}

async function executeCall(manager: McpClientManager, toolName: string, argsStr?: string, serverFilter?: string): Promise<string> {
  let parsedArgs: Record<string, unknown> = {};
  if (argsStr) {
    try {
      parsedArgs = JSON.parse(argsStr);
    } catch (err) {
      return jsonOutput({ error: `Invalid args JSON: ${err instanceof Error ? err.message : err}` });
    }
  }

  // Resolve which server owns this tool
  const allTools = manager.getAllTools();
  let tool = allTools.find((t) => {
    if (serverFilter && t.serverName !== serverFilter) return false;
    return t.name === toolName || t.originalName === toolName;
  });

  if (!tool) {
    // Try connecting idle servers
    for (const name of manager.getServerNames()) {
      if (serverFilter && name !== serverFilter) continue;
      if (manager.getStatus(name) === "idle") {
        try { await manager.connect(name); } catch { continue; }
      }
    }
    tool = manager.getAllTools().find((t) => {
      if (serverFilter && t.serverName !== serverFilter) return false;
      return t.name === toolName || t.originalName === toolName;
    });
  }

  if (!tool) {
    return jsonOutput({ error: `Tool "${toolName}" not found in any connected server` });
  }

  try {
    const result = await manager.callTool(tool.serverName, tool.originalName, parsedArgs);
    return result;
  } catch (error) {
    return jsonOutput({ error: `Tool call failed: ${error instanceof Error ? error.message : error}` });
  }
}

async function executeListResources(manager: McpClientManager, serverName?: string, cursor?: string): Promise<string> {
  if (cursor && !serverName) {
    return jsonOutput({ error: "cursor can only be used when listing resources for a specific server" });
  }

  try {
    if (serverName) {
      const result = await manager.listResources(serverName, cursor);
      return jsonOutput({ server: serverName, ...result });
    }

    const result = await manager.listAllResources();
    return jsonOutput({
      resources: Object.entries(result.resources).flatMap(([server, resources]) => (
        resources.map((resource) => ({ server, ...resource }))
      )),
      errors: result.errors,
    });
  } catch (error) {
    return jsonOutput({ error: `Resource list failed: ${error instanceof Error ? error.message : error}` });
  }
}

async function executeListResourceTemplates(manager: McpClientManager, serverName?: string, cursor?: string): Promise<string> {
  if (cursor && !serverName) {
    return jsonOutput({ error: "cursor can only be used when listing resource templates for a specific server" });
  }

  try {
    if (serverName) {
      const result = await manager.listResourceTemplates(serverName, cursor);
      return jsonOutput({ server: serverName, ...result });
    }

    const result = await manager.listAllResourceTemplates();
    return jsonOutput({
      resourceTemplates: Object.entries(result.resourceTemplates).flatMap(([server, resourceTemplates]) => (
        resourceTemplates.map((resourceTemplate) => ({ server, ...resourceTemplate }))
      )),
      errors: result.errors,
    });
  } catch (error) {
    return jsonOutput({ error: `Resource template list failed: ${error instanceof Error ? error.message : error}` });
  }
}

async function executeReadResource(manager: McpClientManager, uri: string, serverName?: string): Promise<string> {
  if (!serverName) {
    return jsonOutput({ error: "readResource requires a server name" });
  }

  try {
    const result = await manager.readResource(serverName, uri);
    return jsonOutput({ server: serverName, uri, ...result });
  } catch (error) {
    return jsonOutput({ error: `Resource read failed: ${error instanceof Error ? error.message : error}` });
  }
}

// --- Direct Tool Registration ---

function registerDirectToolsForServer(
  registry: ToolRegistry,
  manager: McpClientManager,
  serverName: string,
  entry: McpServerEntry,
): void {
  // If the server is already connected (e.g. eager servers connected at runtime start),
  // register its tools synchronously so they appear in the agent's tool schema immediately.
  // Otherwise, for eager servers not yet connected, fire an async connect + register.
  // For lazy servers, tools become available after the first proxy "connect" call.
  const status = manager.getStatus(serverName);
  if (status === "connected") {
    // Server already connected — register tools synchronously
    registerConnectedDirectTools(registry, manager, serverName, entry);
  } else if (entry.lifecycle === "eager") {
    // Not yet connected — kick off async connect and register when done
    void manager.connect(serverName).then(() => {
      registerConnectedDirectTools(registry, manager, serverName, entry);
    }).catch((err) => {
      console.warn(`[mcp] Failed eager connect to "${serverName}":`, err instanceof Error ? err.message : err);
    });
  }
}

function registerConnectedDirectTools(
  registry: ToolRegistry,
  manager: McpClientManager,
  serverName: string,
  entry: McpServerEntry,
): void {
  const tools = manager.getAllTools().filter((t) => t.serverName === serverName);
  const allowedTools = Array.isArray(entry.directTools) ? new Set(entry.directTools) : null;

  for (const tool of tools) {
    if (allowedTools && !allowedTools.has(tool.originalName) && !allowedTools.has(tool.name)) {
      continue;
    }

    // Skip if already registered (e.g. by proxy tool)
    if (registry.get(tool.name)) continue;

    registry.register({
      name: tool.name,
      description: `[MCP: ${serverName}] ${tool.description}`,
      parameters: tool.inputSchema,
      handler: async (args: Record<string, unknown>) => {
        try {
          return await manager.callTool(serverName, tool.originalName, args);
        } catch (error) {
          return jsonOutput({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
  }
}
