/** AgentSkillCatalog hides discovery, frontmatter parsing and safe skill loading. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface AgentSkillSummary {
  name: string;
  displayName: string;
  description: string;
}

export interface ResolvedSkillInstructions {
  instructions: string;
  warnings: string[];
}

interface CatalogEntry extends AgentSkillSummary {
  path: string;
}

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class AgentSkillCatalog {
  readonly root: string;

  constructor(root = path.join(os.homedir(), ".agents", "skills")) {
    this.root = root;
  }

  list(): AgentSkillSummary[] {
    return this.entries().map(({ name, displayName, description }) => ({
      name,
      displayName,
      description,
    }));
  }

  resolve(names: string[]): ResolvedSkillInstructions {
    const requested = [...new Set(names.filter((name) => SKILL_NAME_PATTERN.test(name)))];
    if (requested.length === 0) return { instructions: "", warnings: [] };

    const byName = new Map(this.entries().map((entry) => [entry.name, entry]));
    const fragments: string[] = [];
    const warnings: string[] = [];
    for (const name of requested) {
      const entry = byName.get(name);
      if (!entry) {
        warnings.push(`Skill not found or unavailable: ${name}`);
        continue;
      }
      try {
        const contents = fs.readFileSync(entry.path, "utf8");
        fragments.push([
          "<skill>",
          `<name>${escapeXml(entry.name)}</name>`,
          `<path>${escapeXml(entry.path)}</path>`,
          contents.trimEnd(),
          "</skill>",
        ].join("\n"));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(`Skill could not be loaded (${name}): ${detail}`);
      }
    }
    return { instructions: fragments.join("\n\n"), warnings };
  }

  private entries(): CatalogEntry[] {
    let rootReal: string;
    try {
      rootReal = fs.realpathSync(this.root);
    } catch {
      return [];
    }

    const entries: CatalogEntry[] = [];
    const seen = new Set<string>();
    for (const directory of fs.readdirSync(rootReal, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const skillPath = path.join(rootReal, directory.name, "SKILL.md");
      let skillReal: string;
      try {
        skillReal = fs.realpathSync(skillPath);
      } catch {
        continue;
      }
      if (!isWithin(rootReal, skillReal)) continue;

      let source: string;
      try {
        source = fs.readFileSync(skillReal, "utf8");
      } catch {
        continue;
      }
      const frontmatter = parseFrontmatter(source);
      const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : directory.name;
      if (!SKILL_NAME_PATTERN.test(name) || seen.has(name) || frontmatter["user-invocable"] === false) continue;
      const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
      entries.push({
        name,
        displayName: humanizeSkillName(name),
        description,
        path: skillReal,
      });
      seen.add(name);
    }
    return entries;
  }
}

function parseFrontmatter(source: string): Record<string, unknown> {
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1] ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function humanizeSkillName(name: string): string {
  return name.split(/[-_]+/).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
