import type { AppRuntime } from "../api/runtime.js";
import { channelTarget } from "../channel/domain.js";
import { startMessageActivation } from "./runtime.js";

const DEFAULT_DEBOUNCE_MS = 500;
const MAX_RETRY_MS = 300_000;

/**
 * Per-Agent single-flight scheduler for DM/Channel inbox activations.
 * Does not own message rules — only wake/debounce/retry/presence.
 */
export class AgentCoordinator {
  private readonly pending = new Set<string>();
  private readonly running = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retries = new Map<string, number>();
  private reminderTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly runtime: AppRuntime,
    private readonly debounceMs = DEFAULT_DEBOUNCE_MS,
  ) {}

  start(): void {
    this.started = true;
    for (const agent of this.runtime.agentStore.list()) {
      if (this.runtime.inboxStore.listPending(agent.id).length > 0) {
        this.notify(agent.id);
      }
    }
    this.reminderTimer = setInterval(() => this.pollReminders(), 5_000);
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
  }

  notify(agentId: string): void {
    if (!this.started || !agentId.trim()) return;
    const context = this.runtime.agentContextManager.ensure(agentId);
    if (context.paused) return;
    this.pending.add(agentId);
    const existing = this.timers.get(agentId);
    if (existing) clearTimeout(existing);
    this.timers.set(agentId, setTimeout(() => {
      this.timers.delete(agentId);
      void this.pump(agentId);
    }, this.debounceMs));
  }

  presence(agentId: string): { status: string; paused: boolean; running: boolean } {
    const context = this.runtime.agentContextManager.get(agentId);
    return {
      status: context?.status ?? "offline",
      paused: Boolean(context?.paused),
      running: this.running.has(agentId),
    };
  }

  async pause(agentId: string): Promise<void> {
    this.runtime.agentContextManager.updateStatus(agentId, { paused: true, status: "paused" });
    const sessionId = this.runtime.agentContextManager.get(agentId)?.activeSessionId;
    if (sessionId) this.runtime.activeAgents.get(sessionId)?.abort();
  }

  async resume(agentId: string): Promise<void> {
    this.runtime.agentContextManager.updateStatus(agentId, { paused: false, status: "idle", lastError: null });
    this.notify(agentId);
  }

  async abort(agentId: string): Promise<void> {
    const sessionId = this.runtime.agentContextManager.get(agentId)?.activeSessionId;
    if (sessionId) this.runtime.activeAgents.get(sessionId)?.abort();
    this.running.delete(agentId);
    this.runtime.agentContextManager.updateStatus(agentId, { status: "idle" });
  }

  private async pump(agentId: string): Promise<void> {
    if (!this.started || this.running.has(agentId)) return;
    const context = this.runtime.agentContextManager.ensure(agentId);
    if (context.paused) {
      this.pending.delete(agentId);
      return;
    }
    const pending = this.runtime.inboxStore.listPending(agentId);
    if (pending.length === 0) {
      this.pending.delete(agentId);
      return;
    }
    this.pending.delete(agentId);
    this.running.add(agentId);
    this.runtime.agentContextManager.updateStatus(agentId, {
      status: "active",
      lastActivationAtMs: Date.now(),
      lastError: null,
    });
    try {
      await startMessageActivation(this.runtime, agentId, pending);
      // Agent had a chance to process these items; auto-ack leftovers so
      // silence / missing message_mark_inbox cannot spin forever.
      for (const item of pending) {
        if (item.status !== "pending") continue;
        try {
          this.runtime.inboxStore.mark({ agentId, itemId: item.id, status: "read" });
        } catch {
          // Item may already be resolved by tools during the activation.
        }
      }
      this.retries.delete(agentId);
      this.runtime.agentContextManager.updateStatus(agentId, { status: "idle" });
    } catch (error) {
      const attempt = (this.retries.get(agentId) ?? 0) + 1;
      this.retries.set(agentId, attempt);
      const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(8, attempt));
      this.runtime.agentContextManager.updateStatus(agentId, {
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
      setTimeout(() => this.notify(agentId), delay);
    } finally {
      this.running.delete(agentId);
      if (this.pending.has(agentId) || this.runtime.inboxStore.listPending(agentId).length > 0) {
        this.notify(agentId);
      }
    }
  }

  private pollReminders(): void {
    if (!this.started) return;
    for (const reminder of this.runtime.channelStore.listDueReminders()) {
      if (!this.runtime.channelStore.markReminderTriggered(reminder.id)) continue;
      const target = channelTarget(reminder.channelId);
      this.runtime.inboxStore.notify({
        agentId: reminder.agentId,
        target,
        messageId: reminder.id,
        reason: "reminder",
      });
      this.notify(reminder.agentId);
    }
  }
}

export {
  appendChannelMessageAndNotify,
  appendHumanDmAndNotify,
  channelChatTarget,
  dispatchSharedMessage,
  humanDmTarget,
} from "./dispatch.js";
