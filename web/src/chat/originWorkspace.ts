/** Origin workspace navigation: keeps Origin selection and chat surface atomic. */
import { useChatStore } from '../stores/chatStore';
import { useAgentStore } from '../stores/agentStore';
import { useOriginStore } from '../stores/originStore';
import { originFallbackTarget } from './originNavigation';

export async function openOriginEntry(sessionId: string): Promise<void> {
  useChatStore.getState().selectOrigin(sessionId);
  await useOriginStore.getState().select(sessionId);
}

export async function deleteOriginEntry(sessionId: string): Promise<void> {
  const activeTarget = useChatStore.getState().activeTarget;
  const wasActive = activeTarget?.kind === 'origin' && activeTarget.sessionId === sessionId;
  await useOriginStore.getState().remove(sessionId);
  if (wasActive) await selectOriginFallback();
}

async function selectOriginFallback(): Promise<void> {
  const agents = useAgentStore.getState();
  const directMessageId = agents.directMessageIdByAgentId[agents.selectedAgentId] ?? null;
  const target = originFallbackTarget(useOriginStore.getState().origins.map((item) => item.id), directMessageId);
  if (target?.kind === 'origin') {
    await openOriginEntry(target.sessionId);
    return;
  }
  useChatStore.getState().leaveOrigin();
  if (target?.kind === 'direct-message') useChatStore.getState().selectDirectMessage(target.directMessageId);
}
