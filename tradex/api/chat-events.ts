import { Hono, type Context } from "hono";
import type { AppRuntime } from "./runtime.js";
import { parseChatTarget } from "../channel/domain.js";
import { sessionResponse } from "./helpers.js";

const EVENT_POLL_MS = 750;

export function chatEventRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  app.get("/api/chat/bootstrap", (c) => {
    // Capture the cursor first. Mutations racing with the projection reads are
    // then replayed after this sequence instead of being skipped forever.
    const lastEventSeq = runtime.chatEventStore.latestSeq();
    return c.json({
      channels: runtime.channelStore.listChannels(),
      saved: runtime.chatReferences.listSaved("owner"),
      pinned: runtime.chatReferences.listPinned(),
      lastEventSeq,
    });
  });

  app.post("/api/chat/saved", async (c) => mutateReference(c, "save"));
  app.delete("/api/chat/saved", async (c) => mutateReference(c, "unsave"));
  app.post("/api/chat/pins", async (c) => mutateReference(c, "pin"));
  app.delete("/api/chat/pins", async (c) => mutateReference(c, "unpin"));

  async function mutateReference(c: Context, action: "save" | "unsave" | "pin" | "unpin") {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const target = parseChatTarget(body.target);
      const messageId = String(body.messageId ?? "");
      if ((action === "save" || action === "pin") && target.kind === "direct-message") {
        const message = runtime.messageStore.getMessage(messageId);
        if (!message || message.directMessageId !== target.directMessageId) {
          // Allow legacy sessionId:messageId while Shared Message import catches up.
          await requireLegacyDirectMessage(runtime, messageId);
        }
      }
      const input = {
        actorId: "owner",
        target,
        messageId,
      };
      runtime.chatReferences[action](input);
      return c.json({
        saved: runtime.chatReferences.listSaved("owner"),
        pinned: runtime.chatReferences.listPinned(),
      });
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Chat reference update failed" }, 400);
    }
  }

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

async function requireLegacyDirectMessage(runtime: AppRuntime, referenceId: string): Promise<void> {
  const separator = referenceId.lastIndexOf(":");
  if (separator <= 0 || separator === referenceId.length - 1) throw new Error("Invalid Direct Message reference");
  const sessionId = referenceId.slice(0, separator);
  const messageId = referenceId.slice(separator + 1);
  const payload = await sessionResponse(runtime, sessionId);
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!messages.some((message) => (
    message && typeof message === "object" && String((message as Record<string, unknown>).id) === messageId
  ))) {
    throw new Error("Message not found for ChatTarget");
  }
}
