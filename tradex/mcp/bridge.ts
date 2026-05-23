/**
 * MCP Bridge — connects McpClientManager to tradex ToolRegistry.
 *
 * Direct mode only: each MCP tool is registered as a separate ToolDefinition
 * in ToolRegistry. All servers are connected eagerly and their tools appear
 * directly in the agent's tool schema.
 */
import { ToolRegistry, jsonOutput } from "../agent/tools/registry.js";
import type { McpClientManager } from "./client.js";
import type { McpConfig } from "./types.js";

/**
 * Build a ToolRegistry containing all MCP tools (direct registration).
 *
 * Connects all configured servers eagerly and registers each tool directly.
 * Returns a registry that can be merged into the agent's main tool set.
 */
export async function buildMcpToolRegistry(manager: McpClientManager, config: McpConfig): Promise<ToolRegistry> {
  const registry = new ToolRegistry();

  // Connect all servers eagerly and register their tools directly
  const serverNames = Object.keys(config.mcpServers);
  await Promise.allSettled(
    serverNames.map(async (serverName) => {
      try {
        await manager.connect(serverName);
        registerDirectTools(registry, manager, serverName);
      } catch (err) {
        console.warn(`[mcp] Failed to connect "${serverName}":`, err instanceof Error ? err.message : err);
      }
    }),
  );

  return registry;
}

function registerDirectTools(
  registry: ToolRegistry,
  manager: McpClientManager,
  serverName: string,
): void {
  const tools = manager.getAllTools().filter((t) => t.serverName === serverName);

  for (const tool of tools) {
    // Skip if already registered (name collision across servers)
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
