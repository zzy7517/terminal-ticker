import { Hono } from "hono";
import type { AppRuntime } from "../runtime.js";

export function tradingRoutes(runtime: AppRuntime): Hono {
  const app = new Hono();

  // Returns trade lessons, optionally filtered by instrument key.
  app.get("/api/lessons", (c) => c.json({ lessons: runtime.tradeStore.listLessons({ instrumentKey: c.req.query("instrument_key") || null, limit: Number(c.req.query("limit") || 50) }) }));

  // Cancels a resting order on the specified exchange.
  app.delete("/api/exchange/orders/:exchange/:orderId", async (c) => c.json({ ok: await runtime.exchangeRouter.cancelOrder({ exchange: c.req.param("exchange"), orderId: c.req.param("orderId"), symbol: c.req.query("symbol") || "" }) }));

  return app;
}
