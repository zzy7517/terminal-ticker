import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultDataDir(): string {
  return path.join(process.cwd(), "data");
}

export function defaultMemoryHome(): string {
  return path.join(defaultDataDir(), "memory");
}

export function memoryHome(inputPath?: string | null): string {
  return path.resolve(inputPath || defaultMemoryHome());
}

export function memoryStoreAvailable(inputPath?: string | null): boolean {
  return fs.existsSync(memoryHome(inputPath));
}

export function memoryStatePath(inputPath?: string | null): string {
  return path.join(memoryHome(inputPath), "state.sqlite3");
}

export function ensureMemoryLayout(inputPath?: string | null): string {
  const root = memoryHome(inputPath);
  for (const dir of [root, path.join(root, "raw"), path.join(root, "facts"), path.join(root, "reviews"), path.join(root, "generated")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return root;
}

export function userHome(): string {
  return os.homedir();
}
