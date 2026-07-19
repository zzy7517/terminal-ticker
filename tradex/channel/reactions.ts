/**
 * Channel reactions — 表情回应读写，由 ChannelStore 委托。
 */
import type Database from "better-sqlite3";
import { appendChatEvent } from "../chat/events.js";
import { nowMs } from "../db.js";
import { channelTarget, type ChannelMessage } from "./domain.js";

export function normalizeEmoji(value: string): string {
  const emoji = value.trim();
  if (!emoji || emoji.length > 32) throw new Error("emoji is required");
  return emoji;
}

export function addReaction(
  conn: Database.Database,
  input: {
    channelId: string;
    messageId: string;
    actorId: string;
    emoji: string;
    actorType?: "human" | "agent";
  },
  deps: {
    requireMessage: (channelId: string, messageId: string) => ChannelMessage;
    bumpChannelVersion: (channelId: string) => void;
  },
): ChannelMessage {
  const emoji = normalizeEmoji(input.emoji);
  const actorType = input.actorType ?? "human";
  return conn.transaction(() => {
    deps.requireMessage(input.channelId, input.messageId);
    const result = conn.prepare(`
      INSERT OR IGNORE INTO channel_reactions (message_id, actor_type, actor_id, emoji, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.messageId, actorType, input.actorId, emoji, nowMs());
    if (result.changes > 0) {
      deps.bumpChannelVersion(input.channelId);
      appendChatEvent(conn, {
        type: "reaction.added",
        actorType,
        actorId: input.actorId,
        target: channelTarget(input.channelId),
        entityType: "message",
        entityId: input.messageId,
        payload: { emoji },
      });
    }
    return deps.requireMessage(input.channelId, input.messageId);
  })();
}

export function removeReaction(
  conn: Database.Database,
  input: {
    channelId: string;
    messageId: string;
    actorId: string;
    emoji: string;
    actorType?: "human" | "agent";
  },
  deps: {
    requireMessage: (channelId: string, messageId: string) => ChannelMessage;
    bumpChannelVersion: (channelId: string) => void;
  },
): ChannelMessage {
  const emoji = normalizeEmoji(input.emoji);
  const actorType = input.actorType ?? "human";
  return conn.transaction(() => {
    deps.requireMessage(input.channelId, input.messageId);
    const result = conn.prepare(`
      DELETE FROM channel_reactions
      WHERE message_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?
    `).run(input.messageId, actorType, input.actorId, emoji);
    if (result.changes > 0) {
      deps.bumpChannelVersion(input.channelId);
      appendChatEvent(conn, {
        type: "reaction.removed",
        actorType,
        actorId: input.actorId,
        target: channelTarget(input.channelId),
        entityType: "message",
        entityId: input.messageId,
        payload: { emoji },
      });
    }
    return deps.requireMessage(input.channelId, input.messageId);
  })();
}
