import { Hono } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeToolReturn } from "../../agent/tools/registry.js";
import type { McpRunGrant } from "./grants.js";
import { McpRunGrantStore } from "./grants.js";

export function tradexMcpRoutes(grants: McpRunGrantStore): Hono {
  const app = new Hono();
  app.all("/mcp/tradex", async (c) => {
    const grant = grants.resolve(bearerToken(c.req.header("authorization")));
    if (!grant) return c.json({ error: "invalid or expired MCP run grant" }, 401);

    const server = createServer(grant);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
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
