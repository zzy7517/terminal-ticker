# tradex

tradex 是一个本地优先的行情监控和交易研究工作台。它把 Bitget、Hyperliquid 主网行情、LLM Agent、Reuters 新闻和本地 SQLite 交易记录放在同一个进程里，适合做盘中观察、交易想法复盘和策略原型验证。

它不是生产级交易终端。显式配置凭证并在 `watchlist.toml` 打开平台交易权限后，可以向 Hyperliquid 主网提交真实订单；Bitget 仍只使用 Demo Trading。外部订单号会写回本地 SQLite。

## 现在它能做什么

- **行情监控**：订阅 Bitget futures，拉取 Hyperliquid 主网快照、K 线与 extended stats。
- **行情工作区**：前端展示 watchlist、实时价格摘要、Agent、新闻、社交动态和持仓面板。
- **Watchlist 管理**：可以在 Web 设置里搜索并添加 Bitget / Hyperliquid 主网标的，也可以直接编辑 `watchlist.toml`。
- **Agent 分析**：支持 Codex Responses provider 和 Anthropic Messages provider。Agent 可以读取行情、K 线、新闻和本地交易记录，并返回结构化交易观察。
- **会话持久化**：每个标的都有独立 Agent session，历史记录保存在本地 SQLite，可以 resume、reset 或删除。
- **交易执行**：配置层允许时，Agent 或 API 可以向 Hyperliquid 主网提交真实订单，或向 Bitget 模拟盘提交测试订单；关闭时 Agent 只会给出开单建议。
- **交易复盘**：Positions 页面可以查看 open/planned/history/fills/lessons，也可以手动触发 review。
- **新闻流**：Reuters sitemap provider 会拉取新闻，写入本地 SQLite，并通过 Web UI 展示最新新闻。

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
- `tradex/agent/`：LLM provider、agent loop、工具和 session 存储。
- `tradex/trading/`：交易数据模型、SQLite store、Hyperliquid 主网 / Bitget Demo Trading 客户端和 review controller。
- `tradex/news/`：Reuters 新闻抓取、存储和 API 数据源。
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
provider = "anthropic"
api_mode = "anthropic_messages"
model = "global.anthropic.claude-opus-4-6-v1"
use_tools = true
timeout_seconds = 45
max_candles = 40
max_iterations = 10

[news]
enabled = true
poll_interval_seconds = 300
retention_days = 30
recent_limit = 50
```

`symbols` 支持两种写法：

- 字符串：`"BTCUSDT"` 或 `"USDT-FUTURES:BTCUSDT"`，默认按 Bitget 解析。
- inline table：可以显式配置 `source`、`inst_type`、`label`、`group`、`analysis_interval`、`show_collapsed`。

常用 `analysis_interval`：

```text
1m, 3m, 5m, 15m, 30m, 1H, 4H, 6H, 12H, 1D, 3D, 1W, 1M
```

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

Agent 不是只看一段 prompt。打开 `agent.use_tools = true` 后，它可以调用本地工具读取真实工作台状态：

- `get_quote`：读取当前报价和日内统计。
- `get_candles`：读取指定周期 K 线。
- `list_instruments`：列出 watchlist 当前标的。
- `get_recent_news` / `refresh_news`：读取或刷新新闻。
- `open_bitget_demo_trade`：向 Bitget 模拟盘提交测试订单并记录 orderId。
- `open_hyperliquid_trade`：向 Hyperliquid 主网提交真实订单并记录 orderId / fill。
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

Agent 输出会被解析成结构化结果，核心字段包括 `summary`、`bias`、`confidence`、`key_levels`、`watch_plan`、`invalidation` 和 `risk_notes`。

## 交易记录与外部交易所

本地不再用 K 线模拟成交。Hyperliquid 订单会提交到主网，Bitget 订单会提交到 Demo Trading，然后把订单结果写入 SQLite。

流程大致是：

1. Agent 或 API 提交 Hyperliquid 主网或 Bitget Demo Trading 订单。
2. 下单结果写入本地 trade store。
3. review controller 定期或手动复盘交易，并把 lessons 写回本地。

Positions 页面可以看到：

- open / planned 交易记录。
- 已关闭和取消的历史交易。
- 每笔交易的 fills、snapshot 和 lesson。
- 手动 review 按钮。

## 主网 / 模拟盘下单

Hyperliquid 主网使用 SDK 和主网私钥。是否允许下单由 `watchlist.toml` 的 `[trading]` 配置控制：

```bash
export HYPERLIQUID_PRIVATE_KEY="..."
# 可选
export HYPERLIQUID_ACCOUNT_ADDRESS="..."
export HYPERLIQUID_VAULT_ADDRESS="..."
```

```toml
[trading]
hyperliquid_enabled = false
bitget_demo_enabled = true
```

当某个平台的开关为 `false` 时，该平台的 Agent 下单工具不会注册，API 下单也会被拒绝。

Bitget Demo Trading 使用 Demo API Key。请求仍走 `https://api.bitget.com`，后端会强制加 `paptrading: 1` header：

```bash
export BITGET_DEMO_API_KEY="..."
export BITGET_DEMO_API_SECRET="..."
export BITGET_DEMO_PASSPHRASE="..."
```

Bitget demo 下单接口：

```http
POST /api/bitget-demo/trades/{instrument_key}
Content-Type: application/json

{
  "direction": "long",
  "size": 0.01,
  "orderType": "limit",
  "limitPrice": 60000,
  "marginMode": "crossed",
  "reasoning": "manual demo trade"
}
```

`instrument_key` 使用当前 watchlist 里的 Bitget key，例如 `USDT-FUTURES:BTCUSDT` 或 `USDC-FUTURES:BTCPERP`。

## 新闻

新闻模块默认从 Reuters sitemap 拉取新闻，写入本地 store，并通过 `/api/news` 给前端展示。

## Web UI

主界面分几块：

- **Watchlist**：左侧标的列表、分组、搜索、价格和涨跌幅。
- **Market Summary**：当前聚焦标的的价格、来源、周期和基础统计摘要。
- **Agent**：按标的发起分析，查看和恢复历史 session。
- **Positions**：查看交易记录、fills、history、lessons 和手动复盘。
- **Settings**：管理 Providers、Watchlist 和 News 配置。

## 本地数据

默认本地状态主要在这些地方：

- `watchlist.toml`：watchlist、display、agent、news、cache 配置。
- `~/.cache/tradex/agent_sessions.sqlite3`：Agent session 和消息历史。
- `~/.cache/tradex/trades.sqlite3`：交易记录、fills、snapshots、lessons。
- `~/.cache/tradex/news.sqlite3`：新闻、新闻决策和处理状态。
- `~/.cache/tradex/candles.sqlite3`：默认 K 线 cache；如果设置了 `XDG_CACHE_HOME` 或 `[cache].path`，会使用对应路径。
- 浏览器 localStorage：主题和部分前端偏好。

这些数据都是本地优先，没有服务端账号体系。

## API 概览

常用接口：

- `GET /api/state`：当前 watchlist、报价、provider 状态。
- `GET /api/instruments/catalog`：读取启动时预加载的可添加标的目录，前端基于它做本地搜索。
- `POST /api/watchlist/bitget`：添加 Bitget 标的。
- `GET /api/agent/models`：当前 provider 可用模型。
- `GET /api/agent/config` / `PUT /api/agent/config`：读取和更新 Agent 配置。
- `POST /api/agent/analyze/{instrument_key}`：对某个标的发起 Agent 分析。
- `GET /api/agent/sessions/{instrument_key}`：读取某个标的的 session 列表。
- `GET /api/trades`：读取本地交易记录。
- `POST /api/trades/review`：手动触发交易复盘。
- `GET /api/news`：读取新闻。
- `POST /api/news/refresh`：手动刷新新闻。
- `GET /api/news/decisions`：读取 news analyst 决策记录。
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

- Hyperliquid 是真实主网交易；Bitget 只支持 Demo Trading。
- 本地不会用 1m K 线模拟成交；未成交或挂单状态依赖交易所状态同步/撤单能力。
- Agent 和 news analyst 适合做研究辅助，不应该直接当作交易信号执行。
- 新闻来源目前以 Reuters sitemap provider 为主。
