/**
 * private-workspace — agent_contexts/<id>/ 下的 per-Agent 隔离磁盘目录。
 *
 * 存放 workspace notes、MEMORY.md 与 Session 归档。不是共享 Company Brain：
 * Agent 不得互读目录。Message Fabric 数据仍在 chat.sqlite3；本树仅私有连续性。
 */
import fs from "node:fs";
import path from "node:path";
import { defaultCacheDir } from "../db.js";

/** 磁盘上的私有目录路径：root / workspace / MEMORY.md / sessions 归档。 */
export interface PrivateWorkspacePaths {
  root: string;
  workspacePath: string;
  memoryPath: string;
  sessionsPath: string;
}

function agentContextRoot(agentId: string): string {
  return path.join(defaultCacheDir(), "agent_contexts", agentId);
}

/** 创建 workspace/memory 目录；缺失时写入初始 MEMORY.md。 */
export function ensurePrivateWorkspace(agentId: string): PrivateWorkspacePaths {
  const root = agentContextRoot(agentId);
  const workspacePath = path.join(root, "workspace");
  const memoryDir = path.join(root, "memory");
  const memoryPath = path.join(memoryDir, "MEMORY.md");
  const sessionsPath = path.join(root, "sessions");
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(sessionsPath, { recursive: true });
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, `# Memory for ${agentId}\n\n`, "utf8");
  }
  const metadataPath = path.join(root, "metadata.json");
  if (!fs.existsSync(metadataPath)) {
    fs.writeFileSync(metadataPath, JSON.stringify({ agentId, createdAtMs: Date.now() }, null, 2), "utf8");
  }
  return { root, workspacePath, memoryPath, sessionsPath };
}

/** 读取 MEMORY.md（不存在则先 ensure）。 */
export function readPrivateMemory(agentId: string): string {
  const { memoryPath } = ensurePrivateWorkspace(agentId);
  return fs.readFileSync(memoryPath, "utf8");
}

/** 覆盖写入 MEMORY.md。失败时调用方不得回滚共享消息/inbox。 */
export function writePrivateMemory(agentId: string, content: string): void {
  const { memoryPath } = ensurePrivateWorkspace(agentId);
  fs.writeFileSync(memoryPath, content, "utf8");
}

/**
 * Full reset：清空 workspace 与 memory，保留 Agent Context 根目录结构。
 * Session reset 不调用本函数（只轮换 Runtime Session）。
 */
export function wipePrivateWorkspace(agentId: string): PrivateWorkspacePaths {
  const root = agentContextRoot(agentId);
  const workspacePath = path.join(root, "workspace");
  const memoryDir = path.join(root, "memory");
  fs.rmSync(workspacePath, { recursive: true, force: true });
  fs.rmSync(memoryDir, { recursive: true, force: true });
  return ensurePrivateWorkspace(agentId);
}
