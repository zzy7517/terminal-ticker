/** Cursor Session 的 runtime-specific 类型、目录和 `.cursor` workspace。 */
import os from "node:os";
import path from "node:path";
import { CURSOR_CLI_CAPABILITIES } from "../capabilities.js";
import {
  ExternalSessionStore,
  type ExternalAgentSnapshot,
  type ExternalProjectedMessage,
} from "../external-session-store.js";

export type CursorAgentSnapshot = ExternalAgentSnapshot<"cursor">;
export type CursorProjectedMessage = ExternalProjectedMessage;

export class CursorSessionStore extends ExternalSessionStore<"cursor", CursorAgentSnapshot> {
  constructor(root = path.join(os.homedir(), ".tradex", "cursor_sessions")) {
    super({
      root,
      runtime: "cursor",
      runtimeLabel: "Cursor",
      capabilities: CURSOR_CLI_CAPABILITIES,
      extraDirectories: [".cursor"],
    });
  }
}
