/** Origin REST routes: identity-free Runtime Sessions, never DM or Channel. */
import { Hono } from "hono";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createOriginSession, deleteOriginSession, stopOriginSession, streamOriginSession } from "../origin-session-runtime.js";
import type { AppRuntime } from "../runtime.js";

export function originRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  app.get("/api/origins", async (c) => c.json(await runtime.originSessions.history(runtime.lockedAgentSessions)));

  app.post("/api/origins", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      return c.json(await createOriginSession(runtime, body), 201);
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/api/origins/:id", async (c) => {
    const sessionId = c.req.param("id");
    const payload = await runtime.originSessions.response(
      sessionId,
      runtime.lockedAgentSessions.has(sessionId),
    );
    if (!payload.session) return c.json({ detail: "Origin not found" }, 404);
    return c.json(payload);
  });

  app.delete("/api/origins/:id", async (c) => {
    const sessionId = c.req.param("id");
    const result = await deleteOriginSession(runtime, sessionId);
    if (result === "running") return c.json({ detail: "cannot delete a running Origin" }, 409);
    if (result === "not_found") return c.json({ detail: "Origin not found" }, 404);
    return c.json({ history: await runtime.originSessions.history(runtime.lockedAgentSessions) });
  });

  app.post("/api/origins/:id/stop", async (c) => {
    const id = c.req.param("id");
    const result = await stopOriginSession(runtime, id);
    if (result === "not_found") return c.json({ detail: "Origin not found" }, 404);
    if (result === "not_running") return c.json({ detail: "Origin is not running" }, 409);
    return c.json({ ok: true }, 202);
  });

  app.post("/api/origins/:id/messages/stream", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const message = stringValue(body.message);
    const requestImages = parseImages(body.images);
    const skillNames = parseSkillNames(body.skillNames);
    if (!message && requestImages.length === 0) {
      return c.json({ detail: "message or images is required" }, 400);
    }
    return streamOriginSession({ runtime, requestUrl: c.req.url, sessionId, message, images: requestImages, skillNames });
  });

  return app;
}

function parseSkillNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseImages(value: unknown): ImageContent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { data: string; mimeType: string } => (
    !!item
    && typeof item === "object"
    && typeof (item as Record<string, unknown>).data === "string"
    && typeof (item as Record<string, unknown>).mimeType === "string"
  )).map((item) => ({ type: "image" as const, data: item.data, mimeType: item.mimeType }));
}
