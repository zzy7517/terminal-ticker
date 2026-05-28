/**
 * BaseFeed — shared polling logic for all data feeds.
 */

import type { DataFeed } from "./types.js";

export abstract class BaseFeed<T> implements DataFeed<T> {
  abstract readonly name: string;
  abstract readonly pollIntervalMs: number;

  private history: T[] = [];
  private maxHistory = 200;
  private timer: NodeJS.Timeout | null = null;
  private subscribers: Array<(data: T) => void> = [];
  protected lastError: string | null = null;

  async start(): Promise<void> {
    // Initial fetch (don't let it crash startup)
    try {
      await this.fetchAndStore();
    } catch (e) {
      this.lastError = String(e);
    }
    // Start polling
    this.timer = setInterval(() => {
      void this.fetchAndStore().catch((e) => {
        this.lastError = String(e);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLatest(): T | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  getHistory(n: number): T[] {
    return this.history.slice(-n);
  }

  getLastError(): string | null {
    return this.lastError;
  }

  subscribe(cb: (data: T) => void): () => void {
    this.subscribers.push(cb);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== cb);
    };
  }

  protected push(data: T): void {
    this.history.push(data);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    for (const cb of this.subscribers) {
      cb(data);
    }
  }

  /** Subclasses implement the actual data fetching. */
  protected abstract fetch(): Promise<T | T[] | null>;

  private async fetchAndStore(): Promise<void> {
    const result = await this.fetch();
    if (result === null) return;
    if (Array.isArray(result)) {
      for (const item of result) {
        this.push(item);
      }
    } else {
      this.push(result);
    }
    this.lastError = null;
  }
}
