import fs from "node:fs";
import path from "node:path";
import { memoryHome } from "./paths.js";

const VISIBLE_ROOT_FILES = new Set(["MEMORY.md", "memory_summary.md"]);
const VISIBLE_ROOT_DIRS = new Set(["facts", "reviews", "rollout_summaries", "skills", "generated"]);
const INTERNAL_FILENAMES = new Set(["phase2_workspace_diff.md", ".phase2_baseline.json", ".gitkeep"]);
const INTERNAL_SUFFIXES = [".sqlite3", ".sqlite3-shm", ".sqlite3-wal", ".db", ".lock", ".tmp"];

export class MemoryAccessError extends Error {}

export class LocalMemoryBackend {
  readonly root: string;

  constructor(root?: string | null) {
    this.root = memoryHome(root);
  }

  list(input: { path?: string | null; limit?: number } = {}): Array<Record<string, unknown>> {
    const start = this.resolveScopedPath(input.path ?? null);
    if (!fs.existsSync(start)) return [];
    const relativePath = path.relative(this.root, start);
    return fs.readdirSync(start, { withFileTypes: true })
      .filter((entry) => this.isVisible(entry, relativePath))
      .slice(0, input.limit ?? 100)
      .map((entry) => ({
        name: entry.name,
        path: path.relative(this.root, path.join(start, entry.name)),
        type: entry.isDirectory() ? "directory" : "file",
      }));
  }

  read(input: { path: string; maxChars?: number; lineOffset?: number; maxLines?: number | null }): Record<string, unknown> {
    const target = this.resolveScopedPath(input.path);
    if (!fs.existsSync(target)) throw new MemoryAccessError(`path '${input.path}' was not found`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new MemoryAccessError("symlinks are not allowed");
    if (!stat.isFile()) throw new MemoryAccessError(`path '${input.path}' is not a file`);
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
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= (input.limit ?? 50)) return;
        if (entry.isSymbolicLink()) continue;
        if (this.isInternal(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            const text = fs.readFileSync(full, "utf8");
            if (text.toLowerCase().includes(query)) out.push({ path: path.relative(this.root, full), preview: text.slice(0, 300) });
          } catch { /* skip unreadable files */ }
        }
      }
    };
    if (fs.existsSync(root)) walk(root);
    return out;
  }

  private resolveScopedPath(relativePath: string | null): string {
    if (!relativePath || relativePath === "" || relativePath === ".") return this.root;
    const normalized = path.normalize(relativePath);
    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes("..")) {
      throw new MemoryAccessError("path must stay within the memories root");
    }
    if (normalized.split(path.sep).some((part) => part.startsWith("."))) {
      throw new MemoryAccessError(`path '${relativePath}' was not found`);
    }
    const target = path.resolve(this.root, normalized);
    if (!target.startsWith(this.root)) throw new MemoryAccessError("path escapes memory root");
    return target;
  }

  private isVisible(entry: fs.Dirent, relativePath: string): boolean {
    const name = entry.name;
    if (entry.isSymbolicLink()) return false;
    if (name.startsWith(".")) return false;
    if (this.isInternal(name)) return false;
    if (!relativePath || relativePath === ".") {
      if (entry.isDirectory()) return VISIBLE_ROOT_DIRS.has(name);
      return VISIBLE_ROOT_FILES.has(name);
    }
    return true;
  }

  private isInternal(name: string): boolean {
    if (INTERNAL_FILENAMES.has(name)) return true;
    return INTERNAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
  }
}
