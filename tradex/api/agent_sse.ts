export class AgentSseWriter {
  private readonly encoder = new TextEncoder();
  private seq = 0;
  private cancelled = false;

  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
  ) {}

  send(controller: ReadableStreamDefaultController<Uint8Array>, event: Record<string, unknown>): void {
    if (this.cancelled) return;
    this.seq += 1;
    try {
      controller.enqueue(this.encoder.encode(`data: ${JSON.stringify({
        sessionId: this.sessionId,
        runId: this.runId,
        seq: this.seq,
        event,
      })}\n\n`));
    } catch {
      this.cancelled = true;
    }
  }

  cancel(): void {
    this.cancelled = true;
  }
}
