/** Origin workspace navigation: keeps Origin selection and chat surface atomic. */
import { useAgentStore } from '../stores/agentStore';
import { useChatStore } from '../stores/chatStore';
import { useOriginStore } from '../stores/originStore';
import type { OriginDraft, OriginDraftConfig } from '../types';

export function initOriginWorkspace(): () => void {
  return useOriginStore.getState().init(() => useChatStore.getState().selectOrigin());
}

export function openNewOriginEntry(config?: Partial<OriginDraftConfig>): OriginDraft {
  const draft = useOriginStore.getState().newDraft(config);
  useChatStore.getState().selectOrigin();
  return draft;
}

export async function openOriginEntry(sessionId: string): Promise<void> {
  const load = useOriginStore.getState().select(sessionId);
  useChatStore.getState().selectOrigin();
  await load;
}

export async function deleteOriginEntry(sessionId: string): Promise<void> {
  const selection = useOriginStore.getState().selection;
  const activeTarget = useChatStore.getState().activeTarget;
  const wasActive = activeTarget?.kind === 'origin'
    && selection?.kind === 'session'
    && selection.sessionId === sessionId;
  const removed = await useOriginStore.getState().remove(sessionId);
  const currentSelection = useOriginStore.getState().selection;
  const stillOnClearedOrigin = useChatStore.getState().activeTarget?.kind === 'origin'
    && currentSelection === null;
  if (removed && wasActive && stillOnClearedOrigin) await selectOriginFallback();
}

async function selectOriginFallback(): Promise<void> {
  const agents = useAgentStore.getState();
  const directMessageId = agents.directMessageIdByAgentId[agents.selectedAgentId] ?? null;
  const nextOriginId = useOriginStore.getState().origins[0]?.id;
  if (nextOriginId) {
    await openOriginEntry(nextOriginId);
    return;
  }
  useChatStore.getState().leaveOrigin();
  if (directMessageId) useChatStore.getState().selectDirectMessage(directMessageId);
}
