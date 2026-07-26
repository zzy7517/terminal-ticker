import { describe, expect, it } from 'vitest';
import { buildOriginTimeline, type OriginToolActivity } from './originTimeline';
import type { AgentMessage, AgentMessageMetadata } from '../types';

function message(
  id: string,
  role: AgentMessage['role'],
  content: string,
  metadata: AgentMessageMetadata | null = null,
): AgentMessage {
  return { id, sessionId: 'origin-1', role, content, createdAt: '2026-07-26T12:00:00.000Z', metadata, error: null };
}

describe('buildOriginTimeline', () => {
  it('resolves arguments from an assistant message that lands after the results', () => {
    // The external CLI adapter persists toolResults first and the assistant last.
    const items = buildOriginTimeline({
      messages: [
        message('m1', 'user', 'what is the working directory'),
        message('m2', 'toolResult', '{"stdout":"/tmp/session\\n"}', { toolCallId: 'call-1', toolName: 'shell' }),
        message('m3', 'assistant', 'It is /tmp/session.', {
          toolCalls: [{ id: 'call-1', name: 'shell', arguments: { command: 'pwd' } }],
        }),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(['message', 'tools', 'message']);
    const tools = items[1];
    if (tools.kind !== 'tools') throw new Error('expected a tool group');
    expect(tools.calls[0].arguments).toEqual({ command: 'pwd' });
  });

  it('groups consecutive tool results and splits on assistant text', () => {
    const items = buildOriginTimeline({
      messages: [
        message('m1', 'toolResult', 'a', { toolCallId: 'call-1', toolName: 'shell' }),
        message('m2', 'toolResult', 'b', { toolCallId: 'call-2', toolName: 'shell' }),
        message('m3', 'assistant', 'done'),
        message('m4', 'toolResult', 'c', { toolCallId: 'call-3', toolName: 'shell' }),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(['tools', 'message', 'tools']);
    const first = items[0];
    if (first.kind !== 'tools') throw new Error('expected a tool group');
    expect(first.calls).toHaveLength(2);
  });

  it('drops live activity once the same call is persisted', () => {
    const activity: OriginToolActivity[] = [
      { callId: 'call-1', name: 'shell', arguments: { command: 'pwd' }, output: '/tmp', isError: false },
    ];
    const items = buildOriginTimeline({
      messages: [message('m1', 'toolResult', '/tmp', { toolCallId: 'call-1', toolName: 'shell' })],
      activity,
    });

    expect(items).toHaveLength(1);
    const tools = items[0];
    if (tools.kind !== 'tools') throw new Error('expected a tool group');
    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0].key).toBe('m1');
  });

  it('marks live activity without a result as running', () => {
    const items = buildOriginTimeline({
      messages: [message('m1', 'user', 'run the tests')],
      activity: [
        { callId: 'call-1', name: 'shell', arguments: { command: 'npm test' }, output: null, isError: false },
      ],
    });

    const tools = items[1];
    if (tools.kind !== 'tools') throw new Error('expected a tool group');
    expect(tools.calls[0].running).toBe(true);
  });

  it('shows a recorded call whose result never arrived', () => {
    const items = buildOriginTimeline({
      messages: [
        message('m1', 'assistant', '', {
          toolCalls: [{ id: 'call-1', name: 'shell', arguments: { command: 'pwd' } }],
        }),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(['message', 'tools']);
    const tools = items[1];
    if (tools.kind !== 'tools') throw new Error('expected a tool group');
    expect(tools.calls[0].output).toBeUndefined();
  });

  it('falls back to the persisted tool name when arguments are missing', () => {
    const items = buildOriginTimeline({
      messages: [message('m1', 'toolResult', '{}', { toolCallId: 'call-9', toolName: 'grep' })],
    });

    const tools = items[0];
    if (tools.kind !== 'tools') throw new Error('expected a tool group');
    expect(tools.calls[0].name).toBe('grep');
  });
});
