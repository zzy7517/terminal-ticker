/**
 * AgentCoordinator — Shared Message Fabric 的 per-Agent 激活调度器。
 *
 * 负责：debounce、single-flight、重试退避、presence、reminder 轮询、因果链 hop 上限。
 * 不负责：消息/inbox 写入规则（见 dispatch.ts / InboxStore）或 Runtime 执行（见 runtime.ts）。
 *
 * wake 投递为 at-least-once；inbox 状态迁移仍由 InboxStore 承担。
 * 多条 pending inbox 合并为一次 activation（短 wake），失败只走指数退避，不再 finally 立刻重唤醒。
 */
import type { AppRuntime } from "../api/runtime.js";
import { channelTarget, chatTargetRef, type ChatTarget } from "../channel/domain.js";
import type { InboxItem, InboxStatus } from "./inbox-store.js";
import { startMessageActivation } from "./runtime.js";

const DEFAULT_DEBOUNCE_MS = 500;
/** 连续 activation 失败后停止自动重试，等待 Human pause/resume 或新消息。 */
const MAX_ACTIVATION_RETRIES = 3;

/**
 * 尝试迁移 inbox 状态。已非 pending 时返回 false（竞态正常）；
 * 其它失败记 warn，不吞掉上下文。
 */
function tryMarkInbox(
  runtime: AppRuntime,
  agentId: string,
  itemId: string,
  status: Exclude<InboxStatus, "pending">,
  context: string,
): boolean {
  try {
    const current = runtime.inboxStore.listForAgent(agentId).find((row) => row.id === itemId);
    if (!current) return false;
    if (current.status !== "pending") return false;
    runtime.inboxStore.mark({ agentId, itemId, status });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[coordinator] ${context} failed for ${agentId}/${itemId}: ${detail}`);
    return false;
  }
}

/**
 * Per-Agent single-flight scheduler for DM/Channel inbox activations.
 * Does not own message rules — only wake/debounce/retry/presence/causal hops.
 */
export class AgentCoordinator {
  /** 已合并、等待 debounce 触发的 Agent。 */
  private readonly pending = new Set<string>();
  /** 当前正在 activation 中的 Agent（single-flight）。 */
  private readonly running = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retries = new Map<string, number>();
  /** 自上次 Human reset 以来，每个 ChatTarget 的 activation hop 计数。 */
  private readonly chainHops = new Map<string, number>();
  /** 已超过 maxActivationHops、等待 Human reset 的目标。 */
  private readonly pausedChains = new Set<string>();
  /** 因果链暂停时 system notice 的去重集合。 */
  private readonly chainNotices = new Set<string>();
  private reminderTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly runtime: AppRuntime,
    private readonly debounceMs = DEFAULT_DEBOUNCE_MS,
  ) {}

  /** 恢复未处理 inbox，并启动 reminder 轮询。 */
  start(): void {
    this.started = true;
    for (const agent of this.runtime.agentStore.list()) {
      if (this.runtime.inboxStore.listPending(agent.id).length > 0) {
        this.notify(agent.id);
      }
    }
    this.pollReminders();
    this.reminderTimer = setInterval(() => this.pollReminders(), 5_000);
  }

  /** 停止定时器；进行中的 activation 不在此 abort（请用 abort/pause）。 */
  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.pending.clear();
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
  }

  /** Human 活动会重置该目标的因果链。 */
  resetChain(target: ChatTarget): void {
    const key = chatTargetRef(target);
    this.chainHops.set(key, 0);
    this.pausedChains.delete(key);
    this.chainNotices.delete(key);
  }

  /**
   * 为单个 Agent 安排 debounce 后的 activation。
   * debounceMs 内的多次 notify 会合并为一次 pump。
   */
  notify(agentId: string): void {
    if (!this.started || !agentId.trim()) return;
    const context = this.runtime.agentContextManager.ensure(agentId);
    if (context.paused) return;
    // 自动重试耗尽后，新的外部 notify（Human 消息等）重新给满预算。
    if ((this.retries.get(agentId) ?? 0) >= MAX_ACTIVATION_RETRIES) {
      this.retries.delete(agentId);
    }
    this.pending.add(agentId);
    const existing = this.timers.get(agentId);
    if (existing) clearTimeout(existing);
    this.timers.set(agentId, setTimeout(() => {
      this.timers.delete(agentId);
      void this.pump(agentId);
    }, this.debounceMs));
  }

  /** 给 UI 用的 Coordinator presence；不同于 Runtime session 的 runState。 */
  presence(agentId: string): {
    status: string;
    paused: boolean;
    running: boolean;
    lastActivationAtMs: number | null;
    lastError: string | null;
  } {
    const context = this.runtime.agentContextManager.get(agentId);
    return {
      status: context?.status ?? "offline",
      paused: Boolean(context?.paused),
      running: this.running.has(agentId),
      lastActivationAtMs: context?.lastActivationAtMs ?? null,
      lastError: context?.lastError ?? null,
    };
  }

  /** 持久化 paused=true，并 abort 该 Agent 当前 Runtime run。 */
  async pause(agentId: string): Promise<void> {
    this.clearRetry(agentId);
    this.pending.delete(agentId);
    const debounce = this.timers.get(agentId);
    if (debounce) {
      clearTimeout(debounce);
      this.timers.delete(agentId);
    }
    this.runtime.agentContextManager.updateStatus(agentId, { paused: true, status: "paused" });
    this.runtime.agentContextManager.abortActiveRun(agentId, this.runtime.activeAgents);
  }

  /** 清除 pause；若仍有 pending inbox 则重新 notify。 */
  async resume(agentId: string): Promise<void> {
    this.retries.delete(agentId);
    this.clearRetry(agentId);
    this.runtime.agentContextManager.updateStatus(agentId, { paused: false, status: "idle", lastError: null });
    this.notify(agentId);
  }

  /** abort 当前 Runtime run，但不永久 pause Agent；并取消排队中的自动重试。 */
  async abort(agentId: string): Promise<void> {
    this.clearRetry(agentId);
    this.pending.delete(agentId);
    const debounce = this.timers.get(agentId);
    if (debounce) {
      clearTimeout(debounce);
      this.timers.delete(agentId);
    }
    this.runtime.agentContextManager.abortActiveRun(agentId, this.runtime.activeAgents);
    this.running.delete(agentId);
    this.runtime.agentContextManager.updateStatus(agentId, { status: "idle" });
  }

  /**
   * 最多跑一次 activation：过滤因果链 → 唤醒 Runtime → 对本轮 wake 残留项 auto-ack，
   * 避免沉默导致死循环。失败时保留 pending inbox，并按指数退避重试（finally 不立刻重唤醒）。
   */
  private async pump(agentId: string): Promise<void> {
    if (!this.started || this.running.has(agentId)) return;
    const context = this.runtime.agentContextManager.ensure(agentId);
    if (context.paused) {
      this.pending.delete(agentId);
      return;
    }
    const maxActive = this.runtime.config.channels.maxActiveAgents;
    if (this.running.size >= maxActive) {
      // 全局并发已满：保持 pending，稍后再试，避免饿死。
      this.timers.set(agentId, setTimeout(() => {
        this.timers.delete(agentId);
        void this.pump(agentId);
      }, Math.max(100, this.debounceMs)));
      return;
    }
    const pending = this.runtime.inboxStore.listPending(agentId);
    if (pending.length === 0) {
      this.pending.delete(agentId);
      return;
    }

    const allowed = this.filterByCausalChain(agentId, pending);
    if (allowed.length === 0) {
      this.pending.delete(agentId);
      return;
    }

    const claimedTargets = this.claimTargetsForActivation(allowed);
    const runnable = allowed.filter((item) => !this.pausedChains.has(chatTargetRef(item.target)));
    for (const item of allowed) {
      if (!this.pausedChains.has(chatTargetRef(item.target))) continue;
      tryMarkInbox(this.runtime, agentId, item.id, "deferred", "defer paused-chain inbox");
    }
    if (runnable.length === 0) {
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
    let failed = false;
    try {
      await startMessageActivation(this.runtime, agentId, runnable);
      // 只对本轮 wake 带入的项 auto-ack，避免沉默导致无限重跑。
      for (const item of runnable) {
        const latest = this.runtime.inboxStore.listForAgent(agentId).find((row) => row.id === item.id);
        if (!latest || latest.status !== "pending") continue;
        tryMarkInbox(this.runtime, agentId, item.id, "read", "auto-ack after activation");
      }
      this.retries.delete(agentId);
      this.runtime.agentContextManager.updateStatus(agentId, { status: "idle" });
    } catch (error) {
      failed = true;
      // 失败重试不应消耗因果链预算。
      this.releaseClaimedTargets(claimedTargets);
      const attempt = (this.retries.get(agentId) ?? 0) + 1;
      this.retries.set(agentId, attempt);
      const detail = error instanceof Error ? error.message : String(error);
      this.runtime.agentContextManager.updateStatus(agentId, {
        status: "error",
        lastError: detail,
      });
      if (attempt < MAX_ACTIVATION_RETRIES) {
        const maxRetryMs = Math.max(1_000, (this.runtime.config.channels.retryMaxSeconds || 300) * 1_000);
        const delay = Math.min(maxRetryMs, 1000 * 2 ** Math.min(8, attempt));
        this.scheduleRetry(agentId, delay);
      }
      // 达到上限：停止自动重试，保留 pending；Human resume / 新 notify 可再试。
    } finally {
      this.running.delete(agentId);
      // 成功时：若 pump 期间又有新 notify / 仍有 pending，再排一次。
      // 失败时：只走 scheduleRetry，避免绕过退避立刻打满 Session。
      if (!failed && (this.pending.has(agentId) || this.runtime.inboxStore.listPending(agentId).length > 0)) {
        this.notify(agentId);
      }
    }
  }

  private scheduleRetry(agentId: string, delayMs: number): void {
    this.clearRetry(agentId);
    this.retryTimers.set(agentId, setTimeout(() => {
      this.retryTimers.delete(agentId);
      this.notify(agentId);
    }, delayMs));
  }

  private clearRetry(agentId: string): void {
    const timer = this.retryTimers.get(agentId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(agentId);
  }

  /**
   * 按 ChatTarget 强制 maxActivationHops。
   * 超限项标记为 deferred，链保持暂停直到 resetChain。
   */
  private filterByCausalChain(agentId: string, pending: InboxItem[]): InboxItem[] {
    const allowed: InboxItem[] = [];
    for (const item of pending) {
      const key = chatTargetRef(item.target);
      if (this.pausedChains.has(key)) {
        tryMarkInbox(this.runtime, agentId, item.id, "deferred", "defer already-paused chain");
        continue;
      }
      allowed.push(item);
    }
    return allowed;
  }

  /** Reserve one hop per distinct target for this activation attempt. */
  private claimTargetsForActivation(items: InboxItem[]): string[] {
    const maxHops = this.runtime.config.channels.maxActivationHops;
    const claimed: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const key = chatTargetRef(item.target);
      if (seen.has(key) || this.pausedChains.has(key)) continue;
      seen.add(key);
      const next = (this.chainHops.get(key) ?? 0) + 1;
      if (next > maxHops) {
        this.pausedChains.add(key);
        this.emitChainLimitNotice(item.target, maxHops);
        continue;
      }
      this.chainHops.set(key, next);
      claimed.push(key);
    }
    return claimed;
  }

  private releaseClaimedTargets(keys: string[]): void {
    for (const key of keys) {
      if (this.pausedChains.has(key)) continue;
      const current = this.chainHops.get(key) ?? 0;
      this.chainHops.set(key, Math.max(0, current - 1));
    }
  }

  /** 每条暂停的链只写一次 system notice（Channel 或 DM）。 */
  private emitChainLimitNotice(target: ChatTarget, maxHops: number): void {
    const key = chatTargetRef(target);
    if (this.chainNotices.has(key)) return;
    this.chainNotices.add(key);
    const content = `Causal activation chain paused after ${maxHops} hops. Human Owner can continue by sending a message.`;
    if (target.kind === "channel") {
      try {
        this.runtime.channelStore.appendSystemMessage({
          channelId: target.channelId,
          content,
          kind: "system",
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[coordinator] chain-limit Channel notice failed (${key}): ${detail}`);
      }
      return;
    }
    try {
      this.runtime.messageStore.appendMessage({
        directMessageId: target.directMessageId,
        authorType: "system",
        authorId: "system",
        content,
        kind: "system",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[coordinator] chain-limit DM notice failed (${key}): ${detail}`);
    }
  }

  /**
   * 恰好触发一次：triggered 与 inbox 写入尽量靠近；
   * inbox 失败时记 warn（triggered 已提交，需运维/下次人工恢复）。
   */
  private pollReminders(): void {
    if (!this.started) return;
    for (const reminder of this.runtime.channelStore.listDueReminders()) {
      if (!this.runtime.channelStore.markReminderTriggered(reminder.id)) continue;
      const target = channelTarget(reminder.channelId);
      try {
        this.runtime.inboxStore.notify({
          agentId: reminder.agentId,
          target,
          messageId: reminder.id,
          reason: "reminder",
        });
        this.notify(reminder.agentId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[coordinator] reminder inbox fan-out failed (${reminder.id}): ${detail}`);
      }
    }
  }
}
