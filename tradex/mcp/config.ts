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

export function loadMcpConfig(configPath?: string | null): McpConfig {
  const paths = configPath
    ? [resolve(configPath)]
    : [resolve(process.cwd(), PROJECT_CONFIG_NAME)];

  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      return validateMcpConfig(raw);
    } catch (error) {
      console.warn(`[mcp] Failed to load config from ${filePath}:`, error instanceof Error ? error.message : error);
    }
  }

  return { mcpServers: {} };
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
