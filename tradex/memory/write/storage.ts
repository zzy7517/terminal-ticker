import fs from "node:fs";
import path from "node:path";
import { ensureMemoryLayout } from "../paths.js";

export class MemoryFileStorage {
  readonly root: string;

  constructor(root?: string | null) {
    this.root = ensureMemoryLayout(root);
  }

  writeManualNoteFile(input: { noteId: string; payload: string | Record<string, unknown> }): string {
    const relative = path.join("raw", `${input.noteId}.md`);
    this.writeRelative(relative, typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload, null, 2));
    return relative;
  }

  manualNotePath(noteRef: string): string {
    return path.join(this.root, "raw", noteRef.endsWith(".md") ? noteRef : `${noteRef}.md`);
  }

  writeRelative(relativePath: string, content: string): void {
    const target = path.resolve(this.root, relativePath);
    if (!target.startsWith(this.root)) throw new Error("path escapes memory root");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
