/**
 * Raft-aligned quick reactions for Channel / DM message pickers.
 */
export const QUICK_REACTIONS = ['👍', '❤️', '🎉', '👀', '🔥', '😂', '✅'] as const;

export type QuickReaction = (typeof QUICK_REACTIONS)[number];

export interface ReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
}
