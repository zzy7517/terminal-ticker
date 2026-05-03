# 功能规格：本地图表 Agent 工作台

**功能分支**：`main`
**创建时间**：2026-04-28
**最近更新**：2026-05-04
**状态**：已实现，继续演进
**输入**：用户希望把项目从悬浮行情工具推进成 K 线图方向的 Codex / Claude Code：用户围绕一个标的和当前 K 线连续提问，系统保留会话历史；Codex 只作为 LLM provider adapter，不是产品概念本身。

## 用户场景与测试

### 用户故事 1：使用本地浏览器行情工作台（优先级：P1）

作为盯盘用户，我希望打开本地 Web 页面后直接看到 watchlist、K 线图、本地策略信号和右侧 Agent 面板，这样我可以围绕一个标的持续观察，而不是使用旧的桌面悬浮 ticker。

**独立测试**：启动本地服务，打开浏览器页面，确认 REST 状态接口和 WebSocket 能提供标的、报价、K 线、策略信号和 Agent 配置。

**验收场景**：

1. **给定** 已配置的 `watchlist.toml`，**当** Web UI 加载，**那么** 页面展示分组标的、当前选中标的和 K 线图。
2. **给定** 某个标的有足够的新鲜 K 线，**当** 用户选择该标的，**那么** 页面展示 regime/context 信号、关键特征和最近 K 线。
3. **给定** 前端 dist 不存在，**当** 开发者运行 Vite，**那么** 前端仍可通过 dev proxy 连接 Python 后端。

---

### 用户故事 2：围绕单个标的连续对话（优先级：P1）

作为交易研究用户，我希望对当前 K 线图发起连续提问，并在切换或刷新页面后保留当前标的的 active session，这样 Agent 可以参考最近问答历史，而不是每次都像一次性分析。

**独立测试**：对同一个 instrument key 连续调用消息接口，确认 SQLite 中保存 user / assistant 消息，后续 LLM 上下文包含最近历史。

**验收场景**：

1. **给定** 用户在 AAPL 页面输入问题，**当** 请求 `/api/agent/sessions/{instrument_key}/messages`，**那么** 后端创建或复用该标的 active session，并保存用户消息。
2. **给定** active session 已有历史，**当** 用户继续提问，**那么** provider 收到的上下文包含近期 user / assistant turns。
3. **给定** 用户点击 reset，**当** 后端创建新 active session，**那么** 旧历史保留在本地数据库，但当前页面切到干净会话。

---

### 用户故事 3：保持 provider 层边界清楚（优先级：P2）

作为项目维护者，我希望产品叫“图表 Agent”或“K 线 Agent”，而不是“Ask Codex”，这样后续可以接入不同模型 provider；Codex 只是当前默认 adapter，负责把结构化行情上下文发给 LLM。

**独立测试**：检查 UI、README、spec 和 provider 代码，确认用户入口使用 Agent/session 语义，Codex 只出现在 provider 配置、凭证和模型列表相关位置。

**验收场景**：

1. **给定** 当前 provider 是 Codex，**当** 用户在 UI 中提问，**那么** UI 展示为 Chart Session / Ask Agent，而不是 Ask Codex。
2. **给定** provider 请求失败、凭证缺失或 token 过期，**当** 用户提问，**那么** 行情和本地策略信号继续可用，Agent 面板显示不可用原因。
3. **给定** 后续新增 provider，**当** 实现新的 adapter，**那么** 不需要改变会话存储和前端会话模型。

---

### 用户故事 4：收窄市场数据主路径（优先级：P2）

作为维护者，我希望当前主路径聚焦 Bitget 加 Alpaca，美股和 ETF 走 Alpaca，Longbridge 不再作为新功能依赖，这样后续删除 Longbridge 时不会影响 Agent 架构。

**独立测试**：检查规格、计划和任务，确认 Bitget / Alpaca 是当前目标数据源；Longbridge 只作为历史兼容或待清理项出现，不再是功能验收条件。

**验收场景**：

1. **给定** watchlist 中配置 Bitget 或 Alpaca 标的，**当** 后端启动，**那么** quote、K 线和本地策略信号按对应 provider 获取。
2. **给定** Longbridge 相关旧代码仍存在，**当** 规划新功能，**那么** 不把 Longbridge 搜索、K 线或凭证作为新功能要求。
3. **给定** 用户确认删除 Longbridge，**当** 执行清理任务，**那么** 删除 legacy provider、watchlist helper、API 路由和对应测试。

## 边界情况

- 最新 quote 仍可用但 K 线缺失：正常展示 quote，策略信号和 Agent 分析标记为不可用。
- 单个标的 K 线拉取失败：只影响该标的，不阻塞其他标的和 WebSocket 广播。
- LLM provider 不可用：保留用户会话记录，assistant turn 写入错误结果，行情面板继续工作。
- 用户刷新页面：前端重新拉取当前 instrument 的 active session 和消息历史。
- provider 返回过少、过旧或解析失败的 K 线：不得展示成新鲜信号。
- Longbridge 旧路径未删除前：它只能作为 legacy 兼容存在，不能成为新功能验收条件。

## 功能需求

- **FR-001**：系统必须从结构化 OHLCV K 线推导上下文，不使用截图或渲染图像识别。
- **FR-002**：系统必须提供本地 FastAPI 后端，支持 REST 快照和 WebSocket 状态推送。
- **FR-003**：系统必须提供浏览器 UI，展示 watchlist、选中标的 K 线、本地策略信号和会话式 Agent 面板。
- **FR-004**：系统必须按 instrument key 保存 active Agent session，并把消息历史持久化到本地 SQLite。
- **FR-005**：系统必须在每次 Agent 请求中携带当前标的、quote、K 线、策略信号和最近会话历史。
- **FR-006**：系统必须把会话历史保存在本地应用层，不依赖 LLM provider 的远端 session。
- **FR-007**：系统必须把 Codex 实现为 provider adapter；产品、UI 和规格中的用户概念必须是图表 Agent 或 K 线 Agent。
- **FR-008**：系统必须支持当前主路径数据源：Bitget 公共行情和 Alpaca 美股 / ETF 行情。
- **FR-009**：系统不得把 Longbridge 作为新功能的必需数据源；相关代码只允许作为 legacy 兼容，后续清理单独执行。
- **FR-010**：系统必须支持模型列表刷新和 Agent 配置保存，但 Codex adapter 不允许通过配置覆盖 base URL。
- **FR-011**：系统必须把过少、缺失、失败或陈旧的 K 线标记为不可用，不得展示为有效策略信号。
- **FR-012**：系统必须保持本地优先：不引入云端服务、不新增必需账号体系、不替用户下单。
- **FR-013**：系统不得下单、管理仓位、连接交易执行链路，或把输出表述成确定性金融建议。

## 关键实体

- **K 线**：某个标的在一个 interval 上的 OHLCV bar。
- **市场标的**：由 provider、symbol、label、group 和可选 analysis interval 组成的 watchlist 条目。
- **本地策略信号**：由 K 线窗口计算出的 regime/context 研究信号，包括方向、置信度、特征和理由。
- **Agent Session**：某个 instrument key 当前活跃的本地对话会话，记录 provider、model、标题和更新时间。
- **Agent Message**：会话中的 user / assistant / system 消息，可带分析 JSON、上下文 JSON 和错误信息。
- **LLM Provider Adapter**：把标准化市场上下文转换成某个模型 provider 请求的边界层，当前默认实现是 Codex。
- **市场状态载荷**：前端通过 REST / WebSocket 获取的完整快照，包含标的、分组、quote、K 线、策略信号、Agent 分析和配置。

## 成功标准

- **SC-001**：`.venv/bin/python -m unittest discover -s tests` 通过。
- **SC-002**：`npm run build` 通过。
- **SC-003**：Web UI 能从序列化状态渲染 watchlist、K 线图、本地策略信号和 Agent session。
- **SC-004**：同一标的连续提问时，后续 provider 上下文包含最近会话历史。
- **SC-005**：UI 和文档不再把用户入口写成 Ask Codex；Codex 只出现在 provider 配置和凭证说明中。
- **SC-006**：规格和计划不再把 Longbridge 作为主路径或验收依赖。

## 假设

- 当前产品形态是本地 Web 工作台，不再回到 PySide 悬浮窗。
- `watchlist.toml` 继续作为 watchlist 和 Agent 配置入口。
- 会话持久化使用本地 SQLite cache，适合个人本机使用，不设计多人协作。
- 第一版只做研究和解释，不做交易执行。
