import { describe, expect, it, vi } from "vitest";
import { resolveOriginSkillInstructions } from "./origin-session-runtime.js";

describe("Origin skill instructions", () => {
  it("resolves the explicitly selected skills for one Origin turn", () => {
    const resolve = vi.fn(() => ({ instructions: "<skill>Think carefully</skill>", warnings: [] }));

    expect(resolveOriginSkillInstructions({ resolve }, ["think", "codebase-design"]))
      .toBe("<skill>Think carefully</skill>");
    expect(resolve).toHaveBeenCalledWith(["think", "codebase-design"]);
  });

  it("returns valid instructions while reporting unavailable selections", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const instructions = resolveOriginSkillInstructions({
      resolve: () => ({ instructions: "", warnings: ["Skill not found or unavailable: missing"] }),
    }, ["missing"]);

    expect(instructions).toBe("");
    expect(warning).toHaveBeenCalledWith("[skills] Skill not found or unavailable: missing");
    warning.mockRestore();
  });
});
