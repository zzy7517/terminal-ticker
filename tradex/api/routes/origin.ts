/** Origin REST routes: identity-free Runtime Sessions, never DM or Channel. */
import { Hono } from "hono";
import type { ImageContent } from "@earendil-works/pi-ai";
import { OriginMaterializationConflictError } from "../../origin/session-store.js";
import { deleteOriginSession, startOriginSession, stopOriginSession, streamOriginSession } from "../origin-session-runtime.js";
import type { AppRuntime } from "../runtime.js";

export function originRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  app.get("/api/origins", async (c) => c.json(await runtime.originSessions.history(runtime.lockedAgentSessions)));

  app.get("/api/origins/:id/run", (c) => {
    const sessionId = c.req.param("id");
    const run = runtime.originSessions.run(sessionId, runtime.lockedAgentSessions.has(sessionId));
    return run ? c.json({ run }) : c.json({ detail: "Origin not found" }, 404);
  });

  app.post("/api/origins/messages/stream", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const materializationId = stringValue(body.materializationId);
      if (!materializationId) return c.json({ detail: "materializationId is required" }, 400);
      const turn = decodeOriginTurn(body, "strict");
      if (!turn.message && turn.images.length === 0) {
        return c.json({ detail: "message or images is required" }, 400);
      }
      const config = recordValue(body.config);
      return await startOriginSession({
        runtime,
        requestUrl: c.req.url,
        materializationId,
        config,
        ...turn,
      });
    } catch (error) {
      if (error instanceof OriginMaterializationConflictError) {
        return c.json({ detail: error.message, sessionId: error.sessionId }, 409);
      }
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
    try {
      const result = await deleteOriginSession(runtime, sessionId);
      if (result === "running") return c.json({ detail: "cannot delete a running Origin" }, 409);
      if (result === "not_found") return c.json({ detail: "Origin not found" }, 404);
      return c.json({
        history: await runtime.originSessions.history(runtime.lockedAgentSessions),
        ...(result === "ok_cursor_native_retained" ? {
          deletion: {
            localState: "deleted",
            cursorNativeChat: "not_deleted",
            reason: "Cursor Agent CLI does not expose native chat deletion",
          },
        } : {}),
      });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 502);
    }
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
    let turn: OriginTurnInput;
    try {
      turn = decodeOriginTurn(body, "permissive");
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (!turn.message && turn.images.length === 0) {
      return c.json({ detail: "message or images is required" }, 400);
    }
    try {
      return await streamOriginSession({ runtime, requestUrl: c.req.url, sessionId, ...turn });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  return app;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface OriginTurnInput {
  message: string;
  images: ImageContent[];
  skillNames: string[];
}

function decodeOriginTurn(body: Record<string, unknown>, mode: "strict" | "permissive"): OriginTurnInput {
  if (mode === "strict" && body.message !== undefined && typeof body.message !== "string") {
    throw new Error("message must be a string");
  }
  const message = stringValue(body.message);
  const images = decodeImages(body.images, mode);
  const skillNames = decodeSkillNames(body.skillNames, mode);
  return { message, images, skillNames };
}

function decodeImages(value: unknown, mode: "strict" | "permissive"): ImageContent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    if (mode === "strict") throw new Error("images must contain base64 data and mimeType");
    return [];
  }
  const images = value.filter((item): item is { data: string; mimeType: string } => (
    !item
      ? false
      : typeof item === "object"
        && typeof (item as Record<string, unknown>).data === "string"
        && typeof (item as Record<string, unknown>).mimeType === "string"
  ));
  if (mode === "strict" && images.length !== value.length) {
    throw new Error("images must contain base64 data and mimeType");
  }
  return images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
}

function decodeSkillNames(value: unknown, mode: "strict" | "permissive"): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    if (mode === "strict") throw new Error("skillNames must be an array of strings");
    return [];
  }
  const names = value.filter((name): name is string => typeof name === "string");
  if (mode === "strict" && names.length !== value.length) {
    throw new Error("skillNames must be an array of strings");
  }
  return names;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config must be an object");
  }
  return value as Record<string, unknown>;
}
