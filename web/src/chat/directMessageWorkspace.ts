/**
 * directMessageWorkspace — Agent ↔ Direct Message 身份深模块。
 *
 * 对外：解析 agentId ↔ directMessageId、打开 DM 入口、刷新时间线。
 * 对内：隐藏 agentStore / chatStore 双写编排，供侧栏与 Chat Event 恢复使用。
 */
import { useAgentStore } from '../stores/agentStore';
import { useChatStore } from '../stores/chatStore';

/** 从当前 workspace 映射反查 Direct Message 所属 Agent。 */
export function agentIdForDirectMessage(directMessageId: string): string | null {
  const map = useAgentStore.getState().directMessageIdByAgentId;
  for (const [agentId, id] of Object.entries(map)) {
    if (id === directMessageId) return agentId;
  }
  return null;
}

/** 刷新某 Agent 的 Shared Message Fabric DM 时间线。 */
export async function refreshDirectMessage(agentId: string): Promise<void> {
  await useAgentStore.getState().refreshAgentDirectMessages(agentId);
}

/**
 * 打开 Direct Message 入口：选中 Agent、加载 DM、设置 Chat Target。
 * 调用方不应自己操作两个 store。
 */
export async function openDirectMessageEntry(agentId: string): Promise<void> {
  await useAgentStore.getState().selectAgent(agentId);
  const directMessageId = useAgentStore.getState().directMessageIdByAgentId[agentId];
  if (directMessageId) {
    useChatStore.getState().selectDirectMessage(directMessageId);
  }
}

/**
 * Chat Event 恢复路径：给定 DM target id，刷新所属 Agent 的时间线。
 * 解析成功时返回 agentId。
 */
export async function recoverDirectMessageTarget(directMessageId: string): Promise<string | null> {
  let agentId = agentIdForDirectMessage(directMessageId);
  if (!agentId) {
    for (const agent of useAgentStore.getState().agents) {
      await refreshDirectMessage(agent.id);
      if (useAgentStore.getState().directMessageIdByAgentId[agent.id] === directMessageId) {
        agentId = agent.id;
        break;
      }
    }
  }
  if (!agentId) return null;
  await refreshDirectMessage(agentId);
  return agentId;
}
