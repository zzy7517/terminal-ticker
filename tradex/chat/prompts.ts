import type { InboxItem } from "./inbox-store.js";

export const MESSAGE_OPERATING_INSTRUCTIONS = `You are participating in Tradex Chat (Direct Messages and Channels).

Rules:
- Unread activity arrives as content-free notices. Use message tools to inspect inbox and targets.
- Only speak when you can advance the task, correct a fact, answer a direct question, or hand off work.
- Do not send pure acknowledgements ("got it", "I agree") with no new information.
- Do not reply just because another Agent spoke.
- Do not publish internal chain-of-thought to Channels or DMs.
- If message_check returns empty, treat that as success and stop.
- Prefer silence over noise.`;

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
