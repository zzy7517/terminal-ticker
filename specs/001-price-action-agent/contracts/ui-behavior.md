# UI 行为契约：本地图表 Agent 工作台

## 应用外壳

- 首屏就是可工作的行情和图表界面，不做 landing page。
- 桌面端使用三块区域：watchlist / 搜索、K 线图工作区、Agent session 面板。
- 窄屏时区域纵向堆叠，不恢复旧的折叠 ticker tape。
- 不提供 PySide 悬浮窗、最小化按钮、加减展开控件或滚动 ticker。

## Watchlist

- 标的按 `watchlist.toml` 的 `group` 分组。
- 选择一行会更新 K 线图、策略信号和 Agent session。
- 行内展示 label、source、price、涨跌幅、最近状态和 freshness。
- 陈旧或不可用的策略信号使用低噪音占位，不展示成强提示。
- 当前主路径是 Bitget 和 Alpaca；Longbridge 不作为新增功能入口。

## K 线工作区

- 当前选中标的使用 Lightweight Charts 渲染最近 OHLCV K 线。
- 空 K 线展示占位状态，不伪造趋势或有效信号。
- 价格、涨跌、高低点、成交量、更新时间和本地策略信号要能被用户扫读。
- 图表绘图、缩放和 hover 不应导致周围布局跳动。

## Agent Session 面板

- 面板标题和按钮使用 Agent / Session 语义，不写 Ask Codex。
- 面板展示当前 active session 的 provider、model、更新时间和最近消息。
- 用户提交问题后，UI 追加 user turn，并展示 assistant 分析或错误。
- reset 只切换到新的 active session，不删除历史数据库记录。
- Agent 输出必须保持研究口径，不显示买卖按钮、仓位 sizing、下单、账户状态或 broker 控件。

## Agent 配置

- UI 可以刷新 provider 可见模型，并保存 model、reasoning effort、max candles 等配置。
- Codex 可以作为当前 provider adapter 出现，但不得成为产品主入口文案。
- provider 不可用时，错误只影响 Agent 面板；行情、K 线和本地策略信号继续展示。

## Watchlist 编辑

- Alpaca 搜索和新增写入本地 `watchlist.toml`。
- Bitget 新增使用已解析的 instrument 信息写入本地配置。
- Longbridge 相关新增 / 删除能力属于 legacy，后续清理时应从 API、watchlist helper 和测试中一起删除。
