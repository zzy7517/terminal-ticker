# 实施计划：[功能名]

**分支**：`[###-feature-name]` | **日期**：[DATE] | **规格**：[link]
**输入**：来自 `/specs/[###-feature-name]/spec.md` 的功能规格

**说明**：此模板由 `/speckit.plan` 填写。执行流程见 `.specify/templates/plan-template.md`。

## 摘要

[从功能规格提取：主要需求、技术方案、为什么现在要做]

## 技术上下文

<!--
  需要填写：用当前项目真实情况替换本节占位内容。
  不确定的地方写 NEEDS CLARIFICATION，不要假装已经确定。
-->

**语言 / 版本**：[例如 Python 3.x、TypeScript/React，或 NEEDS CLARIFICATION]
**主要依赖**：[例如 FastAPI、React、Lightweight Charts、httpx，或 NEEDS CLARIFICATION]
**存储**：[例如 TOML、本地 SQLite、K 线 cache，或 N/A]
**测试**：[例如 unittest、npm run build，或 NEEDS CLARIFICATION]
**目标平台**：[例如 本机浏览器 UI + Python 后端，或 NEEDS CLARIFICATION]
**项目类型**：[例如 local web app、backend module、frontend feature，或 NEEDS CLARIFICATION]
**性能目标**：[例如 provider 不阻塞 WebSocket、payload 控制在 watchlist 规模，或 NEEDS CLARIFICATION]
**约束**：[例如 本地优先、无自动交易、无截图识别、provider 边界清楚，或 NEEDS CLARIFICATION]
**规模 / 范围**：[例如 个人 watchlist、本机单用户，或 NEEDS CLARIFICATION]

## 宪法检查

*门禁：Phase 0 研究前必须通过；Phase 1 设计后再检查一次。*

- 本地优先：不得默认引入云服务、远端数据库、账号体系或新的必需凭证。
- 图表优先：新增能力应服务于 watchlist、K 线图、本地策略信号和 Agent session。
- 行情可靠性：陈旧、缺失、重连、占位或过少 K 线不得展示成新鲜有效信号。
- Provider 边界：产品语义使用 K 线 Agent / 图表 Agent；Codex 等模型只作为 provider adapter。
- 会话边界：Agent session 由本地应用保存；每轮请求显式构造上下文。
- 非交易边界：不得加入下单、仓位、账户或 broker 交易控制。
- 可验证性：用户可见行为、配置、provider、缓存、策略信号、session 和 API 改动都要有验证。

## 项目结构

### 文档（当前功能）

```text
specs/[###-feature]/
├── plan.md              # 本文件，/speckit.plan 输出
├── research.md          # Phase 0 输出
├── data-model.md        # Phase 1 输出
├── quickstart.md        # Phase 1 输出
├── contracts/           # Phase 1 输出
└── tasks.md             # Phase 2 输出，由 /speckit.tasks 创建
```

### 源码（仓库根目录）

```text
terminal_ticker/
├── __main__.py
├── api/
├── agent/
├── config/
├── domain/
├── market_data/
└── runtime/

web/
└── src/

tests/
```

**结构决策**：[说明这次改动放在哪些模块，为什么不放到别处；如果需要新增边界，写清楚原因。]

## 复杂度记录

> 只有违反宪法检查或引入明显复杂度时才填写。

| 复杂度 / 例外 | 为什么需要 | 拒绝的更简单方案 |
|---------------|------------|------------------|
| [例如 新增本地 SQLite 表] | [当前需求为什么必须这样做] | [为什么只用内存或 TOML 不够] |
| [例如 新增 provider adapter] | [当前需求为什么必须这样做] | [为什么硬编码到现有 provider 不够] |

## 实施方向

1. [写清楚第一步要落到哪些文件或模块]
2. [写清楚状态、配置或数据模型如何变化]
3. [写清楚前端 / API / provider 的契约]
4. [写清楚验证命令]
