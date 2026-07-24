/** Loopback CLI gateway for Pi, Claude Code, and Cursor Agent shell calls. */
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { normalizeToolReturn } from "../../agent/tools/registry.js";
import type { CliRunGrantStore } from "../../agent/runtime/cli-tools.js";

export interface TradexCliRouteOptions {
  remoteAddress?: (context: Parameters<typeof getConnInfo>[0]) => string | undefined;
}

export function tradexCliRoutes(grants: CliRunGrantStore, options: TradexCliRouteOptions = {}): Hono {
  const app = new Hono();
  app.use("/cli/tradex/*", async (c, next) => {
    const remoteAddress = options.remoteAddress?.(c) ?? getConnInfo(c).remote.address;
    if (!isLoopbackAddress(remoteAddress)) return c.json({ error: "Tradex CLI only accepts loopback connections" }, 403);
    await next();
  });

  app.get("/cli/tradex/manifest", (c) => {
    const grant = grants.resolve(bearerToken(c.req.header("authorization")));
    if (!grant) return c.json({ error: "invalid or expired Tradex CLI run grant" }, 401);
    return c.json({
      sessionId: grant.tradexSessionId,
      tools: grant.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    });
  });

  app.post("/cli/tradex/invoke", async (c) => {
    const grant = grants.resolve(bearerToken(c.req.header("authorization")));
    if (!grant) return c.json({ error: "invalid or expired Tradex CLI run grant" }, 401);
    const body = await c.req.json().catch(() => null) as { name?: unknown; args?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name : "";
    const tool = grant.tools.find((candidate) => candidate.name === name);
    if (!tool) return c.json({ error: "Tool is not authorized for this run", name }, 403);
    const args = body?.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? body.args as Record<string, unknown>
      : {};
    try {
      const normalized = normalizeToolReturn(await tool.execute(args, c.req.raw.signal));
      return c.json({ content: normalized.content, ...(normalized.details === undefined ? {} : { details: normalized.details }), ...(normalized.terminate ? { terminate: true } : {}) });
    } catch (error) {
      return c.json({
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }, 500);
    }
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

function bearerToken(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}
