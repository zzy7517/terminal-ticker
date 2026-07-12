import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionAttachmentTools } from "./attachment-tools.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("Session attachment tools", () => {
  it("reads only a regular image inside the current Session attachments directory", async () => {
    const sessionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-attachments-"));
    directories.push(sessionDirectory);
    fs.mkdirSync(path.join(sessionDirectory, "attachments"));
    const filename = "11111111-1111-4111-8111-111111111111.png";
    fs.writeFileSync(path.join(sessionDirectory, "attachments", filename), Buffer.from("png"));
    const registry = buildSessionAttachmentTools(sessionDirectory);

    await expect(registry.execute({ id: "1", name: "read_session_attachment", arguments: { filename } })).resolves.toMatchObject({
      error: false,
    });
    await expect(registry.execute({ id: "2", name: "read_session_attachment", arguments: { filename: "../secret.png" } })).resolves.toMatchObject({
      error: true,
      output: "invalid Session attachment filename",
    });
  });
});
