# X/Twitter 交易信息流 Agent 方向演进

## 1. 目标

目标不是让 AI 代替你刷 X，而是把“每天刷交易相关推文”的过程变成一个可回放、可检索、可沉淀的研究循环：

1. 读取关注流、列表、指定账号、关键词和新闻源。
2. 去重、过滤低信号内容，保留原始引用。
3. 按交易主题聚类，例如 BTC 宏观、山寨轮动、资金费率、ETF、链上流、项目事件。
4. 生成每日/盘前/盘后 digest。
5. 把高价值观察保存成长期记忆，后续 agent 分析标的时自动注入相关记忆。

这个方向应当服务 mytradebot 现有定位：本地市场监控 + LLM 研究 + paper trading 复盘。它不应该直接演变成自动下单系统。

## 2. 当前可行性结论

### 免费优先的主路线：人筛选，Agent 记忆化

官方 X API 免费额度太小，不适合每天自动读取关注流。更现实的免费方案是保留你作为“第一层过滤器”：

- 你日常刷 X，看到重要推文后复制链接、收藏/bookmark、或发给本地 agent。
- mytradebot 负责读取单条/批量链接、归档原文、抽取 ticker/topic、生成 digest。
- 只有高价值内容进入长期记忆，后续分析 BTC/ETH/股票时再被检索注入。

这条路线不依赖 X Developer 付费额度，也更贴近真实交易研究：你先判断什么值得看，Agent 负责整理、沉淀和复用。

### 官方路线可行，但不再作为主路径

X API v2 有读取登录用户 home timeline 的官方端点：

- Endpoint: `GET /2/users/:id/timelines/reverse_chronological`
- Python: `tweepy.Client.get_home_timeline()`
- TypeScript: `node-twitter-api-v2` 的 `client.v2.homeTimeline()`
- 内容：你和你关注账号发布/转发/回复的最近 posts
- 注意：这是 reverse chronological timeline，不是 X 的 For You 算法流

官方路线适合作为未来的可选增强。代价是 X API 现在按资源计费，免费层大约只有 100 reads/month，无法支撑每天 digest。按 `$0.005/post read` 粗算，每天 100 条大约 `$15/月`。

### 非官方抓取可跑，但不适合作为核心依赖

社区里常见的替代方式包括：

- cookie + 私有 GraphQL：`twitter-api-client`、`twitter-monitor`、RSSHub `/twitter/home`
- 账号池/异步 scraper：`twscrape`
- 浏览器自动化：Playwright、AutoCLI、OpenCrow
- Nitter/RSS 旁路：适合公开账号或列表的降级场景

这些方案的共同问题是账号风控、接口变动、验证码、cookie 过期、ToS 风险和维护成本。它们可以作为本地个人工具或 fallback adapter，但不应成为唯一数据源。免费路线里可以考虑 RSSHub、`read-x`、浏览器导出和手动导入，先避开高频自动抓取。

### 最适合个人交易研究的是 curated feed

不要抓“全量 X”。更稳的方式是把信息源收窄：

- 你的关注流 home timeline
- 交易相关 X Lists
- 固定关注账号白名单
- 关键词搜索，例如 ticker、funding、liquidation、ETF、unlock
- bookmarks / liked tweets
- Reuters、Cointelegraph、CryptoPanic、GitHub trending、Reddit 作为补充

这样能减少噪音、降低成本，也更适合写入长期记忆。

## 3. 可借鉴项目

### 免费/低成本输入

**read-x skill**  
URL: https://skills.sh/mikeygonz/skills/read-x  
价值：读取单条 X/Twitter 链接和长文，不需要 API key。  
可借鉴点：适合 Phase 0：你把重要推文链接丢给 agent，agent 读取、摘要、归档。

**手动导入 / 浏览器导出**  
价值：完全免费，稳定，最贴近你的真实筛选。  
可借鉴点：支持粘贴多条 URL、Markdown、JSON、CSV，先把“记忆闭环”跑通。

**RSSHub `/twitter/home`**
URL: https://github.com/DIYgod/RSSHub  
价值：把 Twitter following timeline 转成 RSS。  
认证：`TWITTER_AUTH_TOKEN`。  
风险：仍然是 cookie/非官方路线，但比自己写 scraper 更省事。  
可借鉴点：把 X timeline 抽象成 feed，是很好的 ingest 边界。

### 官方 API 客户端

**Tweepy**  
URL: https://github.com/tweepy/tweepy  
价值：Python 官方 API 客户端，支持 `get_home_timeline()`，和 mytradebot 的 Python 后端最匹配。  
可借鉴点：OAuth user context、分页、`since_id` 增量读取、字段选择。  
定位：可选付费增强，不作为免费主路线。

**node-twitter-api-v2**  
URL: https://github.com/PLhery/node-twitter-api-v2  
价值：TS 客户端，文档明确有 `client.v2.homeTimeline()`。  
可借鉴点：如果以后单独做 Node digest worker，它的 paginator 设计值得参考。  
定位：可选付费增强。

### 非官方读取关注流

**twitter-api-client**  
URL: https://github.com/trevorhobenshield/twitter-api-client  
价值：实现 X/Twitter v1、v2 和 GraphQL/internal API，支持 home timeline 类能力。  
风险：依赖私有接口和登录态。  
可借鉴点：cursor 翻页、cookie session、GraphQL 响应解析。

**twscrape**  
URL: https://github.com/vladkens/twscrape  
价值：异步 scraper，支持搜索、用户、followers/following、列表等。  
风险：账号池、代理和风控复杂。  
可借鉴点：账号池抽象、速率限制平滑、异步抓取模型。

**twitter-monitor**  
URL: https://github.com/reflective-technologies/twitter-monitor  
价值：最接近本需求的样本：home timeline -> 去重 -> embedding 聚类 -> Claude 摘要 -> 引用源推文。  
认证：`X_AUTH_TOKEN`、`X_CT0` cookie。  
可借鉴点：semantic clustering、cluster-level digest、source citation。

### 浏览器/多源采集 Agent

**OpenCrow**  
URL: https://github.com/gokhantos/opencrow  
价值：多 agent 信息流系统，覆盖 Reddit、GitHub、X/Twitter、市场数据、memory/RAG。  
可借鉴点：数据源进程隔离、PostgreSQL + Qdrant 混合记忆、信号/想法 pipeline、cross-source search。

**AutoCLI**  
URL: https://github.com/nashsu/AutoCLI  
价值：复用浏览器登录态抓 Twitter、Reddit、雪球等站点。  
可借鉴点：浏览器 session reuse、声明式 YAML adapter、多站点统一 CLI。  
风险：浏览器自动化读取 X 不适合作为长期核心。

### 金融/交易推文信号

**HypeSignal**  
URL: https://github.com/Layr-Labs/hypesignal  
价值：监控 crypto influencer，LLM 做 sentiment 和 token extraction，并能触发 Hyperliquid 交易。  
可借鉴点：influencer watchlist、ticker 映射、processed tweet 去重、sentiment/confidence threshold、tweet context 入库。  
不建议照搬：自动交易闭环。mytradebot 应先停在“提醒、研究、paper trade 观察”。

**twitter-to-sqlite**  
URL: https://github.com/dogsheep/twitter-to-sqlite  
价值：把 Twitter 数据落 SQLite，包含 timeline 类命令。  
可借鉴点：SQLite schema、`since_id` 增量同步、保留原始数据便于后续重跑摘要。

## 4. 推荐架构

建议把它做成 mytradebot 的“信息流记忆层”，不要直接塞进行情 feed。

### 数据层

新增一个 `social_feed` 子系统：

- `SocialFeedProvider` 协议：`fetch(since_id) -> FetchResult`
- provider 实现：
  - `manual_import.py`: 手动导入 bookmarks/export
  - `read_x.py`: 读取单条/批量 X 链接
  - `rsshub.py`: RSSHub fallback
  - `x_api_home.py`: 官方 X API home timeline（可选付费增强）
  - `x_list.py`: X List timeline / 指定账号（可选付费增强）
- SQLite 表：
  - `feed_items`: 原始推文/新闻/帖子
  - `feed_sources`: 来源配置、游标、状态
  - `feed_clusters`: 一次 digest 的聚类结果
  - `feed_memories`: 被提升为长期记忆的观察
  - `feed_item_embeddings`: 可选，后续做 semantic search

这可以复用现有 `NewsService` 的轮询、退避、SQLite cursor、手动刷新设计。

### 处理层

每次抓取后走一条固定 pipeline：

1. Normalize：统一字段，保留 source、author、url、text、created_at、metrics、raw_json。
2. Dedupe：按 tweet id、url、text hash 去重。
3. Filter：按账号白名单、关键词、ticker、语言、互动数据、是否含图表/链接过滤。
4. Enrich：抽取 tickers、资产类别、主题、情绪、是否 actionable。
5. Cluster：按 embedding 或规则聚类成多个交易主题。
6. Digest：每个 cluster 输出摘要、证据、风险和要跟踪的价格/事件。
7. Memory Promotion：只有高信号内容进入长期记忆。

### Agent 工具层

给现有 agent loop 增加只读工具：

- `get_recent_social_feed(limit, since_minutes, topics)`
- `search_social_feed(query, since_days)`
- `get_social_digest(date_or_window)`
- `save_social_memory(item_ids, note, tags)`
- `list_social_memories(instrument_key, tags)`

这些工具应该标记为 readonly，未来配合“只读工具并行”执行。

### 记忆注入

当前 mytradebot 已有：

- agent 会话 SQLite：`agent_sessions.sqlite3`
- 新闻缓存：`news.sqlite3`
- paper trading lessons：`trades.sqlite3`
- K 线缓存：`candles.sqlite3`

新记忆不要直接混进会话历史。更好的方式是：

- 每条长期观察有 `instrument_key`、`symbols`、`topics`、`source_item_ids`、`confidence`、`expires_at`
- agent 分析某个标的时，按 `instrument_key/symbol/topic/time_decay` 检索 top N
- 注入 prompt 时明确标注为“社交信息流观察，不是市场真值”
- 如果观察过期或被价格行为证伪，可以降权或归档

## 5. 方向演进路线

### Phase 0：手动/半自动验证

目标：先证明“每天刷推特记忆化”对交易分析有用。

- 先不接 X API。
- 手动导入 20-50 条推文 URL 或文本。
- 让 agent 做聚类、摘要、ticker 抽取和记忆保存。
- 在现有 agent 分析 BTC/ETH 时注入这些观察，看输出是否更有上下文。

成功标准：

- digest 能明显减少噪音。
- 保存的记忆在第二天分析里能被正确引用。
- 不会把推文观点当作市场事实。

### Phase 1：免费输入 + 本地 digest

目标：不付 X API 费用，先把“推文 -> digest -> 记忆”跑通。

- 支持手动粘贴一批 X URL。
- 支持从本地 JSON/Markdown/CSV 导入 bookmarks 或精选推文。
- 可选接入 `read-x` 类逻辑读取单条推文正文。
- 存 SQLite，保留原始 URL、正文、作者、时间、raw_json/metadata。
- 增加 `get_recent_social_feed`、`get_social_digest`、`save_social_memory` 工具。
- UI 先只展示导入、digest 和“保存为记忆”，不做自动抓关注流。

成功标准：

- 完全免费。
- 你每天手动导入 20-50 条精选推文时，digest 能明显减少噪音。
- 每日 digest 有 source citations。

### Phase 2：交易主题化与记忆提升

目标：让信息流真正进入交易研究闭环。

- 增加 ticker/entity extractor。
- 增加主题分类：宏观、链上、资金费率、清算、ETF、财报、监管、项目事件。
- 对高价值 cluster 自动生成 `memory candidate`。
- 用户在 UI 上确认后保存为长期记忆。
- agent 分析标的时自动检索相关社交记忆。

成功标准：

- BTC/ETH/股票分析能引用最近相关社交观察。
- 复盘时能看到“哪条社交观察影响了交易判断”。
- 记忆可删除、可过期、可降权。

### Phase 3：低成本自动化与多源信息流

目标：在不依赖昂贵 X API 的前提下提高自动化程度。

- 尝试 RSSHub `/twitter/home` 或 browser session fallback，但保持低频、可关闭。
- 加 Reddit、GitHub、Reuters、CryptoPanic、经济日历、交易所公告。
- 做 cross-source cluster：同一主题下聚合 X + 新闻 + 市场数据。
- 借鉴 Vibe-Trading 的 swarm preset，做可选的“盘前研究委员会”：
  - Social Flow Analyst
  - Market Structure Analyst
  - News/Event Analyst
  - Risk Reviewer
- 输出一个 morning brief，而不是实时下单建议。

成功标准：

- 每天开盘前生成一份可读 brief。
- 每个结论都有来源和置信度。
- paper trade 的开单理由能关联到 brief 里的证据。

### Phase 4：官方 API 可选增强

目标：如果以后愿意接受每月成本，再接官方 API。

- 使用 Tweepy + OAuth user context。
- 每天或每 2-4 小时拉一次 home timeline/list timeline。
- 用 `since_id` 增量同步。
- 保持和免费 provider 相同的 `feed_items` schema。

成功标准：

- 7 天连续稳定运行。
- 每月成本可接受。
- 官方 API 输出质量优于手动/RSSHub 路线，才保留。

## 6. 风险边界

### 合规风险

官方 X 政策限制 scraping、自动化网站访问、内容再分发。长期产品化应优先官方 API。非官方 cookie/GraphQL 方案只能作为个人本地实验，并且应该明确可替换。

### 账号风险

不要用主账号做高频 headless 抓取。不要自动点赞、关注、回复。不要账号池，不要代理轮换竞赛。读取频率应低，失败后退避。

### 交易风险

社交媒体是噪声源，不是价格真值。agent 输出里必须区分：

- market truth：报价、K 线、成交量、资金费率
- social observation：推文、观点、传闻
- derived hypothesis：LLM 推导出的假设

任何社交观察都不应绕过 paper trading guard，也不应直接触发真实交易。

## 7. 建议优先级

1. 先做 `SocialFeedStore` 和 `manual_import`，验证记忆闭环。
2. 加批量 X URL 导入和单条推文读取。
3. 加 `get_recent_social_feed` / `get_social_digest` / `save_social_memory` agent tools。
4. 做 ticker/topic 抽取和 memory candidate。
5. UI 增加每日 digest 和“保存为记忆”按钮。
6. 再考虑 RSSHub/browser fallback。
7. 最后才考虑 Tweepy 官方 home timeline/list timeline。

如果只选一个最小可行版本：手动导入推文 + digest + 确认保存记忆。这个版本不碰 X API、不碰 scraper，却能先验证产品价值。
