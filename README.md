# tradex

tradex 是一个本地优先的行情监控和交易研究工作台。它把 Bitget、Hyperliquid 主网行情、LLM Agent、Reuters 新闻、X 社交动态、本地 SQLite 交易记录和定时任务放在同一个进程里，适合做盘中观察、交易想法复盘和策略原型验证。

它不是生产级交易终端。显式配置凭证并在 `watchlist.toml` 打开交易权限后，可以向 Hyperliquid 主网或 Bitget 提交订单；Bitget 支持 demo/live 两种模式，Hyperliquid 只支持主网 live。外部订单号会写回本地 SQLite。

## 现在它能做什么

- **行情监控**：订阅 Bitget futures，拉取 Hyperliquid 主网快照、K 线与 extended stats。
- **行情工作区**：前端展示 watchlist、实时价格摘要、Agent、新闻、社交动态和持仓面板。
- **Watchlist 管理**：可以在 Web 设置里搜索并添加 Bitget / Hyperliquid 主网标的，也可以直接编辑 `watchlist.toml`。
- **Agent 分析**：支持 Codex Responses provider 和 Anthropic Messages provider。Agent 可以读取行情、裸 K / 带指标 K 线、新闻、社交动态、本地记忆和交易记录。
- **会话持久化**：Agent session 会写成本地 JSONL，并用 SQLite 建索引；前端可以恢复、重置或删除历史会话。
- **交易执行**：配置层允许时，Agent 可以向 Hyperliquid 主网或 Bitget 提交订单；关闭时 Agent 只会给出开单建议。
- **交易复盘**：Positions 页面可以查看 open/planned/history/fills/lessons，也可以撤销交易所挂单。
- **新闻流**：Reuters sitemap provider 会拉取新闻，写入本地 SQLite，并通过 Web UI 展示最新新闻。
- **定时看盘**：Cron 面板可以配置周期任务，按固定时间触发 Agent 分析，结果保存为本地 session。

## 架构

```text
Bitget / Hyperliquid / Reuters
        |
        v
Hono TypeScript backend  <---->  SQLite stores
        |
        +-- feed worker
        +-- agent runtime
        |
        v
React + Vite frontend
```

核心代码路径：

- `tradex/api/app.ts`：HTTP API、WebSocket、后台 worker 生命周期。
- `tradex/runtime/feed.ts`：watchlist 行情循环、多周期 K 线、缓存与 provider 路由。
- `tradex/market_data/`：Bitget、Hyperliquid、catalog 和 candle provider。
- `tradex/domain/indicators.ts`：从标准 OHLCV K 线派生 RSI、MACD、EMA。
- `tradex/agent/`：LLM provider、agent loop、工具和 session 存储。
- `tradex/trading/`：交易数据模型、SQLite store、Hyperliquid 主网 / Bitget demo/live 客户端和 review controller。
- `tradex/news/`：Reuters 新闻抓取、存储和 API 数据源。
- `tradex/social_feed/`：X/Twitter 数据源、认证和本地缓存。
- `tradex/cron/`：定时任务、运行记录和 cron session 存储。
- `web/src/App.tsx`：主 UI，包含 watchlist、Agent、Positions 和设置页面。

## 快速启动

后端和前端都使用 TypeScript。开发时直接启动两个进程：

```bash
npm install
npm run dev:all
```

也可以分别启动：

```bash
npm run dev:backend
npm run dev
```

然后打开：

```text
http://127.0.0.1:5173
```

如果要用单进程模式，先构建前端：

```bash
npm run build
npm run build:backend
npm run start:backend -- --config watchlist.toml --host 127.0.0.1 --port 8765
```

生产构建产物会写入 `dist/backend` 和 `dist/`。

## 配置

默认配置文件是 `watchlist.toml`。如果不传 `--config`，程序会读取当前目录下的 `watchlist.toml`。

一个接近当前功能面的示例：

```toml
symbols = [
  { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC Perp", group = "crypto", analysis_interval = "15m", show_collapsed = true },
  { symbol = "BTCPERP", source = "bitget", inst_type = "USDC-FUTURES", label = "BTC USDC Perp", group = "crypto" },
  { symbol = "SPYUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "SPY", group = "stocks", analysis_interval = "1H" },
  { symbol = "AAPLUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "AAPL", group = "stocks" },
  "USDT-FUTURES:SOLUSDT"
]

[display]
refresh_interval_ms = 1000
stale_after_seconds = 20
reconnect_delay_seconds = 3.0
stock_poll_interval_seconds = 5

[analysis]
enabled = true
interval = "15m"
lookback = 40
poll_interval_seconds = 30
stale_after_seconds = 420

[cache]
enabled = true
candle_retention_seconds = 86400

[agent]
enabled = true
max_candles = 40
candle_context_mode = "raw" # "raw" | "with_indicators"

[agent.providers.codex]
enabled = true
models = ["gpt-5.4-mini"]
model_efforts = {"gpt-5.4-mini" = "medium"}

[agent.providers.anthropic]
enabled = false
base_url = "https://api.anthropic.com/v1"
models = ["global.anthropic.claude-opus-4-6-v1"]
model_efforts = {"global.anthropic.claude-opus-4-6-v1" = "high"}

[news]
enabled = true
poll_interval_seconds = 300
retention_days = 30
recent_limit = 50

[social_feed]
enabled = false
recent_limit = 100
retention_days = 30
max_items = 2000

[trading]
hyperliquid_mode = "off" # "off" | "demo" | "live"
bitget_mode = "demo"    # "off" | "demo" | "live"
```

`symbols` 支持两种写法：

- 字符串：`"BTCUSDT"` 或 `"USDT-FUTURES:BTCUSDT"`，默认按 Bitget 解析。
- inline table：可以显式配置 `source`、`inst_type`、`label`、`group`、`analysis_interval`、`show_collapsed`。

常用 `analysis_interval`：

```text
1m, 3m, 5m, 15m, 30m, 1H, 4H, 6H, 12H, 1D, 3D, 1W, 1M
```

`agent.candle_context_mode` 控制 Agent 看到的 K 线形态：

- `"raw"`：`get_candles` 只返回 OHLCV。
- `"with_indicators"`：`get_candles` 返回 OHLCV，并在样本足够时追加 `indicators`。当前指标包括 `rsi14`、`macd`、`ema20` 和 `ema50`；样本不够时对应字段不返回。

## MCP 外部工具

tradex 可以连接外部 MCP 服务器，把它们的工具暴露给 Agent。在项目根目录放一个 `.mcp.json`（格式兼容 Claude Desktop / Cursor / VS Code）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "my-api": {
      "url": "http://localhost:3001/mcp"
    }
  },
  "settings": {
    "toolPrefix": "server",
    "idleTimeout": 10,
    "directTools": false
  }
}
```

`watchlist.toml` 中可以控制开关（默认启用）：

```toml
[mcp]
enabled = true
config_path = ".mcp.json"  # 可选
```

**工作模式：**

- **Proxy（默认）**：注册一个 `mcp` 工具（~200 tokens），Agent 通过它搜索、查看和调用所有外部工具。
- **Direct**：在 server 或全局设置 `directTools: true`，每个工具单独注册到 Agent 工具列表（更方便但占用更多 context）。

服务器支持 `lifecycle: "lazy"` (按需连接) 或 `"eager"` (启动连接)，以及 `idleTimeout` 空闲断开。前端 Settings → MCP 页面可以实时管理连接和查看工具。

## 行情数据

Bitget：

- `source = "bitget"`
- U 本位合约使用 `inst_type = "USDT-FUTURES"`
- USDC 本位合约使用 `inst_type = "USDC-FUTURES"`
- 币本位合约使用 `inst_type = "COIN-FUTURES"`
- catalog 和历史 K 线走 REST，实时报价走 public WebSocket。

## Agent Provider

当前内置两个 provider：`codex` 和 `anthropic`。OpenAI provider 路径已经不再作为独立 provider 暴露。

Anthropic provider 使用 Messages API 形态，默认 base URL 是：

```text
https://api.anthropic.com/v1
```

实际请求会发到：

```text
https://api.anthropic.com/v1/messages
```

模型刷新会请求：

```text
https://api.anthropic.com/v1/models?limit=100
```

认证 header 使用：

```text
x-api-key: <token>
content-type: application/json
```

API key 和可选 base URL 可以在设置页保存到 `watchlist.toml`：

```toml
[agent.providers.anthropic]
enabled = true
api_key = "..."
# 留空或不写时使用 https://api.anthropic.com/v1
base_url = "https://api.anthropic.com/v1"
models = ["global.anthropic.claude-opus-4-6-v1"]
```

也可以继续用环境变量提供 key：

```bash
export ANTHROPIC_AUTH_TOKEN="..."
# 也可以用：
export ANTHROPIC_API_KEY="..."

# 可选
export ANTHROPIC_MODELS="global.anthropic.claude-opus-4-6-v1,global.anthropic.claude-sonnet-4-5-v1"
export ANTHROPIC_MAX_TOKENS="1200"
```

Codex provider 会优先读取 `CODEX_HOME/auth.json`，也支持环境变量：

```bash
export CODEX_API_KEY="..."
```

Web 设置页可以切换 provider、刷新模型列表并保存到本地配置。

## Agent 工具

Agent 不是只看一段 prompt。运行时会把本地工具注册给模型，让它按需读取真实工作台状态：

- `get_quote`：读取当前报价和日内统计。
- `get_candles`：读取指定周期 K 线；如果 `candle_context_mode = "with_indicators"`，会在样本足够时附带 RSI、MACD 和 EMA。
- `list_instruments`：列出 watchlist 当前标的。
- `get_recent_news` / `refresh_news`：读取或刷新新闻。
- `refresh_x_following_feed` / `get_recent_social_feed` / `search_x_tweets`：读取或搜索 X 社交动态。
- `list_memories` / `read_memory` / `search_memories`：读取本地 memory 文件。
- `get_exchange_positions` / `get_exchange_orders`：读取交易所当前持仓和挂单。
- `open_exchange_trade`：按配置向 Hyperliquid 或 Bitget 提交开仓订单，并记录本地 trade。
- `modify_tpsl` / `close_position`：调整止盈止损或关闭交易所仓位。
- `check_trade_status` / `get_exchange_fills`：同步本地交易状态，或从交易所拉取真实成交记录。
- `list_open_trades`：查看 open/planned 交易。
- `get_trade_history`：读取历史交易、fills 和 lessons。
- `web_search` / `web_fetch`：受限制的网页搜索和读取工具，会拒绝 localhost、内网地址和不安全 scheme。

使用 Codex provider 时，`web_search` 会自动切到 Codex/Responses 原生 hosted web search，按 Codex 默认 live web access 暴露；本地 Exa/DuckDuckGo `web_search` wrapper 只作为非 Codex provider 的 function tool 暴露。`web_fetch` 仍是本地受限读取工具。

`web_search` 默认使用 Exa MCP，并在失败时退回 DuckDuckGo HTML 搜索；不需要配置 Exa API key。可以用环境变量强制后端：

```bash
export WEB_SEARCH_BACKEND="auto"       # 默认：Exa MCP -> DuckDuckGo
export WEB_SEARCH_BACKEND="exa_mcp"    # 只用 Exa MCP
export WEB_SEARCH_BACKEND="duckduckgo" # 只用 DuckDuckGo
```

交易类工具只有在 `[trading]` 里至少一个交易所不是 `"off"` 时才会注册开仓和止盈止损工具。`get_exchange_positions`、`get_exchange_orders`、本地交易查询和复盘工具始终可用，但缺少凭证时会返回交易所侧错误。

## 交易记录与外部交易所

本地不再用 K 线模拟成交。Hyperliquid 订单只会提交到主网 live，Bitget 会根据 `bitget_mode` 提交到 demo 或 live，然后把订单结果写入 SQLite。

流程大致是：

1. Agent 调用 `open_exchange_trade` 提交 Hyperliquid 或 Bitget 订单。
2. 下单结果写入本地 trade store。
3. review controller 定期或手动复盘交易，并把 lessons 写回本地。

Positions 页面可以看到：

- open / planned 交易记录。
- 已关闭和取消的历史交易。
- 每笔交易的 fills、snapshot 和 lesson。
- 手动 review 按钮。

## 主网 / 模拟盘下单

Hyperliquid 使用 SDK 和主网私钥。是否允许下单由 `watchlist.toml` 的 `[trading]` 配置控制：

```bash
export HYPERLIQUID_PRIVATE_KEY="..."
# 可选
export HYPERLIQUID_ACCOUNT_ADDRESS="..."
export HYPERLIQUID_VAULT_ADDRESS="..."
```

```toml
[trading]
hyperliquid_mode = "off"   # "off" | "demo" | "live"
bitget_mode = "demo"          # "off" | "demo" | "live"
```

每个交易所有三种模式：
- `"off"` — 禁用下单，Agent 工具不会注册
- `"demo"` — 模拟盘。Bitget 通过 `PAPTRADING: 1` header 切换；Hyperliquid 不支持模拟盘，设为 demo 会拒绝下单
- `"live"` — 实盘，真金白银

⚠️ 设为 `"live"` 时启动日志会打印醒目警告。

Bitget 使用 API Key 认证。请求走 `https://api.bitget.com`，demo 模式下后端自动加 `PAPTRADING: 1` header：

```bash
export BITGET_API_KEY="..."
export BITGET_API_SECRET="..."
export BITGET_API_PASSPHRASE="..."
```

`instrument_key` 使用当前 watchlist 里的 key。Bitget 形如 `USDT-FUTURES:BTCUSDT` 或 `USDC-FUTURES:BTCPERP`，Hyperliquid 形如 `hyperliquid:BTC` 或 `hyperliquid:xyz:VIX`。

## 新闻

新闻模块默认从 Reuters sitemap 拉取新闻，写入本地 store，并通过 `/api/state` 和 `/api/news/refresh` 给前端展示。

## Web UI

主界面分几块：

- **Watchlist**：左侧标的列表、分组、搜索、价格和涨跌幅。
- **Market Summary**：当前聚焦标的的价格、来源、周期和基础统计摘要。
- **Agent**：创建、运行、切换和恢复历史 session。
- **Positions**：查看交易记录、fills、history、lessons，并撤销交易所挂单。
- **News / Social**：查看 Reuters 新闻和 X 社交动态。
- **Cron**：管理定时看盘任务、手动触发任务并查看运行记录。
- **Settings**：管理 Providers、Watchlist、Agent Context、News、Social、Memory 和 Cron 配置。

## 本地数据

默认本地状态主要在这些地方：

- `watchlist.toml`：watchlist、display、agent、news、social、memory、cache、trading 配置。
- `~/.cache/tradex/agent_sessions/`：Agent session JSONL 消息历史。
- `~/.cache/tradex/session_index.sqlite3`：Agent session 索引。
- `~/.cache/tradex/cron.sqlite3`：定时任务配置。
- `~/.cache/tradex/cron_sessions/`：定时任务运行记录。
- `~/.cache/tradex/trades.sqlite3`：交易记录、fills、snapshots、lessons。
- `~/.cache/tradex/news.sqlite3`：新闻条目和抓取 cursor。
- `~/.cache/tradex/social_feed.sqlite3`：社交动态缓存。
- `~/.cache/tradex/candles.sqlite3`：默认 K 线 cache；如果设置了 `XDG_CACHE_HOME` 或 `[cache].path`，会使用对应路径。
- 浏览器 localStorage：主题和部分前端偏好。

这些数据都是本地优先，没有服务端账号体系。

## API 概览

常用接口：

- `GET /api/state`：当前 watchlist、报价、provider 状态。
- `GET /api/instruments/catalog`：读取启动时预加载的可添加标的目录，前端基于它做本地搜索。
- `POST /api/watchlist/bitget`：添加 Bitget 标的。
- `POST /api/watchlist/hyperliquid`：添加 Hyperliquid 标的。
- `DELETE /api/watchlist/instruments/:key`：删除 watchlist 标的。
- `GET /api/agent/sessions`：读取 Agent session 列表。
- `POST /api/agent/sessions`：创建 Agent session。
- `GET /api/agent/sessions/:id`：读取单个 session 的消息历史。
- `POST /api/agent/sessions/:id/messages/stream`：以 SSE 运行一轮 Agent。
- `POST /api/agent/sessions/:id/steer` / `POST /api/agent/sessions/:id/abort`：向运行中的 Agent 注入跟进消息或中止运行。
- `GET /api/agent/providers/:provider/models`：刷新指定 provider 的模型列表。
- `POST /api/agent/providers/:provider`：保存 provider 配置。
- `POST /api/agent/config`：保存 Agent 上下文配置，包括 `maxCandles` 和 `candleContextMode`。
- `POST /api/news/refresh`：手动刷新新闻。
- `POST /api/news/config`：保存新闻配置。
- `GET /api/social/feed` / `POST /api/social/x/refresh`：读取或刷新社交动态。
- `GET /api/lessons`：读取交易 lessons。
- `DELETE /api/exchange/orders/:exchange/:orderId`：撤销交易所挂单。
- `GET /api/cron/jobs` / `POST /api/cron/jobs` / `PATCH /api/cron/jobs/:name` / `PUT /api/cron/jobs/:name` / `DELETE /api/cron/jobs/:name`：管理定时任务。
- `POST /api/cron/jobs/:name/trigger`：手动触发定时任务。
- `GET /api/cron/runs`：读取最近 cron 运行记录。
- `GET /api/mcp/status`：MCP 服务器状态和工具列表。
- `POST /api/mcp/servers/:name/connect` / `disconnect`：连接或断开 MCP 服务器。
- `POST /api/mcp/servers` / `PUT /api/mcp/servers/:name` / `DELETE /api/mcp/servers/:name`：管理 MCP 服务器配置。
- `GET /ws`：前端实时状态推送。

## 验证

类型检查：

```bash
npm run typecheck
```

构建：

```bash
npm run build
npm run build:backend
```

## 当前边界

- Hyperliquid 是真实主网交易，不支持 demo；Bitget 支持 demo/live，默认建议先用 demo。
- 本地不会用 1m K 线模拟成交；未成交或挂单状态依赖交易所状态同步/撤单能力。
- Agent、新闻和社交动态适合做研究辅助，不应该直接当作交易信号执行。
- 新闻来源目前以 Reuters sitemap provider 为主。
