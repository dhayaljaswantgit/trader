import { type Bar } from "./types.ts";

export type Action = "WATCH" | "ENTER" | "NO_TRADE";
export type Dir = "BULLISH" | "BEARISH" | "NEUTRAL";
export interface Check { name: string; pass: boolean; detail: string }
export interface StrategySignal {
  strategyId: string; strategyVersion: string; barTime: number; direction: Dir; action: Action;
  reasons: string[]; checks: Check[]; entry: number | null; stop: number | null; target: number | null;
}

export function barSeconds(b: Bar[]): number {
  if (b.length < 2) return 300;
  let m = Infinity; for (let i = Math.max(1, b.length - 50); i < b.length; i++) { const d = b[i]!.t - b[i - 1]!.t; if (d > 0) m = Math.min(m, d); }
  return Number.isFinite(m) ? m : 300;
}


export function finish(id: string, x: Bar, dir: Dir, checks: Check[], entry: number | null, stop: number | null, rr: number): StrategySignal {
  const failed = checks.filter(c => !c.pass);
  const passCount = checks.length - failed.length;
  let action: Action = "NO_TRADE";
  if (dir !== "NEUTRAL" && failed.length === 0 && entry !== null && stop !== null) action = "ENTER";
  else if (dir !== "NEUTRAL" && passCount >= Math.ceil(checks.length * 0.6)) action = "WATCH";
  const target = action === "ENTER" && entry !== null && stop !== null ? entry + (entry - stop) * rr : null;
  const reasons = action === "ENTER" ? checks.map(c => `✓ ${c.name}`) : failed.map(c => `✗ ${c.name}: ${c.detail}`);
  return { strategyId: id, strategyVersion: "1.0.0", barTime: x.t, direction: dir, action, reasons, checks,
    entry: action === "ENTER" ? entry : null, stop: action === "ENTER" ? stop : null, target };
}
