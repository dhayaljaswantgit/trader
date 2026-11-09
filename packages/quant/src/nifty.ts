/**
 * Custom NIFTY strategies, found by research on Dhan NIFTY data and validated out-of-sample.
 *
 * NIFTY Overnight Momentum — research (daily NIFTY 2016-11 → 2026-11, 0.07% round-trip cost, full-notional position):
 *   design   2016-11 → 2021-11: 225 trades, win 70.7%, PF 1.43, +22.6%, max DD 16.0%
 *   validate 2021-11 → 2023-11:  99 trades, win 69.7%, PF 1.52,  +9.6%, max DD  3.5%
 *   holdout  2023-11 → 2026-11: 134 trades, win 61.9%, PF 1.83, +17.1%, max DD  4.7%  (tested once, after selection)
 * It was selected from 90 variants (daily trend, daily mean reversion, intraday first-move momentum, overnight) using
 * the design period only; it is the only candidate that stayed profitable in all three periods. Buy & hold NIFTY made
 * more in raw return (it is invested every day); this strategy is in the market ~1 night in 5 with a much smaller drawdown.
 */
import { type Bar } from "./types.ts";
import { finish, type Check, type StrategySignal } from "./signal.ts";

const UP_DAY = 0.005; // close at least 0.5% above the open
const GAP_STOP = 0.02; // protective stop 2% below entry (only an overnight gap can hit it)

export interface CustomStrategy {
  id: string; name: string; family: string; description: string;
  evaluate: (b: Bar[], i: number, _pc: unknown, _p: unknown, daily: boolean) => StrategySignal;
  exitRule: (b: Bar[], i: number, side: "LONG" | "SHORT") => string | null;
  entryAtClose: true; fullCapital: true; dailyOnly: true; maxHoldBars: number;
}

export const NIFTY_CUSTOM: CustomStrategy[] = [{
  id: "nifty-overnight-momentum", name: "NIFTY Overnight Momentum", family: "NIFTY custom",
  description: "Daily: on a day NIFTY closes ≥ 0.5% above its open, buy near the close (15:25) and sell at the next morning's open. Strong up-days tend to carry over into the next open. 2% gap stop. Full capital, one night at a time.",
  entryAtClose: true, fullCapital: true, dailyOnly: true, maxHoldBars: 1,
  exitRule: (_b, _i, _side) => "next-day open (overnight hold only)",
  evaluate: (b, i, _pc, _p, daily) => {
    const x = b[i]!, checks: Check[] = [];
    checks.push({ name: "Daily candles", pass: daily, detail: daily ? "daily" : "designed for daily bars — use the Daily timeframe" });
    const move = x.o > 0 ? x.c / x.o - 1 : 0;
    checks.push({ name: `Up-day: close ≥ ${UP_DAY * 100}% above open`, pass: move >= UP_DAY, detail: `${(move * 100).toFixed(2)}% (open ${x.o.toFixed(2)} → close ${x.c.toFixed(2)})` });
    const ok = daily && move >= UP_DAY;
    const sig = finish("nifty-overnight-momentum", x, ok ? "BULLISH" : "NEUTRAL", checks, ok ? x.c : null, ok ? x.c * (1 - GAP_STOP) : null, 1);
    return { ...sig, target: null };
  },
}];
