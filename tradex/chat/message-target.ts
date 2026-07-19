import { channelTarget, directMessageTarget, type ChatTarget } from "../channel/domain.js";

export type MessageActor =
  | { type: "human"; id: string }
  | { type: "agent"; id: string };

export interface ParsedMessageTarget {
  chatTarget: ChatTarget;
  messageId: string | null;
  raw: string;
}

const CHANNEL_RE = /^#([a-z0-9]+(?:-[a-z0-9]+)*)(?::([0-9a-f-]{8,}))?$/i;
const DM_RE = /^dm:@([a-z0-9][a-z0-9_-]*)(?::([0-9a-f-]{8,}))?$/i;

export interface MessageTargetResolver {
  resolveChannelName(name: string): string | null;
  resolveDirectMessage(actor: MessageActor, recipientHandle: string): string | null;
}

/** Parse Agent-facing Message Target strings into trusted ChatTargets at the tool boundary. */
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

export function formatChannelTarget(name: string, messageId?: string | null): string {
  return messageId ? `#${name}:${messageId}` : `#${name}`;
}

export function formatDmTarget(handle: string, messageId?: string | null): string {
  return messageId ? `dm:@${handle}:${messageId}` : `dm:@${handle}`;
}
