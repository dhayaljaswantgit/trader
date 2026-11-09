# Dhan AI Trader (local, PAPER-only)

Self-hosted intraday research + paper-trading platform for NIFTY / BANKNIFTY / SENSEX and selected NSE stock options.
**No system guarantees profit. This build cannot place real orders.**

## Status
| Area | State |
|---|---|
| Daily session: capital, max loss (required), max profit or **Unlimited**, auto-start each day | ✅ |
| Trade setup: styles (Intraday / Scalper / Carry forward), segments (Equity / Futures / Options), any NSE stock | ✅ multi-select |
| Dhan Data API: quotes, intraday+daily candles, option chain w/ Greeks, instrument master | ✅ endpoints verified 2026-11-09 |
| Indicators (VWAP, EMA, RSI, ATR, ADX, rel. volume) + Strategy A/B with explanations | ✅ |
| Auto paper engine: signal → contract pick → risk gate → paper fill → SL/target/trail/square-off | ✅ |
| Close-all (typed confirm), per-position close, Emergency stop | ✅ |
| Backtest Lab: daily up to 10y, intraday up to 5y, costs, slippage, OOS split, CSV | ✅ underlying P&L only |
| Option-premium backtest (Dhan rolling options) | ⏳ next |
| Live orders | 🚫 not implemented; blocked in code regardless of `.env` |

## Daily use
1. `cd dhan-ai-trader && pnpm dev` → http://127.0.0.1:5173
2. (Dhan data) Settings → paste Client ID + today's access token → **Use Dhan live data**.
3. Dashboard → **Start Day** (or enable *Har din auto-start* in Trade Setup).
4. Dashboard → **Start auto engine**. Toggle *Auto paper entries* on to let ENTER signals open paper trades.
5. **Close all positions** (type `CLOSE ALL`) or **EMERGENCY STOP** (type `STOP`) any time.

The engine always starts OFF after a restart (safety). Open paper positions are still monitored.

## Setup (first time)
Needs Node 22+, pnpm, local PostgreSQL (Postgres.app works).
```bash
createdb dhan_trader && createdb dhan_trader_test
cp .env.example .env            # edit DATABASE_URL if needed; never commit .env
pnpm install
pnpm db:migrate
DATABASE_URL=postgresql://$USER@localhost:5432/dhan_trader_test pnpm --filter api exec prisma migrate deploy
pnpm test && pnpm typecheck
pnpm dev
```
API: http://127.0.0.1:4000 (bound to localhost only, no auth yet — do not expose to network).

## Layout
- `apps/api` — Fastify + Prisma (Postgres). Schema in `apps/api/prisma/schema.prisma`.
- `apps/web` — React + Vite dashboard.
- `packages/risk-engine` — independent pre-trade checks.
- `packages/broker-dhan` — `IBrokerAdapter`, mock adapter, Dhan stub.
- `packages/shared` — types, Decimal money, IST helpers.

## Architecture decisions (deviations from spec, deliberately)
- Vite instead of Next.js; no Redis/Turborepo/Docker: single local user, fewer moving parts. Can be added later.
- Quant engine written in TypeScript (`packages/quant`) instead of Python, so one runtime and shared types; Python can be added for ML research later.
- Money stored as Postgres `DECIMAL`, computed with decimal.js.

## Known limitations
- MOCK mode prices are synthetic. Exchange holidays not modelled (engine treats them as open days; Dhan data will simply be absent).
- Backtests are on the underlying price, not option premium.
- No login: relies on localhost binding.
- Holiday calendar / expiry logic not yet implemented.
