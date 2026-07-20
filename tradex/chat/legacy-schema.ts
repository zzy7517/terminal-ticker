/**
 * legacy-schema — 一次性 SQLite 兼容迁移 helper。
 */
import type Database from "better-sqlite3";

/**
 * 若列仍存在，将其非空值清为 NULL（用于退役字段拍平到主时间线）。
 * table / column 仅接受调用方硬编码的标识符。
 */
export function nullOutLegacyColumn(conn: Database.Database, table: string, column: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error("invalid legacy schema identifier");
  }
  const columns = conn.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) return;
  conn.exec(`UPDATE ${table} SET ${column} = NULL WHERE ${column} IS NOT NULL`);
}
