/**
 * MCP Client Manager.
 *
 * Manages connections to external MCP servers (stdio and HTTP).
 * Implements lazy connection — servers only connect when their tools are called.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpAllResourceTemplatesResult,
  McpAllResourcesResult,
  McpConfig,
  McpResourceListResult,
  McpResourceReadResult,
  McpResourceTemplateListResult,
  McpServerEntry,
  McpServerStatus,
  McpToolMeta,
} from "./types.js";
import { formatToolName } from "./config.js";

interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: McpServerEntry;
  tools: McpToolMeta[];
  lastUsedAt: number;
  status: McpServerStatus;
}

export class McpClientManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  /** serverName -> epoch ms until which we skip reconnect attempts after a failure. */
  private failureCooldowns = new Map<string, number>();
  /** Backoff window after a failed connection (ms). Prevents log spam from rate-limited servers. */
  private static readonly FAILURE_COOLDOWN_MS = 5 * 60_000;
  private config: McpConfig;
  private prefix: "server" | "none" | "short";
  private globalIdleTimeout: number;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: McpConfig) {
    this.config = config;
    this.prefix = config.settings?.toolPrefix ?? "server";
    this.globalIdleTimeout = config.settings?.idleTimeout ?? 10;
  }

  /** Start idle-timeout sweep. */
  start(): void {
    if (this.globalIdleTimeout > 0 && !this.idleTimer) {
      this.idleTimer = setInterval(() => this.sweepIdle(), 60_000);
    }
  }

  /** Gracefully disconnect all servers. */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const names = [...this.connections.keys()];
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
  }

  /** Get all configured server names. */
  getServerNames(): string[] {
    return Object.keys(this.config.mcpServers);
  }

  /** Get connection status for a server. */
  getStatus(serverName: string): McpServerStatus {
    return this.connections.get(serverName)?.status ?? "idle";
  }

  /** Get all known tools (from connected servers). */
  getAllTools(): McpToolMeta[] {
    const tools: McpToolMeta[] = [];
    for (const conn of this.connections.values()) {
      tools.push(...conn.tools);
    }
    return tools;
  }

  /** Get the full MCP config (servers + settings). */
  getConfig(): McpConfig {
    return this.config;
  }

  /** Get server config entries. */
  getServerConfig(): Record<string, McpServerEntry> {
    return this.config.mcpServers;
  }

  /** Get prefix mode. */
  getPrefixMode(): "server" | "none" | "short" {
    return this.prefix;
  }

  /**
   * Connect to a server (lazy — called on first tool use or explicit connect).
   * Deduplicates concurrent connection attempts.
   */
  async connect(serverName: string): Promise<ServerConnection> {
    // Reuse existing healthy connection
    const existing = this.connections.get(serverName);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    // Dedupe concurrent connect calls
    if (this.connectPromises.has(serverName)) {
      return this.connectPromises.get(serverName)!;
    }

    // Respect failure cooldown: don't retry (and re-log) a recently-failed server.
    const cooldownUntil = this.failureCooldowns.get(serverName);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      throw new Error(
        `MCP server "${serverName}" is in failure cooldown until ${new Date(cooldownUntil).toISOString()}`,
      );
    }

    const definition = this.config.mcpServers[serverName];
    if (!definition) {
      throw new Error(`MCP server "${serverName}" not found in config`);
    }

    const promise = this.createConnection(serverName, definition);
    this.connectPromises.set(serverName, promise);

    try {
      const connection = await promise;
      this.connections.set(serverName, connection);
      this.failureCooldowns.delete(serverName);
      return connection;
    } catch (error) {
      // Enter cooldown so repeated agent turns / cron runs don't spam reconnect attempts.
      this.failureCooldowns.set(serverName, Date.now() + McpClientManager.FAILURE_COOLDOWN_MS);
      throw error;
    } finally {
      this.connectPromises.delete(serverName);
    }
  }

  /**
   * Call a tool on a specific server.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const conn = await this.connect(serverName);
    conn.lastUsedAt = Date.now();

    const result = await conn.client.callTool({ name: toolName, arguments: args });

    // Extract text content
    const textParts = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);

    if (result.isError) {
      throw new Error(textParts.join("\n") || "MCP tool returned an error");
    }

    return textParts.join("\n") || JSON.stringify(result.content);
  }

  /** List one page of resources exposed by a specific MCP server. */
  async listResources(serverName: string, cursor?: string): Promise<McpResourceListResult> {
    const conn = await this.connect(serverName);
    conn.lastUsedAt = Date.now();

    const result = await conn.client.listResources(cursor ? { cursor } : undefined);
    return { resources: result.resources, nextCursor: result.nextCursor };
  }

  /** List every resource exposed by every configured MCP server. */
  async listAllResources(): Promise<McpAllResourcesResult> {
    const entries = await Promise.all(this.getServerNames().map(async (serverName) => {
      try {
        const resources: McpResourceListResult["resources"] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        while (true) {
          const page = await this.listResources(serverName, cursor);
          resources.push(...page.resources);
          const nextCursor = page.nextCursor?.trim();
          if (!nextCursor) break;
          if (seenCursors.has(nextCursor)) {
            throw new Error("resources/list returned duplicate cursor");
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        return { serverName, resources };
      } catch (error) {
        return { serverName, error: error instanceof Error ? error.message : String(error) };
      }
    }));

    const result: McpAllResourcesResult = { resources: {}, errors: [] };
    for (const entry of entries) {
      if ("error" in entry) {
        result.errors.push({ serverName: entry.serverName, error: entry.error ?? "unknown error" });
      } else {
        result.resources[entry.serverName] = entry.resources;
      }
    }
    return result;
  }

  /** List one page of resource templates exposed by a specific MCP server. */
  async listResourceTemplates(serverName: string, cursor?: string): Promise<McpResourceTemplateListResult> {
    const conn = await this.connect(serverName);
    conn.lastUsedAt = Date.now();

    const result = await conn.client.listResourceTemplates(cursor ? { cursor } : undefined);
    return { resourceTemplates: result.resourceTemplates, nextCursor: result.nextCursor };
  }

  /** List every resource template exposed by every configured MCP server. */
  async listAllResourceTemplates(): Promise<McpAllResourceTemplatesResult> {
    const entries = await Promise.all(this.getServerNames().map(async (serverName) => {
      try {
        const resourceTemplates: McpResourceTemplateListResult["resourceTemplates"] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        while (true) {
          const page = await this.listResourceTemplates(serverName, cursor);
          resourceTemplates.push(...page.resourceTemplates);
          const nextCursor = page.nextCursor?.trim();
          if (!nextCursor) break;
          if (seenCursors.has(nextCursor)) {
            throw new Error("resources/templates/list returned duplicate cursor");
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        return { serverName, resourceTemplates };
      } catch (error) {
        return { serverName, error: error instanceof Error ? error.message : String(error) };
      }
    }));

    const result: McpAllResourceTemplatesResult = { resourceTemplates: {}, errors: [] };
    for (const entry of entries) {
      if ("error" in entry) {
        result.errors.push({ serverName: entry.serverName, error: entry.error ?? "unknown error" });
      } else {
        result.resourceTemplates[entry.serverName] = entry.resourceTemplates;
      }
    }
    return result;
  }

  /** Read the contents of a specific MCP resource. */
  async readResource(serverName: string, uri: string): Promise<McpResourceReadResult> {
    const conn = await this.connect(serverName);
    conn.lastUsedAt = Date.now();

    return conn.client.readResource({ uri });
  }

  /** Disconnect from a specific server. */
  async disconnect(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    try {
      await conn.client.close();
    } catch {
      // Ignore close errors
    }
    try {
      await conn.transport.close();
    } catch {
      // Ignore close errors
    }

    this.connections.delete(serverName);
  }

  // --- Private ---

  private async createConnection(name: string, definition: McpServerEntry): Promise<ServerConnection> {
    const client = new Client({ name: `tradex-mcp-${name}`, version: "1.0.0" });
    let transport: Transport;

    if (definition.command) {
      transport = new StdioClientTransport({
        command: definition.command,
        args: definition.args ?? [],
        env: definition.env ? { ...process.env, ...definition.env } as Record<string, string> : undefined,
        cwd: definition.cwd,
        stderr: "ignore",
      });
    } else if (definition.url) {
      transport = await this.createHttpTransport(definition);
    } else {
      throw new Error(`MCP server "${name}" has neither command nor url`);
    }

    try {
      await client.connect(transport);

      // Discover tools
      const toolsResult = await client.listTools();
      const tools: McpToolMeta[] = toolsResult.tools.map((t) => ({
        name: formatToolName(t.name, name, this.prefix),
        originalName: t.name,
        serverName: name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));

      console.log(`[mcp] Connected to "${name}" — ${tools.length} tool(s)`);

      return {
        client,
        transport,
        definition,
        tools,
        lastUsedAt: Date.now(),
        status: "connected",
      };
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      console.warn(
        `[mcp] Failed to connect to "${name}" (cooling down ${Math.round(McpClientManager.FAILURE_COOLDOWN_MS / 60_000)}m before retry):`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    }
  }

  private async createHttpTransport(definition: McpServerEntry): Promise<Transport> {
    const url = new URL(definition.url!);
    const headers = definition.headers ?? {};

    try {
      // Try Streamable HTTP first
      return new StreamableHTTPClientTransport(url, {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      });
    } catch {
      // Fall back to SSE
      return new SSEClientTransport(url, {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      });
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [name, conn] of this.connections) {
      const timeout = conn.definition.idleTimeout ?? this.globalIdleTimeout;
      if (timeout <= 0) continue;
      if (now - conn.lastUsedAt > timeout * 60_000) {
        console.log(`[mcp] Disconnecting idle server "${name}"`);
        void this.disconnect(name);
      }
    }
  }
}
