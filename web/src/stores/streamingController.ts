import type { AgentMessage, AgentStreamEvent } from '../types';

export const STREAM_COMMIT_TICK_MS = 8;
const STREAM_CATCH_UP_QUEUE_DEPTH = 8;
const STREAM_CATCH_UP_OLDEST_AGE_MS = 120;

export type StreamingRawMessage = Partial<AgentMessage> & {
  clientId?: string;
  role: AgentMessage['role'];
  content?: string;
};

interface QueuedStreamChunk {
  text: string;
  enqueuedAt: number;
}

export class StreamingMessageController {
  readonly id: number;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly clientId: string;
  role: AgentMessage['role'];
  metadata: AgentMessage['metadata'];
  error: string | null;
  runId: string;
  lastSeq: number;
  private source = '';
  private committedIndex = 0;
  private visibleContent = '';
  private queuedChunks: QueuedStreamChunk[] = [];

  constructor(
    raw: StreamingRawMessage,
    fallback: { id: number; sessionId: string; createdAt: string },
    envelope: Pick<AgentStreamEvent, 'runId' | 'seq'>,
  ) {
    this.id = typeof raw.id === 'number' ? raw.id : fallback.id;
    this.sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : fallback.sessionId;
    this.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : fallback.createdAt;
    this.clientId = raw.clientId ?? String(this.id);
    this.role = raw.role;
    this.metadata = raw.metadata ?? null;
    this.error = raw.error ?? null;
    this.runId = envelope.runId;
    this.lastSeq = envelope.seq;
  }

  update(raw: StreamingRawMessage, envelope: Pick<AgentStreamEvent, 'runId' | 'seq'>) {
    this.role = raw.role;
    this.metadata = raw.metadata ?? this.metadata;
    this.error = raw.error ?? this.error;
    this.runId = envelope.runId;
    this.lastSeq = envelope.seq;
  }

  pushDelta(delta: string | undefined, rawContent: string | undefined): boolean {
    let incoming = delta ?? '';
    if (!incoming && rawContent && rawContent.startsWith(this.source)) {
      incoming = rawContent.slice(this.source.length);
    }
    if (!incoming) return false;

    this.source += incoming;
    this.enqueueSource(incoming);
    this.committedIndex = this.source.length;
    return this.queuedChunks.length > 0;
  }

  drain(now: number, force = false): AgentMessage | null {
    if (this.queuedChunks.length === 0) return null;
    const oldestAge = now - this.queuedChunks[0].enqueuedAt;
    const catchUp = force
      || this.queuedChunks.length >= STREAM_CATCH_UP_QUEUE_DEPTH
      || oldestAge >= STREAM_CATCH_UP_OLDEST_AGE_MS;
    const count = catchUp ? this.queuedChunks.length : 1;
    const drained = this.queuedChunks.splice(0, count).map((chunk) => chunk.text).join('');
    if (!drained) return null;
    this.visibleContent += drained;
    return this.toMessage();
  }

  finalize(raw: StreamingRawMessage, envelope: Pick<AgentStreamEvent, 'runId' | 'seq'>): AgentMessage {
    this.update(raw, envelope);
    const finalContent = typeof raw.content === 'string' && (raw.content || !this.source)
      ? raw.content
      : this.source;
    this.source = finalContent;
    this.visibleContent = finalContent;
    this.committedIndex = finalContent.length;
    this.queuedChunks = [];
    return this.toMessage();
  }

  hasQueuedChunks() {
    return this.queuedChunks.length > 0;
  }

  toMessage(): AgentMessage {
    return {
      id: this.id,
      sessionId: this.sessionId,
      role: this.role,
      content: this.visibleContent,
      createdAt: this.createdAt,
      metadata: this.metadata,
      error: this.error,
    };
  }

  private enqueueSource(source: string) {
    const now = Date.now();
    if (source) this.queuedChunks.push({ text: source, enqueuedAt: now });
  }
}
