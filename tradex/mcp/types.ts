/**
 * MCP Client types for tradex.
 */

/** Server entry in .mcp.json config */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Lifecycle: lazy (default) | eager */
  lifecycle?: "lazy" | "eager";
  /** Idle timeout in minutes before disconnecting (default: 10, 0 to disable) */
  idleTimeout?: number;
  /** Register tools directly into ToolRegistry instead of behind proxy */
  directTools?: boolean | string[];
}

/** Root MCP config shape (.mcp.json) */
export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
  settings?: McpSettings;
}

/** Global MCP settings */
export interface McpSettings {
  /** Tool name prefix mode: "server" (default) | "none" | "short" */
  toolPrefix?: "server" | "none" | "short";
  /** Idle timeout in minutes (default: 10, 0 to disable) */
  idleTimeout?: number;
  /** Register all tools directly (overrides per-server) */
  directTools?: boolean;
}

/** Parsed MCP config for AppConfig */
export interface McpAppConfig {
  enabled: boolean;
  configPath: string | null;
}

/** Tool metadata cached from MCP server */
export interface McpToolMeta {
  name: string;
  originalName: string;
  serverName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Connection status for a server */
export type McpServerStatus = "idle" | "connecting" | "connected" | "failed";
