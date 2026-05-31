# Options & Gamma Exposure (GEX) 分析模块设计文档

## 目录

1. [设计哲学](#设计哲学)
2. [核心概念](#核心概念)
3. [系统架构](#系统架构)
4. [数据源方案](#数据源方案)
5. [模块分层设计](#模块分层设计)
6. [数学公式与计算引擎](#数学公式与计算引擎)
7. [API 设计](#api-设计)
8. [前端展示](#前端展示)
9. [Agent 工具集成](#agent-工具集成)
10. [数据持久化](#数据持久化)
11. [配置设计](#配置设计)
12. [实现计划](#实现计划)
13. [进阶：Hedge Impulse 与 Pressure Cloud](#进阶设计hedge-impulse-与-pressure-cloud)
14. [进阶：完整的 Greek Exposure 四维分析](#进阶设计完整的-greek-exposure-四维分析)
15. [进阶：VannaFlip 信号 + 策略框架](#进阶设计vannaflip-信号--策略框架)
16. [进阶：LLM + GEX 因果推理框架](#进阶设计llm--gex-的因果推理框架)
17. [进阶：BTC/ETH 期权流 (Deribit)](#进阶设计btceth-期权流deribit-免费数据)
18. [进阶：IV Surface 与 Regime 派生](#进阶设计iv-surface-与-regime-派生)
19. [参考项目](#参考项目)
20. [关键设计决策](#关键设计决策)
21. [文件清单](#文件清单实现时的-checklist)

---

## 设计哲学

> 你想研究机构，就直接去研究机构。不要通过 K 线图这个信息损失极大的中间层去「猜测」。

本模块的核心目标是：**直接观测机构的期权行为 → 推导做市商的被迫对冲方向 → 形成有因果链的、可证伪的市场预判**。

我们不做：
- ❌ 基于 K 线形态的「价格行为」分析
- ❌ 基于 EMA/MACD 之类的滞后指标

我们做：
- ✅ 实时拉取期权链数据（OI、Volume、IV、Greeks）
- ✅ 计算做市商的 Gamma Exposure（GEX），找到他们被迫买卖的价格位
- ✅ 计算 Charm/Vanna 隐藏流——即使价格不动，时间流逝和 IV 变化也会迫使做市商对冲
- ✅ 检测异常大单和 OI 突变，识别机构的直接行为
- ✅ 输出 regime 判断：正 gamma（压制波动）/ 负 gamma（放大波动）

---

## 核心概念

### 1. Gamma Exposure (GEX)

做市商通常是期权的卖方（特别是对散户买入的 call/put）。当他们持有期权的 short position 时，必须进行 delta hedging。Gamma 衡量的是 delta 对价格的敏感度——即价格每变动 1 点，做市商需要调整多少 delta 对冲。

**GEX 的含义**：
- **正 GEX（Long Gamma）**：做市商在价格上涨时卖出、下跌时买入 → 压制波动、把价格 pin 住
- **负 GEX（Short Gamma）**：做市商在价格上涨时买入、下跌时卖出 → 放大波动、加速趋势

### 2. Zero Gamma Level (ZGL)

累积 GEX 曲线穿越零点的价格。在 ZGL 以上，市场行为倾向于被压制；在 ZGL 以下，市场行为倾向于被放大。这是一个关键的 regime 切换价格。

### 3. Charm（∂Δ/∂t）

即使价格不动，时间流逝也会改变 delta。做市商为了保持 delta-neutral，必须仅仅因为「时间过了」而调整仓位。对于 0DTE 期权，这个力量在收盘前几小时极其强大。

### 4. Vanna（∂Δ/∂σ）

IV 变化会改变 delta。如果 IV 突然下降 1%（比如 VIX crush），做市商必须调整仓位来补偿 delta 的变化。

### 5. Call Wall / Put Wall

OI 最大的 call strike = Call Wall（大概率短期阻力）。OI 最大的 put strike = Put Wall（大概率短期支撑）。这是因为做市商在那些位置有最大的对冲义务。

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        tradex 后端 (Hono Server)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐    ┌─────────────────┐    ┌────────────────────────┐ │
│  │ options/     │    │ options/        │    │ options/               │ │
│  │ providers/   │───▶│ calculator.ts   │───▶│ service.ts             │ │
│  │              │    │                 │    │                        │ │
│  │ • yfinance   │    │ • GEX           │    │ • 定时拉取             │ │
│  │ • tradier    │    │ • Charm/Vanna   │    │ • 缓存 + 持久化        │ │
│  │ • cboe       │    │ • IV Surface    │    │ • 异常检测             │ │
│  └──────────────┘    │ • Greeks        │    │ • Regime 判断          │ │
│         │            └─────────────────┘    └────────────────────────┘ │
│         │                     │                         │              │
│         ▼                     ▼                         ▼              │
│  ┌──────────────┐    ┌─────────────────┐    ┌────────────────────────┐ │
│  │ 数据标准化    │    │ SQLite 持久化   │    │ API Routes             │ │
│  │ OptionChain  │    │ gex_snapshots   │    │ /api/options/*         │ │
│  │ OptionQuote  │    │ oi_history      │    └────────────────────────┘ │
│  └──────────────┘    └─────────────────┘              │                │
│                                                       │                │
│  ┌────────────────────────────────────────────────────┼───────────────┐│
│  │ Agent Tools                                        ▼              ││
│  │ • get_gex_snapshot    → 当前 GEX 全貌                              ││
│  │ • get_options_flow    → 最近大单/异常活动                           ││
│  │ • get_dealer_levels   → Call/Put Wall + ZGL                        ││
│  │ • get_gamma_regime    → 正/负 gamma 判断                           ││
│  └────────────────────────────────────────────────────────────────────┘│
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                        WebSocket → 前端                                  │
│  state.options = { gex, regime, levels, charm_vanna, oi_changes }       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 数据源方案

### 免费方案（Phase 1 — 立即可用）

| Provider | 方式 | 能拿到什么 | 限制 |
|---|---|---|---|
| **Yahoo Finance (yfinance)** | 非官方 API，无需 key | **任意美股/ETF** 的期权链：strike, bid, ask, OI, volume, IV。含黄金(GLD)、BTC(IBIT/BITO)、科技股等全部有期权的标的 | 无法拿指数期权（SPX/NDX）；Greeks 需自己算；可能被限速 |
| **Deribit Public API** | REST + WebSocket，无需注册/key | BTC/ETH 原生期权的全部数据：OI, volume, bid/ask, mark price, **Greeks（直接提供）**, IV | 只有 BTC/ETH；加密市场结构与股票不同（做市商主要是加密原生机构） |
| **CBOE 官网** | 爬取免费公开数据 | 每日 volume 汇总，历史数据 xls | 非实时，适合日终分析 |

### 低成本方案（Phase 2 — 推荐）

| Provider | 方式 | 能拿到什么 | 费用 |
|---|---|---|---|
| **Tradier Sandbox** | REST API + Bearer Token | 真实 SPX/SPXW 链 + ORATS Greeks | 免费（sandbox，延迟数据） |
| **Tradier Production** | 同上，实时数据 | 同上，实时 | 开户后免费 market data |

### Provider 抽象

参考 `0DTE-dealer-gamma` 的设计，定义统一的 `OptionsDataProvider` 接口：

```typescript
interface OptionsDataProvider {
  readonly name: string;
  readonly providesGreeks: boolean;
  readonly supportsSpxDirectly: boolean;

  getSpotPrice(symbol: string): Promise<number>;
  getExpirations(symbol: string): Promise<string[]>;
  getOptionsChain(symbol: string, expiration?: string): Promise<OptionChain>;
  close(): Promise<void>;
}
```

**YFinance provider** 用 SPY 作为 SPX 的 proxy（×10 转换），Greeks 在本地计算。

**Tradier provider** 直接拿 SPX 链 + ORATS Greeks，无需本地计算。

---

## 模块分层设计

遵循 tradex 的分层原则（domain → config → market_data → runtime → api），新增：

```
tradex/
├── options/                      ← 新增模块
│   ├── domain.ts                 ← 纯类型 + 数学计算（无 I/O）
│   │   • OptionQuote, OptionChain, GexSnapshot
│   │   • StrikeGex, RegimeState, CharmVannaFlow
│   │
│   ├── greeks.ts                 ← Black-Scholes Greeks 向量化计算
│   │   • gamma(), delta(), vega(), theta()
│   │   • charm(), vanna()
│   │   • solveIV() (Newton-Raphson)
│   │
│   ├── gex_calculator.ts         ← GEX 核心计算引擎
│   │   • calculateGexFromChain()
│   │   • findZeroGammaLevel()
│   │   • determineRegime()
│   │   • calculateCharmVannaFlow()
│   │   • detectCallPutWalls()
│   │
│   ├── providers/                ← 数据源适配层
│   │   ├── base.ts              ← OptionsDataProvider 接口
│   │   ├── yfinance.ts          ← Yahoo Finance (免费，SPY proxy)
│   │   ├── tradier.ts           ← Tradier API (推荐)
│   │   └── index.ts             ← Provider registry + factory
│   │
│   ├── service.ts               ← 运行时服务（定时拉取、缓存、异常检测）
│   │   • OptionsService class
│   │   • 定时轮询（可配置间隔）
│   │   • 内存缓存 + SQLite 历史
│   │   • OI 变化追踪
│   │   • 异常 volume 检测
│   │
│   ├── store.ts                 ← SQLite 持久化
│   │   • gex_snapshots 表
│   │   • oi_history 表
│   │   • unusual_activity 表
│   │
│   └── index.ts                 ← 模块导出
│
├── api/routes/
│   └── options.ts               ← Hono API 路由
│
├── agent/tools/
│   └── options.ts               ← Agent 工具注册
│
└── web/src/components/workspace/
    └── OptionsPanel.tsx          ← 前端 GEX 可视化
```

---

## 数学公式与计算引擎

### Black-Scholes with Dividend Yield

所有公式包含股息率 q（SPX ≈ 1.5%），这对 SPX 期权很重要。

```
d₁ = [ln(S/K) + (r - q + σ²/2)T] / (σ√T)
d₂ = d₁ - σ√T
```

### Gamma

```
Γ = e^(-qT) × N'(d₁) / (S × σ × √T)
```

Gamma 对 call 和 put 相同（put-call parity）。

### GEX 公式

对每个期权合约 i：

```
GEX_i = OI_i × Γ_i × 100 × S² × 0.01
```

- `OI_i`: Open Interest
- `Γ_i`: Black-Scholes Gamma
- `100`: 合约乘数（每张期权代表 100 股）
- `S²`: 转为 dollar gamma
- `0.01`: 标准化为 1% 价格变动

**符号约定（Trader-facing baseline）**：
- Call 贡献 **正** GEX
- Put 贡献 **负** GEX
- **Net GEX = Σ(Call GEX) + Σ(Put GEX)**

### Charm（Delta 时间衰减）

```
Charm_call = -e^(-qT) × [N'(d₁) × (2(r-q)T - d₂σ√T) / (2Tσ√T)] + q×e^(-qT)×N(d₁)
Charm_put  = -e^(-qT) × [N'(d₁) × (2(r-q)T - d₂σ√T) / (2Tσ√T)] - q×e^(-qT)×N(-d₁)
```

Charm Flow = OI × Charm × 100 × (时间前进分钟数 / 1440)

### Vanna（Delta 对 IV 的敏感度）

```
Vanna = -e^(-qT) × N'(d₁) × d₂ / σ
```

Vanna Flow = OI × Vanna × ΔIV × 100

### Zero Gamma Level 计算

1. 按 strike 排序
2. 计算 cumulative GEX
3. 找到累积 GEX 穿越零点的位置
4. 在相邻两个 strike 之间线性插值

```typescript
// 伪代码
for (i = 0; i < cumulativeGex.length - 1; i++) {
  if (cumulativeGex[i] * cumulativeGex[i+1] < 0) {
    // 线性插值
    zgl = strike[i] - cumulativeGex[i] * (strike[i+1] - strike[i]) / (cumulativeGex[i+1] - cumulativeGex[i])
  }
}
```

### Regime 判断

| Net GEX | Regime | 含义 |
|---|---|---|
| > +$1B | Long Gamma 🟢 | 做市商压制波动，市场倾向于横盘/回归 |
| < -$1B | Short Gamma 🔴 | 做市商放大波动，市场倾向于加速/极端 |
| 其他 | Neutral 🟡 | 无明确倾向 |

### Call Wall / Put Wall

- **Call Wall** = OI 最大的 call strike（在 spot 以上）
- **Put Wall** = OI 最大的 put strike（在 spot 以下）
- **Max Gamma Strike** = |GEX| 最大的 strike

---

## API 设计

新增路由组 `/api/options/*`，挂载在 `app.ts`：

### Endpoints

```typescript
// GET /api/options/gex/current?symbol=SPY
// 当前 GEX 快照
interface GexCurrentResponse {
  timestamp: string;
  symbol: string;
  spotPrice: number;
  netGex: number;
  netGexBillions: number;
  totalCallGex: number;
  totalPutGex: number;
  zeroGammaLevel: number;
  regime: 'long_gamma' | 'short_gamma' | 'neutral';
  regimeDescription: string;
  dominantStrike: number;
  gexByStrike: Record<string, number>;  // strike → gex
  callWall: number;
  putWall: number;
  maxGammaStrike: number;
  charmVanna: {
    charmFlow: number;       // 做市商因时间衰减需买卖的 $ 数
    vannaFlow: number;       // 做市商因 IV 变化需买卖的 $ 数
    netHiddenFlow: number;   // 综合隐藏流
  };
  provider: string;
}

// GET /api/options/gex/strikes?symbol=SPY
// 逐 strike 的 GEX 分解（前端柱状图用）
interface GexStrikesResponse {
  strikes: number[];
  callGex: number[];
  putGex: number[];
  netGex: number[];
  spotPrice: number;
  zeroGammaLevel: number;
}

// GET /api/options/chain?symbol=SPY&expiration=2026-06-02
// 原始期权链数据
interface OptionsChainResponse {
  symbol: string;
  spotPrice: number;
  expiration: string;
  contracts: OptionQuote[];
  totalContracts: number;
  provider: string;
}

// GET /api/options/levels?symbol=SPY
// 快速获取关键 level（适合 Agent 用）
interface KeyLevelsResponse {
  symbol: string;
  spotPrice: number;
  zeroGammaLevel: number;
  callWall: number;
  putWall: number;
  maxGammaStrike: number;
  regime: string;
  netGexBillions: number;
}

// GET /api/options/unusual?symbol=SPY&minOiChange=1000
// 异常活动检测
interface UnusualActivityResponse {
  items: Array<{
    strike: number;
    type: 'call' | 'put';
    expiration: string;
    oiChange: number;
    volumeVsOi: number;  // volume/OI ratio
    premium: number;
    timestamp: string;
    signal: 'opening' | 'closing' | 'unknown';
  }>;
}

// GET /api/options/history?symbol=SPY&days=7
// GEX 历史（用于观察 regime 变化趋势）
interface GexHistoryResponse {
  data: Array<{
    timestamp: string;
    netGex: number;
    zeroGammaLevel: number;
    spotPrice: number;
    regime: string;
  }>;
}
```

---

## 前端展示

新增 `OptionsPanel.tsx` 组件，可在 workspace 中作为 tab 访问。

### 布局设计

```
┌─────────────────────────────────────────────────────────────────────┐
│ Options / GEX Analysis                          [SPY ▾] [Refresh]  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────────────┐│
│  │ Net GEX   │  │ Regime    │  │ ZGL       │  │ Hidden Flow       ││
│  │ -$2.3B    │  │ 🔴 Short  │  │ 5,880     │  │ Charm: -$120M     ││
│  │           │  │ Gamma     │  │ (spot-20) │  │ Vanna: +$45M      ││
│  └───────────┘  └───────────┘  └───────────┘  └───────────────────┘│
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │              GEX by Strike (柱状图)                            │  │
│  │                                                               │  │
│  │    ████                                                       │  │
│  │    ████  ██                            Call Wall ─────▶ │     │  │
│  │    ████  ████  ██                                       │     │  │
│  │ ───████──████──████──────ZGL────────────────────────────│──── │  │
│  │         ████  ████  ██                                  │     │  │
│  │               ████  ████                                │     │  │
│  │ ◀──── Put Wall      ████                                     │  │
│  │                                                               │  │
│  │  5800  5820  5840  5860  5880  5900  5920  5940  5960  5980  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────┐  ┌─────────────────────────────┐  │
│  │ Key Levels                   │  │ Unusual Activity            │  │
│  │                              │  │                             │  │
│  │ Call Wall:  5960 (+1.4%)     │  │ 🔴 5800P  OI+5200  $2.1M  │  │
│  │ Put Wall:   5820 (-1.0%)     │  │ 🟢 6000C  OI+3800  $1.5M  │  │
│  │ Max Gamma:  5900             │  │ 🔴 5750P  OI+2100  $890K  │  │
│  │ ZGL:        5880 (-0.3%)     │  │                             │  │
│  │ Spot:       5898             │  │                             │  │
│  └──────────────────────────────┘  └─────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 前端数据流

与 tradex 现有架构一致，通过 WebSocket snapshot 推送：

```typescript
// 在 serializeState() 中新增 options 字段
interface StateSnapshot {
  // ... existing fields ...
  options?: {
    gex: GexCurrentResponse;
    lastUpdated: string;
  };
}
```

前端通过 `useMarketStore` 读取 `state.options`，OptionsPanel 纯粹是展示层。

---

## Agent 工具集成

新增 `tradex/agent/tools/options.ts`，注册到 ToolRegistry：

```typescript
// Tool: get_gex_snapshot
// 描述: Get current Gamma Exposure analysis for a symbol
// 参数: symbol (default: SPY)
// 返回: 精简版 GEX 数据（适合 LLM 消费）

// Tool: get_dealer_levels  
// 描述: Get key dealer positioning levels (Call Wall, Put Wall, ZGL)
// 参数: symbol
// 返回: { spotPrice, zgl, callWall, putWall, maxGamma, regime, netGexBillions }

// Tool: get_options_flow
// 描述: Get unusual options activity and large trades
// 参数: symbol, minPremium?, lookbackMinutes?
// 返回: 最近的异常活动列表

// Tool: get_gamma_regime
// 描述: Determine if market is in positive/negative gamma regime
// 参数: symbol
// 返回: { regime, description, implication, netGex, zglDistance }
```

Agent 在分析时可以这样使用：

```
用户: "SPY 现在的 gamma 环境怎么样？做市商在哪里？"

Agent 调用 get_gex_snapshot("SPY") → 得到:
- Net GEX: -$2.3B → Short Gamma → 市场波动会被放大
- ZGL: 5880 (spot 5898 在 ZGL 之上，但很近)
- Call Wall: 5960 → 短期阻力
- Put Wall: 5820 → 短期支撑
- Charm Flow: -$120M → 时间流逝会让做市商卖出
- Unusual: 5800P 大量开仓 → 有人在 5800 建立了看跌保护
```

---

## 数据持久化

使用 SQLite（与 tradex 现有 `better-sqlite3` 一致），文件：`~/.cache/tradex/options.sqlite3`

### Schema

```sql
-- GEX 快照历史（每次计算存一条）
CREATE TABLE IF NOT EXISTS gex_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  spot_price REAL NOT NULL,
  net_gex REAL NOT NULL,
  total_call_gex REAL NOT NULL,
  total_put_gex REAL NOT NULL,
  zero_gamma_level REAL NOT NULL,
  regime TEXT NOT NULL,
  call_wall REAL,
  put_wall REAL,
  max_gamma_strike REAL,
  charm_flow REAL,
  vanna_flow REAL,
  provider TEXT NOT NULL,
  gex_by_strike_json TEXT,  -- JSON blob
  UNIQUE(symbol, timestamp_ms, provider)
);
CREATE INDEX idx_gex_symbol_time ON gex_snapshots(symbol, timestamp_ms DESC);

-- OI 历史（用于追踪变化）
CREATE TABLE IF NOT EXISTS oi_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  strike REAL NOT NULL,
  option_type TEXT NOT NULL,  -- 'call' | 'put'
  expiration TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  open_interest INTEGER NOT NULL,
  volume INTEGER NOT NULL,
  implied_vol REAL,
  UNIQUE(symbol, strike, option_type, expiration, timestamp_ms)
);
CREATE INDEX idx_oi_symbol_strike ON oi_history(symbol, strike, timestamp_ms DESC);

-- 异常活动记录
CREATE TABLE IF NOT EXISTS unusual_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  strike REAL NOT NULL,
  option_type TEXT NOT NULL,
  expiration TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  oi_change INTEGER NOT NULL,
  volume INTEGER NOT NULL,
  premium_estimate REAL,
  signal TEXT,  -- 'opening' | 'closing' | 'sweep' | 'block'
  notes TEXT
);
CREATE INDEX idx_unusual_time ON unusual_activity(timestamp_ms DESC);
```

### 数据保留

- GEX snapshots: 保留 30 天
- OI history: 保留 7 天（用于计算 delta OI）
- Unusual activity: 保留 90 天

---

## 配置设计

在 `watchlist.toml` 中新增 `[options]` section：

```toml
[options]
enabled = true
provider = "yfinance"        # "yfinance" | "tradier"
symbols = ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "GLD", "IBIT"]  # 任意美股/ETF（含黄金、BTC ETF）

# Deribit 加密期权（免费 public API，无需 key）
[options.deribit]
enabled = true
currencies = ["BTC", "ETH"]       # 监控的币种
poll_interval_seconds = 60   # 拉取间隔（免费源建议 >= 60s）
strike_range_percent = 0.15  # ±15% 的 strike 范围
risk_free_rate = 0.0363      # 无风险利率（FRED DTB4WK 4周国债）
dividend_yield = 0.015       # SPX 股息率

# Tradier 专用配置
[options.tradier]
api_key = ""                 # sandbox 或 production token
base_url = "https://sandbox.tradier.com/v1"  # sandbox 免费

# 异常检测阈值
[options.alerts]
min_oi_change = 1000         # 最小 OI 变化量才算异常
min_volume_oi_ratio = 3.0    # volume/OI > 3x 算异常
min_premium = 100000         # 最小权利金 $100K 才记录
```

对应 TypeScript 配置类型：

```typescript
export interface OptionsConfig {
  enabled: boolean;
  provider: 'yfinance' | 'tradier';
  symbols: string[];
  pollIntervalSeconds: number;
  strikeRangePercent: number;
  riskFreeRate: number;
  dividendYield: number;
  tradier?: {
    apiKey: string;
    baseUrl: string;
  };
  alerts: {
    minOiChange: number;
    minVolumeOiRatio: number;
    minPremium: number;
  };
}
```

---

## 实现计划

### Phase 1: 核心引擎 + YFinance（免费，立即可用）

**预计工作量**：2-3 天

1. `tradex/options/domain.ts` — 类型定义
2. `tradex/options/greeks.ts` — Black-Scholes Greeks 计算（TypeScript 实现，参考 0DTE-dealer-gamma 的 NumPy 逻辑）
3. `tradex/options/gex_calculator.ts` — GEX + ZGL + Regime + Charm/Vanna
4. `tradex/options/providers/yfinance.ts` — 通过 `yahoo-finance2` npm 包获取期权链
5. `tradex/options/service.ts` — 定时拉取 + 缓存
6. `tradex/options/store.ts` — SQLite 持久化
7. `tradex/api/routes/options.ts` — API 路由
8. 配置解析集成

### Phase 2: 前端 + Agent 工具

**预计工作量**：1-2 天

1. `web/src/components/workspace/OptionsPanel.tsx` — GEX 可视化
2. `tradex/agent/tools/options.ts` — Agent 工具注册
3. WebSocket state 集成

### Phase 3: Tradier + 高级分析

**预计工作量**：1 天

1. `tradex/options/providers/tradier.ts` — Tradier provider（有 API key 后启用）
2. Unusual Activity 异常检测完善
3. OI 历史变化分析
4. IV Surface / Skew 分析

### Phase 4: 进阶功能（可选）

- Hawkes Process 自激模型（检测 OI 突增的级联效应）
- Kalman Filter 平滑 GEX 序列
- 多标的联动分析（SPY + QQQ + IWM gamma 环境对比）
- CBOE 日终数据自动下载和历史回测

---

## 进阶设计：Hedge Impulse 与 Pressure Cloud

> 参考 [FullStackCraft/floe](https://github.com/FullStackCraft/floe) 的设计哲学 —— 一个被 VannaCharm.com 等生产环境使用的 TypeScript 零依赖期权分析库。

### 问题：GEX 单一数值的局限

传统 GEX 分析只给出一个 Net GEX 数值 + 逐 strike 柱状图。但这忽略了一个关键问题：**Gamma 和 Vanna 在价格空间中的交互效应**。

做市商的 delta 变化不仅来自 Gamma（价格移动），还来自 Vanna（IV 移动）。而 IV 和价格经验上是负相关的（spot-vol coupling），所以二者不能独立分析。

### 解决方案：Hedge Impulse Curve

`floe` 提出的 **Hedge Impulse** 概念将 Gamma 和 Vanna 通过 Taylor 展开合并为单一的价格空间响应函数：

```
H(S) = GEX_smoothed(S) - (k / S) × VEX_smoothed(S)
```

其中：
- `GEX_smoothed(S)` = 通过 Gaussian kernel 平滑后的 Gamma Exposure
- `VEX_smoothed(S)` = 通过 Gaussian kernel 平滑后的 Vanna Exposure  
- `k` = spot-vol coupling coefficient，从 IV surface 的 skew slope 导出
- 对于股票指数，k 通常在 4-12 之间

**关键设计决策**：
1. **不做时间加权** —— Dollar GEX/VEX/CEX 已经通过 Black-Scholes Greeks 内含了所有 time-to-expiry 效应。额外加权会 double-count。
2. **物理组合而非任意权重** —— 通过 Taylor 展开推导而非硬编码 regime-dependent 权重。
3. **自适应 Kernel 宽度** —— 以 strike spacing 的倍数定义（默认 2 × modal strike spacing），而非 spot 的百分比。确保不同合约规格的标的有一致的平滑效果。

### Impulse 曲线的含义

| H(S) 值 | 含义 | 做市商行为 |
|---|---|---|
| H(S) > 0 | **稳定区**（Mean-reversion） | 做市商在价格靠近时做反向对冲（挂 limit 单吸收波动） |
| H(S) < 0 | **加速区**（Trend-amplification） | 做市商在价格靠近时做同向对冲（发 market 单放大波动） |
| H(S) = 0 | **Regime Edge** | 市场行为模式切换的临界价格 |

### Regime 分类（基于 Impulse Curve）

```typescript
type ImpulseRegime = 
  | 'pinned'        // Spot 处有强正 impulse → 价格被锁定
  | 'expansion'     // Spot 处有负 impulse → 随时可能突破
  | 'squeeze-up'    // 上方负 impulse + 下方正 impulse → 上行挤压
  | 'squeeze-down'  // 下方负 impulse + 上方正 impulse → 下行挤压  
  | 'neutral';      // 信号混合或微弱
```

### Pressure Cloud —— 可交易的区域

在 Impulse Curve 基础上，`PressureCloud` 进一步提取可交易区域：

```typescript
interface PressureCloud {
  stabilityZones: PressureZone[];     // 正 impulse 峰 → 价格减速/反转
  accelerationZones: PressureZone[];  // 负 impulse 谷 → 价格加速/突破
  regimeEdges: RegimeEdge[];          // 零交叉点 → 行为模式切换
  priceLevels: PressureLevel[];       // 每个价格点的详细信息
}

interface PressureZone {
  center: number;     // 区域中心价格
  lower: number;      // 下界
  upper: number;      // 上界
  strength: number;   // 0-1 归一化强度（含 reachability 权重）
  side: 'above-spot' | 'below-spot';
  tradeType: 'long' | 'short';  // 交易方向建议
  hedgeType: 'passive' | 'aggressive';  // 做市商对冲方式
}
```

**Reachability 权重**：不是所有区域都同样重要。10% 外的 stability basin 不如 0.5% 处的 moderate basin 有意义：

```
reachRange = expectedDailySpotMove × spot × reachabilityMultiple (默认 2.0)
proximity = exp(-((distance / reachRange)²))
strength = (|impulse| / maxImpulse) × proximity
```

这把注意力集中在当前 session 内市场能够实际到达的价格水平。

### 对冲合约估算

每个价格水平都附带预估对冲合约数（正 = 买入，负 = 卖出）：

```
contracts = impulse / (multiplier × spot × 0.01)
```

| 产品 | 乘数 | 说明 |
|---|---|---|
| NQ (E-mini Nasdaq) | 20 | 基准单位 |
| MNQ (Micro Nasdaq) | 2 | 10x NQ |
| ES (E-mini S&P) | 50 | 0.4x NQ |
| MES (Micro S&P) | 5 | 4x NQ |

---

## 进阶设计：完整的 Greek Exposure 四维分析

> 参考 [FlashAlpha-lab/gex-explained](https://github.com/FlashAlpha-lab/gex-explained) 的 DEX/VEX/CHEX 框架

### 超越 GEX：四个维度的做市商约束

| 指标 | 含义 | 驱动因素 | 做市商被迫做什么 |
|---|---|---|---|
| **GEX** (Gamma Exposure) | 每 1% 价格变动的对冲量 | 价格变动 | 价格涨→卖/买取决于正/负gamma |
| **DEX** (Delta Exposure) | 当前净方向性持仓 | 存量状态 | 反映现有对冲负担，IV 变化时会重新平衡 |
| **VEX** (Vanna Exposure) | IV 变化 1 点时的 delta 调整 | IV 变动 | IV 下跌时正 VEX → 卖出；IV 上涨时 → 买入 |
| **CHEX** (Charm Exposure) | 每天时间流逝导致的 delta 漂移 | 时间消逝 | 创造可预测的方向性流（尤其周五收盘/周一开盘） |

四者合在一起，给出做市商流动的完整结构性画面：
- **GEX** = 价格移动时发生什么
- **DEX** = 当前方向性状态
- **VEX** = 波动率变化时发生什么  
- **CHEX** = 纯粹因为时间流逝会发生什么

### Exposure 三种计算模式

参考 `floe` 的三模式设计：

```typescript
interface ExposureVariantsPerExpiry {
  canonical: ExposureModeBreakdown;      // 标准模式：GEX/VEX/CEX
  stateWeighted: ExposureModeBreakdown;  // 状态加权：Vanna×IV level, Charm×DTE
  flowDelta: ExposureModeBreakdown;      // 增量模式：仅计算 OI 变化量的贡献
}
```

- **Canonical**：标准计算，适合 regime 判断
- **State-Weighted**：考虑当前 IV 水平和 DTE 的实际影响（高 IV 环境下 Vanna 影响更大）
- **Flow-Delta**：只看 OI 的日内变化（`liveOI - previousOI`），识别新开仓带来的增量影响

---

## 进阶设计：VannaFlip 信号 + 策略框架

> 参考 [simonrey1/gex-strategy](https://github.com/simonrey1/gex-strategy) —— 一个基于 GEX walls 的量化策略，8 年回测 Sharpe 2.82

### VannaFlip 信号（暴风雨后的平静）

该策略的核心洞察：当 IV spike 时做市商疯狂对冲 → 当恐慌消退 IV 压缩时做市商回补 → 创造机械性买入尾流。

**信号两阶段结构**：

```
阶段1: SPIKE 检测 — "暴风雨来了？"
├─ IV 飙升到 ≥3.5× baseline（真正的恐慌）
├─ 价格接近 Put Wall（对冲压力峰值处）
└─ 最小波动率门槛（市场足够活跃）
→ 打开 50-bar 观察窗口

阶段2: ENTRY 门控 — "暴风雨过去了？"  
├─ IV Compression: IV 下降到 spike 峰值的 ≤50%（恐惧消退）
├─ Max ATR% < 0.50%: 价格 choppiness 正在平息
├─ Wall structure: GEX walls 健在且健康
├─ Trend state: TSI、momentum、dead-zone 检查
└─ 5+ 更多结构性门控（GEX norm、wall spread、PW/CW strength）
→ 第一个全部通过的 bar: 买入
```

### GEX Wall 多层设计

`gex-strategy` 使用三层 wall 系统而非单一的 Call/Put Wall：

| Wall 类型 | 定义 | 用途 |
|---|---|---|
| **Narrow Walls** | 最高 γ×OI 的 strike（靠近 spot） | 短线支撑/阻力判断 |
| **Wide Walls** | >3% OTM 的最高 γ×OI | 结构性 levels + Trailing Stop 依据 |
| **Weekly Walls** | 仅周五到期期权 | 本周到期前的短期 pin 效应 |

### 进阶 Gamma 指标

```typescript
interface EnrichedGexProfile {
  // 基础
  narrow_put_walls: WallLevel[];
  narrow_call_walls: WallLevel[];
  wide_put_walls: WallLevel[];
  wide_call_walls: WallLevel[];
  atm_put_iv: number;
  
  // 进阶结构指标
  total_put_goi: number;         // Put side 总 gamma×OI
  total_call_goi: number;        // Call side 总 gamma×OI
  cw_depth_ratio: number;        // Call Wall 之上的 gamma 比例 → CW 有多强
  pw_com_dist_pct: number;       // Put Wall 重心距 spot 的距离% → 支撑有多远
  pw_near_far_ratio: number;     // 近处/远处 Put gamma 比例 → 支撑是否集中
  atm_gamma_dominance: number;   // ATM gamma 占总 gamma 比例 → pin 强度
  near_gamma_imbalance: number;  // 近处 Put vs Call gamma 不平衡 → 方向偏向
  gamma_tilt: number;            // (Call - Put) / Total → 整体倾斜
}
```

### Exit 策略

- **Bracket SL/TP**: 5 ATR 止损，30 ATR 止盈
- **Wall-Trailing Stop**: 盈利达 12 ATR 后激活，跟踪到最高 PW - 2.5 ATR
- **Hurst Exhaustion**: 当 Hurst < 0.45 持续 4+ bars 且盈利 ≥ 12 ATR 时，收紧到 highest_close − 2 ATR

---

## 进阶设计：LLM + GEX 的因果推理框架

> 参考 [iAmGiG/gex-llm-patterns](https://github.com/iAmGiG/gex-llm-patterns) —— PhD 研究项目，已发表 IEEE BigData 2025 和 AIAI 2026。证明 LLM 可以从纯数字结构中检测做市商约束，检测率 71.5%、预测精度 90.9%。

### WHO → WHOM → WHAT 因果框架

Agent 的每一次 GEX 分析输出必须指明因果链：

- **WHO**: 被约束的行为人（如：持有负 gamma 的做市商）
- **WHOM**: 被影响的参与者（如：方向性交易者）
- **WHAT**: 被迫的机制（如：顺周期对冲放大波动）

示例 prompt 结构（用于 Agent tool 输出）：

```
[GEX REGIME ANALYSIS - SPY]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ Regime: NEGATIVE GAMMA (-$32.9B)
▶ Gamma Flip: $485.50 (spot $522.22, 在 flip 之上 7.6%)

因果链:
• WHO: 做市商净短 gamma $32.9B，74% 来自 call side
• WHOM: 方向性交易者将面临放大的波动
• WHAT: 价格下行时做市商被迫卖出→加速下跌
         价格上行时做市商被迫买入→加速上涨

结构性含义:
• Call Wall $540 (+3.4%) = 做市商卖出压力峰值
• Put Wall $500 (-4.3%) = 若跌破将加速下行
• Gamma 集中度 73.4% = 强 pin 效应“罩子”
```

### 关键设计原则

1. **Net GEX 是充分的** —— 不需要了解做市商是卖了 iron condor 还是 straddle。SEC 15c3-1 规则基于 aggregate risk，不是 strategy-by-strategy。
2. **Call/Put 分解有价值** —— 同样是 -$30B net GEX，call 主导意味上行对冲压力更大，put 主导意味下行对冲压力更大。
3. **时间混淆测试** —— LLM 应当能仅从数值结构中识别模式（无需日期/ticker 提示），这证明它在做结构性推理而非记忆匹配。
4. **检测≠可交易** —— 稳定的检测率(68-74%)可以和经济利润崩溃(Sharpe 1.8→0.1)共存。GEX 模式是结构性机制，不是可利用的异常。

### 15 种核心市场机制模式（来自 Pattern Library）

该项目定义了四类 15 种可检测模式，可作为 Agent 分析的参考框架：

| 类别 | 典型模式 | Agent 应输出什么 |
|---|---|---|
| **Squeeze** | Gamma Squeeze、Short Squeeze、Pin Risk | 拤压条件是否满足 + 方向 |
| **Manipulation** | Max Pain Magnet、Expiration Pinning | 到期日价格吸引区 + 强度 |
| **Flow** | Dealer Hedging、Dark Pool、Sweep Detection | 机构行为方向 + 规模 |
| **Volatility** | Vol Crush、Regime Shift、0DTE Hedging | 波动率转向预期 + 时间线 |

---

## 进阶设计：BTC/ETH 期权流——Deribit 免费数据

> 参考 [laloquidity/btc-options-flow](https://github.com/laloquidity/btc-options-flow) —— 实时 BTC 期权流终端，拉取 Deribit 公开 API，无需 key。

### Deribit Provider 设计

Deribit 提供完全免费的公开 API，包含：
- `get_last_trades_by_currency` → 实时交易流
- `get_book_summary_by_currency` → IV map + ATM percentile
- `get_index_price` → BTC/ETH 现货参考价

而且 Deribit **直接提供 Greeks**，无需本地计算。

### Multi-Leg 结构检测

自动将 ±2s/±20% 内的交易分组：

| 结构 | 检测条件 |
|---|---|
| Vertical Spread | 同 type、反 direction、同 expiry |
| Straddle | P+C、同 direction、同 strike(±2%)、同 expiry |
| Strangle | P+C、同 direction、不同 strikes、同 expiry |
| Risk Reversal | P+C、反 direction、同 expiry |
| Calendar | 同 type、同 direction、不同 expiry |

### 鲸鱼交易跟踪

自动保存超过门槛的大单，并计算复合权重排序：

| 因子 | 权重 | 方法 |
|---|---|---|
| 名义金额 | 40% | `log₁₀` scale，避免悬崖效应 |
| DTE 紧迫度 | 25% | 指数衰减，7 天半衰期 |
| 离 Spot 距离 | 15% | ATM > NTM > OTM > Deep OTM |
| 逆境度 | 10% | 与你方向相反的排名更高 |
| 时效性 | 10% | 48 小时半衰期衰减 |

### IV Regime 分类

计算滚动 ATM IV percentile（基于 session 内 ~200 个样本点）：

| ATM IV Percentile | Regime | 含义 |
|---|---|---|
| < 20th | Cheap | 波动率历史低位，市场自满 |
| 20th - 80th | Mid | 正常环境 |
| > 80th | Expensive | 波动率历史高位，市场恐慌 |

### Flow Toxicity Score

单一指标浓缩流动方向性：
- **-1.0** = 极度 bullish（买方主导）
- **+1.0** = 极度 bearish（卖方主导）
- ATM 交易权重 1.0x，Deep OTM 交易权重 0.1x（Delta-weighted P/C ratio）

---

## 进阶设计：IV Surface 与 Regime 派生

> 参考 `floe` 的 regime.ts 设计

### 从 IV Surface 直接导出市场状态

不需要外部数据，仅从 IV surface 本身就能导出：

```typescript
interface RegimeParams {
  atmIV: number;                 // ATM 波动率（如 0.18 = 18%）
  impliedSpotVolCorr: number;    // 从 skew slope 导出的 spot-vol 相关性
  impliedVolOfVol: number;       // 从 smile curvature 导出的 vol-of-vol
  regime: 'calm' | 'normal' | 'stressed' | 'crisis';
  expectedDailySpotMove: number; // ATM IV / sqrt(252)
  expectedDailyVolMove: number;  // vol-of-vol / sqrt(252)
}
```

Regime 分类规则：

| ATM IV | Regime | 含义 |
|---|---|---|
| < 15% | Calm | 市场极低波动 |
| 15%-20% | Normal | 正常环境 |
| 20%-35% | Stressed | 压力环境 |
| > 35% | Crisis | 危机模式 |

Skew → Correlation 转换：
```
impliedSpotVolCorr = clamp(skew × 0.15, -0.95, 0.5)
```

Curvature → Vol-of-Vol 转换：
```
impliedVolOfVol = sqrt(|curvature|) × 2.0 × atmIV
```

---

## 参考项目

| 项目 | 重点参考 | 链接 |
|---|---|---|
| **FullStackCraft/floe** | 🌟 TypeScript 零依赖期权库；Hedge Impulse Curve + Pressure Cloud；GEX/VEX/CEX 三模式 Exposure；Broker-agnostic 设计；生产级代码质量 | [GitHub](https://github.com/FullStackCraft/floe) |
| **simonrey1/gex-strategy** | 🌟 Rust 回测引擎；VannaFlip 信号；多层 Wall 系统；Wall-Trailing Stop；8年 Sharpe 2.82；IBKR 实盘执行 | [GitHub](https://github.com/simonrey1/gex-strategy) |
| **iAmGiG/gex-llm-patterns** | 🌟 PhD 研究；LLM+GEX 因果推理；15种模式库；时间混淆验证；IEEE BigData 2025 发表 | [GitHub](https://github.com/iAmGiG/gex-llm-patterns) |
| **FlashAlpha-lab/gex-explained** | GEX 从零开始解释；DEX/VEX/CHEX 四维分析；Gamma Flip 跟踪；多标的扫描 | [GitHub](https://github.com/FlashAlpha-lab/gex-explained) |
| **laloquidity/btc-options-flow** | Deribit 免费数据；Multi-Leg 结构检测；鲸鱼跟踪；Flow Toxicity Score | [GitHub](https://github.com/laloquidity/btc-options-flow) |
| **ShortGammaGambler/options-desk** | Bloomberg Terminal 风格 UI；3D Vol Surface；HMM Regime Detection；Monte Carlo | [GitHub](https://github.com/ShortGammaGambler/options-desk) |
| **0DTE-dealer-gamma** | GEX 计算引擎、向量化 Greeks、YFinance/Tradier provider 设计 | [GitHub](https://github.com/puneet-chandna/0DTE-dealer-gamma) |
| **Radon** | 完整的「信号→策略→执行」pipeline、Unusual Whales 集成 | [GitHub](https://github.com/RektBelly/radon) |
| **options-scanner** | 简洁的多标的扫描 UI、Claude AI 集成 | [GitHub](https://github.com/jwolberg/options-scanner) |
| **GEX_Dashboard** | 多市场支持、AI-optimized API 设计 | [GitHub](https://github.com/KaranChavan21/GEX_Dashboard) |
| **unusual-whales-mcp** | MCP 工具设计参考 | [GitHub](https://github.com/erikmaday/unusual-whales-mcp) |

---

## 关键设计决策

### Q: 为什么用 TypeScript 而不是 Python？

tradex 全栈是 TypeScript。引入 Python 会增加部署复杂度。Black-Scholes 公式在 TS 中实现并无困难（无需 NumPy 级别的向量化，因为我们单次处理的合约数 < 5000）。参考项目 `floe` 就是纯 TypeScript 实现的零依赖期权分析库，已用于多个生产产品。

### Q: YFinance 用 SPY 代替 SPX 准确吗？

SPY ≈ SPX / 10。OI 分布形态相似，但存在差异：
- SPY 的期权更零散、OI 更分散
- SPX 有 AM-settled 和 PM-settled 的区别
- 作为 Phase 1 的起步方案完全够用；Phase 3 切到 Tradier 可以直接拿 SPX

### Q: 轮询间隔应该多少？

- YFinance 免费：建议 60-120 秒（避免被限速）
- Tradier sandbox：30-60 秒
- Tradier production：5-15 秒（120 req/min 限制）
- Deribit：15-60 秒（免费 public API，无限制但建议礼貌访问）

### Q: GEX 数据对日内交易有多大用？

关键 level（ZGL、Call/Put Wall）在盘中相对稳定（OI 不会剧变），但 0DTE 期权的 Charm/Vanna 效应在尾盘非常强。所以：
- GEX 本身适合做日级/半日级的 regime 判断
- Charm/Vanna 在 0DTE 最后 2 小时尤其有用
- Unusual Activity 是实时信号
- Hedge Impulse Curve 在盘中持续更新时能给出最及时的做市商流向预测

### Q: 为什么需要 Hedge Impulse 而不仅仅是 GEX + Vanna 分开看？

因为 Gamma 和 Vanna 不是独立的。当价格下跌时，IV 通常上升（负相关）。做市商的 delta 变化同时受到两个力量作用：
- Gamma effect: 价格下跌→delta 变化
- Vanna effect: IV 上升→delta 变化

将两者分开看会低估实际的对冲压力，因为它们在特定方向上是叠加的。Hedge Impulse 的 Taylor 展开等式 `H(S) = GEX(S) - (k/S) × VEX(S)` 正确地将二者组合，其中 k 从市场数据导出而非硬编码。

### Q: 为什么 floe 说“不需要时间加权”？

传统的 GEX 分析工具会对近期期权给更高权重（因为它们“更紧迫”）。但这是 double-counting —— Black-Scholes Greeks 已经包含了这个效应：
- Gamma ∝ 1/√T → 近期期权 gamma 自然更大
- Charm ∝ 1/T → 近期期权 charm 自然更强

所以 Dollar GEX/VEX/CEX 的绝对值已经反映了时间紧迫性。额外加权会让近期期权被过度放大。

---

## 文件清单（实现时的 checklist）

```
tradex/options/
├── domain.ts              # OptionQuote, OptionChain, GexSnapshot, PressureCloud 等类型
├── greeks.ts              # Black-Scholes Greeks (gamma, delta, vega, theta, charm, vanna)
├── gex_calculator.ts      # GEX 计算 + ZGL + Regime + Charm/Vanna + Walls
├── hedge_impulse.ts       # Hedge Impulse Curve: Gaussian kernel smoothing + Gamma-Vanna coupling
├── pressure_cloud.ts      # Stability/Acceleration zones + Reachability weighting
├── exposure.ts            # GEX/DEX/VEX/CHEX 四维 Exposure (canonical + stateWeighted + flowDelta)
├── iv_surface.ts          # IV Surface 构建 + skew/curvature → RegimeParams 导出
├── flow_detector.ts       # Multi-Leg 结构检测 + 鲸鱼跟踪 + Flow Toxicity Score
├── providers/
│   ├── base.ts            # OptionsDataProvider 接口
│   ├── yfinance.ts        # Yahoo Finance adapter（美股/ETF/黄金/BTC ETF）
│   ├── deribit.ts         # Deribit adapter（BTC/ETH 原生期权，免费 public API）
│   ├── tradier.ts         # Tradier API adapter（SPX 直接链）
│   └── index.ts           # Registry + factory
├── service.ts             # OptionsService: polling + caching + detection
├── store.ts               # SQLite persistence (gex_snapshots, oi_history, unusual_activity)
└── index.ts               # Module exports

tradex/api/routes/
└── options.ts             # Hono routes: /api/options/*

tradex/agent/tools/
└── options.ts             # Agent tools: get_gex_snapshot, get_dealer_levels,
                           #   get_hedge_impulse, get_pressure_cloud, etc.

web/src/components/workspace/
├── OptionsPanel.tsx        # GEX visualization panel
└── PressureChart.tsx       # Candlestick + Pressure Cloud overlay

web/src/stores/
└── optionsStore.ts         # (optional) 或直接挂在 marketStore.state.options

docs/
└── OPTIONS_GEX_DESIGN.md   # 本文档
```
