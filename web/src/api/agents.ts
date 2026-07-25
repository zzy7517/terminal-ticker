/** Agent 定义、Runtime Session、流式消息与模型目录客户端。 */
import type {
  AgentConfigUpdate,
  AgentDefinition,
  AgentDefinitionInput,
  AgentModelRegistry,
  AgentModelsResponse,
  AgentRuntimeStatus,
  AgentSessionHistoryResponse,
  AgentSessionMutationResponse,
  AgentSessionResponse,
  AgentStreamEvent,
  AgentStreamPayload,
  RuntimeSessionStreamEvent,
  RuntimeSessionStreamPayload,
  ClaudeCodeModelsResponse,
  CursorModelsResponse,
  MarketState,
  ProviderProfileUpdate,
} from '../types';
import { responseError } from './http';

export async function fetchAgents(): Promise<{ agents: AgentDefinition[] }> {
  const response = await fetch('/api/agents');
  if (!response.ok) throw await responseError(response, 'agents fetch failed');
  return response.json();
}

export async function fetchAgentRuntimes(): Promise<{ runtimes: AgentRuntimeStatus[] }> {
  const response = await fetch('/api/agent/runtimes');
  if (!response.ok) throw await responseError(response, 'agent runtimes fetch failed');
  return response.json();
}

export async function fetchClaudeCodeModels(): Promise<ClaudeCodeModelsResponse> {
  const response = await fetch('/api/agent/runtimes/claude-code/models');
  if (!response.ok) throw await responseError(response, 'Claude models fetch failed');
  return response.json();
}

export async function fetchCursorModels(): Promise<CursorModelsResponse> {
  const response = await fetch('/api/agent/runtimes/cursor/models');
  if (!response.ok) throw await responseError(response, 'Cursor models fetch failed');
  return response.json();
}

export async function createAgent(input: AgentDefinitionInput): Promise<{ agent: AgentDefinition; agents: AgentDefinition[] }> {
  const response = await fetch('/api/agents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'agent create failed');
  return response.json();
}

export async function updateAgent(id: string, input: Partial<AgentDefinitionInput>): Promise<{ agent: AgentDefinition; agents: AgentDefinition[] }> {
  const response = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'agent update failed');
  return response.json();
}

export async function deleteAgent(id: string): Promise<{ agents: AgentDefinition[] }> {
  const response = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, 'agent delete failed');
  return response.json();
}

// Lists all saved agent sessions for the decoupled chat workspace.
export async function fetchAgentSessions(): Promise<AgentSessionHistoryResponse> {
  const response = await fetch('/api/agent/sessions');
  if (!response.ok) {
    throw await responseError(response, 'agent sessions fetch failed');
  }
  return response.json();
}

// Creates a new decoupled agent session.
export async function createAgentSession(options?: {
  title?: string;
  agentId?: string;
}): Promise<AgentSessionResponse & { history: AgentSessionHistoryResponse }> {
  const response = await fetch('/api/agent/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options ?? {}),
  });
  if (!response.ok) {
    throw await responseError(response, 'agent session create failed');
  }
  return response.json();
}

// Loads an agent session by id.
export async function fetchAgentSession(key: string): Promise<AgentSessionResponse> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(key)}`);
  if (!response.ok) {
    throw await responseError(response, 'agent session fetch failed');
  }
  return response.json();
}

// Deletes a decoupled session by id.
export async function deleteAgentSessionById(sessionId: string): Promise<AgentSessionMutationResponse> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw await responseError(response, 'agent session delete failed');
  }
  return response.json();
}

export interface ImageAttachment {
  data: string;      // base64
  mimeType: string;  // image/png, image/jpeg, etc.
}

// 标识未收到终止帧的网络或 SSE 传输中断。
export class AgentStreamDisconnectError extends Error {
  // 构造可与后端业务错误区分的 Agent 流断线错误。
  constructor(message = 'agent stream disconnected before completion') {
    super(message);
    this.name = 'AgentStreamDisconnectError';
  }
}

export async function streamAgentMessage(
  key: string,
  message: string,
  options: { afterSeq?: number; images?: ImageAttachment[] } | undefined,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  return streamRuntimeSessionMessage(
    `/api/agent/sessions/${encodeURIComponent(key)}/messages/stream`,
    key,
    message,
    options,
    onEvent,
  );
}

/** Shared SSE transport for identity-bound Agent Sessions and Origins. */
export async function streamRuntimeSessionMessage<SessionResponse, HistoryResponse, State = undefined>(
  endpoint: string,
  key: string,
  message: string,
  options: { afterSeq?: number; images?: ImageAttachment[] } | undefined,
  onEvent: (event: RuntimeSessionStreamEvent<SessionResponse, HistoryResponse, State>) => void,
): Promise<void> {
  const body: Record<string, unknown> = { message };
  if (typeof options?.afterSeq === 'number') body.afterSeq = options.afterSeq;
  if (options?.images && options.images.length > 0) body.images = options.images;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new AgentStreamDisconnectError(error instanceof Error ? error.message : undefined);
  }
  if (!response.ok) {
    throw await responseError(response, 'agent stream failed');
  }
  if (!response.body) {
    throw new Error('agent stream failed: response body is empty');
  }
  const parseEvent = (data: string) => {
    const parsed = JSON.parse(data) as RuntimeSessionStreamEvent<SessionResponse, HistoryResponse, State> | RuntimeSessionStreamPayload<SessionResponse, HistoryResponse, State>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'event' in parsed &&
      parsed.event &&
      typeof parsed.event === 'object' &&
      'type' in parsed.event &&
      typeof parsed.event.type === 'string' &&
      typeof parsed.sessionId === 'string'
    ) {
      return parsed;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      typeof parsed.type === 'string'
    ) {
      return {
        sessionId: key,
        runId: '',
        seq: 0,
        event: parsed as RuntimeSessionStreamPayload<SessionResponse, HistoryResponse, State>,
      };
    }
    return {
      sessionId: key,
      runId: '',
      seq: 0,
      event: { type: 'error', error: 'Malformed agent stream event.' } satisfies RuntimeSessionStreamPayload<SessionResponse, HistoryResponse, State>,
    };
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminalFrameSeen = false;
  let errorFrameSeen = false;
  const emitEvent = (data: string) => {
    const event = parseEvent(data);
    if (event.event?.type === 'agent_end') terminalFrameSeen = true;
    if (event.event?.type === 'error') errorFrameSeen = true;
    onEvent(event);
  };
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new AgentStreamDisconnectError(error instanceof Error ? error.message : undefined);
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) emitEvent(data);
    }
  }
  buffer += decoder.decode();
  const data = buffer
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data) emitEvent(data);
  if (!terminalFrameSeen) {
    if (errorFrameSeen) throw new Error('agent stream ended after an error without a terminal frame');
    throw new AgentStreamDisconnectError();
  }
}

// Fetches model catalog for a specific provider.
export async function fetchProviderModels(provider: string): Promise<AgentModelsResponse> {
  const response = await fetch(`/api/agent/providers/${encodeURIComponent(provider)}/models`);
  if (!response.ok) {
    throw await responseError(response, 'provider model refresh failed');
  }
  return response.json();
}

export async function fetchAgentModelRegistry(): Promise<AgentModelRegistry> {
  const response = await fetch('/api/agent/model-registry');
  if (!response.ok) {
    throw await responseError(response, 'model registry fetch failed');
  }
  return response.json();
}

// Updates a single provider profile (enabled, model, reasoning effort).
export async function saveProviderProfile(
  provider: string,
  update: ProviderProfileUpdate,
): Promise<MarketState> {
  const response = await fetch(`/api/agent/providers/${encodeURIComponent(provider)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!response.ok) {
    throw await responseError(response, 'provider profile save failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Saves shared agent settings to the local watchlist configuration.
export async function saveAgentConfig(config: AgentConfigUpdate): Promise<MarketState> {
  const response = await fetch('/api/agent/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw await responseError(response, 'agent config save failed');
  }
  const payload = await response.json();
  return payload.state;
}
