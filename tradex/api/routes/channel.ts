import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";

export function channelRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  app.get("/api/channels", (c) => c.json({ channels: runtime.channelStore.listChannels() }));

  app.post("/api/channels", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const channel = runtime.channelStore.createChannel({
        name: String(body.name ?? ""),
        topic: typeof body.topic === "string" ? body.topic : "",
        visibility: body.visibility === "private" ? "private" : "public",
      });
      return c.json({ channel, channels: runtime.channelStore.listChannels() }, 201);
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Channel create failed" }, 400);
    }
  });

  app.get("/api/channels/:id", (c) => {
    const channel = runtime.channelStore.getChannel(c.req.param("id"));
    return channel ? c.json({ channel }) : c.json({ detail: "Channel not found" }, 404);
  });

  app.get("/api/channels/:id/messages", (c) => {
    const channel = runtime.channelStore.getChannel(c.req.param("id"));
    if (!channel) return c.json({ detail: "Channel not found" }, 404);
    const beforeSeq = Number(c.req.query("before_seq"));
    const limit = Number(c.req.query("limit"));
    return c.json(runtime.channelStore.listMessages({
      channelId: channel.id,
      beforeSeq: Number.isFinite(beforeSeq) && beforeSeq > 0 ? beforeSeq : null,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    }));
  });

  app.post("/api/channels/:id/messages", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const message = runtime.channelStore.appendMessage({
        channelId: c.req.param("id"),
        authorId: "owner",
        content: String(body.content ?? ""),
        threadRootId: typeof body.threadRootId === "string" ? body.threadRootId : null,
      });
      return c.json({ message, channel: runtime.channelStore.getChannel(c.req.param("id")) }, 201);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Message send failed";
      return c.json({ detail }, detail === "Channel not found" ? 404 : 400);
    }
  });

  return app;
}
