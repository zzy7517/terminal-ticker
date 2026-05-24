# tradex

tradex 是一个本地优先的行情监控和交易研究工作台。它把 Bitget、Hyperliquid 主网行情、LLM Agent、Reuters 新闻、X 社交动态、本地 SQLite 交易记录和定时任务放在同一个进程里，适合做盘中观察、交易想法复盘和策略原型验证，同时，tradex还集成了chrome的brower use。

它不是生产级交易终端。显式配置凭证并在 `watchlist.toml` 打开交易权限后，可以向 Hyperliquid 主网或 Bitget 提交订单；Bitget 支持 demo/live 两种模式，Hyperliquid 只支持主网 live。外部订单号会写回本地 SQLite。

## 现在它能做什么

- **行情监控**：订阅 Bitget futures，拉取 Hyperliquid 主网快照、K 线与 extended stats。
- **行情工作区**：前端展示 watchlist、实时价格摘要、Agent、新闻、社交动态和持仓面板。
- **Watchlist 管理**：可以在 Web 设置里搜索并添加 Bitget / Hyperliquid 主网标的，也可以直接编辑 `watchlist.toml`。
- **Agent 分析**：支持 Codex Responses provider 和 Anthropic Messages provider。Agent 可以读取行情、裸 K / 带指标 K 线、新闻、社交动态、本地记忆和交易记录。支持外部的mcp和skills集成。
- **会话持久化**：Agent session 会写成本地 JSONL，并用 SQLite 建索引；前端可以恢复、重置或删除历史会话。
- **交易执行**：配置层允许时，Agent 可以向 Hyperliquid 主网或 Bitget 提交订单；关闭时 Agent 只会给出开单建议。
- **交易复盘**：自动反思的memory模块，在每一笔交易中学习。
- **定时看盘**：Cron 面板可以配置周期任务，按固定时间触发 Agent 分析，结果保存为本地 session。
- **brower use**: 比如，agent可以打开chrome浏览器，去到tradingview页面，在黄金期货的日线图上画趋势线和通道线。

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

## 配置

默认配置文件是 `watchlist.toml`。如果不传 `--config`，程序会读取当前目录下的 `watchlist.toml`。

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

## Acknowledgements

本项目借鉴了大量来自其它开源项目的代码和设计，在此致谢：

- [**earendil-works/pi**](https://github.com/earendil-works/pi) 
- [**openai/codex**](https://github.com/openai/codex)
- [**iFurySt/open-browser-use**](https://github.com/iFurySt/open-browser-use)
