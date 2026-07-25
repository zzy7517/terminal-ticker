import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSkillCatalog } from "./skills.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function skillRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-skills-"));
  roots.push(root);
  return root;
}

function writeSkill(root: string, directory: string, source: string): void {
  const target = path.join(root, directory);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "SKILL.md"), source);
}

describe("AgentSkillCatalog", () => {
  it("parses quoted and folded descriptions and filters non-invocable skills", () => {
    const root = skillRoot();
    writeSkill(root, "plain", `---\nname: plain\ndescription: "Quoted description"\n---\nPlain body\n`);
    writeSkill(root, "folded", `---\nname: folded-skill\ndescription: >-\n  Folded description\n  over two lines\n---\nFolded body\n`);
    writeSkill(root, "hidden", `---\nname: hidden\ndescription: Hidden\nuser-invocable: false\n---\nHidden body\n`);

    expect(new AgentSkillCatalog(root).list()).toEqual([
      { name: "folded-skill", displayName: "Folded Skill", description: "Folded description over two lines" },
      { name: "plain", displayName: "Plain", description: "Quoted description" },
    ]);
  });

  it("loads complete instructions and rejects symlinks escaping the skill root", () => {
    const root = skillRoot();
    const outside = skillRoot();
    writeSkill(root, "safe", `---\nname: safe\ndescription: Safe\n---\n# Complete body\nUse all of this.\n`);
    writeSkill(outside, "escaped", `---\nname: escaped\ndescription: Escaped\n---\nMust not load\n`);
    fs.symlinkSync(path.join(outside, "escaped"), path.join(root, "escaped"));

    const catalog = new AgentSkillCatalog(root);
    expect(catalog.list().map((skill) => skill.name)).toEqual(["safe"]);
    const resolved = catalog.resolve(["safe", "escaped", "safe"]);
    expect(resolved.instructions).toContain("<name>safe</name>");
    expect(resolved.instructions).toContain("# Complete body\nUse all of this.");
    expect(resolved.instructions).not.toContain("Must not load");
    expect(resolved.warnings).toEqual(["Skill not found or unavailable: escaped"]);
  });
});
