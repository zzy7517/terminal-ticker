# mytradebot

mytradebot 是一个本地优先的行情监控和交易研究工作台。它把 Bitget、Alpaca、Hyperliquid 测试网行情、React 图表、LLM Agent、Reuters 新闻和本地 SQLite 交易记录放在同一个进程里，适合做盘中观察、交易想法复盘和策略原型验证。

它不是生产级交易终端，也不会连接真实盘账户自动交易。显式配置测试网/模拟盘凭证后，可以向 Hyperliquid testnet 或 Bitget Demo Trading 提交测试订单，并把外部订单号写回本地 SQLite。

## 现在它能做什么

- **行情监控**：订阅 Bitget spot / USDT futures，拉取 Alpaca 美股/ETF 和 Hyperliquid 测试网快照、K 线与 extended stats。
- **多周期图表**：前端展示 watchlist、实时价格、K 线、成交量、均线、VWAP、布林带、RSI、MACD、ATR，并支持图表画线。
- **Watchlist 管理**：可以在 Web 设置里搜索并添加 Bitget / Alpaca 标的，也可以直接编辑 `watchlist.toml`。
- **Agent 分析**：支持 Codex Responses provider 和 Anthropic Messages provider。Agent 可以读取行情、K 线、新闻和本地交易记录，并返回结构化交易观察。
- **会话持久化**：每个标的都有独立 Agent session，历史记录保存在本地 SQLite，可以 resume、reset 或删除。
- **测试网 / 模拟盘交易**：Agent 或 API 可以向 Hyperliquid testnet 或 Bitget 模拟盘提交测试订单，并把结果同步记录到本地交易表。
- **交易复盘**：Positions 页面可以查看 open/planned/history/fills/lessons，也可以手动触发 review。
- **新闻流**：Reuters sitemap provider 会拉取新闻，写入本地 SQLite，并通过 Web UI 展示最新新闻。
- **新闻驱动分析**：可选的 `news_analyst` 会筛选新闻、结合 1H/15m 行情和 lessons 调用 LLM，输出可复盘的决策记录。

## 架构

```text
Bitget / Alpaca / Hyperliquid / Reuters
        |
        v
FastAPI backend  <---->  SQLite stores
        |
        +-- feed worker
        +-- agent runtime
        +-- news analyst
        |
        v
React + Vite frontend
```

核心代码路径：

- `mytradebot/api/app.py`：HTTP API、WebSocket、后台 worker 生命周期。
- `mytradebot/runtime/feed.py`：watchlist 行情循环、多周期 K 线、缓存与 provider 路由。
- `mytradebot/market_data/`：Bitget、Alpaca、Hyperliquid、catalog 和 candle provider。
- `mytradebot/agent/`：LLM provider、agent loop、工具和 session 存储。
- `mytradebot/trading/`：交易数据模型、SQLite store、Hyperliquid testnet / Bitget Demo Trading 客户端和 review controller。
- `mytradebot/news/`：Reuters 新闻抓取、存储和 API 数据源。
- `mytradebot/news_analyst/`：新闻筛选、LLM 分析、交易 gate 和决策记录。
- `web/src/App.tsx`：主 UI，包含 Chart、Agent、Positions 和设置页面。

## 快速启动

后端使用 Python，前端使用 Vite。开发时通常开两个进程：

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

npm install
npm run dev
```

另一个终端启动后端：

```bash
source .venv/bin/activate
python -m mytradebot --config watchlist.toml --host 127.0.0.1 --port 8765
```

然后打开：

```text
http://127.0.0.1:5173
```

如果要用单进程模式，先构建前端：

```bash
npm run build
python -m mytradebot --config watchlist.toml --host 127.0.0.1 --port 8765
```

这种模式下 FastAPI 会直接服务 `web/dist`。

## 配置

默认配置文件是 `watchlist.toml`。如果不传 `--config`，程序会读取当前目录下的 `watchlist.toml`。

一个接近当前功能面的示例：

```toml
symbols = [
  { symbol = "BTCUSDT", source = "bitget", inst_type = "USDT-FUTURES", label = "BTC Perp", group = "crypto", analysis_interval = "15m", show_collapsed = true },
  { symbol = "ETHUSDT", source = "bitget", inst_type = "SPOT", label = "ETH Spot", group = "crypto" },
  { symbol = "SPY", source = "alpaca", label = "SPY", group = "stocks", analysis_interval = "1H" },
  { symbol = "AAPL", source = "alpaca", label = "AAPL", group = "stocks" },
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

[news_analyst]
enabled = false
min_confidence = 0.7
max_entry_distance_pct = 0.5
default_size = 1.0
llm_timeout_seconds = 20
cooldown_minutes = 30

[[news_analyst.universe]]
instrument_key = "alpaca:SPY"
aliases = ["S&P 500", "SPX", "SPY"]
```

`symbols` 支持两种写法：

- 字符串：`"BTCUSDT"` 或 `"USDT-FUTURES:BTCUSDT"`，默认按 Bitget 解析。
- inline table：可以显式配置 `source`、`inst_type`、`label`、`group`、`analysis_interval`、`show_collapsed`。
- Alpaca 标的需要写成 inline table，并显式设置 `source = "alpaca"`。

常用 `analysis_interval`：

```text
1m, 3m, 5m, 15m, 30m, 1H, 4H, 6H, 12H, 1D, 3D, 1W, 1M
```

## 行情数据

Bitget：

- `source = "bitget"`
- spot 标的使用 `inst_type = "SPOT"`
- U 本位合约使用 `inst_type = "USDT-FUTURES"`
- catalog 和历史 K 线走 REST，实时报价走 public WebSocket。

Alpaca：

- `source = "alpaca"`
- 适合美股和 ETF。
- API key 只从环境变量读取，不写入 `watchlist.toml`。

```bash
export APCA_API_KEY_ID="..."
export APCA_API_SECRET_KEY="..."
export APCA_API_BASE_URL="https://paper-api.alpaca.markets"
export ALPACA_DATA_FEED="iex"
export ALPACA_EXTENDED_STATS_FEED="delayed_sip"
```

Alpaca Basic 常见限制是 IEX/default feed 和 delayed SIP 数据，UI 中的 extended stats 会按当前可用 feed 返回。

## Agent Provider

当前内置两个 provider：`codex` 和 `anthropic`。OpenAI provider 路径已经不再作为独立 provider 暴露。

Anthropic provider 使用 Messages API 形态，默认 base URL 是：

```text
https://claude-proxy.p1.cn/api
```

实际请求会发到：

```text
https://claude-proxy.p1.cn/api/v1/messages
```

认证 header 使用：

```text
x-api-key: <token>
content-type: application/json
```

环境变量：

```bash
export ANTHROPIC_AUTH_TOKEN="..."
# 也可以用：
export MYTRADEBOT_ANTHROPIC_API_KEY="..."
export ANTHROPIC_API_KEY="..."

# 可选
export MYTRADEBOT_ANTHROPIC_BASE_URL="https://claude-proxy.p1.cn/api"
export ANTHROPIC_BASE_URL="https://claude-proxy.p1.cn/api"
export MYTRADEBOT_ANTHROPIC_MODELS="global.anthropic.claude-opus-4-6-v1,global.anthropic.claude-sonnet-4-5-v1"
export MYTRADEBOT_ANTHROPIC_MAX_TOKENS="1200"
```

Codex provider 会优先读取 `CODEX_HOME/auth.json`，也支持环境变量：

```bash
export MYTRADEBOT_CODEX_API_KEY="..."
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
- `open_hyperliquid_testnet_trade`：向 Hyperliquid 测试网提交测试订单并记录 orderId / fill。
- `list_open_trades`：查看 open/planned 交易。
- `get_trade_history`：读取历史交易、fills 和 lessons。
- `web_search` / `web_fetch`：受限制的网页搜索和读取工具，会拒绝 localhost、内网地址和不安全 scheme。

`web_search` 默认使用 Exa MCP，并在失败时退回 DuckDuckGo HTML 搜索；不需要配置 Exa API key。可以用环境变量强制后端：

```bash
export MYTRADEBOT_WEB_SEARCH_BACKEND="auto"       # 默认：Exa MCP -> DuckDuckGo
export MYTRADEBOT_WEB_SEARCH_BACKEND="exa_mcp"    # 只用 Exa MCP
export MYTRADEBOT_WEB_SEARCH_BACKEND="duckduckgo" # 只用 DuckDuckGo
```

Agent 输出会被解析成结构化结果，核心字段包括 `summary`、`bias`、`confidence`、`key_levels`、`watch_plan`、`invalidation` 和 `risk_notes`。

## 交易记录与测试网

本地不再用 K 线模拟成交。Hyperliquid testnet 和 Bitget Demo Trading 订单会提交到对应测试环境，然后把订单结果写入 SQLite。

流程大致是：

1. Agent 或 API 提交 Hyperliquid testnet 或 Bitget Demo Trading 订单。
2. 下单结果写入本地 trade store。
3. review controller 定期或手动复盘交易，并把 lessons 写回本地。

Positions 页面可以看到：

- open / planned 交易记录。
- 已关闭和取消的历史交易。
- 每笔交易的 fills、snapshot 和 lesson。
- 手动 review 按钮。

## 测试网 / 模拟盘下单

Hyperliquid testnet 使用 SDK 和测试网私钥：

```bash
export HYPERLIQUID_TESTNET_PRIVATE_KEY="..."
# 可选
export HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS="..."
export HYPERLIQUID_TESTNET_VAULT_ADDRESS="..."
```

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

`instrument_key` 使用当前 watchlist 里的 Bitget key，例如 `USDT-FUTURES:BTCUSDT` 或 `SPOT:ETHUSDT`。

## 新闻和 News Analyst

新闻模块默认从 Reuters sitemap 拉取新闻，写入本地 store，并通过 `/api/news` 给前端展示。

`news_analyst` 是独立的可选模块。启用后，它会：

1. 从最近新闻里筛出候选 headline。
2. 映射到配置里的交易 universe。
3. 读取对应标的的 1H / 15m K 线和本地 lessons。
4. 调用 `[agent]` 里选定的 LLM provider 生成方向、置信度、入场、止损、止盈。
5. 通过 confidence、entry distance、cooldown 等 gate 后，写入可复盘的交易决策。

它不会真实下单，只写入本地 planned 交易记录用于复盘。

## Web UI

主界面分几块：

- **Watchlist**：左侧标的列表、分组、搜索、价格和涨跌幅。
- **Chart**：主 K 线图，支持周期切换、指标显示和本地画线。
- **Agent**：按标的发起分析，查看和恢复历史 session。
- **Positions**：查看交易记录、fills、history、lessons 和手动复盘。
- **Settings**：管理 Providers、Watchlist 和 News 配置。

画线数据保存在浏览器 localStorage，不会写入后端数据库。

## 本地数据

默认本地状态主要在这些地方：

- `watchlist.toml`：watchlist、display、agent、news、cache 配置。
- `~/.cache/mytradebot/agent_sessions.sqlite3`：Agent session 和消息历史。
- `~/.cache/mytradebot/trades.sqlite3`：交易记录、fills、snapshots、lessons。
- `~/.cache/mytradebot/news.sqlite3`：新闻、新闻决策和处理状态。
- `~/.cache/mytradebot/candles.sqlite3`：默认 K 线 cache；如果设置了 `XDG_CACHE_HOME` 或 `[cache].path`，会使用对应路径。
- 浏览器 localStorage：图表画线和部分前端偏好。

这些数据都是本地优先，没有服务端账号体系。

## API 概览

常用接口：

- `GET /api/state`：当前 watchlist、报价、K 线、provider 状态。
- `GET /api/instruments/search`：搜索可添加标的。
- `POST /api/watchlist/bitget` / `POST /api/watchlist/alpaca`：添加标的。
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

后端测试：

```bash
python -m unittest discover -s tests -p "test_*.py"
```

前端构建：

```bash
npm run build
```

## 当前边界

- 不连接真实盘账户下单；只支持 Hyperliquid testnet 和 Bitget Demo Trading。
- 本地不会用 1m K 线模拟成交；未成交或挂单状态需要以后接入交易所状态同步/撤单能力。
- Agent 和 news analyst 适合做研究辅助，不应该直接当作交易信号执行。
- Alpaca 数据能力取决于账号权限和 feed 配置。
- 新闻来源目前以 Reuters sitemap provider 为主。
