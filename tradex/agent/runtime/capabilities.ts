/** Pi 与 Claude Code Runtime 的能力矩阵。 */
import type { RuntimeCapabilities } from "./types.js";

export const PI_SDK_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  abort: true,
  steer: true,
  resume: true,
  forkFromMessage: true,
  cloneFromMessage: true,
  imageInput: true,
  toolProgress: true,
};

export const CLAUDE_CODE_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  abort: true,
  steer: false,
  resume: true,
  forkFromMessage: false,
  cloneFromMessage: false,
  imageInput: true,
  toolProgress: false,
};
