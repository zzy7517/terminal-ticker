import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OriginStreamEvent, StartOriginInput } from '../types';
import { HttpResponseError } from './http';
import { streamNewOrigin, streamOriginMessage } from './origins';

const INPUT: StartOriginInput = {
  materializationId: 'draft-1',
  config: { runtime: 'pi', provider: null, model: null, reasoningEffort: null },
  message: 'hello',
  images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
  skillNames: ['codebase-design'],
};

afterEach(() => vi.unstubAllGlobals());

describe('Origin start transport', () => {
  it('reports the materialized Session before consuming SSE events', async () => {
    const envelope: OriginStreamEvent = {
      sessionId: 'origin-1',
      runId: 'run-1',
      seq: 1,
      event: { type: 'agent_end', error: null },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      `data: ${JSON.stringify(envelope)}\n\n`,
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'X-Origin-Session-Id': 'origin-1',
        },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const order: string[] = [];

    const result = await streamNewOrigin(
      INPUT,
      (sessionId) => order.push(`materialized:${sessionId}`),
      (event) => order.push(`event:${event.event.type}`),
    );

    expect(result).toEqual({ kind: 'streamed' });
    expect(order).toEqual(['materialized:origin-1', 'event:agent_end']);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual(INPUT);
  });

  it('surfaces an already materialized id from a 409 without consuming it as SSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(
      { detail: 'already materialized', sessionId: 'origin-existing' },
      { status: 409 },
    )));
    const materialized: string[] = [];
    const onEvent = vi.fn();

    await expect(streamNewOrigin(INPUT, (id) => materialized.push(id), onEvent)).resolves.toEqual({
      kind: 'already-materialized',
      sessionId: 'origin-existing',
    });
    expect(materialized).toEqual([]);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('rejects a successful response that omits the materialization header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    const onMaterialized = vi.fn();

    await expect(streamNewOrigin(INPUT, onMaterialized, vi.fn())).rejects.toThrow(
      'missing X-Origin-Session-Id',
    );
    expect(onMaterialized).not.toHaveBeenCalled();
  });

  it('preserves the HTTP status when a continuation is rejected before SSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(
      { detail: 'a Runtime run is already active for this Session' },
      { status: 409 },
    )));

    const error = await streamOriginMessage('origin-1', 'retry', undefined, vi.fn())
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HttpResponseError);
    expect(error).toMatchObject({ status: 409 });
  });
});
