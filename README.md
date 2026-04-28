# Terminal Ticker

一个适合放在屏幕角落的浮动行情小窗，支持 macOS 和 Linux。它从本地 `watchlist.toml` 读取标的，保留 Bitget 加密行情的实时 WebSocket 数据，同时通过长桥 OpenAPI 拉取美股和 ETF 行情。

## 功能

- 按 watchlist 显示行情。
- 无边框、置顶的小窗，适合常驻屏幕角落。
- 展开状态按分类标签页显示全部标的。
- 美股页可以按代码或中英文名称搜索长桥标的并添加到本地 watchlist。
- 折叠状态显示横向滚动行情，并可单独选择哪些标的出现。
- 支持 Bitget `USDT-FUTURES` 和 `SPOT`。
- 支持长桥 OpenAPI 美股和 ETF 行情。
- 支持 Bitget OHLCV K 线的本地价格行为分析，显示趋势、震荡、突破尝试和回调状态。
- 折叠状态显示哪些标的由 `watchlist.toml` 里的 `show_collapsed` 控制。
- Bitget 连接失败后会自动重连。
- 长桥凭证只从环境变量读取，不写入配置文件。

## 快速开始

创建并激活虚拟环境：

```bash
cd /path/to/terminal-ticker
source .venv/bin/activate
pip install -r requirements.txt
```

设置长桥 OpenAPI 凭证：

```bash
export LONGBRIDGE_APP_KEY="你的 App Key"
export LONGBRIDGE_APP_SECRET="你的 App Secret"
export LONGBRIDGE_ACCESS_TOKEN="你的 Access Token"
export LONGBRIDGE_REGION="cn"
```

使用默认 watchlist 启动：

```bash
python -m terminal_ticker
```

使用自定义配置：

```bash
python -m terminal_ticker --config my-watchlist.toml
```

临时指定 Bitget 标的：

```bash
python -m terminal_ticker --symbols USDT-FUTURES:BTCUSDT USDT-FUTURES:ETHUSDT
```

## 配置格式

默认配置文件是 [`watchlist.toml`](watchlist.toml)。

```toml
symbols = [
  { symbol = "AAPL.US", source = "longbridge", label = "AAPL", group = "stocks", show_collapsed = true },
  { symbol = "SPY.US", source = "longbridge", label = "SPY", group = "stocks", show_collapsed = false },
  { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC", group = "crypto" },
  { symbol = "ETHUSDT", inst_type = "USDT-FUTURES", label = "ETH", group = "crypto" },
  { symbol = "XAUUSDT", inst_type = "USDT-FUTURES", label = "XAU", group = "crypto" },
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
```

配置说明：

- `source` 默认是 `bitget`，所以旧的字符串写法和旧的 Bitget table 写法仍然可用。
- Bitget 标的如果同时存在于 Spot 和 Futures，需要写明 `inst_type`，例如 `BTCUSDT`。
- 长桥标的使用 `source = "longbridge"`，美股格式是 `AAPL.US`、`SPY.US`。
- `group` 控制展开状态里的分类标签页。`stocks` 在界面中显示为“美股”，其他常用值包括 `crypto`、`metals`、`indices`、`watchlist`。
- 没有写 `group` 时会自动归类：Bitget 到 `crypto`，长桥到 `stocks`。
- `show_collapsed` 控制折叠状态是否显示该标的。
- `refresh_interval_ms` 控制 UI 心跳刷新，用于 stale 计时显示，不控制交易所推送频率。
- `longbridge_poll_interval_seconds` 控制长桥 quote 拉取间隔。
- `[analysis]` 控制本地价格行为分析。当前只对 Bitget 标的拉取 OHLCV K 线并生成紧凑状态标记；长桥标的仍然只显示 quote。
- `analysis.interval` 是 K 线周期，默认 `5m`。
- `analysis.lookback` 是每次分析使用的最近 K 线数量，最小值是 `10`。
- `analysis.poll_interval_seconds` 控制 K 线分析刷新间隔。
- `analysis.stale_after_seconds` 控制分析结果和最新 K 线多久后视为过期；默认值是 `420`，能覆盖一根 5 分钟 K 线的形成时间。过期分析不会在折叠行情条中显示。

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

## 添加和移除美股

展开窗口后进入“美股”页，在顶部搜索框输入代码或名称，例如 `NVDA`、`Apple`、`苹果`，点击“搜索”。

搜索结果不在 watchlist 时，动作按钮显示“添加”：

- 立即把标的加入当前窗口并开始拉行情。
- 主动写入当前启动使用的 `watchlist.toml`，下次启动仍然保留。

搜索结果已经在 watchlist 时，动作按钮显示“移除”：

- 立即从当前窗口移除这个长桥标的。
- 从当前启动使用的 `watchlist.toml` 删除精确匹配的 `source = "longbridge"` 行，不会删除 Bitget 加密标的。

长桥没有单独的 keyword search endpoint；输入 `AAPL`、`NVDA` 这种代码时会先用 `static_info(["AAPL.US"])` 精确查询，不会拉完整列表。输入 `Apple`、`苹果` 这种名称时，才会用 `security_list(Market.US, SecurityListCategory.Overnight)` 获取美股标的列表，并在本地按代码和名称过滤。列表搜索结果会在进程内缓存一段时间，避免每次名称搜索都重新拉完整列表。

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

## 窗口操作

- 拖动窗口任意位置可以移动。
- 展开状态通过“美股”、`Crypto`、`Metals`、`Indices`、`Watchlist` 等标签页切换分类。
- 展开状态可以拖动右下角调整面板大小。
- 点击 `–` 折叠为滚动行情条。
- 点击 `+` 展开；点击滚动行情条本身不会展开。
- 点击 `×` 关闭。

## 限制

- 这是个人行情监控工具，不是生产级行情终端。
- 当前长桥 provider 只接美股和 ETF quote，不保留 Yahoo fallback。
- 当前不做指数、MT5、商品期货或 K 线研究。
- 当前价格行为分析只覆盖 Bitget 标的，不覆盖长桥标的。
- 当前不做自动交易、订单执行、仓位管理或风险控制。
- 窗口基于 Qt，不是 Swift/AppKit 原生 macOS 应用。
