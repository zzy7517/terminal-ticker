/**
 * MCP config loading.
 *
 * Reads .mcp.json from project root or a custom path.
 * Compatible with the standard MCP config format used by Claude Desktop, Cursor, etc.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpConfig, McpServerEntry } from "./types.js";

const PROJECT_CONFIG_NAME = ".mcp.json";

/**
 * Built-in default MCP servers that are always available.
 *
 * NOTE: Only free, unmetered servers belong here. Rate-limited / paid servers
 * must be opt-in via `.mcp.json`, otherwise eager connection on every agent
 * turn / cron run spams the logs once the daily limit is hit.
 *
 * Jin10 used to live here; it is now a first-class data source that owns its
 * own connection (`tradex/jin10/client.ts`), configured under `[jin10]`.
 */
const BUILTIN_SERVERS: Record<string, McpServerEntry> = {};

export function loadMcpConfig(configPath?: string | null): McpConfig {
  const paths = configPath
    ? [resolve(configPath)]
    : [resolve(process.cwd(), PROJECT_CONFIG_NAME)];

  let config: McpConfig = { mcpServers: {} };

  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      config = validateMcpConfig(raw);
      break;
    } catch (error) {
      console.warn(`[mcp] Failed to load config from ${filePath}:`, error instanceof Error ? error.message : error);
    }
  }

  // Merge built-in servers (user config takes precedence)
  for (const [name, entry] of Object.entries(BUILTIN_SERVERS)) {
    if (!config.mcpServers[name]) {
      config.mcpServers[name] = entry;
    }
  }

  return config;
}

function validateMcpConfig(raw: unknown): McpConfig {
  if (!raw || typeof raw !== "object") return { mcpServers: {} };

  const obj = raw as Record<string, unknown>;
  const servers = obj.mcpServers ?? obj["mcp-servers"] ?? {};

  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return { mcpServers: {} };
  }

  // Normalize server entries (handle serverUrl → url alias)
  const normalized: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(servers as Record<string, Record<string, unknown>>)) {
    if (!entry || typeof entry !== "object") continue;
    const serverEntry = { ...entry } as Record<string, unknown>;
    // Support serverUrl as alias for url
    if (!serverEntry.url && serverEntry.serverUrl) {
      serverEntry.url = serverEntry.serverUrl;
      delete serverEntry.serverUrl;
    }
    normalized[name] = serverEntry as unknown as McpServerEntry;
  }

  return {
    mcpServers: normalized,
    settings: (obj.settings as McpConfig["settings"]) ?? undefined,
  };
}

/**
 * Get server prefix based on tool prefix mode.
 */
export function getServerPrefix(serverName: string, mode: "server" | "none" | "short"): string {
  if (mode === "none") return "";
  if (mode === "short") {
    let short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    if (!short) short = "mcp";
    return short;
  }
  return serverName.replace(/-/g, "_");
}

/**
 * Format a tool name with server prefix.
 */
export function formatToolName(toolName: string, serverName: string, prefix: "server" | "none" | "short"): string {
  const p = getServerPrefix(serverName, prefix);
  return p ? `${p}_${toolName}` : toolName;
}
