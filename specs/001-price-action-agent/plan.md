# 实施计划：本地图表 Agent 工作台

**分支**：`main` | **日期**：2026-05-04 | **规格**：[spec.md](spec.md)
**输入**：用户希望把 priceViewer 演进成 K 线图方向的 Codex / Claude Code：围绕当前图表连续对话，保留会话 session；Codex 只是 provider 层，不是产品概念；Longbridge 不再作为目标数据源。

## 摘要

产品主线从“Web 版行情面板”推进到“本地图表 Agent 工作台”。Python 后端继续负责行情 provider、K 线标准化、本地策略信号和 WebSocket 状态广播；React 前端负责 watchlist、K 线图、绘图交互、Agent 配置和会话式对话。LLM 调用通过 provider adapter 完成，当前默认 adapter 是 Codex Responses 风格接口，但会话状态由本地 SQLite 保存，不能依赖 provider 远端 session。

## 技术上下文

**语言 / 版本**：现有 `.venv` 中的 Python 3.x；Vite + React + TypeScript
**主要依赖**：FastAPI、uvicorn、httpx、React、Lightweight Charts、lucide-react、SQLite 标准库
**存储**：`watchlist.toml` 保存配置；本地 SQLite cache 保存 K 线缓存和每个标的的 Agent session
**测试**：`.venv/bin/python -m unittest discover -s tests`；前端 `npm run build`
**目标平台**：本机浏览器 UI，由 Python 进程提供静态资源和 API；开发期可走 Vite dev server
**项目类型**：本地 Web app + 行情 / Agent 后端
**性能目标**：provider 后台任务不能阻塞 HTTP / WebSocket；WebSocket payload 控制在 watchlist 规模；K 线渲染交给 Lightweight Charts；Agent 请求不能阻塞行情刷新。
**约束**：本地优先；不做自动交易；不做截图识别；不把 Codex 当产品名；不通过配置覆盖 Codex base URL；Longbridge 不进入新功能主路径。
**规模 / 范围**：个人 watchlist 规模，当前主路径覆盖 Bitget 加 Alpaca；Longbridge 仅作为 legacy 待清理代码存在。

## 宪法检查

- 本地优先：通过。行情、配置、会话和模型凭证都在本机处理。
- 图表优先：通过。用户工作区围绕 K 线图、策略信号和会话面板组织。
- 数据可靠性：通过。过少、缺失、失败或陈旧的 K 线都进入不可用状态。
- Provider 边界：通过。Codex 只在 LLM adapter、模型列表和凭证读取处出现。
- 会话可恢复：通过。active session 和消息历史写入本地 SQLite。
- 非交易边界：通过。没有下单、仓位、账户或经纪商交易控制。
- 可验证性：通过。Python 单测和前端构建是基础门禁；会话行为有后端测试覆盖。

## 项目结构

### 源码

```text
terminal_ticker/
├── __main__.py                    # 本地 Web server CLI 入口
├── api/app.py                     # FastAPI app、REST、WebSocket、运行时状态
├── agent/provider.py              # LLM provider 抽象、上下文构造、Codex adapter
├── agent/session_store.py         # 本地 SQLite Agent session / message 存储
├── config/
│   ├── __init__.py                # TOML 配置解析
│   ├── agent_models.py            # Agent provider / model 配置
│   └── watchlist_store.py         # watchlist 和 Agent 配置写回
├── domain/
│   ├── price_action.py            # K 线模型和合并逻辑
│   ├── quotes.py                  # quote 状态和展示字段
│   └── strategy.py                # regime/context 本地策略信号
├── market_data/
│   ├── alpaca.py                  # Alpaca 美股 / ETF quote 和 K 线
│   ├── bitget.py                  # Bitget quote 和 K 线
│   ├── candle_cache.py            # 本地 K 线缓存
│   ├── longbridge.py              # legacy Longbridge provider，待清理
│   └── router.py                  # watchlist 标的解析和 provider 路由
└── runtime/
    ├── controller.py              # quote 状态归并
    └── feed.py                    # 后台 provider 任务

web/
├── index.html
├── tsconfig.json
└── src/
    ├── App.tsx                    # 主工作台、图表、Agent session UI
    ├── api.ts                     # REST / WebSocket API client
    ├── chartDrawings.ts           # 图表绘图状态
    ├── main.tsx
    ├── styles.css
    └── types.ts

tests/
├── test_agent.py                  # Agent context、provider、session store
├── test_web.py                    # API、序列化、Agent session endpoints
├── test_alpaca_provider.py
├── test_bitget.py
├── test_candle_cache.py
├── test_config.py
├── test_controller.py
├── test_feed.py
├── test_llm_models.py
├── test_price_action.py
├── test_strategy.py
└── test_watchlist_store.py
```

**结构决策**：行情、缓存、策略和 LLM provider 保持在 Python 后端，因为这些逻辑需要测试、凭证隔离和本地文件访问。浏览器只负责工作台交互和展示。Agent session 是后端领域模型，不绑定 Codex。

## 复杂度记录

这次演进跨过了单纯 UI 改造，新增了本地会话存储、LLM provider 抽象和前端会话面板。复杂度可以接受，原因是用户目标已经从行情展示转向“围绕 K 线连续工作的 Agent”。拒绝的更简单方案是继续做一次性 `analyze` 按钮，因为它无法保留上下文，也无法接近 Codex / Claude Code 的会话体验。

Longbridge 删除没有放进同一次重构，是因为它涉及 provider 文件、watchlist helper、API 路由、测试和 README 的兼容边界。规格现在把它降为 legacy，真正删除应作为单独清理任务执行。

## 实施方向

1. 保留当前 Web 工作台：watchlist、K 线图、本地策略信号、绘图工具和响应式布局。
2. 把 Agent 入口从一次性分析改成 per-instrument active session。
3. 用 SQLite 保存 `agent_sessions` 和 `agent_messages`，每次请求带上最近会话历史。
4. 把 Codex 限定在 provider adapter 层，UI 和产品文案统一使用 Chart Agent / K-line Agent。
5. 主数据源收窄到 Bitget 和 Alpaca；Longbridge 只作为待删除 legacy。
6. 保持非交易边界：不下单、不管理仓位、不连接交易执行接口。
