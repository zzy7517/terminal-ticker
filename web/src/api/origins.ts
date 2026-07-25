/** Origin Session HTTP client. */
import type {
  AgentSessionRun,
  OriginStreamEvent,
  OriginSessionHistoryResponse,
  OriginSessionResponse,
  StartOriginInput,
  StartOriginStreamResult,
} from '../types';
import { responseError } from './http';
import {
  AgentStreamDisconnectError,
  consumeRuntimeSessionStream,
  streamRuntimeSessionMessage,
  type ImageAttachment,
} from './agents';

const ORIGIN_SESSION_ID_HEADER = 'X-Origin-Session-Id';

export async function fetchOrigins(): Promise<OriginSessionHistoryResponse> {
  const response = await fetch('/api/origins');
  if (!response.ok) throw await responseError(response, 'Origins fetch failed');
  return response.json();
}

export async function fetchOrigin(sessionId: string): Promise<OriginSessionResponse> {
  const response = await fetch(`/api/origins/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw await responseError(response, 'Origin fetch failed');
  return response.json();
}

export async function fetchOriginRun(sessionId: string): Promise<{ run: AgentSessionRun }> {
  const response = await fetch(`/api/origins/${encodeURIComponent(sessionId)}/run`);
  if (!response.ok) throw await responseError(response, 'Origin run fetch failed');
  return response.json();
}

export async function deleteOrigin(sessionId: string): Promise<{ history: OriginSessionHistoryResponse }> {
  const response = await fetch(`/api/origins/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, 'Origin delete failed');
  return response.json();
}

export async function stopOrigin(sessionId: string): Promise<void> {
  const response = await fetch(`/api/origins/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'Origin stop failed');
}

export async function streamOriginMessage(
  sessionId: string,
  message: string,
  options: { images?: ImageAttachment[]; skillNames?: string[] } | undefined,
  onEvent: (event: OriginStreamEvent) => void,
): Promise<void> {
  return streamRuntimeSessionMessage<OriginSessionResponse, OriginSessionHistoryResponse>(
    `/api/origins/${encodeURIComponent(sessionId)}/messages/stream`,
    sessionId,
    message,
    options,
    onEvent,
  );
}

/** Materializes a draft and exposes its Session id before consuming any SSE event. */
export async function streamNewOrigin(
  input: StartOriginInput,
  onMaterialized: (sessionId: string) => void,
  onEvent: (event: OriginStreamEvent) => void,
): Promise<StartOriginStreamResult> {
  const body: Record<string, unknown> = {
    materializationId: input.materializationId,
    config: input.config,
    message: input.message,
  };
  if (input.images?.length) body.images = input.images;
  if (input.skillNames?.length) body.skillNames = input.skillNames;

  let response: Response;
  try {
    response = await fetch('/api/origins/messages/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new AgentStreamDisconnectError(error instanceof Error ? error.message : undefined);
  }
  if (response.status === 409) {
    const conflict = await readMaterializationConflict(response.clone());
    if (conflict) {
      return { kind: 'already-materialized', sessionId: conflict };
    }
  }
  if (!response.ok) throw await responseError(response, 'Origin start failed');

  const sessionId = response.headers.get(ORIGIN_SESSION_ID_HEADER)?.trim();
  if (!sessionId) throw new Error(`Origin start failed: missing ${ORIGIN_SESSION_ID_HEADER}`);
  onMaterialized(sessionId);
  await consumeRuntimeSessionStream<OriginSessionResponse, OriginSessionHistoryResponse>(
    response,
    sessionId,
    onEvent,
  );
  return { kind: 'streamed' };
}

async function readMaterializationConflict(response: Response): Promise<string | null> {
  try {
    const payload = await response.json() as { sessionId?: unknown };
    return typeof payload.sessionId === 'string' && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : null;
  } catch {
    return null;
  }
}
