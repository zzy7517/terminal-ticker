import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeToolReturn } from "../../agent/tools/registry.js";
import type { McpRunGrant } from "./grants.js";
import { McpRunGrantStore } from "./grants.js";

export interface TradexMcpRouteOptions {
  remoteAddress?: (context: Parameters<typeof getConnInfo>[0]) => string | undefined;
}

export function tradexMcpRoutes(grants: McpRunGrantStore, options: TradexMcpRouteOptions = {}): Hono {
  const app = new Hono();
  app.all("/mcp/tradex", async (c) => {
    // loopback 限制负责缩小暴露面，token 鉴权仍然保留，不能把二者互相替代。
    const remoteAddress = options.remoteAddress?.(c) ?? getConnInfo(c).remote.address;
    if (!isLoopbackAddress(remoteAddress)) return c.json({ error: "Tradex MCP only accepts loopback connections" }, 403);
    const grant = grants.resolve(bearerToken(c.req.header("authorization")));
    if (!grant) return c.json({ error: "invalid or expired MCP run grant" }, 401);

    const server = createServer(grant);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "127.0.0.1"
    || normalized.startsWith("127.")
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}

function createServer(grant: McpRunGrant): Server {
  const server = new Server(
    { name: "tradex", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const byName = new Map(grant.tools.map((tool) => [tool.name, tool]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: grant.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as { type: "object"; properties?: Record<string, unknown>; required?: string[] },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // tools/list 只是展示；tools/call 必须再次按当前 grant 校验，不能信任客户端缓存。
    const tool = byName.get(request.params.name);
    if (!tool) return { content: [{ type: "text", text: "Tool is not authorized for this run" }], isError: true };
    try {
      const raw = await tool.execute(
        (request.params.arguments ?? {}) as Record<string, unknown>,
        extra.signal,
      );
      const normalized = normalizeToolReturn(raw);
      return {
        content: normalized.content.map((block) => block.type === "image"
          ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
          : { type: "text" as const, text: block.text }),
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
  return server;
}

function bearerToken(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}
