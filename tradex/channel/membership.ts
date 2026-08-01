/**
 * Channel membership — 成员表读写，由 ChannelStore 委托。
 */
import type Database from "better-sqlite3";
import { appendChatEvent } from "../chat/events.js";
import { nowMs } from "../db.js";
import { channelTarget } from "../chat/target.js";
import type { Channel } from "./domain.js";

export type ChannelMember = {
  subjectType: string;
  subjectId: string;
  joinedAtMs: number;
};

export function addMember(
  conn: Database.Database,
  input: {
    channelId: string;
    subjectType: "human" | "agent";
    subjectId: string;
  },
  getChannel: (channelId: string) => Channel | null,
): { channelId: string; subjectType: string; subjectId: string } {
  return conn.transaction(() => {
    const channel = getChannel(input.channelId);
    if (!channel || channel.archivedAtMs !== null) throw new Error("Channel not found");
    conn.prepare(`
      INSERT OR REPLACE INTO channel_memberships (channel_id, subject_type, subject_id, joined_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(input.channelId, input.subjectType, input.subjectId, nowMs());
    appendChatEvent(conn, {
      type: "membership.added",
      actorType: "human",
      actorId: "owner",
      target: channelTarget(input.channelId),
      entityType: "membership",
      entityId: `${input.subjectType}:${input.subjectId}`,
    });
    return {
      channelId: input.channelId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
    };
  })();
}

export function removeMember(
  conn: Database.Database,
  input: { channelId: string; subjectType: "human" | "agent"; subjectId: string },
): void {
  conn.transaction(() => {
    conn.prepare(`
      DELETE FROM channel_memberships
      WHERE channel_id = ? AND subject_type = ? AND subject_id = ?
    `).run(input.channelId, input.subjectType, input.subjectId);
    appendChatEvent(conn, {
      type: "membership.removed",
      actorType: "human",
      actorId: "owner",
      target: channelTarget(input.channelId),
      entityType: "membership",
      entityId: `${input.subjectType}:${input.subjectId}`,
    });
  })();
}

export function listMembers(conn: Database.Database, channelId: string): ChannelMember[] {
  const rows = conn.prepare(`
    SELECT subject_type, subject_id, joined_at_ms
    FROM channel_memberships WHERE channel_id = ?
    ORDER BY joined_at_ms
  `).all(channelId) as Array<{ subject_type: string; subject_id: string; joined_at_ms: number }>;
  return rows.map((row) => ({
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    joinedAtMs: row.joined_at_ms,
  }));
}

export function listAgentMemberIds(conn: Database.Database, channelId: string): string[] {
  return listMembers(conn, channelId)
    .filter((member) => member.subjectType === "agent")
    .map((member) => member.subjectId);
}
