# Terminal Ticker

一个本地优先的行情和策略研究 Web UI。后端用 Python 连接 Bitget 和 Alpaca，读取 OHLCV K 线并生成 regime/context 信号；前端用 React 和 Lightweight Charts 展示 watchlist、K 线图和 agent 解释面板。

## 功能

- 按 `watchlist.toml` 显示 Bitget、Alpaca 美股和 ETF 标的。
- 通过本地 WebSocket 推送实时 quote、K 线和策略状态更新。
- 使用结构化 OHLCV 数据生成 `long` / `short` / `flat` 研究信号、regime 和 confidence。
- 展示选中标的的 K 线图、价格、涨跌幅、成交量和 strategy context。
- 提供会话式 K 线 Agent 解读入口，把当前 K 线、策略信号、本地特征和最近问答历史转成结构化市场解读；Codex 只是当前默认的 LLM provider adapter。
- 美股页内搜索 Alpaca 标的，并写入本地 watchlist。
- Alpaca 凭证只从环境变量读取，不写入配置文件。
- 不包含 PySide/Qt 浮窗、折叠行情条或滚动 ticker。

## 快速开始

创建并激活虚拟环境：

```bash
cd /path/to/terminal-ticker
source .venv/bin/activate
pip install -r requirements.txt
```

安装前端依赖：

```bash
npm install
```

设置 Alpaca API 凭证。Paper trading 账户也可以用于 market data：

```bash
export APCA_API_KEY_ID="你的 Alpaca Key"
export APCA_API_SECRET_KEY="你的 Alpaca Secret"
export APCA_API_BASE_URL="https://paper-api.alpaca.markets"
export ALPACA_DATA_FEED="iex"
```

当前 Codex provider adapter 默认读取本机 Codex CLI 登录态：

```text
$CODEX_HOME/auth.json，未设置 CODEX_HOME 时使用 ~/.codex/auth.json
```

也可以用环境变量提供 Codex access token：

```bash
export TERMINAL_TICKER_CODEX_API_KEY="你的 Codex access token"
```

开发模式需要两个终端。

终端 1：启动 Python 后端：

```bash
.venv/bin/python -m terminal_ticker --host 127.0.0.1 --port 8765
```

终端 2：启动 Vite 前端：

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:5173
```

生产/单进程模式：

```bash
npm run build
.venv/bin/python -m terminal_ticker --host 127.0.0.1 --port 8765
```

然后打开：

```text
http://127.0.0.1:8765
```

使用自定义配置：

```bash
.venv/bin/python -m terminal_ticker --config my-watchlist.toml
```

临时指定 Bitget 标的：

```bash
.venv/bin/python -m terminal_ticker --symbols USDT-FUTURES:BTCUSDT USDT-FUTURES:ETHUSDT
```

## 配置格式

默认配置文件是 [`watchlist.toml`](watchlist.toml)。

```toml
symbols = [
  { symbol = "AAPL", source = "alpaca", label = "AAPL", group = "stocks" },
  { symbol = "SPY", source = "alpaca", label = "SPY", group = "stocks" },
  { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC", group = "crypto" },
  { symbol = "ETHUSDT", inst_type = "USDT-FUTURES", label = "ETH", group = "crypto" },
]

[display]
refresh_interval_ms = 1000
stale_after_seconds = 20
reconnect_delay_seconds = 3.0
stock_poll_interval_seconds = 5

[analysis]
enabled = true
interval = "5m"
lookback = 40
poll_interval_seconds = 30
stale_after_seconds = 420

[agent]
enabled = true
provider = "codex"
api_mode = "codex_responses"
model = "gpt-5.4-mini"
timeout_seconds = 45
max_candles = 40
reasoning_effort = "medium"
```

配置说明：

- `source` 默认是 `bitget`，所以旧的字符串写法和旧的 Bitget table 写法仍然可用。
- Bitget 标的如果同时存在于 Spot 和 Futures，需要写明 `inst_type`，例如 `BTCUSDT`。
- Alpaca 标的使用 `source = "alpaca"`，美股格式是 `AAPL`、`SPY`；旧的 `AAPL.US` 会自动兼容成 `AAPL`。
- `group` 控制 Web UI 左侧 watchlist 分组。常用值包括 `stocks`、`crypto`、`metals`、`indices`、`watchlist`。
- 没有写 `group` 时会自动归类：Bitget 到 `crypto`，Alpaca 到 `stocks`。
- `refresh_interval_ms` 控制后端向 WebSocket 客户端刷新状态的心跳。
- `stock_poll_interval_seconds` 控制 Alpaca 股票 quote 快照拉取间隔。
- `[analysis]` 控制本地 K 线拉取和 strategy context 刷新。当前对 Bitget 和 Alpaca 标的拉取 OHLCV K 线，并基于 K 线生成 `long` / `short` / `flat` 研究信号。
- `analysis.interval` 是 K 线周期，默认 `5m`。
- `analysis.lookback` 是每次拉取和策略上下文使用的最近 K 线数量，最小值是 `10`。
- `analysis.poll_interval_seconds` 控制 K 线刷新间隔。
- `analysis.stale_after_seconds` 控制最新行情多久后视为过期。
- `[agent]` 控制 LLM provider 层。第一版只支持 `provider = "codex"`，但产品侧的核心概念是 K 线 Agent 会话，不是“问 Codex”。
- `agent.api_mode` 当前固定为 `codex_responses`，这和 Hermes 把 `openai-codex` 映射到 Responses 风格 transport 的思路一致。
- Codex provider adapter 会直接读取 Codex CLI 的 `auth.json`，不会读取 Hermes 的 auth store，也不会导入 Hermes runtime。
- Codex provider adapter 不再支持通过配置文件或环境变量覆盖 base URL；当前只走内置 Codex backend。
- Web UI 右侧 `Agent Config` 可以刷新当前 Codex 账号可用模型，选择模型后会写回配置文件。
- `agent.max_candles` 控制每次发送给 LLM 的最近 K 线数量，最小值是 `10`。
- `agent.reasoning_effort` 支持 `low`、`medium`、`high`、`xhigh`。
- 旧配置里的 `show_collapsed` 会被解析以保持兼容，但 Web UI 不再使用折叠行情条。

## Strategy Context

本地策略层不再输出 `TR+`、`BO+`、`RG` 这类固定 price-action 标签，而是直接读取交易所返回的 OHLCV 数据，提取 regime/context filter 特征：

- `O`：开盘价
- `H`：最高价
- `L`：最低价
- `C`：收盘价
- `V`：成交量

当前策略信号：

- `long`：结构化特征支持做多观察
- `short`：结构化特征支持做空观察
- `flat`：趋势置信度不足，或者当前 regime 更适合空仓/等待

本地特征包括近期涨跌幅、range efficiency、ATR 百分比、realized volatility、EMA trend score、价格在区间里的位置和成交量相对均值。这个信号是研究信号，不会下单、不会管理仓位，也不会给出买卖按钮。

可以用离线脚本把历史数据切成前半段和后半段：前半段搜索参数，后半段做样本外验证。

```bash
.venv/bin/python scripts/research_strategy.py --symbol BTCUSDT --inst-type USDT-FUTURES --interval 5m --limit 1000 --refresh
```

输出会包含训练段和验证段的 `trades`、`hit_rate`、`average_trade_return`、`total_return`、`max_drawdown`、`sharpe_like` 等指标。抓到的 K 线会保存到 `data/strategy/*.csv`，后续不加 `--refresh` 时会复用本地数据。

## Agent 会话解读

Web UI 右侧的 `Ask Agent` 会把用户问题追加到当前标的的本地会话，并触发一次手动分析。后端发送给 LLM provider 的不是截图，而是当前标的的结构化上下文：

- 标的信息和实时 quote。
- 最近 OHLCV K 线。
- 本地 strategy signal、regime、confidence 和近期高低点、最新实体、最新振幅、成交量均值等事实。
- 当前标的最近的用户问题和 Agent 回复摘要，用于延续会话。

LLM provider 必须返回结构化 JSON，Web UI 会展示摘要、方向、置信度、关键价位、观察计划和失效条件。会话消息会持久化到本机 SQLite cache，按标的保留 active session；没有 K 线、provider 凭证缺失、token 过期或 provider 请求失败时，只会显示不可用状态，不影响行情和本地 strategy signal。

## 添加和移除美股

Web UI 左侧搜索框可以输入代码或名称，例如 `NVDA`、`AAPL`、`Apple`。

搜索结果不在 watchlist 时，动作按钮显示“添加”：

- 立即把标的加入当前运行状态并开始拉行情。
- 写入当前启动使用的 `watchlist.toml`，下次启动仍然保留。

搜索结果已经在 watchlist 时，动作按钮显示“移除”：

- 立即从当前运行状态移除这个 Alpaca 标的。
- 从当前启动使用的 `watchlist.toml` 删除精确匹配的 `source = "alpaca"` 行，不会删除 Bitget 标的。

Alpaca 免费 Basic market data 的 REST 限制约为 `200 requests/min`，实时股票 feed 是 `IEX`，历史数据最新 15 分钟有权限限制。项目默认给 bars 请求留出 16 分钟窗口，适合分钟级研究和本地指标，不适合当全市场实时 tick 源。

## zsh 配置示例

如果你希望每次开终端都自动带上 Alpaca 凭证，可以把下面几行加到 `~/.zshrc`：

```bash
export APCA_API_KEY_ID="你的 Alpaca Key"
export APCA_API_SECRET_KEY="你的 Alpaca Secret"
export APCA_API_BASE_URL="https://paper-api.alpaca.markets"
export ALPACA_DATA_FEED="iex"
```

然后让当前终端生效：

```bash
source ~/.zshrc
```

检查环境变量是否存在时，不要把密钥完整打印出来。可以这样看：

```bash
printenv APCA_API_KEY_ID
printenv APCA_API_SECRET_KEY | cut -c1-8
```

## 验证

```bash
.venv/bin/python -m unittest discover -s tests
npm run build
```

## 限制

- 这是个人行情监控工具，不是生产级行情终端。
- 当前 Alpaca provider 接美股和 ETF quote/K 线，免费档使用 IEX feed，数据和全市场 SIP 可能有差异。
- 当前不做指数、MT5 或商品期货接入。
- 当前不做自动交易、订单执行、仓位管理或风险控制。
- 当前 Web UI 是本地产品形态，不包含桌面托盘、置顶窗口或原生 macOS 封装。
