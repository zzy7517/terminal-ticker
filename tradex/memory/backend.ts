import fs from "node:fs";
import path from "node:path";
import { memoryHome } from "./paths.js";

const VISIBLE_ROOT_FILES = new Set(["MEMORY.md", "memory_summary.md"]);
const VISIBLE_ROOT_DIRS = new Set(["facts", "reviews", "rollout_summaries", "skills", "generated", "extensions"]);
const INTERNAL_FILENAMES = new Set(["phase2_workspace_diff.md", ".phase2_baseline.json", ".gitkeep"]);
const INTERNAL_SUFFIXES = [".sqlite3", ".sqlite3-shm", ".sqlite3-wal", ".db", ".lock", ".tmp"];

function cleanNoteSlug(value: string): string {
  const clean = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return clean.slice(0, 80) || "note";
}

function redactNoteSecrets(value: string): string {
  let redacted = value.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_SECRET]",
  );
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_SECRET]");
  redacted = redacted.replace(/Basic\s+[A-Za-z0-9+/=-]+/gi, "Basic [REDACTED_SECRET]");
  redacted = redacted.replace(
    /\b(api[_-]?key|secret|token|password|passphrase|authorization|cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b(\s*[:=]\s*)["']?[^"',}\]\s\n\r]+["']?/gi,
    "$1$2[REDACTED_SECRET]",
  );
  return redacted;
}

export class MemoryAccessError extends Error {}

export class LocalMemoryBackend {
  readonly root: string;

  constructor(root?: string | null) {
    this.root = path.resolve(memoryHome(root));
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
    this.assertVisiblePath(target, input.path);
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
    this.assertVisiblePath(root, input.path ?? null);
    const out: Array<Record<string, unknown>> = [];
    const query = input.query.toLowerCase();
    const visitFile = (full: string) => {
      try {
        const text = fs.readFileSync(full, "utf8");
        if (text.toLowerCase().includes(query)) out.push({ path: path.relative(this.root, full), preview: text.slice(0, 300) });
      } catch { /* skip unreadable files */ }
    };
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) return;
      if (stat.isFile()) {
        if (!this.isInternal(path.basename(dir))) visitFile(dir);
        return;
      }
      if (!stat.isDirectory()) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= (input.limit ?? 50)) return;
        if (entry.isSymbolicLink()) continue;
        if (this.isInternal(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          visitFile(full);
        }
      }
    };
    if (fs.existsSync(root)) walk(root);
    return out;
  }

  writeAdHocNote(input: { content: string; slug?: string | null; allowWrite?: boolean }): Record<string, unknown> {
    if (input.allowWrite === false) {
      throw new MemoryAccessError("memory note writing is disabled by the current memory config");
    }
    const content = redactNoteSecrets(input.content.trim());
    if (!content) throw new MemoryAccessError("note content must not be empty");
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
    const slug = cleanNoteSlug(input.slug || content.slice(0, 60));
    const relativePath = path.join("extensions", "ad_hoc", "notes", `${stamp}-${slug}.md`);
    const target = path.join(this.root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, [
      "---",
      "type: ad_hoc_note",
      `created_at: ${new Date().toISOString()}`,
      "---",
      "",
      content,
      "",
    ].join("\n"));
    return { path: relativePath.replace(/\\/g, "/") };
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
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new MemoryAccessError("path escapes memory root");
    }
    return target;
  }

  private assertVisiblePath(target: string, originalPath: string | null): void {
    const relativePath = path.relative(this.root, target);
    if (!relativePath || relativePath === ".") return;
    const parts = relativePath.split(path.sep);
    const top = parts[0];
    if (this.isInternal(path.basename(target))) {
      throw new MemoryAccessError(`path '${originalPath ?? ""}' was not found`);
    }
    if (parts.length === 1) {
      const exists = fs.existsSync(target);
      const isDir = exists && fs.lstatSync(target).isDirectory();
      if (isDir ? VISIBLE_ROOT_DIRS.has(top) : VISIBLE_ROOT_FILES.has(top)) return;
      throw new MemoryAccessError(`path '${originalPath ?? ""}' was not found`);
    }
    if (!VISIBLE_ROOT_DIRS.has(top)) {
      throw new MemoryAccessError(`path '${originalPath ?? ""}' was not found`);
    }
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
