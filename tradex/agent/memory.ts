/**
 * memory — 基于私有 workspace MEMORY.md 的 per-Agent 记忆加固。
 *
 * 对应 Raft「每个 Agent 独立 memory」：路径经 ensurePrivateWorkspace 绑定 agentId；
 * 写入失败不得回滚 Shared Message / inbox；压缩与 retention 只动本 Agent 文件。
 */
import fs from "node:fs";
import path from "node:path";
import {
  ensurePrivateWorkspace,
  readPrivateMemory,
  writePrivateMemory,
} from "./private-workspace.js";

const MEMORY_MAX_CHARS = 48_000;
const MEMORY_RETENTION_DAYS = 180;

/** MEMORY.md 行级搜索命中。 */
export interface MemorySearchHit {
  line: number;
  text: string;
}

/** 压缩结果：压缩前后字符数与是否截断。 */
export interface MemoryCompactResult {
  beforeChars: number;
  afterChars: number;
  truncated: boolean;
}

/** 笔记 retention 结果：归档数量与最后归档路径。 */
export interface MemoryRetentionResult {
  archivedNotes: number;
  archivePath: string | null;
}

/** 读取 Agent 私有 MEMORY.md。 */
export function memoryRead(agentId: string): string {
  return readPrivateMemory(agentId);
}

/** 覆盖写入 MEMORY.md；不触及 Shared Message Fabric。 */
export function memoryWrite(agentId: string, content: string): void {
  writePrivateMemory(agentId, content);
}

/** 在 MEMORY.md 内做不区分大小写的行搜索。 */
export function memorySearch(agentId: string, query: string, limit = 20): MemorySearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const content = readPrivateMemory(agentId);
  const hits: MemorySearchHit[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].toLowerCase().includes(q)) continue;
    hits.push({ line: i + 1, text: lines[i] });
    if (hits.length >= Math.max(1, Math.min(100, limit))) break;
  }
  return hits;
}

/**
 * 将 MEMORY.md 压缩到 maxChars：保留短标题 + 最新尾部，溢出归档到 memory/archive/。
 */
export function memoryCompact(agentId: string, maxChars = MEMORY_MAX_CHARS): MemoryCompactResult {
  const content = readPrivateMemory(agentId);
  const beforeChars = content.length;
  if (beforeChars <= maxChars) {
    return { beforeChars, afterChars: beforeChars, truncated: false };
  }
  const lines = content.split(/\r?\n/);
  // 只保留标题行，避免第 3 行起就是超长正文时把整段当成 header。
  const header = (lines[0] ?? `# Memory for ${agentId}`).slice(0, 200);
  const bodyBudget = Math.max(64, maxChars - header.length - 80);
  const body = content.length > header.length ? content.slice(content.indexOf("\n") + 1) : "";
  const tail = body.length > bodyBudget ? body.slice(-bodyBudget) : body;
  const archiveDir = path.join(ensurePrivateWorkspace(agentId).root, "memory", "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `compact-${Date.now()}.md`);
  fs.writeFileSync(archivePath, body, "utf8");
  const next = `${header}\n\n<!-- compacted ${new Date().toISOString()} -->\n\n${tail}`.trimEnd() + "\n";
  writePrivateMemory(agentId, next);
  return { beforeChars, afterChars: next.length, truncated: true };
}

/**
 * 将 workspace/notes 中超过 retentionDays 的笔记移入 memory/archive。
 * MEMORY.md 本体不动（体积控制用 memoryCompact）。
 */
export function memoryApplyRetention(
  agentId: string,
  retentionDays = MEMORY_RETENTION_DAYS,
  now = Date.now(),
): MemoryRetentionResult {
  const workspace = ensurePrivateWorkspace(agentId);
  const notesDir = path.join(workspace.workspacePath, "notes");
  const archiveDir = path.join(workspace.root, "memory", "archive");
  if (!fs.existsSync(notesDir)) {
    return { archivedNotes: 0, archivePath: null };
  }
  const cutoff = now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  let archived = 0;
  let lastArchive: string | null = null;
  for (const name of fs.readdirSync(notesDir)) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(notesDir, name);
    const stat = fs.statSync(full);
    if (stat.mtimeMs >= cutoff) continue;
    fs.mkdirSync(archiveDir, { recursive: true });
    const dest = path.join(archiveDir, `note-${stat.mtimeMs}-${name}`);
    fs.renameSync(full, dest);
    archived += 1;
    lastArchive = dest;
  }
  return { archivedNotes: archived, archivePath: lastArchive };
}
