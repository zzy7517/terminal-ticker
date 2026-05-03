# 研究记录：本地图表 Agent 工作台

## 决策：用 OHLCV K 线做分析输入，不做截图识别

**理由**：K 线图本质是 OHLCV 数据的可视化。项目已经掌握 provider 边界和 K 线缓存，直接使用结构化数据更稳定，也更容易测试。截图识别会受到主题、缩放、坐标轴、绘图覆盖物和分辨率影响。

**考虑过的替代方案**：

- 截图识别：不采用。它适合临时看图，不适合作为本地盯盘工作台的核心输入。
- 只让 LLM 读自然语言摘要：不采用。摘要可以辅助，但不能替代可验证的 K 线窗口。

## 决策：会话状态保存在本地应用层

**理由**：用户要的是像 Codex / Claude Code 一样的连续工作体验。Codex 的关键做法是本地保存 thread / rollout item，然后每轮重建上下文；Hermes 的关键做法是把 session / messages 存到 SQLite，并把 `conversation_history` 带进下一轮。priceViewer 采用同样的工程原则：本地 SQLite 保存 per-instrument active session 和消息历史，每次 LLM 请求显式带上最近 turns。

**考虑过的替代方案**：

- 依赖 provider 远端 session：不采用。不同 provider 的 session 语义不一致，也会把产品状态绑死在某个 provider 上。
- 只在浏览器内存保存聊天记录：不采用。刷新页面或重启服务后会丢失上下文。
- 把所有历史都塞进每次请求：不采用。成本高，也会污染当前图表分析；默认只带最近历史。

## 决策：Codex 只是 LLM provider adapter

**理由**：产品目标是 K 线图 Agent，不是“Ask Codex”。Codex 当前适合作为默认 provider，因为本机已有 Codex CLI 登录态和 Responses 风格 backend；但 UI、session 模型、上下文 schema 都不应该依赖 Codex 命名。后续新增 OpenAI API、Anthropic 或本地模型时，应只新增 adapter。

**考虑过的替代方案**：

- 把 UI 写成 Codex Read / Ask Codex：不采用。它会把用户概念绑定到 provider，后续扩展成本高。
- 直接复用 Hermes runtime：不采用。Hermes 的 outer agent loop 和 Telegram 能力不是这个项目的核心；这里只吸收 session 设计。

## 决策：本地 Web 工作台继续作为主界面

**理由**：K 线交互、布局、会话面板和配置页更适合浏览器实现。React + Lightweight Charts 可以减少自绘图表成本，Python 后端继续承担行情、缓存、策略和 provider 凭证。

**考虑过的替代方案**：

- 回到 PySide 悬浮窗：不采用。用户目标已经从小窗行情变成图表工作台。
- 直接做 Electron / Tauri 包装：暂缓。先把本地浏览器工作流跑稳，再考虑桌面壳。

## 决策：主数据源收窄到 Bitget 和 Alpaca

**理由**：当前产品主路径是 crypto + 美股 / ETF。Bitget 覆盖 crypto，Alpaca 覆盖美股和 ETF；这两条线已经能支撑 K 线 Agent 的第一版。Longbridge 不再作为新功能依赖，避免后续功能继续加深旧 provider 耦合。

**考虑过的替代方案**：

- 继续把 Longbridge 写成必需数据源：不采用。用户已经明确不再需要它作为当前方向。
- 立即删除 Longbridge：暂缓。删除会影响 provider 文件、watchlist helper、API 路由和测试，应该单独做清理任务并一次性验证。
