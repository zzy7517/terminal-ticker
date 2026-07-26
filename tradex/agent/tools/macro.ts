/**
 * Agent Tools — Macro environment.
 *
 * Exposes the macro layer as context, not signal: the Agent gets rates,
 * inflation expectations, dollar, crypto vol and positioning as descriptive
 * statistics, plus the release calendar, and draws its own conclusions. There is
 * deliberately no tool that answers "is macro bullish" (see 决策 3 in
 * docs/MACRO_DATA_DESIGN.md).
 *
 * Staleness is always reported rather than hidden. A silently omitted series
 * would read as "nothing unusual there" when the truth is "we don't know".
 */

import type { MacroCategory, MacroEventImpact } from "../../macro/domain.js";
import { MACRO_SERIES, findSeries } from "../../macro/registry.js";
import type { MacroService } from "../../macro/service.js";
import type { SeriesStats } from "../../macro/snapshot.js";
import { ToolRegistry, jsonOutput } from "./registry.js";

const CATEGORIES: MacroCategory[] = [
  "rates",
  "inflation",
  "dollar",
  "employment",
  "energy",
  "metals",
  "risk",
];

const DISABLED = {
  error: "宏观数据层未启用。在配置中设置 [macro] enabled = true。",
} as const;

function round(value: number | null, digits = 3): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Compact a stats row for the model, keeping staleness visible. */
function formatStats(stats: SeriesStats): Record<string, unknown> {
  return {
    seriesId: stats.seriesId,
    label: stats.label,
    category: stats.category,
    unit: stats.unit,
    latest: round(stats.latest),
    asOf: stats.latestTs ? new Date(stats.latestTs).toISOString() : null,
    change: round(stats.changeAbs),
    windowChange: round(stats.windowChangeAbs),
    zScore: round(stats.zScore, 2),
    percentile: round(stats.percentile, 1),
    windowMin: round(stats.windowMin),
    windowMax: round(stats.windowMax),
    sampleCount: stats.sampleCount,
    // Surfaced explicitly so the model can discount an old reading instead of
    // treating every number as current.
    ageHours: stats.ageMs === null ? null : Math.round(stats.ageMs / 3600_000),
    available: stats.latest !== null,
  };
}

function parseCategories(raw: unknown): MacroCategory[] | null {
  if (!Array.isArray(raw)) return null;
  const picked = raw
    .map((item) => String(item).trim().toLowerCase())
    .filter((item): item is MacroCategory => (CATEGORIES as string[]).includes(item));
  return picked.length > 0 ? picked : null;
}

function parseImpact(raw: unknown): MacroEventImpact | undefined {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

export function buildMacroTools(svc: MacroService | null): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: "get_macro_snapshot",
    description:
      "获取当前宏观环境快照：美债利率与曲线、通胀预期、美元指数、WTI、金融压力指数、BTC/ETH DVOL、币安未平仓量与多空比，" +
      "每个序列附带窗口内的 z-score、分位、极值和数据年龄。同时返回派生指标（曲线陡峭度、10 年实际利率、加密波动率溢价）。" +
      "输出是描述性的环境底色，不含方向性判断，用于校准其他信号的有效性。",
    parameters: {
      type: "object",
      properties: {
        window_days: { type: "number", description: "z-score / 分位的回看窗口天数，默认 90" },
        categories: {
          type: "array",
          items: { type: "string", enum: CATEGORIES },
          description: "只返回这些维度；省略则返回全部",
        },
      },
    },
    execute: (args) => {
      if (!svc?.available) return jsonOutput(DISABLED);

      const windowDays = typeof args.window_days === "number" && args.window_days > 0 ? args.window_days : 90;
      const snapshot = svc.getSnapshot({ windowDays });
      const categories = parseCategories(args.categories);
      const series = categories
        ? snapshot.series.filter((s) => categories.includes(s.category))
        : snapshot.series;

      return jsonOutput({
        atMs: snapshot.atMs,
        at: new Date(snapshot.atMs).toISOString(),
        windowDays,
        derived: snapshot.derived,
        series: series.map(formatStats),
        // A snapshot where nothing has been collected yet must not look like a
        // snapshot where everything is calm.
        seriesWithData: series.filter((s) => s.latest !== null).length,
      });
    },
  });

  registry.register({
    name: "get_macro_series",
    description:
      "读取单个宏观序列的历史观测值。修正型序列（CPI / 核心 PCE / 非农 / 失业率）按 vintage 存储，" +
      "传 as_of 只会返回该时点之前已发布的版本，可用于避免回测穿越。用 series_id 指定序列，可用列表见 list_macro_series。",
    parameters: {
      type: "object",
      properties: {
        series_id: { type: "string", description: "内部序列 id，如 us10y / breakeven_10y / dvol_btc" },
        limit: { type: "number", description: "最多返回多少个观测值，默认 60" },
        as_of: { type: "number", description: "epoch 毫秒；只返回该时点之前已发布的数据" },
      },
      required: ["series_id"],
    },
    execute: (args) => {
      if (!svc?.available) return jsonOutput(DISABLED);

      const seriesId = String(args.series_id ?? "").trim();
      const meta = findSeries(seriesId);
      if (!meta) {
        return jsonOutput({
          error: `未知序列 ${seriesId}`,
          knownSeriesIds: MACRO_SERIES.map((s) => s.seriesId),
        });
      }

      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 500) : 60;
      const asOfMs = typeof args.as_of === "number" && args.as_of > 0 ? args.as_of : undefined;
      const points = svc.getSeries(seriesId, { limit, asOfMs });

      return jsonOutput({
        seriesId,
        label: meta.label,
        unit: meta.unit,
        source: meta.source,
        vintaged: meta.vintaged,
        count: points.length,
        points: points.map((p) => ({
          ts: new Date(p.ts).toISOString(),
          value: p.value,
          // Only meaningful for vintaged series; null means period === publication.
          publishedAt: p.vintageTs ? new Date(p.vintageTs).toISOString() : null,
        })),
      });
    },
  });

  registry.register({
    name: "list_macro_series",
    description: "列出所有已注册的宏观序列及其 id、来源、单位、频率和是否为修正型序列。用于确定 get_macro_series 的参数。",
    parameters: { type: "object", properties: {} },
    execute: () =>
      jsonOutput({
        series: MACRO_SERIES.map((s) => ({
          seriesId: s.seriesId,
          label: s.label,
          category: s.category,
          source: s.source,
          unit: s.unit,
          cadenceSeconds: s.cadenceSeconds,
          vintaged: s.vintaged,
        })),
      }),
  });

  registry.register({
    name: "get_macro_calendar",
    description:
      "读取已持久化的财经日历：即将发布和最近发布的宏观数据事件，含重要性、星级、前值/预期/实际值和中文影响说明。" +
      "返回的 fresh 字段表示这份副本是否足够新；fresh 为 false 时不要把「没有事件」理解成「确实无事件」。",
    parameters: {
      type: "object",
      properties: {
        hours_ahead: { type: "number", description: "向前看多少小时，默认 48" },
        hours_back: { type: "number", description: "向后看多少小时，默认 12" },
        min_impact: { type: "string", enum: ["high", "medium", "low"], description: "最低重要性，默认全部" },
      },
    },
    execute: (args) => {
      if (!svc?.available) return jsonOutput(DISABLED);

      const now = Date.now();
      const ahead = typeof args.hours_ahead === "number" && args.hours_ahead > 0 ? args.hours_ahead : 48;
      const back = typeof args.hours_back === "number" && args.hours_back > 0 ? args.hours_back : 12;
      const events = svc.getEvents({
        fromMs: now - back * 3600_000,
        toMs: now + ahead * 3600_000,
        minImpact: parseImpact(args.min_impact),
      });

      return jsonOutput({
        fresh: svc.calendarFresh,
        count: events.length,
        events: events.map((e) => ({
          time: new Date(e.pubTimeMs).toISOString(),
          released: e.pubTimeMs <= now,
          title: e.title,
          country: e.country,
          impact: e.impact,
          star: e.star,
          previous: e.previous,
          consensus: e.consensus,
          actual: e.actual,
          note: e.note,
          provider: e.provider,
        })),
      });
    },
  });

  registry.register({
    name: "get_macro_event_window",
    description:
      "查询当前（或指定时点）是否处于高影响宏观数据发布的静默窗口。blocked 为 true 时 open_exchange_trade 会拒绝开仓；" +
      "unknown 为 true 表示日历不可信，按 fail-closed 当作处于窗口内处理。平仓从不受此限制。",
    parameters: {
      type: "object",
      properties: {
        at: { type: "number", description: "epoch 毫秒，默认当前时刻" },
      },
    },
    execute: (args) => {
      if (!svc?.available) {
        return jsonOutput({ ...DISABLED, blocked: false, note: "宏观层未启用时不做任何开仓拦截。" });
      }

      const atMs = typeof args.at === "number" && args.at > 0 ? args.at : Date.now();
      const gate = svc.checkEntryGate(atMs);
      const window = svc.config.eventWindow;

      return jsonOutput({
        at: new Date(atMs).toISOString(),
        inWindow: gate.verdict.inWindow,
        unknown: gate.verdict.unknown,
        blocked: gate.blocked,
        reason: gate.reason,
        calendarFresh: svc.calendarFresh,
        policy: {
          minImpact: window.minImpact,
          beforeMinutes: window.beforeMinutes,
          afterMinutes: window.afterMinutes,
          blocksEntry: window.blockTrades,
        },
        event: gate.verdict.event
          ? {
              time: new Date(gate.verdict.event.pubTimeMs).toISOString(),
              title: gate.verdict.event.title,
              impact: gate.verdict.event.impact,
              star: gate.verdict.event.star,
            }
          : null,
      });
    },
  });

  return registry;
}
