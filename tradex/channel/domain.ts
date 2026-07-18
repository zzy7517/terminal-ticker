export type ChatTarget =
  | { kind: "direct-chat"; agentId: string; chatId: string }
  | { kind: "channel"; channelId: string };

export interface Channel {
  id: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  version: number;
  createdAtMs: number;
  archivedAtMs: number | null;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  channelSeq: number;
  authorType: "human" | "agent" | "system";
  authorId: string;
  kind: "message" | "system";
  content: string;
  threadRootId: string | null;
  createdAtMs: number;
}
