import { Trade, tradeToPayload, snapshotToPayload } from "./models.js";
import { TradeStore } from "./store.js";

export interface TradeReviewLesson {
  category: string;
  text: string;
  tags: string[];
}

export interface TradeReviewer {
  reviewTrade(trade: Trade): Promise<TradeReviewLesson[]>;
}

export const REVIEW_INSTRUCTIONS = `你是一个 price action 交易复盘助手。
根据一笔已关闭的本地交易记录的开单上下文、执行结果和盈亏，写出简短、可执行的教训。
输出一个 JSON object，字段必须是：
lesson: string (一两句话，聚焦下次能改进的点)
category: string ("entry" | "exit" | "risk" | "patience" | "bias" 之一)
tags: array of string (最多 4 个小标签，例如 ["fvg", "1H", "late_entry"])
`;

export type ReviewLLM = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class DefaultTradeReviewer implements TradeReviewer {
  private readonly llm: ReviewLLM;
  private readonly tradeStore: TradeStore;

  constructor(input: { llm: ReviewLLM; tradeStore: TradeStore }) {
    this.llm = input.llm;
    this.tradeStore = input.tradeStore;
  }

  async reviewTrade(trade: Trade): Promise<TradeReviewLesson[]> {
    let snapshotPayload: Record<string, unknown> | null = null;
    if (trade.snapshotId != null) {
      const snap = this.tradeStore.getSnapshot(trade.snapshotId);
      if (snap) snapshotPayload = snapshotToPayload(snap) as Record<string, unknown>;
    }
    const lessons = this.tradeStore.listLessons({ instrumentKey: trade.instrumentKey, limit: 5 });
    const prompt: Record<string, unknown> = {
      instruction: REVIEW_INSTRUCTIONS,
      trade: tradeToPayload(trade),
      snapshotAtOpen: snapshotPayload,
      recentLessons: lessons,
    };
    const parsed = await this.llm(prompt);
    return [extractLesson(parsed)].filter((l): l is TradeReviewLesson => l !== null);
  }
}

function extractLesson(parsed: unknown): TradeReviewLesson | null {
  const obj = unwrapJson(parsed);
  if (!obj) return null;
  const text = extractText(obj);
  if (!text) return null;
  const category = String(obj.category || "entry");
  const tagsRaw = obj.tags;
  const tags = Array.isArray(tagsRaw) ? tagsRaw.map(String).slice(0, 4) : [];
  return { category, text, tags };
}

function unwrapJson(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const stripped = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try { return JSON.parse(stripped) as Record<string, unknown>; } catch { return null; }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function extractText(obj: Record<string, unknown>): string {
  for (const key of ["lesson", "text", "content", "summary"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export async function reviewClosedTrades(input: { store: TradeStore; reviewer: TradeReviewer; limit?: number }): Promise<number> {
  let reviewed = 0;
  for (const tradeId of input.store.tradeIdsWithoutReview({ limit: input.limit ?? 10 })) {
    const trade = input.store.getTrade(tradeId);
    if (!trade) continue;
    try {
      const lessons = await input.reviewer.reviewTrade(trade);
      for (const lesson of lessons) {
        input.store.saveLesson({
          tradeId: trade.id,
          instrumentKey: trade.instrumentKey,
          category: lesson.category,
          text: lesson.text,
          tags: lesson.tags,
        });
      }
      reviewed += 1;
    } catch {
      continue;
    }
  }
  return reviewed;
}
