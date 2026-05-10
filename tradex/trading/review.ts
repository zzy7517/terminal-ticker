import { Trade } from "./models.js";
import { TradeStore } from "./store.js";

export interface TradeReviewLesson {
  category: string;
  text: string;
  tags: string[];
}

export interface TradeReviewer {
  reviewTrade(trade: Trade): Promise<TradeReviewLesson[]>;
}

export async function reviewClosedTrades(input: { store: TradeStore; reviewer: TradeReviewer; limit?: number }): Promise<number> {
  let reviewed = 0;
  for (const tradeId of input.store.tradeIdsWithoutReview({ limit: input.limit ?? 10 })) {
    const trade = input.store.getTrade(tradeId);
    if (!trade) continue;
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
  }
  return reviewed;
}
