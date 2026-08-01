/**
 * message-target — 把 Agent 侧 target 字符串解析为可信 ChatTarget。
 *
 * 示例：`#btc-research`、`#btc-research:<messageId>`、`dm:@owner`、`dm:@alpha`。
 * 只在工具边界用 resolver 查真实 Channel/DM id；Agent 不能单靠伪造 UUID 造 ChatTarget。
 */
import { channelTarget, directMessageTarget, type ChatTarget } from "./target.js";

/** 解析时的调用方身份（Human 或 Agent）。 */
export type MessageActor =
  | { type: "human"; id: string }
  | { type: "agent"; id: string };

/** 解析结果：内部 ChatTarget + 可选 messageId（around 定位）。 */
export interface ParsedMessageTarget {
  chatTarget: ChatTarget;
  /** `:` 后可选的 message id，用于 around 定位。 */
  messageId: string | null;
  raw: string;
}

const CHANNEL_RE = /^#([a-z0-9]+(?:-[a-z0-9]+)*)(?::([0-9a-f-]{8,}))?$/i;
const DM_RE = /^dm:@([a-z0-9][a-z0-9_-]*)(?::([0-9a-f-]{8,}))?$/i;

/** 名称/句柄 → 真实 id 的解析依赖（由 tools 注入）。 */
export interface MessageTargetResolver {
  resolveChannelName(name: string): string | null;
  resolveDirectMessage(actor: MessageActor, recipientHandle: string): string | null;
}

/** 在工具边界把 Agent 侧 Message Target 解析为可信 ChatTarget。 */
export function parseMessageTarget(
  raw: string,
  actor: MessageActor,
  resolver: MessageTargetResolver,
): ParsedMessageTarget {
  const value = raw.trim();
  if (!value) throw new Error("message target is required");

  const channel = CHANNEL_RE.exec(value);
  if (channel) {
    const channelId = resolver.resolveChannelName(channel[1].toLowerCase());
    if (!channelId) throw new Error(`unknown channel: #${channel[1]}`);
    return {
      chatTarget: channelTarget(channelId),
      messageId: channel[2] ?? null,
      raw: value,
    };
  }

  const dm = DM_RE.exec(value);
  if (dm) {
    const directMessageId = resolver.resolveDirectMessage(actor, dm[1]);
    if (!directMessageId) throw new Error(`unknown dm recipient: @${dm[1]}`);
    return {
      chatTarget: directMessageTarget(directMessageId),
      messageId: dm[2] ?? null,
      raw: value,
    };
  }

  throw new Error(`invalid message target: ${value}`);
}
