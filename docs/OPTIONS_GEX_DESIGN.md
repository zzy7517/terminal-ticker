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

## 参考项目

| 项目 | 重点参考 | 链接 |
|---|---|---|
| **0DTE-dealer-gamma** | GEX 计算引擎、向量化 Greeks、YFinance/Tradier provider 设计 | [GitHub](https://github.com/puneet-chandna/0DTE-dealer-gamma) |
| **Radon** | 完整的「信号→策略→执行」pipeline、Unusual Whales 集成 | [GitHub](https://github.com/RektBelly/radon) |
| **options-scanner** | 简洁的多标的扫描 UI、Claude AI 集成 | [GitHub](https://github.com/jwolberg/options-scanner) |
| **GEX_Dashboard** | 多市场支持、AI-optimized API 设计 | [GitHub](https://github.com/KaranChavan21/GEX_Dashboard) |
| **unusual-whales-mcp** | MCP 工具设计参考 | [GitHub](https://github.com/erikmaday/unusual-whales-mcp) |

---

## 关键设计决策

### Q: 为什么用 TypeScript 而不是 Python？

tradex 全栈是 TypeScript。引入 Python 会增加部署复杂度。Black-Scholes 公式在 TS 中实现并无困难（无需 NumPy 级别的向量化，因为我们单次处理的合约数 < 5000）。

### Q: YFinance 用 SPY 代替 SPX 准确吗？

SPY ≈ SPX / 10。OI 分布形态相似，但存在差异：
- SPY 的期权更零散、OI 更分散
- SPX 有 AM-settled 和 PM-settled 的区别
- 作为 Phase 1 的起步方案完全够用；Phase 3 切到 Tradier 可以直接拿 SPX

### Q: 轮询间隔应该多少？

- YFinance 免费：建议 60-120 秒（避免被限速）
- Tradier sandbox：30-60 秒
- Tradier production：5-15 秒（120 req/min 限制）

### Q: GEX 数据对日内交易有多大用？

关键 level（ZGL、Call/Put Wall）在盘中相对稳定（OI 不会剧变），但 0DTE 期权的 Charm/Vanna 效应在尾盘非常强。所以：
- GEX 本身适合做日级/半日级的 regime 判断
- Charm/Vanna 在 0DTE 最后 2 小时尤其有用
- Unusual Activity 是实时信号

---

## 文件清单（实现时的 checklist）

```
tradex/options/
├── domain.ts              # OptionQuote, OptionChain, GexSnapshot 等类型
├── greeks.ts              # Black-Scholes Greeks (gamma, delta, vega, theta, charm, vanna)
├── gex_calculator.ts      # GEX 计算 + ZGL + Regime + Charm/Vanna + Walls
├── providers/
│   ├── base.ts            # OptionsDataProvider 接口
│   ├── yfinance.ts        # Yahoo Finance adapter（美股/ETF/黄金/BTC ETF）
│   ├── deribit.ts         # Deribit adapter（BTC/ETH 原生期权，免费）
│   ├── tradier.ts         # Tradier API adapter（SPX 直接链）
│   └── index.ts           # Registry + factory
├── service.ts             # OptionsService: polling + caching + detection
├── store.ts               # SQLite persistence (gex_snapshots, oi_history, unusual_activity)
└── index.ts               # Module exports

tradex/api/routes/
└── options.ts             # Hono routes: /api/options/*

tradex/agent/tools/
└── options.ts             # Agent tools: get_gex_snapshot, get_dealer_levels, etc.

web/src/components/workspace/
└── OptionsPanel.tsx        # GEX visualization panel

web/src/stores/
└── optionsStore.ts         # (optional) 或直接挂在 marketStore.state.options

docs/
└── OPTIONS_GEX_DESIGN.md   # 本文档
```