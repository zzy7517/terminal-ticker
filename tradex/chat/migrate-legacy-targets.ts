/**
 * 将遗留 Phase 1 `direct-chat` 行改写为真实 `direct-message` ChatTarget。
 * 不得伪造 `legacy:agentId:chatId` 作为 directMessageId。
 * 同时丢弃已退役的 `chat_saved` / `chat_pins` 表。
 */
import type Database from "better-sqlite3";
import { chatTargetRef, directMessageTarget } from "./target.js";

const TABLES: Array<{ table: string }> = [
  { table: "agent_inbox" },
  { table: "chat_unread_cursors" },
  { table: "chat_events" },
];

/**
 * 扫描共用 chat.sqlite3，把 direct-chat [agentId, chatId] 改写为
 * direct-message [realDmId]。resolveDmId(agentId) 必须返回 MessageStore 中的真实 DM。
 */
export function migrateLegacyDirectChatTargets(
  conn: Database.Database,
  resolveDmId: (agentId: string) => string,
): number {
  conn.exec(`
    DROP TABLE IF EXISTS chat_saved;
    DROP TABLE IF EXISTS chat_pins;
  `);

  let rewritten = 0;
  for (const { table } of TABLES) {
    const exists = conn.prepare(`
      SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table) as { ok: number } | undefined;
    if (!exists) continue;

    // Alias rowid explicitly: INTEGER PRIMARY KEY tables (e.g. chat_events.seq)
    // cause better-sqlite3 to name the column after the PK, not "rowid".
    const rows = conn.prepare(`
      SELECT rowid AS _rowid, target_ref AS target_ref
      FROM ${table}
      WHERE target_kind = 'direct-chat'
    `).all() as Array<{ _rowid: number; target_ref: string }>;

    for (const row of rows) {
      let values: unknown;
      try {
        values = JSON.parse(row.target_ref);
      } catch {
        continue;
      }
      if (!Array.isArray(values) || values.length !== 2 || typeof values[0] !== "string") continue;
      const agentId = values[0];
      const dmId = resolveDmId(agentId);
      const nextRef = chatTargetRef(directMessageTarget(dmId));
      const result = conn.prepare(`
        UPDATE ${table}
        SET target_kind = 'direct-message', target_ref = ?
        WHERE rowid = ?
      `).run(nextRef, row._rowid);
      if (result.changes > 0) rewritten += 1;
    }
  }
  return rewritten;
}
