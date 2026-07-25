import type { ChatSurfaceTarget } from '../types';

/** Pure navigation rule used after an Origin leaves the active list. */
export function originFallbackTarget(
  remainingOriginIds: readonly string[],
  selectedDirectMessageId: string | null,
): ChatSurfaceTarget | null {
  if (remainingOriginIds[0]) return { kind: 'origin', sessionId: remainingOriginIds[0] };
  if (selectedDirectMessageId) return { kind: 'direct-message', directMessageId: selectedDirectMessageId };
  return null;
}
