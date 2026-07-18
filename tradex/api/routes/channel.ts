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

  app.patch("/api/channels/:id", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const visibility = body.visibility === "private" || body.visibility === "public"
        ? body.visibility
        : undefined;
      const channel = runtime.channelStore.updateChannel(c.req.param("id"), {
        name: typeof body.name === "string" ? body.name : undefined,
        topic: typeof body.topic === "string" ? body.topic : undefined,
        visibility,
      });
      return c.json({ channel, channels: runtime.channelStore.listChannels() });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Channel update failed";
      return c.json({ detail }, detail === "Channel not found" ? 404 : 400);
    }
  });

  app.delete("/api/channels/:id", (c) => {
    try {
      const channel = runtime.channelStore.archiveChannel(c.req.param("id"));
      return c.json({ channel, channels: runtime.channelStore.listChannels() });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Channel archive failed";
      return c.json({ detail }, detail === "Channel not found" ? 404 : 400);
    }
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

  app.patch("/api/channels/messages/:id", async (c) => {
    try {
      const message = runtime.channelStore.getMessage(c.req.param("id"));
      if (!message) return c.json({ detail: "Message not found" }, 404);
      const body = await c.req.json() as Record<string, unknown>;
      const updated = runtime.channelStore.editMessage({
        channelId: message.channelId,
        messageId: message.id,
        actorId: "owner",
        content: String(body.content ?? ""),
      });
      return c.json({ message: updated, channel: runtime.channelStore.getChannel(message.channelId) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Message edit failed" }, 400);
    }
  });

  app.delete("/api/channels/messages/:id", async (c) => {
    try {
      const message = runtime.channelStore.getMessage(c.req.param("id"));
      if (!message) return c.json({ detail: "Message not found" }, 404);
      const deleted = runtime.channelStore.deleteMessage({
        channelId: message.channelId,
        messageId: message.id,
        actorId: "owner",
      });
      return c.json({
        message: deleted,
        revisions: runtime.channelStore.listRevisions({ channelId: message.channelId, messageId: message.id }),
        channel: runtime.channelStore.getChannel(message.channelId),
      });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Message delete failed" }, 400);
    }
  });

  app.get("/api/channels/messages/:id/thread", (c) => {
    try {
      const message = runtime.channelStore.getMessage(c.req.param("id"));
      if (!message) return c.json({ detail: "Message not found" }, 404);
      return c.json(runtime.channelStore.listThread({ channelId: message.channelId, rootMessageId: message.id }));
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Thread fetch failed" }, 400);
    }
  });

  app.post("/api/channels/messages/:id/thread", async (c) => {
    try {
      const root = runtime.channelStore.getMessage(c.req.param("id"));
      if (!root) return c.json({ detail: "Message not found" }, 404);
      const body = await c.req.json() as Record<string, unknown>;
      const message = runtime.channelStore.appendMessage({
        channelId: root.channelId,
        authorId: "owner",
        content: String(body.content ?? ""),
        threadRootId: root.id,
      });
      return c.json({ message, thread: runtime.channelStore.listThread({ channelId: root.channelId, rootMessageId: root.id }) }, 201);
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Thread reply failed" }, 400);
    }
  });

  app.post("/api/channels/messages/:id/reactions", async (c) => {
    try {
      const message = runtime.channelStore.getMessage(c.req.param("id"));
      if (!message) return c.json({ detail: "Message not found" }, 404);
      const body = await c.req.json() as Record<string, unknown>;
      const updated = runtime.channelStore.addReaction({
        channelId: message.channelId,
        messageId: message.id,
        actorId: "owner",
        emoji: String(body.emoji ?? ""),
      });
      return c.json({ message: updated, channel: runtime.channelStore.getChannel(message.channelId) }, 201);
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Reaction add failed" }, 400);
    }
  });

  app.delete("/api/channels/messages/:id/reactions", async (c) => {
    try {
      const message = runtime.channelStore.getMessage(c.req.param("id"));
      if (!message) return c.json({ detail: "Message not found" }, 404);
      const body = await c.req.json() as Record<string, unknown>;
      const updated = runtime.channelStore.removeReaction({
        channelId: message.channelId,
        messageId: message.id,
        actorId: "owner",
        emoji: String(body.emoji ?? ""),
      });
      return c.json({ message: updated, channel: runtime.channelStore.getChannel(message.channelId) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Reaction remove failed" }, 400);
    }
  });

  return app;
}
