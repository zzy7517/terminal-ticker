/** Claude Code Session 的 runtime-specific 类型与默认目录。 */
import os from "node:os";
import path from "node:path";
import { CLAUDE_CODE_CAPABILITIES } from "../capabilities.js";
import {
  ExternalSessionStore,
  type ExternalAgentSnapshot,
  type ExternalProjectedMessage,
} from "../external-session-store.js";

export type ClaudeAgentSnapshot = ExternalAgentSnapshot<"claude-code">;
export type ClaudeProjectedMessage = ExternalProjectedMessage;

export class ClaudeSessionStore extends ExternalSessionStore<"claude-code", ClaudeAgentSnapshot> {
  constructor(root = path.join(os.homedir(), ".tradex", "claude_sessions")) {
    super({
      root,
      runtime: "claude-code",
      runtimeLabel: "Claude",
      capabilities: CLAUDE_CODE_CAPABILITIES,
    });
  }
}
