/**
 * referenceResolver — Saved / Pinned 引用解析与导航。
 *
 * 打开引用时主动加载目标时间线，不依赖缓存是否碰巧命中。
 */
import { useAgentStore } from '../stores/agentStore';
import { useChatStore } from '../stores/chatStore';
import type { ChatMessageReference } from '../types';
import { agentIdForDirectMessage, openDirectMessageEntry, refreshDirectMessage } from './directMessageWorkspace';

/** 列表展示用的引用投影（未加载时可显示占位文案）。 */
export interface ReferenceProjection {
  label: string;
  content: string;
}

/** 把引用投影为列表展示文案。 */
export function projectReference(reference: ChatMessageReference): ReferenceProjection {
  const chat = useChatStore.getState();
  const agents = useAgentStore.getState();
  if (reference.target.kind === 'channel') {
    const channelId = reference.target.channelId;
    const channel = chat.channels.find((entry) => entry.id === channelId);
    const message = chat.messagesByChannelId[channelId]?.find((entry) => entry.id === reference.messageId);
    return {
      label: `#${channel?.name ?? 'Channel'}`,
      content: message?.content || 'Open Channel to load this message',
    };
  }
  const directMessageId = reference.target.directMessageId;
  const agentId = agentIdForDirectMessage(directMessageId) ?? 'Agent';
  const message = agents.directMessagesByAgentId[agentId]?.find((entry) => entry.id === reference.messageId);
  const agent = agents.agents.find((entry) => entry.id === agentId);
  return {
    label: agent?.name ?? agentId,
    content: message?.content || 'Open Direct Message to load this message',
  };
}

/** 导航到引用目标并确保其时间线已加载。 */
export async function openReference(reference: ChatMessageReference): Promise<void> {
  if (reference.target.kind === 'channel') {
    await useChatStore.getState().selectChannel(reference.target.channelId);
    return;
  }
  const directMessageId = reference.target.directMessageId;
  let agentId = agentIdForDirectMessage(directMessageId);
  if (!agentId) {
    // Cold map: try each agent until DM id matches (bounded by agent count).
    for (const agent of useAgentStore.getState().agents) {
      await refreshDirectMessage(agent.id);
      if (useAgentStore.getState().directMessageIdByAgentId[agent.id] === directMessageId) {
        agentId = agent.id;
        break;
      }
    }
  }
  if (agentId) {
    await openDirectMessageEntry(agentId);
  } else {
    useChatStore.getState().selectDirectMessage(directMessageId);
  }
}
