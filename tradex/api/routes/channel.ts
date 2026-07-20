/**
 * Channel REST 路由（Human Owner）。
 *
 * 消息发送走 dispatch.appendChannelMessageAndNotify：
 * 权威 Channel 消息 + inbox fan-out + Coordinator 唤醒。
 */
import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";

/** 注册 /api/channels* Human Owner 路由。 */
export function channelRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // --- Channel CRUD ---------------------------------------------------------

  app.get("/api/channels", (c) => c.json({ channels: runtime.channelStore.listChannels() }));

  /** 创建公开/私有 Channel；不自动启动任何 Agent。 */
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

  /** 归档 Channel（软删除）。 */
  app.delete("/api/channels/:id", (c) => {
    try {
      const channel = runtime.channelStore.archiveChannel(c.req.param("id"));
      return c.json({ channel, channels: runtime.channelStore.listChannels() });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Channel archive failed";
      return c.json({ detail }, detail === "Channel not found" ? 404 : 400);
    }
  });

  // --- 消息 ----------------------------------------------------------------

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

  /** Human 发 Channel 消息：重置因果链，并为成员写入 inbox 后唤醒。 */
  app.post("/api/channels/:id/messages", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const channelId = c.req.param("id");
      const { appendChannelMessageAndNotify } = await import("../../chat/dispatch.js");
      const { message } = appendChannelMessageAndNotify(runtime, {
        channelId,
        authorType: "human",
        authorId: "owner",
        content: String(body.content ?? ""),
      });
      return c.json({ message, channel: runtime.channelStore.getChannel(channelId) }, 201);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Message send failed";
      return c.json({ detail }, detail === "Channel not found" ? 404 : 400);
    }
  });

  // --- 成员 / held draft ----------------------------------------------------

  app.get("/api/channels/:id/members", (c) => {
    const channel = runtime.channelStore.getChannel(c.req.param("id"));
    if (!channel) return c.json({ detail: "Channel not found" }, 404);
    return c.json({ members: runtime.channelStore.listMembers(channel.id) });
  });

  /** Human 添加成员。 */
  app.post("/api/channels/:id/members", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const member = runtime.channelStore.addMember({
        channelId: c.req.param("id"),
        subjectType: body.subjectType === "human" ? "human" : "agent",
        subjectId: String(body.subjectId ?? ""),
      });
      return c.json({ member, members: runtime.channelStore.listMembers(c.req.param("id")) }, 201);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Membership update failed";
      return c.json({ detail }, detail === "Channel not found" ? 404 : 400);
    }
  });

  app.delete("/api/channels/:id/members", async (c) => {
    try {
      const channelId = c.req.param("id");
      const body = await c.req.json() as Record<string, unknown>;
      const subjectType = body.subjectType === "human" ? "human" as const : "agent" as const;
      const subjectId = String(body.subjectId ?? "");
      runtime.channelStore.removeMember({
        channelId,
        subjectType,
        subjectId,
      });
      if (subjectType === "agent" && subjectId) {
        runtime.inboxStore.cancelForTarget(subjectId, { kind: "channel", channelId });
        await runtime.agentCoordinator?.abort(subjectId);
      }
      return c.json({ members: runtime.channelStore.listMembers(channelId) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Membership remove failed" }, 400);
    }
  });

  /** 列出 held draft。未满 5 分钟不向 Human 返回正文（仅 Agent trace 可见）。 */
  app.get("/api/channels/:id/drafts", (c) => {
    const channel = runtime.channelStore.getChannel(c.req.param("id"));
    if (!channel) return c.json({ detail: "Channel not found" }, 404);
    const graceMs = 5 * 60_000;
    const now = Date.now();
    const drafts = runtime.channelStore.listHeldDrafts(channel.id).map((draft) => {
      const visible = now - draft.createdAtMs >= graceMs;
      return {
        ...draft,
        content: visible ? draft.content : null,
        contentVisible: visible,
      };
    });
    return c.json({ drafts });
  });

  /**
   * Human Owner 在 draft 持有超过 5 分钟后可 discard；不能代 Agent 发布。
   */
  app.post("/api/channels/:id/drafts/:draftId/discard", (c) => {
    const channel = runtime.channelStore.getChannel(c.req.param("id"));
    if (!channel) return c.json({ detail: "Channel not found" }, 404);
    try {
      const draft = runtime.channelStore.humanDiscardHeldDraft({
        draftId: c.req.param("draftId"),
      });
      if (draft.channelId !== channel.id) {
        return c.json({ detail: "Held draft not found" }, 404);
      }
      return c.json({ draft });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Discard failed";
      const status = detail.includes("5-minute") ? 409 : detail.includes("not found") ? 404 : 400;
      return c.json({ detail }, status);
    }
  });

  // --- 消息编辑 / 删除 / reaction -------------------------------------------

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
