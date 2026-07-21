/** Shared Message Fabric 客户端：Direct Message、Channel、Chat 事件与 Agent 生命周期。 */
import type {
  AgentDirectMessage,
  AgentDirectMessageResponse,
  AgentPresence,
  Channel,
  ChannelHeldDraft,
  ChannelMember,
  ChannelMessage,
  ChannelMessagesResponse,
  ChatBootstrapResponse,
  ChatEvent,
  ChatTarget,
  ChatUnreadEntry,
} from '../types';
import { responseError } from './http';

export async function fetchAgentDirectMessages(agentId: string): Promise<AgentDirectMessageResponse> {
  const response = await fetch(`/api/chat/agents/${encodeURIComponent(agentId)}/messages`);
  if (!response.ok) throw await responseError(response, 'Agent Direct Messages fetch failed');
  return response.json();
}

export async function sendAgentDirectMessage(
  agentId: string,
  content: string,
  images?: Array<{ data: string; mimeType: string }>,
): Promise<{ message: AgentDirectMessage; target: { kind: 'direct-message'; directMessageId: string } }> {
  const response = await fetch(`/api/chat/agents/${encodeURIComponent(agentId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, images: images?.length ? images : undefined }),
  });
  if (!response.ok) throw await responseError(response, 'Agent Direct Message send failed');
  return response.json();
}

export async function setDirectMessageReaction(
  agentId: string,
  messageId: string,
  emoji: string,
  active: boolean,
): Promise<{ message: AgentDirectMessage }> {
  const response = await fetch(
    `/api/chat/agents/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: active ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    },
  );
  if (!response.ok) throw await responseError(response, 'Direct Message reaction failed');
  return response.json();
}

export async function fetchChatBootstrap(): Promise<ChatBootstrapResponse> {
  const response = await fetch('/api/chat/bootstrap');
  if (!response.ok) throw await responseError(response, 'Chat bootstrap failed');
  return response.json();
}

export function connectChatEvents(
  afterSeq: number,
  onEvent: (event: ChatEvent) => void,
  onStatus: (status: 'connected' | 'disconnected' | 'error') => void,
): () => void {
  const source = new EventSource(`/api/chat/events?after_seq=${Math.max(0, Math.floor(afterSeq))}`);
  source.addEventListener('open', () => onStatus('connected'));
  source.addEventListener('error', () => onStatus('error'));
  source.addEventListener('chat', (frame) => {
    try {
      onEvent(JSON.parse((frame as MessageEvent<string>).data) as ChatEvent);
    } catch {
      onStatus('error');
    }
  });
  return () => {
    source.close();
    onStatus('disconnected');
  };
}

export async function createChannel(input: { name: string; topic?: string }): Promise<{ channel: Channel; channels: Channel[] }> {
  const response = await fetch('/api/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Channel create failed');
  return response.json();
}

export async function fetchChannelMembers(channelId: string): Promise<{ members: ChannelMember[] }> {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/members`);
  if (!response.ok) throw await responseError(response, 'Channel members fetch failed');
  return response.json();
}

export async function addChannelMember(
  channelId: string,
  input: { subjectType: 'human' | 'agent'; subjectId: string },
): Promise<{ members: ChannelMember[] }> {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Channel member add failed');
  return response.json();
}

export async function removeChannelMember(
  channelId: string,
  input: { subjectType: 'human' | 'agent'; subjectId: string },
): Promise<{ members: ChannelMember[] }> {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/members`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Channel member remove failed');
  return response.json();
}

export async function fetchChannelDrafts(channelId: string): Promise<{ drafts: ChannelHeldDraft[] }> {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/drafts`);
  if (!response.ok) throw await responseError(response, 'Channel drafts fetch failed');
  return response.json();
}

export async function discardChannelDraft(
  channelId: string,
  draftId: string,
): Promise<{ draft: ChannelHeldDraft }> {
  const response = await fetch(
    `/api/channels/${encodeURIComponent(channelId)}/drafts/${encodeURIComponent(draftId)}/discard`,
    { method: 'POST' },
  );
  if (!response.ok) throw await responseError(response, 'Channel draft discard failed');
  return response.json();
}

export async function fetchAgentPresence(): Promise<{ agents: AgentPresence[] }> {
  const response = await fetch('/api/chat/agents/status');
  if (!response.ok) throw await responseError(response, 'Agent presence fetch failed');
  return response.json();
}

export async function pauseChatAgent(agentId: string): Promise<void> {
  const response = await fetch(`/api/chat/agents/${encodeURIComponent(agentId)}/pause`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'Agent pause failed');
}

export async function resumeChatAgent(agentId: string): Promise<void> {
  const response = await fetch(`/api/chat/agents/${encodeURIComponent(agentId)}/resume`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'Agent resume failed');
}

export async function resetChatAgent(
  agentId: string,
  mode: 'restart' | 'session-reset' | 'full-reset',
): Promise<{ mode: string; sessionId: string | null }> {
  const response = await fetch(`/api/chat/agents/${encodeURIComponent(agentId)}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw await responseError(response, 'Agent reset failed');
  return response.json();
}

export async function markChatUnreadRead(input: {
  target: ChatTarget;
  seq: number;
  messageId?: string | null;
}): Promise<{ unread: ChatUnreadEntry[] }> {
  const response = await fetch('/api/chat/unread/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Unread mark failed');
  return response.json();
}

export async function fetchChannelMessages(channelId: string, beforeSeq?: number): Promise<ChannelMessagesResponse> {
  const query = beforeSeq ? `?before_seq=${encodeURIComponent(String(beforeSeq))}` : '';
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/messages${query}`);
  if (!response.ok) throw await responseError(response, 'Channel messages fetch failed');
  return response.json();
}

export async function sendChannelMessage(channelId: string, content: string): Promise<{ message: ChannelMessage; channel: Channel }> {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw await responseError(response, 'Channel message send failed');
  return response.json();
}

export async function setChannelReaction(messageId: string, emoji: string, active: boolean): Promise<{ message: ChannelMessage; channel: Channel }> {
  const response = await fetch(`/api/channels/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: active ? 'POST' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji }),
  });
  if (!response.ok) throw await responseError(response, 'Channel reaction failed');
  return response.json();
}
