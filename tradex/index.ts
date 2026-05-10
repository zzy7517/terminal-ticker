import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config/index.js";
import { createApp } from "./api/app.js";
import { MarketRuntime } from "./api/runtime.js";

interface CliOptions {
  configPath: string;
  host: string;
  port: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    configPath: "watchlist.toml",
    host: "127.0.0.1",
    port: 8765,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--config" && next) {
      options.configPath = next;
      index += 1;
    } else if (arg === "--host" && next) {
      options.host = next;
      index += 1;
    } else if (arg === "--port" && next) {
      options.port = Number.parseInt(next, 10);
      index += 1;
    }
  }
  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive integer");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  const runtime = await MarketRuntime.create(config);
  await runtime.start();
  const app = createApp({ runtime });
  const server = serve({ fetch: app.fetch, hostname: options.host, port: options.port });
  const wss = new WebSocketServer({ server: server as never, path: "/ws" });
  wss.on("connection", (socket) => {
    const sendState = async () => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(await runtime.state()));
    };
    void sendState();
    const timer = setInterval(() => void sendState(), config.display.refreshIntervalMs);
    socket.on("close", () => clearInterval(timer));
  });
  process.on("SIGINT", () => void runtime.stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void runtime.stop().finally(() => process.exit(0)));
  console.log(`tradex TS backend listening on http://${options.host}:${options.port}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
