/** Origin Session HTTP client. */
import type {
  OriginStreamEvent,
  OriginSessionHistoryResponse,
  OriginSessionMutationResponse,
  OriginSessionResponse,
  CreateOriginInput,
} from '../types';
import { responseError } from './http';
import { streamRuntimeSessionMessage, type ImageAttachment } from './agents';

export async function fetchOrigins(): Promise<OriginSessionHistoryResponse> {
  const response = await fetch('/api/origins');
  if (!response.ok) throw await responseError(response, 'Origins fetch failed');
  return response.json();
}

export async function createOrigin(input: CreateOriginInput): Promise<OriginSessionMutationResponse> {
  const response = await fetch('/api/origins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Origin create failed');
  return response.json();
}

export async function fetchOrigin(sessionId: string): Promise<OriginSessionResponse> {
  const response = await fetch(`/api/origins/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw await responseError(response, 'Origin fetch failed');
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
