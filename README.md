# tradex

tradex 是一个本地优先的行情监控和交易研究工作台。它把 Bitget、Hyperliquid 主网行情、LLM Agent、Reuters 新闻、X 社交动态、本地 SQLite 交易记录和定时任务放在同一个进程里，适合做盘中观察、交易想法复盘和策略原型验证，同时，tradex还集成了chrome的brower use。

它不是生产级交易终端。显式配置凭证并在 `watchlist.toml` 打开交易权限后，可以向 Hyperliquid 主网或 Bitget 提交订单；Bitget 支持 demo/live 两种模式，Hyperliquid 只支持主网 live。外部订单号会写回本地 SQLite。

## 现在它能做什么

- **行情监控**：订阅 Bitget futures，拉取 Hyperliquid 主网快照、K 线与 extended stats。
- **Jin10 数据**：集成金十数据，实时行情报价（黄金、原油、汇率、指数等）、快讯 Flash、经济日历。通过 MCP 桥接调用 jin10 server。
- **行情工作区**：前端展示 watchlist、实时价格摘要、Agent、新闻、社交动态、经济日历和持仓面板。
- **Watchlist 管理**：可以在 Web 设置里搜索并添加 Bitget / Hyperliquid 主网标的，也可以直接编辑 `watchlist.toml`。金十数据标的可在 mcp配置里直接添加。
- **Agent 分析**：支持 Codex Responses provider 和 Anthropic Messages provider。Agent 可以读取行情、裸 K / 带指标 K 线、路透社新闻、金十快讯、社交动态、本地记忆和交易记录。支持外部 MCP 和 skills 集成。
- **MCP 集成**：通过 `.mcp.json` 配置外部 MCP server（如 jin10），Agent 可以调用 MCP 工具。前端 Settings 可视化管理 MCP 连接。
- **会话持久化**：Agent session 会写成本地 JSONL，并用 SQLite 建索引；前端可以恢复、重置或删除历史会话。
- **交易执行**：配置层允许时，Agent 可以向 Hyperliquid 主网或 Bitget 提交订单；关闭时 Agent 只会给出开单建议。
- **交易复盘**：自动反思的 memory 模块，在每一笔交易中学习。
- **定时看盘**：Cron 面板可以配置周期任务，按固定时间触发 Agent 分析，结果保存为本地 session。
- **Browser Use**：Agent 可以通过 Open Browser Use 控制 Chrome 浏览器，比如去 TradingView 画趋势线、截图、读取页面内容。

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

界面采用 Bloomberg Terminal 风格：纯黑背景、全等宽字体（JetBrains Mono）、零圆角、荧光橙 accent、1px 网格边框、高信息密度。没有 light/dark 切换——始终是终端模式。

主界面分几块：

- **Watchlist**：左侧标的列表、分组、拖拽排序、价格和涨跌幅。支持 Jin10 实时报价标的。
- **Agent**：创建、运行、切换和恢复历史 session。支持多模型切换和 effort 调节。
- **Positions**：查看实时持仓、交易记录、fills、history、lessons，并撤销交易所挂单。
- **News / Social**：Reuters 新闻、Jin10 快讯、X 社交动态。
- **Calendar**：经济日历（来自 Jin10），按时间排列重要经济事件和数据发布。
- **Cron**：管理定时看盘任务、手动触发任务并查看运行记录。
- **Settings**：管理 Providers、Watchlist、Agent Context、News、Social、Memory、Cron、MCP 和 Browser 配置。

## 本地数据

默认本地状态主要在这些地方：

- `watchlist.toml`：watchlist、display、agent、news、social、memory、cache、trading、jin10、browser 配置。
- `.mcp.json`：MCP server 配置（jin10 等外部工具 server）。
- `~/.cache/tradex/agent_sessions/`：Agent session JSONL 消息历史。
- `~/.cache/tradex/session_index.sqlite3`：Agent session 索引。
- `~/.cache/tradex/cron.sqlite3`：定时任务配置。
- `~/.cache/tradex/cron_sessions/`：定时任务运行记录。
- `~/.cache/tradex/trades.sqlite3`：交易记录、fills、snapshots、lessons。
- `~/.cache/tradex/news.sqlite3`：新闻条目和抓取 cursor。
- `~/.cache/tradex/social_feed.sqlite3`：社交动态缓存。
- `~/.cache/tradex/candles.sqlite3`：默认 K 线 cache；如果设置了 `XDG_CACHE_HOME` 或 `[cache].path`，会使用对应路径。
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

## Acknowledgements

本项目借鉴了大量来自其它开源项目的代码和设计，在此致谢：

- [**earendil-works/pi**](https://github.com/earendil-works/pi) 
- [**openai/codex**](https://github.com/openai/codex)
- [**iFurySt/open-browser-use**](https://github.com/iFurySt/open-browser-use)
- [**chrisworsey55/atlas-gic**](https://github.com/chrisworsey55/atlas-gic) — 多智能体交易流水线和 Darwinian evolution 架构参考
