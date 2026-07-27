/** 将 Agent 事件写成支持取消的 Server-Sent Events。 */
export class AgentSseWriter {
  private readonly encoder = new TextEncoder();
  private seq = 0;
  private cancelled = false;

  /** 创建绑定到一个 Session/run 的 SSE 写入器。 */
  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
  ) {}

  /** 写入带递增序号的 SSE frame，客户端断开后自动忽略后续事件。 */
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

  /** 标记客户端已断开，阻止继续向已关闭的 stream 写入。 */
  cancel(): void {
    this.cancelled = true;
  }
}
