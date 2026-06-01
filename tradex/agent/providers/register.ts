/**
 * register.ts — Bootstraps the API registry with built-in providers.
 *
 * Import this module once at startup to ensure Codex and Anthropic
 * stream functions are available via getApiStream().
 */

import { registerApiProvider } from "../api_registry.js";
import {
  CODEX_API_MODE,
  ANTHROPIC_MESSAGES_API_MODE,
  OPENAI_COMPLETIONS_API_MODE,
} from "../../config/agent_models.js";
import { streamCodex, listCodexModels } from "./codex.js";
import { streamAnthropic, listAnthropicModels } from "./anthropic.js";
import { streamOpenAICompletions, listOpenAICompletionsModels } from "./openai_completions.js";

export function registerBuiltInProviders(): void {
  registerApiProvider({
    api: CODEX_API_MODE,
    stream: streamCodex,
    listModels: listCodexModels,
  });

  registerApiProvider({
    api: ANTHROPIC_MESSAGES_API_MODE,
    stream: streamAnthropic,
    listModels: listAnthropicModels,
  });

  registerApiProvider({
    api: OPENAI_COMPLETIONS_API_MODE,
    stream: streamOpenAICompletions,
    listModels: listOpenAICompletionsModels,
  });
}

// Auto-register on import
registerBuiltInProviders();
