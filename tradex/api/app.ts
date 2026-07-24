import { Hono } from "hono";
import type { AppRuntime } from "./runtime.js";
import { marketRoutes } from "./routes/market.js";
import { agentRoutes } from "./routes/agent.js";
import { newsRoutes } from "./routes/news.js";
import { tradingRoutes } from "./routes/trading.js";
import { cronRoutes } from "./routes/cron.js";
import { mcpRoutes } from "./routes/mcp.js";
import { jin10Routes } from "./routes/jin10.js";
import { browserRoutes } from "./routes/browser.js";
import { optionsRoutes } from "./routes/options.js";
import { proxyRoutes } from "./routes/proxy.js";
import { channelRoutes } from "./routes/channel.js";
import { chatEventRoutes } from "./routes/chat.js";
import { tradexCliRoutes } from "./routes/cli.js";

export interface CreateAppOptions {
  runtime: AppRuntime;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const runtime = options.runtime;

  app.route("", marketRoutes(runtime));
  app.route("", agentRoutes(runtime));
  app.route("", channelRoutes(runtime));
  app.route("", chatEventRoutes(runtime));
  app.route("", newsRoutes(runtime));
  app.route("", tradingRoutes(runtime));
  app.route("", cronRoutes(runtime));
  app.route("", mcpRoutes(runtime));
  app.route("", jin10Routes(runtime));
  app.route("", browserRoutes(runtime));
  app.route("", optionsRoutes(runtime));
  app.route("", proxyRoutes(runtime));
  app.route("", tradexCliRoutes(runtime.cliRunGrants));

  return app;
}
