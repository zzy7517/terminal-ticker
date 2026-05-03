# 数据模型：本地图表 Agent 工作台

## MarketInstrument

表示 watchlist 中已经解析完成的一个标的。

- `key`：稳定 provider key，例如 `USDT-FUTURES:BTCUSDT` 或 `alpaca:AAPL`
- `symbol`：provider 使用的原始 symbol
- `label`：前端展示名
- `source`：数据源，当前主路径是 `bitget` 或 `alpaca`
- `group`：watchlist 分组，例如 `crypto`、`stocks`
- `analysis_interval`：可选的单标的 K 线周期覆盖值

校验规则：

- `key` 必须在一次运行中唯一。
- 未配置 `group` 时，系统按 source 给出默认分组。
- Longbridge key 只能作为 legacy 兼容输入，不作为新功能要求。

## Candle

表示一根 OHLCV K 线。

- `symbol_key`：所属标的 key
- `open_time_ms`：K 线开盘时间，单位毫秒
- `open`：开盘价
- `high`：最高价
- `low`：最低价
- `close`：收盘价
- `volume`：成交量

校验规则：

- `high` 必须大于等于 `open`、`close` 和 `low`。
- `low` 必须小于等于 `open`、`close` 和 `high`。
- 数值字段必须能解析成浮点数。
- 过少、过旧或 provider 明确失败的 K 线不得进入可用策略信号。

## StrategySignal

表示本地 regime/context filter 生成的研究信号。

- `available`：当前是否有足够 K 线生成信号
- `side`：`long`、`short` 或 `flat`
- `regime`：市场环境，例如 trend、range、breakout、pullback 或 unclear
- `confidence`：0 到 100 的置信度
- `reason`：简短理由
- `features`：计算后的 K 线特征，包括趋势效率、波动、区间位置、量能等

校验规则：

- K 线少于最小窗口时必须返回 `available = false`。
- `flat` 不代表交易建议，只表示当前本地策略没有方向性倾向。
- 信号用于研究和 Agent 上下文，不触发交易执行。

## AgentConfig

表示 LLM provider 层配置。

- `enabled`：是否启用 Agent 请求
- `provider`：当前默认 `codex`
- `api_mode`：当前 Codex adapter 使用 `codex_responses`
- `model`：用户选择的模型
- `timeout_seconds`：请求超时时间
- `max_candles`：每次发送给 LLM 的最近 K 线数量
- `reasoning_effort`：模型推理强度

校验规则：

- `provider` 是实现层配置，不是产品名称。
- Codex adapter 不支持通过配置覆盖 base URL。
- `max_candles` 必须满足最低 K 线数量，避免发送太短的图表上下文。

## AgentSession

表示某个标的当前或历史的一次本地会话。

- `id`：本地 UUID
- `instrument_key`：会话绑定的标的 key
- `title`：用于 UI 展示的会话标题
- `provider`：创建或更新会话时使用的 provider
- `model`：创建或更新会话时使用的模型
- `active`：该标的是否把此 session 作为当前会话
- `created_at`：创建时间
- `updated_at`：最近消息或元数据更新时间

校验规则：

- 同一个 `instrument_key` 同一时刻只能有一个 active session。
- reset 会创建新的 active session，不删除旧 session。
- provider 或 model 变化时，可以更新 active session 元数据。

## AgentMessage

表示会话中的一条消息。

- `id`：自增本地 ID
- `session_id`：所属 AgentSession
- `role`：`user`、`assistant` 或 `system`
- `content`：消息正文
- `created_at`：创建时间
- `analysis_json`：assistant 标准分析结果，可为空
- `context_json`：当轮发送给 provider 的结构化上下文，可为空
- `error`：provider 或解析错误，可为空

校验规则：

- `role` 只能取允许值。
- user 消息必须保留原始问题。
- assistant 失败时仍应写入消息，方便 UI 展示错误和保留会话链路。

## AgentAnalysisResult

表示 provider 输出后的标准化分析。

- `available`：分析是否可用
- `provider`：实际 provider
- `model`：实际模型
- `updated_at`：分析时间
- `summary`：摘要
- `bias`：`bullish`、`bearish`、`neutral` 或 `mixed`
- `confidence`：0 到 100
- `key_levels`：关键价位列表
- `watch_plan`：观察计划
- `invalidation`：失效条件
- `risk_notes`：风险说明
- `error`：不可用原因
- `raw_text`：provider 原始输出，可用于排错

校验规则：

- 不可用结果必须包含 `error`，并使用中性默认值。
- 可用结果必须能序列化为前端类型。
- 输出不得包含下单、仓位或收益承诺。

## MarketStatePayload

表示 REST 和 WebSocket 发给前端的完整状态快照。

- `updatedAt`：服务端序列化时间
- `streamStatus`：provider feed 状态
- `config`：前端需要展示和编辑的配置
- `instruments`：已解析的 watchlist 标的
- `groups`：分组到 instrument key 的映射
- `quotes`：每个标的的 quote、K 线和策略信号
- `agentAnalyses`：每个标的最近一次 Agent 分析

校验规则：

- `groups` 中的 key 必须能在 `instruments` 中找到。
- quote 可以在 provider 首次返回前为空，但占位行必须存在。
- 陈旧策略信号不得以有效 marker 展示。
