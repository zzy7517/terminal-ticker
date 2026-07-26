/**
 * Jin10 MCP client.
 *
 * Jin10 ships its data as a hosted MCP server, so MCP stays on the wire — but the
 * connection is owned here rather than borrowed from the shared McpClientManager.
 * That keeps Jin10 configured like any other data source (`[jin10]` in the TOML)
 * instead of as an entry in `.mcp.json`, and decouples it from `[mcp] enabled`.
 *
 * Retains the failure-backoff behaviour of McpClientManager: a failed connect puts
 * the client in cooldown so the 30s quote poller cannot hammer a rate-limited or
 * down server (and spam the log) on every tick.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpResourceReadResult } from "../mcp/types.js";
import { DEFAULT_JIN10_URL } from "./types.js";

interface Connection {
  client: Client;
  transport: Transport;
}

export class Jin10Client {
  private readonly url: string;
  private readonly token: string;

  private connection: Connection | null = null;
  /** In-flight connect, so concurrent quote fetches share one handshake. */
  private connectPromise: Promise<Connection> | null = null;
  /** Epoch ms until which connect attempts are skipped after a failure. */
  private cooldownUntilMs = 0;

  /** Backoff window after a failed connection (ms). Mirrors McpClientManager. */
  private static readonly FAILURE_COOLDOWN_MS = 5 * 60_000;

  constructor(input: { url?: string; token: string }) {
    this.url = input.url?.trim() || DEFAULT_JIN10_URL;
    this.token = input.token;
  }

  /** Whether a live connection is currently held. */
  get connected(): boolean {
    return this.connection !== null;
  }

  /**
   * Call a Jin10 MCP tool and return its text content.
   *
   * Throws on transport failure, cooldown, or a tool-reported error.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const conn = await this.connect();
    const result = await conn.client.callTool({ name, arguments: args });

    const textParts = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);

    if (result.isError) {
      throw new Error(textParts.join("\n") || `Jin10 tool "${name}" returned an error`);
    }

    return textParts.join("\n") || JSON.stringify(result.content);
  }

  /** Read a Jin10 MCP resource (e.g. `quote://codes`). */
  async readResource(uri: string): Promise<McpResourceReadResult> {
    const conn = await this.connect();
    return conn.client.readResource({ uri });
  }

  /** Close the connection, if any. Safe to call when disconnected. */
  async close(): Promise<void> {
    const conn = this.connection;
    this.connection = null;
    if (!conn) return;
    await conn.client.close().catch(() => {});
    await conn.transport.close().catch(() => {});
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async connect(): Promise<Connection> {
    if (this.connection) return this.connection;
    if (this.connectPromise) return this.connectPromise;

    if (Date.now() < this.cooldownUntilMs) {
      throw new Error(
        `Jin10 is in failure cooldown until ${new Date(this.cooldownUntilMs).toISOString()}`,
      );
    }

    const promise = this.createConnection();
    this.connectPromise = promise;

    try {
      const conn = await promise;
      this.connection = conn;
      this.cooldownUntilMs = 0;
      return conn;
    } catch (error) {
      this.cooldownUntilMs = Date.now() + Jin10Client.FAILURE_COOLDOWN_MS;
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  private async createConnection(): Promise<Connection> {
    const client = new Client({ name: "tradex-jin10", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
      },
    });

    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      console.warn(
        `[jin10] Failed to connect (cooling down ${Math.round(Jin10Client.FAILURE_COOLDOWN_MS / 60_000)}m before retry):`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    }

    // Drop the cached connection when the server or transport hangs up, so the
    // next poll reconnects instead of calling into a dead socket.
    const conn: Connection = { client, transport };
    client.onclose = () => {
      if (this.connection === conn) this.connection = null;
    };

    console.log(`[jin10] Connected to ${this.url}`);
    return conn;
  }
}
