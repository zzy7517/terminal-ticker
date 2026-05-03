# 任务清单：本地图表 Agent 工作台

**输入**：用户希望把项目做成 K 线图方向的 Codex / Claude Code：围绕图表连续对话，保留 session；Codex 只是 provider 层；Longbridge 不再作为当前方向。
**测试要求**：涉及运行时行为、配置解析、provider、session 和 UI 构建的改动都需要测试或构建验证。

## 阶段 1：旧桌面运行时迁移

- [x] T001 删除 PySide 窗口运行时代码。
- [x] T002 删除 Qt widget 和悬浮 ticker 行为。
- [x] T003 移除 PySide / shiboken 依赖。
- [x] T004 把 `python -m terminal_ticker` 改成本地 Web server 入口。
- [x] T005 用 FastAPI 提供 REST 状态快照和 WebSocket 推送。
- [x] T006 用 React + Lightweight Charts 实现浏览器工作台。

## 阶段 2：行情、K 线和策略主路径

- [x] T007 保留 Bitget quote / K 线主路径。
- [x] T008 接入 Alpaca 美股 / ETF quote、搜索和 K 线。
- [x] T009 增加本地 K 线缓存，支持增量刷新和历史加载。
- [x] T010 在后端生成 regime/context 本地策略信号。
- [x] T011 把策略信号序列化到 REST / WebSocket payload。
- [x] T012 为 provider、缓存、策略和序列化补充单测。

## 阶段 3：Agent provider 层

- [x] T013 增加 `terminal_ticker/agent/provider.py`，定义 LLM provider 抽象和标准输出。
- [x] T014 构造包含标的、quote、K 线、本地策略信号的结构化上下文。
- [x] T015 实现 Codex Responses 风格 adapter。
- [x] T016 支持读取 Codex CLI 登录态或 `TERMINAL_TICKER_CODEX_API_KEY`。
- [x] T017 支持模型列表刷新和 Agent 配置写回。
- [x] T018 移除 Codex base URL override，避免把 provider backend 变成用户配置面。

## 阶段 4：会话式图表 Agent

- [x] T019 增加 `terminal_ticker/agent/session_store.py`，用 SQLite 保存 session 和 message。
- [x] T020 增加按 instrument key 获取 active session 的 API。
- [x] T021 增加向 active session 追加用户消息并调用 provider 的 API。
- [x] T022 增加 reset active session 的 API。
- [x] T023 每次 provider 请求带上最近会话历史。
- [x] T024 assistant 成功或失败都写入会话历史。
- [x] T025 前端把一次性分析面板改成 Chart Session 对话面板。
- [x] T026 将 UI 文案从 Codex Read / Ask Codex 改成 Agent / Session 语义。

## 阶段 5：文档和 Speckit 对齐

- [x] T027 README 说明会话式 K 线 Agent、Codex provider 边界和本地 SQLite session。
- [x] T028 Speckit 规格、计划、研究、数据模型、quickstart、UI 契约和任务清单改成中文。
- [x] T029 Speckit 宪法和模板从旧 PySide / 悬浮窗默认约束改成本地 Web 图表 Agent 约束。
- [x] T030 Speckit 文档不再把 Longbridge 写成主路径数据源。

## 阶段 6：Longbridge legacy 清理

- [ ] T031 删除 `terminal_ticker/market_data/longbridge.py` 和兼容导出文件。
- [ ] T032 删除 Longbridge watchlist helper、API 路由和前端遗留入口。
- [ ] T033 删除 `scripts/longbridge_push_probe.py` 和 Longbridge 专属测试。
- [ ] T034 清理 README、配置示例和测试夹具中的 Longbridge 描述。
- [ ] T035 运行 Python 单测、前端构建和 `rg -n "longbridge|Longbridge"` 确认只剩必要历史说明。

## 阶段 7：验证

- [x] T036 运行 `.venv/bin/python -m unittest discover -s tests`。
- [x] T037 运行 `npm run build`。
- [x] T038 冒烟验证 `/api/state`、WebSocket 和 Agent session API。
- [x] T039 确认工作台可以连续向同一标的提问并保留 active session。

备注：阶段 6 是后续清理任务。当前规格已经把 Longbridge 降为 legacy，但实际代码删除需要单独执行和验证。
