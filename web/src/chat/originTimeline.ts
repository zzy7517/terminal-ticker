/**
 * Projects Origin messages into timeline items, folding tool calls out of the
 * message stream and into grouped rows.
 *
 * Tool call arguments and their results live in different messages, and not in a
 * fixed order: the external CLI adapter persists every `toolResult` first and the
 * assistant message carrying `metadata.toolCalls` last
 * (`tradex/api/external-cli-turn.ts`). So arguments are resolved from an index
 * built over the whole transcript rather than from a neighbouring message.
 */
import type { OriginToolViewInput } from './originToolDisplay';
import type { AgentMessage, AgentToolCall } from '../types';

/** A tool call observed live over the stream, before it is persisted. */
export interface OriginToolActivity {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  output: string | null;
  isError: boolean;
}

export type OriginTimelineItem =
  | { kind: 'message'; key: string; message: AgentMessage }
  | { kind: 'tools'; key: string; calls: Array<OriginToolViewInput & { key: string }> };

export function buildOriginTimeline(input: {
  messages: AgentMessage[];
  activity?: OriginToolActivity[];
  workspace?: string | null;
}): OriginTimelineItem[] {
  const workspace = input.workspace ?? null;
  const callsById = indexToolCalls(input.messages);
  const items: OriginTimelineItem[] = [];
  const resolved = new Set<string>();

  for (const message of input.messages) {
    const key = String(message.id);
    if (message.role !== 'toolResult') {
      items.push({ kind: 'message', key, message });
      continue;
    }
    const callId = readString(message.metadata?.toolCallId);
    if (callId) resolved.add(callId);
    const call = callId ? callsById.get(callId) : undefined;
    appendCall(items, {
      key,
      name: call?.name ?? readString(message.metadata?.toolName) ?? 'tool',
      arguments: call?.arguments ?? null,
      output: message.content,
      isError: Boolean(message.metadata?.error) || Boolean(message.error),
      workspace,
    });
  }

  const activity = input.activity ?? [];
  const liveIds = new Set(activity.map((entry) => entry.callId));
  // A call the transcript records but never resolves — an interrupted run.
  for (const [callId, call] of callsById) {
    if (resolved.has(callId) || liveIds.has(callId)) continue;
    appendCall(items, {
      key: `call:${callId}`,
      name: call.name,
      arguments: call.arguments,
      workspace,
    });
  }

  for (const entry of activity) {
    // The persisted result already covers this call; showing both would duplicate it.
    if (resolved.has(entry.callId)) continue;
    appendCall(items, {
      key: `activity:${entry.callId}`,
      name: entry.name,
      arguments: entry.arguments,
      output: entry.output,
      isError: entry.isError,
      running: entry.output === null,
      workspace,
    });
  }

  return items;
}

/** Consecutive tool calls share one group so the timeline stays compact. */
function appendCall(
  items: OriginTimelineItem[],
  call: OriginToolViewInput & { key: string },
): void {
  const last = items[items.length - 1];
  if (last?.kind === 'tools') {
    last.calls.push(call);
    return;
  }
  items.push({ kind: 'tools', key: `tools:${call.key}`, calls: [call] });
}

function indexToolCalls(messages: AgentMessage[]): Map<string, AgentToolCall> {
  const callsById = new Map<string, AgentToolCall>();
  for (const message of messages) {
    for (const call of message.metadata?.toolCalls ?? []) {
      if (call?.id) callsById.set(call.id, call);
    }
  }
  return callsById;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
