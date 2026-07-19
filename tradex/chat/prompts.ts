/**
 * prompts — activation 用的无正文 wake 文本与操作说明。
 *
 * wake prompt 故意不含消息正文。Agent 必须调用 message_check / message_read。
 * stale notice 后空 check 视为成功。
 *
 * MESSAGE_OPERATING_INSTRUCTIONS 应放在 Runtime systemPrompt，不要每轮当 user 消息重复投递。
 * buildWakePrompt 带 ACTIVATION_WAKE_MARKER，遗留 Session→DM 导入会跳过。
 */
import type { InboxItem } from "./inbox-store.js";

/** 标记 activation user prompt，禁止导入 Shared DM。 */
export const ACTIVATION_WAKE_MARKER = "[tradex-activation-wake]";

export const MESSAGE_OPERATING_INSTRUCTIONS = `You are participating in Tradex Chat (Direct Messages and Channels).

Rules:
- Unread activity arrives as content-free notices. Use message tools to inspect inbox and targets.
- Only speak when you can advance the task, correct a fact, answer a direct question, or hand off work.
- Do not send pure acknowledgements ("got it", "I agree") with no new information.
- Do not reply just because another Agent spoke.
- Do not publish internal chain-of-thought to Channels or DMs.
- If message_check returns empty, treat that as success and stop.
- Prefer silence over noise.`;

/** 是否为 Coordinator activation 产生的内部 wake（含历史未打标版本）。 */
export function isActivationWakeContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(ACTIVATION_WAKE_MARKER)) return true;
  // 历史：ops instructions 曾整段塞进 user prompt 并被导入 DM。
  if (trimmed.startsWith("You are participating in Tradex Chat (Direct Messages and Channels).")) {
    return true;
  }
  return false;
}

/** 构造只含变化目标与游标的短 wake（不含正文、不含 ops 全文）。 */
export function buildWakePrompt(pending: InboxItem[]): string {
  const byTarget = new Map<string, InboxItem[]>();
  for (const item of pending) {
    const key = item.target.kind === "channel"
      ? `channel:${item.target.channelId}`
      : `dm:${item.target.directMessageId}`;
    const list = byTarget.get(key) ?? [];
    list.push(item);
    byTarget.set(key, list);
  }
  const lines = [
    ACTIVATION_WAKE_MARKER,
    `You have unread messages across ${byTarget.size} target${byTarget.size === 1 ? "" : "s"}. Inspect them at a natural breakpoint if useful.`,
    "Changed targets:",
  ];
  for (const [key, items] of byTarget) {
    const latest = items[items.length - 1]!;
    lines.push(
      `- ${key} reason=${latest.reason} first=${latest.firstMessageId} latest=${latest.latestMessageId} count=${items.length}`,
    );
  }
  lines.push("Call message_check, then message_read only for targets you decide to handle.");
  return lines.join("\n");
}
