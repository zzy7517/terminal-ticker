# Options & GEX Analysis Module Implementation

Implement the full options/GEX analysis module for tradex, based on the design in `docs/OPTIONS_GEX_DESIGN.md`. Free data sources: YFinance (any US stock/ETF) + Deribit (BTC/ETH, free public API).

## Goals
- Implement a production-quality options analysis module matching open-source references (0DTE-dealer-gamma, Radon, GEX_Dashboard)
- Support free data sources: YFinance for US equities/ETFs (SPY, QQQ, AAPL, NVDA, GLD, IBIT), Deribit for BTC/ETH
- Calculate GEX, Charm, Vanna, detect regime, find key levels (ZGL, Call/Put Wall)
- Expose via REST API + WebSocket + Agent tools
- Frontend panel for visualization
- PR target: main branch

## Checklist
- [ ] 1. `tradex/options/domain.ts` — Types: OptionQuote, OptionChain, GexSnapshot, RegimeState, CharmVannaFlow, KeyLevels
- [ ] 2. `tradex/options/greeks.ts` — Black-Scholes Greeks engine (gamma, delta, vega, theta, charm, vanna, IV solver)
- [ ] 3. `tradex/options/gex_calculator.ts` — GEX calculation, ZGL, regime detection, charm/vanna flow, call/put walls
- [ ] 4. `tradex/options/providers/base.ts` — OptionsDataProvider interface
- [ ] 5. `tradex/options/providers/yfinance.ts` — Yahoo Finance adapter (any US stock/ETF)
- [ ] 6. `tradex/options/providers/deribit.ts` — Deribit public API adapter (BTC/ETH, free, no key)
- [ ] 7. `tradex/options/providers/index.ts` — Provider registry + factory
- [ ] 8. `tradex/options/store.ts` — SQLite persistence (gex_snapshots, oi_history, unusual_activity)
- [ ] 9. `tradex/options/service.ts` — OptionsService: polling, caching, OI change tracking, unusual activity detection
- [ ] 10. `tradex/options/index.ts` — Module exports
- [ ] 11. `tradex/api/routes/options.ts` — Hono API routes (/api/options/*)
- [ ] 12. Config integration — Parse [options] from watchlist.toml, add OptionsConfig type
- [ ] 13. `tradex/api/runtime.ts` — Wire OptionsService into AppRuntime
- [ ] 14. `tradex/agent/tools/options.ts` — Agent tools (get_gex_snapshot, get_dealer_levels, get_options_flow, get_gamma_regime)
- [ ] 15. `web/src/components/workspace/OptionsPanel.tsx` — Frontend GEX visualization
- [ ] 16. WebSocket state integration — Add options to snapshot payload
- [ ] 17. Type-check + build verification
- [ ] 18. Git commit + push + PR