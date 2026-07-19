/**
 * timeline — Channel / DM 时间线投影辅助。
 *
 * API 分页为 newest-first，UI 时间线为 oldest→newest；
 * 另提供未读计数查找与前端 ChatTarget 构造。
 */
import type { ChatTarget, ChatUnreadEntry } from '../types';

/** API 页是 newest-first；UI 时间线转为 oldest→newest。 */
export function chronologicalMessages<T>(messages: T[]): T[] {
  return [...messages].reverse();
}

/** 从 unread 列表查找某 ChatTarget 的未读数。 */
export function unreadCountForTarget(
  unread: ChatUnreadEntry[],
  target: ChatTarget,
): number {
  const entry = unread.find((item) => {
    if (item.target.kind !== target.kind) return false;
    if (target.kind === 'channel' && item.target.kind === 'channel') {
      return item.target.channelId === target.channelId;
    }
    if (target.kind === 'direct-message' && item.target.kind === 'direct-message') {
      return item.target.directMessageId === target.directMessageId;
    }
    return false;
  });
  return entry?.unreadCount ?? 0;
}

/** 构造 Channel ChatTarget。 */
export function channelTarget(channelId: string): ChatTarget {
  return { kind: 'channel', channelId };
}

/** 构造 Direct Message ChatTarget。 */
export function directMessageTarget(directMessageId: string): ChatTarget {
  return { kind: 'direct-message', directMessageId };
}
