/**
 * PromptComposer — assembles system prompts for each pipeline module.
 *
 * Reads .md files from tradex/prompts/, combines persona + regime + execution rules,
 * and formats the data context for each module.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { RegimeSignal } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");

export interface ComposedPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface ModulePromptInput {
  moduleId: string;
  instrumentKey: string;
  regime: RegimeSignal;
  candleData: string;       // formatted OHLCV text
  additionalContext?: string; // e.g. funding rate, OI for fundamental analyst
}

export class PromptComposer {
  private personaCache = new Map<string, string>();
  private regimeCache = new Map<string, string>();
  private executionRules: string;

  constructor() {
    this.executionRules = this.loadFile("meta/execution_rules.md");
  }

  /** Compose full prompt for a single analysis module. */
  compose(input: ModulePromptInput): ComposedPrompt {
    const persona = this.getPersona(input.moduleId);
    const regimeRules = this.getRegimeRules(input.regime);

    const systemPrompt = [
      persona,
      "",
      "---",
      "",
      regimeRules,
      "",
      "---",
      "",
      this.executionRules,
    ].join("\n");

    const userPrompt = this.buildUserPrompt(input);

    return { systemPrompt, userPrompt };
  }

  /** Get the CRO (risk officer) prompt. */
  composeCRO(candidateDecision: string, context: string): ComposedPrompt {
    const persona = this.getPersona("risk_officer");
    return {
      systemPrompt: persona,
      userPrompt: `## 候选交易决策\n\n${candidateDecision}\n\n## 市场上下文\n\n${context}\n\n请按照输出格式审查此决策。`,
    };
  }

  /** Get the synthesis prompt. */
  composeSynthesis(moduleOutputs: string, regimeInfo: string): ComposedPrompt {
    const synthesis = this.loadFile("meta/synthesis.md");
    return {
      systemPrompt: synthesis,
      userPrompt: `## 当前 Regime\n\n${regimeInfo}\n\n## 各模块输出\n\n${moduleOutputs}\n\n请综合以上模块输出，给出最终候选决策。`,
    };
  }

  private getPersona(moduleId: string): string {
    if (!this.personaCache.has(moduleId)) {
      const content = this.loadFile(`personas/${moduleId}.md`);
      this.personaCache.set(moduleId, content);
    }
    return this.personaCache.get(moduleId)!;
  }

  private getRegimeRules(regime: RegimeSignal): string {
    const key = this.regimeToFile(regime);
    if (!this.regimeCache.has(key)) {
      const content = this.loadFile(`regimes/${key}.md`);
      this.regimeCache.set(key, content);
    }
    return this.regimeCache.get(key)!;
  }

  private regimeToFile(regime: RegimeSignal): string {
    if (regime.volatility === "EXTREME" || regime.volatility === "HIGH") return "volatile";
    if (regime.trend === "RANGE") return "ranging";
    return "trending";
  }

  private buildUserPrompt(input: ModulePromptInput): string {
    const parts: string[] = [];
    parts.push(`## 分析目标: ${input.instrumentKey}`);
    parts.push("");
    parts.push(`## 当前 Regime`);
    parts.push(`- Market: ${input.regime.market}`);
    parts.push(`- Volatility: ${input.regime.volatility}`);
    parts.push(`- Trend: ${input.regime.trend}`);
    parts.push("");
    parts.push(`## K线数据`);
    parts.push(input.candleData);

    if (input.additionalContext) {
      parts.push("");
      parts.push(`## 附加数据`);
      parts.push(input.additionalContext);
    }

    parts.push("");
    parts.push("请严格按照输出格式 (JSON) 给出你的分析结果。只输出JSON，不要其他文字。");

    return parts.join("\n");
  }

  private loadFile(relativePath: string): string {
    const fullPath = join(PROMPTS_DIR, relativePath);
    if (!existsSync(fullPath)) return `[Prompt file not found: ${relativePath}]`;
    return readFileSync(fullPath, "utf-8");
  }

  /** Reload prompts from disk (after autoresearch modifies them). */
  reload(): void {
    this.personaCache.clear();
    this.regimeCache.clear();
    this.executionRules = this.loadFile("meta/execution_rules.md");
  }
}
