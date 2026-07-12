/** 通过 MCP 向 Claude 暴露当前 Session 的受控图片读取能力。 */
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { ToolRegistry } from "../../tools/registry.js";

const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * 为当前 Claude Session 创建“读取图片附件”的受控 Tool。
 *
 * 图片处理流程是：
 * 1. 用户上传图片后，API 先把图片保存到当前 Session 的 attachments/ 目录；
 * 2. API 只把后端生成的安全文件名放进 Claude 的 prompt；
 * 3. Claude 调用 read_session_attachment，并由这里读取图片内容；
 * 4. 图片以 MCP image content 返回给 Claude，而不是把 Session 目录直接暴露给 Claude。
 *
 * 这样做是为了让 Claude 能理解用户上传的图片，同时避免开放原生文件读取能力，
 * 防止它通过路径遍历、软链接或任意路径读取 Tradex 主机上的其他文件。
 */
/** 为一个 Session 创建只允许读取其 attachments 目录的 ToolRegistry。 */
export function buildSessionAttachmentTools(sessionDirectory: string): ToolRegistry {
  // 工具只绑定当前 Session 的 attachments/，不同 Session 之间不能互相读取附件。
  const attachmentsDirectory = path.join(sessionDirectory, "attachments");
  const registry = new ToolRegistry();
  registry.register({
    name: "read_session_attachment",
    description: "Read an image attachment from the current Tradex Session by its provided filename.",
    parameters: {
      type: "object",
      properties: { filename: { type: "string", description: "Attachment filename shown in the user prompt" } },
      required: ["filename"],
      additionalProperties: false,
    },
    policy: { access: "read", domain: "filesystem", runtimeExposure: ["claude-code"] },
    async execute(args) {
      const filename = String(args.filename || "");
      // 文件名必须是后端生成的 UUID 风格名称，拒绝 ../、绝对路径和用户自定义路径。
      if (path.basename(filename) !== filename || !/^[0-9a-f-]+\.(?:jpg|png|gif|webp)$/i.test(filename)) {
        throw new Error("invalid Session attachment filename");
      }
      // MIME 类型由扩展名映射，不信任调用方传入的 MIME 字段。
      const mimeType = ATTACHMENT_MIME_TYPES[path.extname(filename).slice(1).toLowerCase()];
      if (!mimeType) throw new Error("unsupported Session attachment type");
      const file = path.join(attachmentsDirectory, filename);
      const stats = await lstat(file);
      // 只允许真实普通文件，拒绝目录和软链接，避免借道访问 attachments/ 外部路径。
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Session attachment must be a regular file");
      // 限制单张图片大小，避免 MCP 响应和 Claude 上下文被超大文件拖垮。
      if (stats.size > 20 * 1024 * 1024) throw new Error("Session attachment exceeds 20 MB");
      const data = await readFile(file);
      // MCP image content 使用 base64 传输，Claude 才能把它作为图片而不是普通文本处理。
      return [{ type: "image" as const, data: data.toString("base64"), mimeType }];
    },
  });
  return registry;
}
