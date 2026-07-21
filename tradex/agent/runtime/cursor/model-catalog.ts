/** 维护 Cursor CLI 模型目录；优先解析本机 `agent --list-models`。 */
import { spawn } from "node:child_process";

export interface CursorModelOption {
  id: string;
  label: string;
  provider: "cursor";
  default?: boolean;
}

export interface CursorModelCatalogResult {
  models: CursorModelOption[];
  error: string | null;
}

const FALLBACK_MODELS: CursorModelOption[] = [
  { id: "auto", label: "Auto", provider: "cursor", default: true },
  { id: "composer-2.5", label: "Composer 2.5", provider: "cursor" },
  { id: "gpt-5.2", label: "GPT-5.2", provider: "cursor" },
  { id: "claude-opus-4-8-thinking-high", label: "Opus 4.8 Thinking", provider: "cursor" },
];

/** 返回静态 fallback 目录（离线或探测失败时使用）。 */
export function cursorModelCatalogFallback(): CursorModelOption[] {
  return FALLBACK_MODELS.map((model) => ({ ...model }));
}

/** 从本机 Cursor CLI 拉取可用模型列表。 */
export async function fetchCursorModelCatalog(executablePath: string): Promise<CursorModelCatalogResult> {
  const result = await runListModels(executablePath);
  if (result.error) return { models: cursorModelCatalogFallback(), error: result.error };
  const parsed = parseCursorModelList(result.output);
  return parsed.length > 0
    ? { models: parsed, error: null }
    : { models: cursorModelCatalogFallback(), error: "Cursor CLI returned no parseable models" };
}

export function parseCursorModelList(output: string): CursorModelOption[] {
  const models: CursorModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || /^available models$/i.test(line)) continue;
    const match = line.match(/^(\S+)\s+-\s+(.+)$/);
    if (!match) continue;
    const id = match[1];
    const label = match[2].replace(/\s*\(default\)\s*$/i, "").trim() || id;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label,
      provider: "cursor",
      ...(/(?:^|\s)\(default\)\s*$/i.test(match[2]) || id === "auto" ? { default: true } : {}),
    });
  }
  if (models.some((model) => model.default)) return models;
  if (models[0]) models[0] = { ...models[0], default: true };
  return models;
}

function runListModels(executablePath: string): Promise<{ output: string; error: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(executablePath, ["--list-models"], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: { output: string; error: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ output: "", error: "Cursor model discovery timed out" });
    }, 8_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-65_536); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
    child.once("error", (error) => finish({ output: "", error: error.message }));
    child.once("close", (code) => {
      if (code === 0) {
        finish({ output: stdout.trim(), error: null });
      } else {
        finish({
          output: stdout.trim(),
          error: stderr.trim() || `Cursor CLI exited with code ${code ?? "unknown"}`,
        });
      }
    });
  });
}
