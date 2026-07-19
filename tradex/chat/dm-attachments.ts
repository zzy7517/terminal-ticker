/**
 * dm-attachments — Human DM 图片落到 Agent 私有 workspace。
 *
 * 图片不进 Runtime Session 存储；Message Fabric 正文只引用 workspace 相对路径，
 * Agent 再用文件系统工具读取。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensurePrivateWorkspace } from "../agent/private-workspace.js";

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 一条待落盘的 base64 图片。 */
export interface DmImageAttachment {
  data: string;
  mimeType: string;
}

/** 将 base64 图片写入 workspace/dm-attachments，返回 workspace 相对路径。 */
export function saveDmImageAttachments(agentId: string, images: DmImageAttachment[]): string[] {
  if (images.length === 0) return [];
  const { workspacePath } = ensurePrivateWorkspace(agentId);
  const dir = path.join(workspacePath, "dm-attachments");
  fs.mkdirSync(dir, { recursive: true });
  return images.map((image) => {
    const ext = MIME_EXT[image.mimeType];
    if (!ext) throw new Error(`unsupported image type: ${image.mimeType}`);
    const fileName = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(dir, fileName), Buffer.from(image.data, "base64"), { mode: 0o600 });
    return path.join("dm-attachments", fileName);
  });
}

/** 组装 Shared Message 正文：用户说明 + 附件路径列表（供 Agent 工具读取）。 */
export function buildDmMessageContent(text: string, attachmentPaths: string[]): string {
  const trimmed = text.trim();
  if (attachmentPaths.length === 0) {
    if (!trimmed) throw new Error("content is required");
    return trimmed;
  }
  const body = trimmed || "分析这张图片";
  return [
    body,
    "",
    "Attached images (private workspace paths — use filesystem tools to read):",
    ...attachmentPaths.map((file) => `- ${file}`),
  ].join("\n");
}
