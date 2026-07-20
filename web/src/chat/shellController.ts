/**
 * shellController — 可测试的 Chat 壳控制器（bootstrap / 选中 / 发送）。
 *
 * 生产适配器接 live Zustand；测试可注入 fake ports。
 */
import type { ChatTarget } from '../types';
import { useChatStore } from '../stores/chatStore';
import { openDirectMessageEntry } from './directMessageWorkspace';

/** Chat 壳依赖端口：init / 选 Channel / 开 DM / 发消息 / 读活动目标。 */
export interface ChatShellPorts {
  initChat: () => () => void;
  selectChannel: (channelId: string) => Promise<void>;
  openDirectMessageEntry: (agentId: string) => Promise<void>;
  sendChannelMessage: (content: string) => Promise<void>;
  getActiveTarget: () => ChatTarget | null;
}

/** 用 ports 组装薄控制器，便于单测。 */
export function createChatShellController(ports: ChatShellPorts) {
  return {
    start: () => ports.initChat(),
    openChannel: (channelId: string) => ports.selectChannel(channelId),
    openDirectMessage: (agentId: string) => ports.openDirectMessageEntry(agentId),
    send: (content: string) => ports.sendChannelMessage(content),
    activeTarget: () => ports.getActiveTarget(),
  };
}

/** 生产环境：接到 live Zustand stores。 */
export function createLiveChatShellController() {
  return createChatShellController({
    initChat: () => useChatStore.getState().initChat(),
    selectChannel: (channelId) => useChatStore.getState().selectChannel(channelId),
    openDirectMessageEntry,
    sendChannelMessage: (content) => useChatStore.getState().sendMessage(content),
    getActiveTarget: () => useChatStore.getState().activeTarget,
  });
}
