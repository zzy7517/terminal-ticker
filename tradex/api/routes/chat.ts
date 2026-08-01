/**
 * Chat HTTP 路由：bootstrap 快照、未读游标、SSE 事件。
 * Channel CRUD 在 routes/channel.ts；Agent DM timeline 在 routes/agent.ts。
 */
import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";
import { channelTarget, directMessageTarget, parseChatTarget } from "../../chat/target.js";

const EVENT_POLL_MS = 750;

/** 用 UnreadStore 游标 + message seq 投影 Human Owner 未读数。 */
function humanUnreadProjection(runtime: AppRuntime): Array<{
  target: ReturnType<typeof parseChatTarget>;
  unreadCount: number;
  lastReadSeq: number;
}> {
  const viewer = { type: "human" as const, id: "owner" };
  const unread: Array<{ target: ReturnType<typeof parseChatTarget>; unreadCount: number; lastReadSeq: number }> = [];
  for (const channel of runtime.channelStore.listChannels()) {
    const target = channelTarget(channel.id);
    const cursor = runtime.unreadStore.getCursor(viewer, target);
    const unreadCount = runtime.channelStore.countMessagesAfterSeq(channel.id, cursor.lastReadSeq);
    if (unreadCount > 0) unread.push({ target, unreadCount, lastReadSeq: cursor.lastReadSeq });
  }
  for (const agent of runtime.agentStore.list()) {
    const conversation = runtime.messageStore.ensureHumanAgentDm(agent.id);
    const target = directMessageTarget(conversation.id);
    const cursor = runtime.unreadStore.getCursor(viewer, target);
    const unreadCount = runtime.messageStore.countMessagesAfterSeq(conversation.id, cursor.lastReadSeq);
    if (unreadCount > 0) unread.push({ target, unreadCount, lastReadSeq: cursor.lastReadSeq });
  }
  return unread;
}

/** 注册 Chat bootstrap / 未读 / SSE 路由。 */
export function chatEventRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  /** Chat 工作区启动快照；先抓 lastEventSeq，避免并发写入被永久漏掉。 */
  app.get("/api/chat/bootstrap", (c) => {
    // Capture the cursor first. Mutations racing with the projection reads are
    // then replayed after this sequence instead of being skipped forever.
    const lastEventSeq = runtime.chatEventStore.latestSeq();
    return c.json({
      channels: runtime.channelStore.listChannels(),
      unread: humanUnreadProjection(runtime),
      lastEventSeq,
    });
  });

  /** Human 推进 target-local 已读游标，并返回最新未读投影。 */
  app.post("/api/chat/unread/read", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const target = parseChatTarget(body.target);
      const seq = Number(body.seq);
      const messageId = typeof body.messageId === "string" ? body.messageId : null;
      if (!Number.isFinite(seq) || seq < 0) throw new Error("seq is required");
      runtime.unreadStore.markRead({
        viewer: { type: "human", id: "owner" },
        target,
        messageId,
        seq,
      });
      return c.json({ unread: humanUnreadProjection(runtime) });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Unread update failed" }, 400);
    }
  });

  app.get("/api/chat/events", (c) => {
    const querySeq = Number(c.req.query("after_seq"));
    const headerSeq = Number(c.req.header("last-event-id"));
    let cursor = Number.isFinite(headerSeq) && headerSeq >= 0
      ? Math.floor(headerSeq)
      : Number.isFinite(querySeq) && querySeq >= 0 ? Math.floor(querySeq) : 0;
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const pump = () => {
          if (closed) return;
          const { events } = runtime.chatEventStore.list({ afterSeq: cursor, limit: 100 });
          for (const event of events) {
            cursor = event.seq;
            controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: chat\ndata: ${JSON.stringify(event)}\n\n`));
          }
        };
        pump();
        timer = setInterval(pump, EVENT_POLL_MS);
      },
      cancel() {
        closed = true;
        if (timer) clearInterval(timer);
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      },
    });
  });

  return app;
}
