# ATLAS-Inspired Pipeline & Evolution

This document describes the `tradex` multi-agent trading pipeline introduced from the ATLAS-GIC architecture reference.

Reference repository: [`chrisworsey55/atlas-gic`](https://github.com/chrisworsey55/atlas-gic)

## Goal

The goal is not to copy ATLAS-GIC in full. `tradex` uses a smaller crypto/perp-oriented version that can run locally inside the existing TypeScript backend:

- detect market regime with deterministic data rules;
- run several specialist LLM analyst modules in parallel;
- aggregate module outputs with Darwinian performance weights;
- pass candidate trades through an adversarial risk officer (CRO);
- persist every run and every module recommendation for later scoring;
- expose current regime, feed state, run history, and evolution weights in the Web UI.

## Non-goals

This MVP deliberately does **not** implement the full ATLAS system:

- no 25+ macro/sector/superinvestor agent hierarchy;
- no agent spawning;
- no JANUS or PRISM cohort meta-layer;
- no Soros reflexivity simulation or MiroFish integration;
- no automatic prompt editing with git keep/revert;
- no automatic exchange execution from pipeline decisions.

`[pipeline].auto_execute` is intentionally treated as future-facing configuration. The current pipeline records decisions only.

## Architecture

```
Market data / candles / feeds
          │
          ▼
┌────────────────────┐
│ L1 RegimeDetector  │  Pure rules, no LLM call
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ L2 ModuleRunner x5 │  ICT, Chanlun, Wave, Indicator, Fundamental
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ L3 Synthesizer     │  Darwin-weighted voting, no LLM call
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ L3 CRO Reviewer    │  Risk-officer LLM challenge
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ L4 TradeDecision   │  PASS / OPEN_LONG / OPEN_SHORT record
└────────────────────┘
```

### L1: Regime detection

`tradex/pipeline/regime_detector.ts` reads deterministic inputs and emits:

- `market`: `RISK_ON | RISK_OFF | NEUTRAL`
- `volatility`: `LOW | MEDIUM | HIGH | EXTREME`
- `trend`: `STRONG_UP | UP | RANGE | DOWN | STRONG_DOWN`
- indicator snapshot: VIX, ADX, Fear & Greed, funding, long/short ratio, OI delta, DXY.

It is designed to be cheap and fast. If an input is missing, it falls back to neutral/default behavior instead of failing the run.

### L2: Analyst modules

`tradex/pipeline/module_runner.ts` calls the configured LLM provider with short JSON-only prompts composed from `tradex/prompts/`:

- `ict_trader`
- `chanlun_analyst`
- `wave_analyst`
- `indicator_analyst`
- `fundamental_analyst`

A module failure produces a neutral module output and stores the error. One broken module should not fail the whole run.

### L3: Synthesis and CRO

`Synthesizer` uses Darwin weights from `EvolutionStore` to vote across module outputs. It does not call an LLM.

If enough modules agree, `AdversarialReviewer` calls the `risk_officer` prompt and can reject the trade. Failure to parse or run CRO fails safe to `PASS`.

### L4: Decision record

A completed run is persisted to `~/.cache/tradex/pipeline.sqlite3`. The current implementation records the decision but does not submit orders.

## Data feeds

`tradex/data_feeds/` contains a small polling registry:

| Feed | Source | Purpose |
|---|---|---|
| `fear_greed` | alternative.me | sentiment/regime input |
| `funding` | Bitget public REST | perp crowding / carry |
| `long_short_ratio` | Bitget public REST | account positioning |
| `oi_delta` | Bitget public REST | open-interest flow |
| `dxy` | Jin10 EURUSD quote proxy | dollar pressure |

Feeds start only when `[data_feeds].enabled = true`.

## Evolution system

`tradex/evolution/` tracks analyst performance:

- `recommendations`: every module signal with entry price and later forward returns;
- `darwin_weights`: current module influence weight;
- `darwin_weight_history`: historical weight changes;
- `prompt_modifications`: manual/future autoresearch change log.

Daily-style Darwin update rule:

- top quartile by 30-day Sharpe: `weight × 1.05`
- bottom quartile: `weight × 0.95`
- bounds: `[0.3, 2.5]`

The scorecard uses conviction-weighted 5-day returns and flips the sign for short recommendations.

## Runtime lifecycle

At backend startup:

1. `AppRuntime` resolves instruments and starts the normal market controller.
2. If data feeds are enabled, `DataFeedRegistry.startAll()` begins polling.
3. If pipeline is enabled, `PipelineOrchestrator` is created.
4. If pipeline/evolution cron is enabled by config, lightweight `croner` timers fire background jobs.

Runtime state and `/ws` snapshots expose:

- `regime`
- `feeds`
- `darwinWeights`
- `lastPipelineRun`

## Config

Example:

```toml
[data_feeds]
enabled = true
fear_greed_interval_seconds = 3600
funding_interval_seconds = 60
long_short_interval_seconds = 900
oi_delta_interval_seconds = 60

[pipeline]
enabled = true
cron = "*/15 * * * *"
instruments = ["USDT-FUTURES:BTCUSDT"]
auto_execute = false
cost_budget_daily_usd = 5.0

[evolution]
enabled = true
weight_update_cron = "0 0 * * *"
return_tracking_cron = "0 */4 * * *"
min_recommendations_for_eval = 20
```

Defaults are disabled for safe rollout.

## API

Pipeline:

- `GET /api/pipeline/regime`
- `GET /api/pipeline/runs?instrument=<key>&limit=50&offset=0`
- `GET /api/pipeline/runs/:id`
- `POST /api/pipeline/trigger` with `{ "instrumentKey": "USDT-FUTURES:BTCUSDT" }`

Evolution:

- `GET /api/evolution/scorecard`
- `GET /api/evolution/weights/history/:moduleId`
- `GET /api/evolution/modifications`
- `GET /api/evolution/recommendations/:moduleId?days=30`

Feeds:

- `GET /api/feeds/status`
- `GET /api/feeds/snapshot`
- `GET /api/feeds/:name/latest`
- `GET /api/feeds/:name/history?limit=50`

## UI

The Web UI surfaces pipeline state through:

- `RegimeHUD`: current regime and key indicators;
- `FeedStatusBar`: compact feed values;
- `PipelineDashboard`: manual trigger and run details;
- `EvolutionPanel`: Darwin weights and prompt modification log.

## Failure behavior

The pipeline should degrade safely:

- missing feed data becomes `null` indicator values;
- failed module calls become neutral module results;
- CRO failure rejects the trade;
- disabled pipeline returns `503` from manual trigger;
- concurrent trigger attempts return `409`;
- no code path submits real orders in this MVP.

## Verification

Run:

```bash
npm run typecheck
npm run build
npm run build:backend
npm test
```

Manual checks:

1. Enable `[data_feeds]` and confirm `/api/feeds/status` returns current ages.
2. Enable `[pipeline]` and call `/api/pipeline/trigger` for a configured instrument.
3. Confirm `/api/pipeline/runs` includes the new run.
4. Confirm `/api/evolution/scorecard` returns weights.
5. Confirm the Web UI shows regime/feed/evolution state or clear empty states.
