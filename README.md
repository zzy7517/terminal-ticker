# tradex

tradex 是一个本地优先的行情监控和交易研究工作台。它把 Bitget 行情、LLM Agent、Reuters 新闻、本地 SQLite 交易记录和定时任务放在同一个进程里，适合做盘中观察、交易想法复盘和策略原型验证，同时，tradex还集成了chrome的brower use。

它不是生产级交易终端。显式配置凭证并在 `watchlist.toml` 打开交易权限后，可以向 Bitget 提交订单；Bitget 支持 demo/live 两种模式。外部订单号会写回本地 SQLite。

## 现在它能做什么

- **行情监控**：订阅 Bitget futures，拉取快照与 K 线。
- **Jin10 数据**：集成金十数据，实时行情报价（黄金、原油、汇率、指数等）、快讯 Flash、经济日历。通过 MCP 桥接调用 jin10 server。
- **期权 / GEX 分析**：对美股/ETF（SPY、QQQ、AAPL、NVDA、GLD、IBIT 等）和加密（BTC/ETH）计算 Gamma Exposure、做市商定位与隐藏对冲流。Black-Scholes Greeks 引擎，输出 net GEX、gamma regime（正/负）、Zero Gamma Level、Call/Put Wall、Max Gamma Strike，以及 charm/vanna 隐藏流、对冲脉冲与压力云。数据源 MarketData.app 为主、Yahoo Finance 免费兜底，按需懒刷新（默认 12h 新鲜度）。前端有 Options 面板做可视化。
- **行情工作区**：前端展示 watchlist、实时价格摘要、Agent、新闻、经济日历和持仓面板。
- **Watchlist 管理**：可以在 Web 设置里搜索并添加 Bitget 标的，也可以直接编辑 `watchlist.toml`。金十数据标的可在 mcp配置里直接添加。
- **Agent 分析**：支持 Codex Responses provider、Anthropic Messages provider，以及 OpenAI Chat Completions provider（可指向任意 OpenAI 兼容端点）。Agent 可以读取行情、裸 K / 带指标 K 线、路透社新闻、金十快讯、期权 GEX / 做市商定位、本地记忆和交易记录。Pi / Claude / Cursor 等 Runtime 通过同一条 session-scoped `tradex` CLI 调用业务工具；也支持 skills 与外部数据源集成。
- **Origin 会话**：无需创建固定 Agent 身份，消息直接发送给 Pi、Claude Code 或 Cursor Runtime。New Origin 在第一次发送消息前只保留为浏览器草稿；首次发送时才创建持久化会话及随机工作目录，并固定本次会话使用的 provider、model 和 reasoning 配置。
- **外部 MCP 数据源**：通过 `.mcp.json` 配置上游 MCP server（如 jin10）。Tradex 作为客户端连接后，把可用工具并入业务 `ToolRegistry`，再经 `tradex` CLI 暴露给 Agent。前端 Settings 可视化管理这些外部连接。Tradex 自身不再作为 Agent 侧 MCP server。
- **会话持久化**：Agent session 会写成本地 JSONL，并用 SQLite 建索引；前端可以恢复、重置或删除历史会话。
- **交易执行**：配置层允许时，Agent 可以向 Bitget 提交订单；关闭时 Agent 只会给出开单建议。
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

**期权数据**：`[options]` 段控制期权/GEX 模块。`provider = "marketdata"` 用 MarketData.app（需在 marketdata.app 免费申请 token），失败或空链时自动回落到 Yahoo Finance（免费无 key）。MarketData token 通过 `[options.marketdata].api_key` 配置，支持 `${MARKETDATA_API_KEY}` 形式的环境变量引用，凭证不必写进 `watchlist.toml`。加密标的（BTC/ETH）走 Deribit 公开 API，无需 key。快照按需懒刷新（默认 12h 新鲜度），无后台轮询。

## Web UI

界面采用高信息密度的工作台布局，并支持 light / dark 主题。排版以 Geist 为主、Geist Mono 用于行情和代码类数据；颜色、层级、圆角、控件和阴影统一由设计 token 管理。整体保留交易工具的克制与扫描效率，同时使用清晰的表面层级、适度圆角和轻量阴影；Origin 复用同一套视觉语言，而不是独立的零圆角终端皮肤。

主界面分几块：

- **Watchlist**：左侧标的列表、分组、拖拽排序、价格和涨跌幅。支持 Jin10 实时报价标的。
- **Chat**：使用固定 Agent 身份的 Direct Message、多人 Channel，以及不绑定身份的 Origin Session。Origin 支持创建、切换和永久删除 Tradex 持有的会话数据，并可选择 Runtime、provider、model 和 reasoning effort；Cursor CLI 暂不提供原生 chat 删除能力，删除响应会明确标记这部分外部状态仍被保留。
- **Positions**：查看实时持仓、交易记录、fills、history、lessons，并撤销交易所挂单。
- **News**：Reuters 新闻、Jin10 快讯。
- **Calendar**：经济日历（来自 Jin10），按时间排列重要经济事件和数据发布。
- **Options**：期权 GEX 可视化——net GEX、gamma regime、Zero Gamma Level、Call/Put Wall 等关键位，以及逐行权价的 GEX 柱状图。
- **Cron**：管理定时看盘任务、手动触发任务并查看运行记录。
- **Settings**：管理 Providers、Watchlist、Agent Context、Appearance（头像风格）、News、Cron、MCP、Options 和 Browser 配置。

## 本地数据

默认本地状态主要在这些地方：

- `watchlist.toml`：watchlist、display、agent、news、cache、trading、jin10、options、browser 配置。
- `.mcp.json`：外部上游 MCP server 配置（jin10 等数据源）；不是 Tradex 对外暴露的 Agent MCP endpoint。
- `~/.cache/tradex/agent_sessions/`：Agent session JSONL 消息历史。
- `~/.cache/tradex/origin_sessions/`：Origin Session 的元数据、各 Runtime 会话记录和 Tradex 管理的随机工作目录。
- `~/.cache/tradex/session_index.sqlite3`：Agent session 索引。
- `~/.cache/tradex/cron.sqlite3`：定时任务配置。
- `~/.cache/tradex/cron_sessions/`：定时任务运行记录。
- `~/.cache/tradex/trades.sqlite3`：交易记录、fills、snapshots、lessons。
- `~/.cache/tradex/news.sqlite3`：新闻条目和抓取 cursor。
- `~/.cache/tradex/candles.sqlite3`：默认 K 线 cache；如果设置了 `XDG_CACHE_HOME` 或 `[cache].path`，会使用对应路径。
- `~/.cache/tradex/options.sqlite3`：期权 GEX 快照（每个标的仅保留最新一条，用于重启后预热缓存）。
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
- [**PokeAPI/sprites**](https://github.com/PokeAPI/sprites)：可选 Pokemon official artwork 头像的远程图片来源

## Agent 头像与版权说明

- Pokemon 及相关图像版权属于 **Nintendo / Creatures Inc. / GAME FREAK Inc.**（以及 The Pokémon Company）。
- [PokeAPI/sprites](https://github.com/PokeAPI/sprites) 方便社区引用，**并不等于**授予任天堂 IP 的商业使用许可。仓库自身也声明图像内容仍属 The Pokémon Company。
