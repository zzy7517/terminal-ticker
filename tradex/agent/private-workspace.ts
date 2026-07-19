import fs from "node:fs";
import path from "node:path";
import { defaultCacheDir } from "../db.js";

export interface PrivateWorkspacePaths {
  root: string;
  workspacePath: string;
  memoryPath: string;
  sessionsPath: string;
}

export function agentContextRoot(agentId: string): string {
  return path.join(defaultCacheDir(), "agent_contexts", agentId);
}

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

export function readPrivateMemory(agentId: string): string {
  const { memoryPath } = ensurePrivateWorkspace(agentId);
  return fs.readFileSync(memoryPath, "utf8");
}

export function writePrivateMemory(agentId: string, content: string): void {
  const { memoryPath } = ensurePrivateWorkspace(agentId);
  fs.writeFileSync(memoryPath, content, "utf8");
}
