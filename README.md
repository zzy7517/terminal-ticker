# Terminal Ticker

一个本地优先的价格行为 Web UI。后端用 Python 连接 Bitget 和长桥 OpenAPI，读取 OHLCV K 线并生成 price action 状态；前端用 React 和 Lightweight Charts 展示 watchlist、K 线图和 agent 解释面板。

## 功能

- 按 `watchlist.toml` 显示 Bitget、长桥美股和 ETF 标的。
- 通过本地 WebSocket 推送实时 quote、K 线分析和状态更新。
- 使用结构化 OHLCV 数据分析趋势、震荡、突破尝试和回调状态。
- 展示选中标的的 K 线图、价格、涨跌幅、成交量和 price action 解释。
- 提供 Codex provider 的 LLM 解读入口，把当前 K 线和本地分析结果转成结构化市场解读。
- 美股页内搜索长桥标的，并写入本地 watchlist。
- 长桥凭证只从环境变量读取，不写入配置文件。
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

设置长桥 OpenAPI 凭证：

```bash
export LONGBRIDGE_APP_KEY="你的 App Key"
export LONGBRIDGE_APP_SECRET="你的 App Secret"
export LONGBRIDGE_ACCESS_TOKEN="你的 Access Token"
export LONGBRIDGE_REGION="cn"
```

Codex agent 解读默认读取本机 Codex CLI 登录态：

```text
$CODEX_HOME/auth.json，未设置 CODEX_HOME 时使用 ~/.codex/auth.json
```

也可以用环境变量覆盖：

```bash
export TERMINAL_TICKER_CODEX_API_KEY="你的 Codex access token"
export TERMINAL_TICKER_CODEX_BASE_URL="https://chatgpt.com/backend-api/codex"
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
  { symbol = "AAPL.US", source = "longbridge", label = "AAPL", group = "stocks" },
  { symbol = "SPY.US", source = "longbridge", label = "SPY", group = "stocks" },
  { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC", group = "crypto" },
  { symbol = "ETHUSDT", inst_type = "USDT-FUTURES", label = "ETH", group = "crypto" },
]

[display]
refresh_interval_ms = 1000
stale_after_seconds = 20
reconnect_delay_seconds = 3.0
longbridge_poll_interval_seconds = 2

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
model = "gpt-5.2-codex"
timeout_seconds = 45
max_candles = 40
reasoning_effort = "medium"
```

配置说明：

- `source` 默认是 `bitget`，所以旧的字符串写法和旧的 Bitget table 写法仍然可用。
- Bitget 标的如果同时存在于 Spot 和 Futures，需要写明 `inst_type`，例如 `BTCUSDT`。
- 长桥标的使用 `source = "longbridge"`，美股格式是 `AAPL.US`、`SPY.US`。
- `group` 控制 Web UI 左侧 watchlist 分组。常用值包括 `stocks`、`crypto`、`metals`、`indices`、`watchlist`。
- 没有写 `group` 时会自动归类：Bitget 到 `crypto`，长桥到 `stocks`。
- `refresh_interval_ms` 控制后端向 WebSocket 客户端刷新状态的心跳。
- `longbridge_poll_interval_seconds` 控制长桥 quote 拉取间隔。
- `[analysis]` 控制本地价格行为分析。当前对 Bitget 和长桥标的拉取 OHLCV K 线并生成状态。
- `analysis.interval` 是 K 线周期，默认 `5m`。
- `analysis.lookback` 是每次分析使用的最近 K 线数量，最小值是 `10`。
- `analysis.poll_interval_seconds` 控制 K 线分析刷新间隔。
- `analysis.stale_after_seconds` 控制分析结果和最新 K 线多久后视为过期。
- `[agent]` 控制 LLM 解读层。第一版只支持 `provider = "codex"`。
- `agent.api_mode` 当前固定为 `codex_responses`，这和 Hermes 把 `openai-codex` 映射到 Responses 风格 transport 的思路一致。
- Codex provider 会直接读取 Codex CLI 的 `auth.json`，不会读取 Hermes 的 auth store，也不会导入 Hermes runtime。
- `agent.max_candles` 控制每次发送给 LLM 的最近 K 线数量，最小值是 `10`。
- `agent.reasoning_effort` 支持 `low`、`medium`、`high`、`xhigh`。
- 旧配置里的 `show_collapsed` 会被解析以保持兼容，但 Web UI 不再使用折叠行情条。

## 价格行为分析

价格行为分析不识别屏幕截图里的 K 线图，而是直接读取交易所返回的 OHLCV 数据：

- `O`：开盘价
- `H`：最高价
- `L`：最低价
- `C`：收盘价
- `V`：成交量

当前状态标记：

- `TR+` / `TR-`：上涨或下跌趋势
- `RG`：震荡区间
- `BO+` / `BO-`：向上或向下突破尝试
- `PB+` / `PB-`：上涨或下跌背景里的回调

这只是本地监控和解释层，不会下单、不会管理仓位，也不会给出买卖按钮。

## Codex Agent 解读

Web UI 右侧的 `Ask Codex` 会触发一次手动分析。后端发送给 Codex 的不是截图，而是当前标的的结构化上下文：

- 标的信息和实时 quote。
- deterministic price action 结果。
- 最近 OHLCV K 线。
- 本地计算出的近期高低点、最新实体、最新振幅、成交量均值等事实。

Codex 必须返回结构化 JSON，Web UI 会展示摘要、方向、置信度、关键价位、观察计划和失效条件。没有 K 线、Codex 登录态缺失、token 过期或 provider 请求失败时，只会显示不可用状态，不影响行情和本地 price action。

## 添加和移除美股

Web UI 左侧搜索框可以输入代码或名称，例如 `NVDA`、`Apple`、`苹果`。

搜索结果不在 watchlist 时，动作按钮显示“添加”：

- 立即把标的加入当前运行状态并开始拉行情。
- 写入当前启动使用的 `watchlist.toml`，下次启动仍然保留。

搜索结果已经在 watchlist 时，动作按钮显示“移除”：

- 立即从当前运行状态移除这个长桥标的。
- 从当前启动使用的 `watchlist.toml` 删除精确匹配的 `source = "longbridge"` 行，不会删除 Bitget 标的。

## zsh 配置示例

如果你希望每次开终端都自动带上长桥凭证，可以把下面几行加到 `~/.zshrc`：

```bash
export LONGBRIDGE_APP_KEY="你的 App Key"
export LONGBRIDGE_APP_SECRET="你的 App Secret"
export LONGBRIDGE_ACCESS_TOKEN="你的 Access Token"
export LONGBRIDGE_REGION="cn"
```

然后让当前终端生效：

```bash
source ~/.zshrc
```

检查环境变量是否存在时，不要把密钥完整打印出来。可以这样看：

```bash
printenv LONGBRIDGE_APP_KEY
printenv LONGBRIDGE_ACCESS_TOKEN | cut -c1-8
```

## 验证

```bash
.venv/bin/python -m unittest discover -s tests
npm run build
```

## 限制

- 这是个人行情监控工具，不是生产级行情终端。
- 当前长桥 provider 接美股和 ETF quote，并在长桥 OpenAPI 凭证和行情权限可用时拉取 K 线用于本地分析；不可用时会退回 quote-only。
- 当前不做指数、MT5 或商品期货接入。
- 当前不做自动交易、订单执行、仓位管理或风险控制。
- 当前 Web UI 是本地产品形态，不包含桌面托盘、置顶窗口或原生 macOS 封装。
