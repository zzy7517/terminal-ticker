/**
 * Channel held drafts — 版本冲突时暂存回复的 SQLite 实现。
 * ChannelStore 委托到此模块；发布仍经 appendAgentMessage 回调回到 Store。
 */
import type Database from "better-sqlite3";
import crypto from "node:crypto";
import { appendChatEvent } from "../chat/events.js";
import { nowMs } from "../db.js";
import { channelTarget } from "../chat/target.js";
import {
  type Channel,
  type ChannelMessage,
  type HeldDraft,
  type HeldDraftStatus,
} from "./domain.js";

export type { HeldDraft } from "./domain.js";

/** 当 Agent 的 observedVersion 落后于 channel.version 时暂存回复。 */
export function createHeldDraft(
  conn: Database.Database,
  input: {
    agentId: string;
    channelId: string;
    observedVersion: number;
    content: string;
  },
): HeldDraft {
  return conn.transaction(() => {
    const id = crypto.randomUUID();
    const createdAtMs = nowMs();
    conn.prepare(`
      INSERT INTO channel_drafts (
        id, agent_id, channel_id, observed_version, content, status, created_at_ms, resolved_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'held', ?, NULL)
    `).run(id, input.agentId, input.channelId, input.observedVersion, input.content, createdAtMs);
    appendChatEvent(conn, {
      type: "draft.held",
      actorType: "agent",
      actorId: input.agentId,
      target: channelTarget(input.channelId),
      entityType: "draft",
      entityId: id,
    });
    return {
      id,
      agentId: input.agentId,
      channelId: input.channelId,
      observedVersion: input.observedVersion,
      content: input.content,
      status: "held" as const,
      createdAtMs,
    };
  })();
}

/**
 * 解决 held draft。retry/replace 经 appendAgentMessage 发布；
 * 调用方发布后还需 dispatchSharedMessage 做 inbox fan-out。
 */
export function resolveHeldDraft(
  conn: Database.Database,
  input: {
    agentId: string;
    draftId: string;
    action: "retry" | "replace" | "discard";
    content?: string;
  },
  deps: {
    getChannel: (channelId: string) => Channel | null;
    appendAgentMessage: (input: {
      channelId: string;
      authorId: string;
      content: string;
    }) => ChannelMessage;
  },
): {
  draft: Omit<HeldDraft, "createdAtMs">;
  publishedMessage: ChannelMessage | null;
} {
  return conn.transaction(() => {
    const row = conn.prepare("SELECT * FROM channel_drafts WHERE id = ?").get(input.draftId) as {
      id: string;
      agent_id: string;
      channel_id: string;
      observed_version: number;
      content: string;
      status: string;
    } | undefined;
    if (!row || row.agent_id !== input.agentId) throw new Error("Held draft not found");
    if (row.status !== "held") throw new Error("draft already resolved");
    if (input.action === "discard") {
      conn.prepare(`
        UPDATE channel_drafts SET status = 'discarded', resolved_at_ms = ? WHERE id = ?
      `).run(nowMs(), input.draftId);
      return {
        draft: {
          id: row.id,
          agentId: row.agent_id,
          channelId: row.channel_id,
          observedVersion: row.observed_version,
          content: row.content,
          status: "discarded" as const,
        },
        publishedMessage: null,
      };
    }
    const content = input.action === "replace" ? String(input.content ?? "").trim() : row.content;
    if (!content) throw new Error("content is required");
    const channel = deps.getChannel(row.channel_id);
    if (!channel) throw new Error("Channel not found");
    // retry：要求 Agent 已通过 message_read 把 observed_version 推进到当前 version。
    // replace：允许用新正文发布，但仍要求已读到当前 version，避免静默基于更旧快照再发。
    if (row.observed_version < channel.version) {
      throw new Error("channel changed again; read latest messages before retry");
    }
    const publishedMessage = deps.appendAgentMessage({
      channelId: row.channel_id,
      authorId: input.agentId,
      content,
    });
    conn.prepare(`
      UPDATE channel_drafts SET status = 'published', content = ?, resolved_at_ms = ? WHERE id = ?
    `).run(content, nowMs(), input.draftId);
    return {
      draft: {
        id: row.id,
        agentId: row.agent_id,
        channelId: row.channel_id,
        observedVersion: row.observed_version,
        content,
        status: "published" as const,
      },
      publishedMessage,
    };
  })();
}

/** 列出某 Channel 上仍为 held 的草稿。 */
export function listHeldDrafts(conn: Database.Database, channelId: string): HeldDraft[] {
  const rows = conn.prepare(`
    SELECT id, agent_id, channel_id, observed_version, content, status, created_at_ms
    FROM channel_drafts
    WHERE channel_id = ? AND status = 'held'
    ORDER BY created_at_ms DESC
  `).all(channelId) as Array<{
    id: string;
    agent_id: string;
    channel_id: string;
    observed_version: number;
    content: string;
    status: string;
    created_at_ms: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    observedVersion: row.observed_version,
    content: row.content,
    status: row.status as HeldDraftStatus,
    createdAtMs: row.created_at_ms,
  }));
}

/**
 * Agent 读取 Channel 后，把其 held draft 的 observed_version 推进到 reviewedVersion。
 * 这样后续 retry/replace 在房间未再变化时可发布。
 */
export function markHeldDraftsReviewed(
  conn: Database.Database,
  input: {
    agentId: string;
    channelId: string;
    reviewedVersion: number;
  },
): number {
  const result = conn.prepare(`
    UPDATE channel_drafts
    SET observed_version = ?
    WHERE agent_id = ? AND channel_id = ? AND status = 'held'
      AND observed_version < ?
  `).run(
    input.reviewedVersion,
    input.agentId,
    input.channelId,
    input.reviewedVersion,
  );
  return Number(result.changes) || 0;
}

/**
 * Human Owner 在 draft 持有超过 graceMs 后可 discard；不能代 Agent 发布。
 */
export function humanDiscardHeldDraft(
  conn: Database.Database,
  input: {
    draftId: string;
    graceMs?: number;
    now?: number;
  },
): { id: string; agentId: string; channelId: string; status: HeldDraftStatus; createdAtMs: number } {
  const graceMs = input.graceMs ?? 5 * 60_000;
  const now = input.now ?? nowMs();
  return conn.transaction(() => {
    const row = conn.prepare("SELECT * FROM channel_drafts WHERE id = ?").get(input.draftId) as {
      id: string;
      agent_id: string;
      channel_id: string;
      status: string;
      created_at_ms: number;
    } | undefined;
    if (!row) throw new Error("Held draft not found");
    if (row.status !== "held") throw new Error("draft already resolved");
    if (now - row.created_at_ms < graceMs) {
      throw new Error("held draft is still within the 5-minute Agent-only window");
    }
    conn.prepare(`
      UPDATE channel_drafts SET status = 'discarded', resolved_at_ms = ? WHERE id = ?
    `).run(now, input.draftId);
    appendChatEvent(conn, {
      type: "draft.discarded",
      actorType: "human",
      actorId: "owner",
      target: channelTarget(row.channel_id),
      entityType: "draft",
      entityId: row.id,
    });
    return {
      id: row.id,
      agentId: row.agent_id,
      channelId: row.channel_id,
      status: "discarded" as const,
      createdAtMs: row.created_at_ms,
    };
  })();
}
