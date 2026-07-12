import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { ToolRegistry } from "./registry.js";

const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

export function buildSessionAttachmentTools(sessionDirectory: string): ToolRegistry {
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
      if (path.basename(filename) !== filename || !/^[0-9a-f-]+\.(?:jpg|png|gif|webp)$/i.test(filename)) {
        throw new Error("invalid Session attachment filename");
      }
      const mimeType = ATTACHMENT_MIME_TYPES[path.extname(filename).slice(1).toLowerCase()];
      if (!mimeType) throw new Error("unsupported Session attachment type");
      const file = path.join(attachmentsDirectory, filename);
      const stats = await lstat(file);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Session attachment must be a regular file");
      if (stats.size > 20 * 1024 * 1024) throw new Error("Session attachment exceeds 20 MB");
      const data = await readFile(file);
      return [{ type: "image" as const, data: data.toString("base64"), mimeType }];
    },
  });
  return registry;
}
