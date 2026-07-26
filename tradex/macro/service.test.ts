import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MacroService } from "./service.js";
import { MacroStore } from "./store.js";
import { parseMacroConfig } from "../config/index.js";
import type { MacroEvent } from "./domain.js";

const dirs: string[] = [];

function tempStore(): MacroStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-macro-svc-"));
  dirs.push(dir);
  return new MacroStore(path.join(dir, "macro.sqlite3"));
}

function service(store: MacroStore, overrides: Record<string, unknown> = {}) {
  return new MacroService({
    config: parseMacroConfig({ enabled: true, fred_api_key: "", ...overrides }),
    jin10Service: null,
    store,
  });
}

function event(pubTimeMs: number, fetchedAtMs: number): MacroEvent {
  return {
    key: `${pubTimeMs}:cpi`,
    pubTimeMs,
    title: "美国CPI年率",
    normalizedTitle: "美国cpi年率",
    country: "美国",
    impact: "high",
    star: 5,
    previous: null,
    consensus: null,
    actual: null,
    revised: null,
    note: null,
    provider: "jin10",
    fetchedAtMs,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("MacroService event window", () => {
  it("fails closed before any calendar fetch", () => {
    const svc = service(tempStore());
    expect(svc.isInEventWindow()).toEqual({ inWindow: true, event: null, unknown: true });
    svc.close();
  });

  it("reports clear when calendar is disabled", () => {
    const svc = service(tempStore(), { calendar_enabled: false });
    expect(svc.isInEventWindow()).toEqual({ inWindow: false, event: null, unknown: false });
    svc.close();
  });

  it("fails closed when a hydrated calendar is stale", async () => {
    // Regression guard: `list_calendar` only covers the current natural week, so
    // a stale copy looks populated while containing zero upcoming releases.
    // Treating "has rows" as "usable" would report clear through a live print.
    const store = tempStore();
    const now = Date.UTC(2026, 1, 12, 12, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const weekAgo = now - 7 * 864e5;
    store.upsertEvents([event(weekAgo, weekAgo)]);

    const svc = service(store);
    await svc.start();

    expect(svc.calendarFresh).toBe(false);
    expect(svc.isInEventWindow(now).unknown).toBe(true);
    expect(svc.getStatus().calendar.fresh).toBe(false);

    await svc.stop();
    svc.close();
  });

  it("trusts a freshly hydrated calendar after restart", async () => {
    const store = tempStore();
    const now = Date.UTC(2026, 1, 12, 12, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Persisted one minute ago by the previous process.
    store.upsertEvents([event(now + 6 * 3600_000, now - 60_000)]);

    const svc = service(store);
    await svc.start();

    expect(svc.calendarFresh).toBe(true);
    // A release six hours out is outside the 15-minute window.
    expect(svc.isInEventWindow(now)).toEqual({ inWindow: false, event: null, unknown: false });

    await svc.stop();
    svc.close();
  });

  it("flags the window around a fresh upcoming release", async () => {
    const store = tempStore();
    const now = Date.UTC(2026, 1, 12, 12, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const release = now + 10 * 60_000;
    store.upsertEvents([event(release, now - 30_000)]);

    const svc = service(store);
    await svc.start();

    const verdict = svc.isInEventWindow(now);
    expect(verdict.inWindow).toBe(true);
    expect(verdict.unknown).toBe(false);
    expect(verdict.event?.pubTimeMs).toBe(release);

    await svc.stop();
    svc.close();
  });

  it("keeps the entry gate inert while the whole layer is disabled", () => {
    // Regression guard: a disabled layer never polls, so treating its "unknown"
    // as fail-closed would reject every order on a default install rather than
    // protect anything.
    const svc = service(tempStore(), { enabled: false });
    const gate = svc.checkEntryGate();
    expect(gate.blocked).toBe(false);
    expect(gate.verdict).toEqual({ inWindow: false, event: null, unknown: false });
    svc.close();
  });

  it("reports the window but allows entry when block_trades is off", () => {
    const svc = service(tempStore(), { event_window: { block_trades: false } });
    const gate = svc.checkEntryGate();
    expect(gate.verdict.unknown).toBe(true);
    expect(gate.blocked).toBe(false);
    expect(gate.reason).toBeNull();
    svc.close();
  });

  it("blocks entry with a named reason inside a fresh release window", async () => {
    const store = tempStore();
    const now = Date.UTC(2026, 1, 12, 12, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    store.upsertEvents([event(now + 5 * 60_000, now - 30_000)]);

    const svc = service(store);
    await svc.start();

    const gate = svc.checkEntryGate(now);
    expect(gate.blocked).toBe(true);
    expect(gate.reason).toContain("美国CPI年率");

    await svc.stop();
    svc.close();
  });

  it("skips the FRED sweep without an API key instead of throwing", async () => {
    const svc = service(tempStore());
    await expect(svc.refreshFred()).resolves.toEqual({ updated: 0, failed: 0 });
    expect(svc.getStatus().fredConfigured).toBe(false);
    svc.close();
  });

  it("returns nothing for an unregistered series id", () => {
    const svc = service(tempStore());
    expect(svc.getSeries("not_a_series")).toEqual([]);
    expect(svc.getLatest("not_a_series")).toBeNull();
    svc.close();
  });
});
