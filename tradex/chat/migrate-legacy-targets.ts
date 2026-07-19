/**
 * 将遗留 Phase 1 `direct-chat` 行改写为真实 `direct-message` ChatTarget。
 * 不得伪造 `legacy:agentId:chatId` 作为 directMessageId。
 */
import type Database from "better-sqlite3";
import { chatTargetRef, directMessageTarget } from "../channel/domain.js";

const TABLES: Array<{ table: string; hasActor: boolean }> = [
  { table: "chat_saved", hasActor: true },
  { table: "chat_pins", hasActor: true },
  { table: "agent_inbox", hasActor: false },
  { table: "chat_unread_cursors", hasActor: false },
  { table: "chat_events", hasActor: false },
];

/**
 * 扫描共用 chat.sqlite3，把 direct-chat [agentId, chatId] 改写为
 * direct-message [realDmId]。resolveDmId(agentId) 必须返回 MessageStore 中的真实 DM。
 */
export function migrateLegacyDirectChatTargets(
  conn: Database.Database,
  resolveDmId: (agentId: string) => string,
): number {
  let rewritten = 0;
  for (const { table } of TABLES) {
    const exists = conn.prepare(`
      SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table) as { ok: number } | undefined;
    if (!exists) continue;

    const rows = conn.prepare(`
      SELECT rowid, target_ref FROM ${table} WHERE target_kind = 'direct-chat'
    `).all() as Array<{ rowid: number; target_ref: string }>;

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
      conn.prepare(`
        UPDATE ${table}
        SET target_kind = 'direct-message', target_ref = ?
        WHERE rowid = ?
      `).run(nextRef, row.rowid);
      rewritten += 1;
    }
  }
  return rewritten;
}
