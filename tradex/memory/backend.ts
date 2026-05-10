import fs from "node:fs";
import path from "node:path";
import { memoryHome } from "./paths.js";

export class MemoryAccessError extends Error {}

export class LocalMemoryBackend {
  readonly root: string;

  constructor(root?: string | null) {
    this.root = memoryHome(root);
  }

  list(input: { path?: string | null; limit?: number } = {}): Array<Record<string, unknown>> {
    const start = this.resolveScopedPath(input.path ?? null);
    if (!fs.existsSync(start)) return [];
    return fs.readdirSync(start, { withFileTypes: true }).slice(0, input.limit ?? 100).map((entry) => ({
      name: entry.name,
      path: path.relative(this.root, path.join(start, entry.name)),
      type: entry.isDirectory() ? "directory" : "file",
    }));
  }

  read(input: { path: string; maxChars?: number; lineOffset?: number; maxLines?: number | null }): Record<string, unknown> {
    const target = this.resolveScopedPath(input.path);
    const text = fs.readFileSync(target, "utf8");
    const lines = text.split(/\r?\n/).slice(input.lineOffset ?? 0, input.maxLines ? (input.lineOffset ?? 0) + input.maxLines : undefined);
    const content = lines.join("\n").slice(0, input.maxChars ?? 20_000);
    return { path: path.relative(this.root, target), content, truncated: content.length < text.length };
  }

  search(input: { query: string; path?: string | null; limit?: number }): Array<Record<string, unknown>> {
    const root = this.resolveScopedPath(input.path ?? null);
    const out: Array<Record<string, unknown>> = [];
    const query = input.query.toLowerCase();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= (input.limit ?? 50)) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const text = fs.readFileSync(full, "utf8");
          if (text.toLowerCase().includes(query)) out.push({ path: path.relative(this.root, full), preview: text.slice(0, 300) });
        }
      }
    };
    if (fs.existsSync(root)) walk(root);
    return out;
  }

  private resolveScopedPath(relativePath: string | null): string {
    const target = path.resolve(this.root, relativePath || ".");
    if (!target.startsWith(this.root)) throw new MemoryAccessError("path escapes memory root");
    return target;
  }
}
