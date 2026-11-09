# Dhan API mapping

Verified against https://dhanhq.co/docs/v2/ on **2026-11-09**. Re-verify before every milestone.

| Internal method | Dhan endpoint | Limits (per docs) | Status |
|---|---|---|---|
| healthCheck | `POST /v2/marketfeed/ltp` `{IDX_I:[13]}` | 1 req/s | ✅ implemented |
| getQuotes | `POST /v2/marketfeed/quote` body `{SEGMENT:[ids]}` | 1 req/s, ≤1000 ids | ✅ |
| getCandles (D) | `POST /v2/charts/historical` (toDate exclusive) | from inception | ✅ |
| getCandles (1/5/15/25/60) | `POST /v2/charts/intraday` `"YYYY-MM-DD HH:mm:ss"` | last 5 years, ≤90 days per call | ✅ chunked |
| getExpiries | `POST /v2/optionchain/expirylist` | 1 unique req / 3 s | ✅ |
| getOptionChain | `POST /v2/optionchain` (greeks, IV, top bid/ask, OI) | 1 unique req / 3 s | ✅ |
| instrument master | `https://images.dhan.co/api-data/api-scrip-master-detailed.csv` (public) | — | ✅ daily sync |
| expired options (backtest) | `POST /v2/charts/rollingoption` (ATM±10 idx / ±3 stk, ≤30 days/call, 5y) | — | ⏳ next milestone |
| orders / positions / funds | Trading APIs | — | 🚫 not implemented (Milestone 7, needs your separate authorization) |

Headers: `access-token`, `client-id`, `Content-Type: application/json`.
Segments: IDX_I, NSE_EQ, NSE_FNO, BSE_EQ, BSE_FNO. Instruments: INDEX, EQUITY, FUTIDX, FUTSTK, OPTIDX, OPTSTK.
Product types (for future live): INTRADAY, CNC (delivery), MARGIN (F&O carry forward).

Facts discovered in the master file (2026-11-09):
- Index IDs: NIFTY 13, BANKNIFTY 25 (IDX_I, NSE); SENSEX 51 (IDX_I, BSE).
- Index futures reference a *different* underlying id (NIFTY futures → 26000, BANKNIFTY → 26009, SENSEX → 1) → we match index futures by underlying **symbol**.
- Lot sizes differ by expiry (e.g. HDFCBANK Nov/Dec 650, Jan 750) → always use the specific contract's lot size.

Open questions (verify before live): Data-API historical rate limits, token lifetime/renewal API, static-IP + SEBI retail-algo registration via broker, order-rate limits.
