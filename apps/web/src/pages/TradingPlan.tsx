import { usePoll, inr, Modal } from "../lib.tsx";
import { condText, type Spec } from "./Builder.tsx";

type Plan = {
  autoPaper: boolean; styles: string[]; segments: string[]; engineRunning: boolean; marketOpen: boolean; defaultCapital: number; squareOffIst: string; maxOpenPositions: number;
  session: null | { capitalInr: string; riskPerTradePct: string; maxLossInr: string; maxProfitInr: string | null; status: string; consecutiveLosses: number; maxConsecutiveLosses?: number; realizedPnlInr: string };
  strategies: Array<{ id: string; name: string; kind: "custom" | "builtin" | "missing"; timeframe?: string; runsOn?: string[]; spec?: Spec; family?: string; description?: string; live?: boolean }>;
};
const SEG: Record<string, string> = { OPTIONS: "Options — ATM CALL (bullish) / PUT (bearish) buy, expiry ≥ 2 din door", FUTURES: "Futures — nearest expiry, long/short", EQUITY: "Equity (cash) — stock khud" };

/** Lots the engine will actually use per trade for a custom strategy at the given session capital. */
function liveLots(spec: Spec, capital: number) {
  const z = spec.sizing, perLot = z.capitalPerLot || 15000, afford = Math.min(Math.max(1, Math.round((z as { maxLots?: number }).maxLots ?? 20)), Math.floor(capital / perLot));
  const mode = z.mode ?? "fixed";
  if (mode === "fixed") { const want = Math.max(1, Math.round(z.lots ?? 1)); return { text: want > afford ? `${want} lot maange → sirf ${afford} lot (capital ₹${capital.toLocaleString("en-IN")} ÷ ₹${perLot.toLocaleString("en-IN")}/lot, max 20)` : `${want} lot fixed`, warn: want > afford }; }
  if (mode === "capital") return { text: `${afford} lot (capital ÷ ₹${perLot.toLocaleString("en-IN")}/lot, max 20)`, warn: false };
  return { text: `Risk ${z.riskPct ?? 1}% of capital per trade (≈ ₹${Math.round(capital * (z.riskPct ?? 1) / 100).toLocaleString("en-IN")} loss if stop hit), max ${afford} lot`, warn: false };
}

export function TradingPlan({ onClose, go }: { onClose: () => void; go: (p: any) => void }) {
  const { data: p } = usePoll<Plan>("/api/live-plan", 5000);
  if (!p) return <Modal title="👁 Trading plan" onClose={onClose}><div className="empty">Loading…</div></Modal>;
  const s = p.session, cap = s ? Number(s.capitalInr) : p.defaultCapital;
  const blockers: string[] = [];
  if (!p.strategies.length) blockers.push("Koi strategy select nahi hai — Trade Setup mein select karein.");
  if (!s) blockers.push("Aaj ka trading day start nahi hua — Dashboard par Start Day karein.");
  if (s && s.status !== "ACTIVE") blockers.push(`Aaj ka session "${s.status.replace(/_/g, " ").toLowerCase()}" hai — aaj nayi entries nahi hongi (kal naya session, ya ✎ Edit limits se limit badlein).`);
  if (!p.autoPaper) blockers.push("Auto paper entries OFF hai — signals banenge par trade nahi hoga.");
  if (!p.engineRunning) blockers.push("Auto engine band hai — ▶ Start auto engine dabayein.");
  if (!p.marketOpen) blockers.push("Market abhi band hai (09:15–15:30 IST) — engine market hours mein hi entry lega.");
  if (s && p.strategies.some(x => x.kind === "custom") && Number(s.capitalInr) !== p.defaultCapital)
    blockers.push(`Aaj ke session ka capital ₹${Number(s.capitalInr).toLocaleString("en-IN")} hai, par strategy ₹${p.defaultCapital.toLocaleString("en-IN")} ke liye apply ki thi — live lots aaj ke session capital se banenge (✎ Edit limits se badlein).`);
  for (const x of p.strategies) if (x.kind === "builtin" && x.live === false) blockers.push(`"${x.name}" daily strategy hai — live engine isse trade nahi karta.`);

  return <Modal title="👁 Trading plan — engine kya, kaise trade karega" onClose={onClose}>
    <div className="plan-wide" style={{ maxHeight: "72vh", overflowY: "auto", display: "grid", gap: 12 }}>
      {blockers.length > 0 ? <div className="note bad"><b>Abhi trade nahi hoga / dhyan dein:</b><ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{blockers.map((b, k) => <li key={k}>{b}</li>)}</ul></div>
        : <div className="note">✅ Sab ready — market hours mein signals par paper trades apne aap honge.</div>}

      <div className="kpis">
        <div className="kpi"><div className="l">Capital (aaj)</div><div className="v">{inr(cap, 0)}</div><div className="s">{s ? "aaj ka session" : `default (session start nahi)`}</div></div>
        <div className="kpi"><div className="l">Max loss / din</div><div className="v">{s ? inr(s.maxLossInr, 0) : "—"}</div><div className="s">hit hote hi sab band</div></div>
        <div className="kpi"><div className="l">Loss streak limit</div><div className="v">{s ? `${s.consecutiveLosses} / ${s.maxConsecutiveLosses ?? 3}` : "—"}</div></div>
        <div className="kpi"><div className="l">Kya kharidega</div><div className="v" style={{ fontSize: 15 }}>{p.segments.join(", ") || "—"}</div><div className="s">max {p.maxOpenPositions} open position(s) · square-off {p.squareOffIst}</div></div>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>{p.segments.map(x => SEG[x] ?? x).join(" · ")}</div>

      {p.strategies.map(x => <section key={x.id} className="card" style={{ padding: 14 }}>
        <div className="card-head" style={{ marginBottom: 8 }}><h2 style={{ fontSize: 15 }}>{x.name}</h2>
          {x.kind === "custom" ? <span className="pill WATCH">CUSTOM</span> : x.kind === "builtin" ? <span className="pill NEUTRAL">{x.family}</span> : <span className="pill SHORT">MISSING</span>}
          {x.timeframe && <span className="muted" style={{ fontSize: 12 }}>⏱ {x.timeframe}</span>}
          {x.runsOn && <span className="muted" style={{ fontSize: 12 }}>📍 {x.runsOn.length > 6 ? `${x.runsOn.slice(0, 6).join(", ")} +${x.runsOn.length - 6}` : x.runsOn.join(", ")}</span>}</div>
        {x.kind === "builtin" && <p style={{ margin: 0 }}>{x.description}</p>}
        {x.kind === "custom" && x.spec && (() => { const sp = x.spec, lots = liveLots(sp, cap); return <ul className="steps" style={{ listStyle: "disc", margin: 0 }}>
          <li><b>Entry check:</b> {sp.entryMode === "dayOpen" ? "09:15 open par (din mein ek baar)" : "har candle close par → agle candle par order"}</li>
          {sp.long.enabled && <li><b>📈 BUY CALL jab:</b> {sp.long.entry.map(condText).join(" AND ")}{sp.long.exit.length ? <> · <b>exit:</b> {sp.long.exit.map(condText).join(" OR ")}</> : null}</li>}
          {sp.short.enabled && <li><b>📉 BUY PUT jab:</b> {sp.short.entry.map(condText).join(" AND ")}{sp.short.exit.length ? <> · <b>exit:</b> {sp.short.exit.map(condText).join(" OR ")}</> : null}</li>}
          <li><b>Stop:</b> {sp.stop.type === "pivot" ? `nearest swing pivot − ${sp.stop.value} pts` : sp.stop.type === "none" ? "koi fixed stop nahi (exit rules se)" : `${sp.stop.value} ${sp.stop.type === "pct" ? "%" : sp.stop.type === "atr" ? "× ATR" : "pts"}`}
            {" · "}<b>Trailing:</b> {sp.trailing.type === "pivot" ? `har naye swing pivot (k=${sp.trailing.k ?? 3}) ke peeche` : sp.trailing.type === "step" ? `har ${sp.trailing.every} pts → stop +${sp.trailing.by}` : sp.trailing.type === "trail" ? `best close se ${sp.trailing.by} pts peeche` : "off"}
            {sp.target.type !== "none" ? <> · <b>Target:</b> {sp.target.value} {sp.target.type === "rr" ? "× risk" : sp.target.type === "pct" ? "%" : "pts"}</> : null}</li>
          <li className={lots.warn ? "warn" : ""}><b>Lots / trade (live):</b> {lots.text}</li>
          <li><b>Session:</b> {sp.session.windows?.length ? `sirf ${sp.session.windows.map(w => `${w.from}–${w.to}`).join(", ")} · ` : ""}no entry after {sp.session.noEntryAfter} · square-off {sp.session.squareOff} · max {sp.session.maxTradesPerDay} trade/din
            {sp.session.dayProfitLock ? ` · din ka profit +₹${sp.session.dayProfitLock} par stop` : ""}{sp.session.dayLossLimit ? ` · din ka loss −₹${sp.session.dayLossLimit} par stop` : ""}</li>
        </ul>; })()}
      </section>)}

      <div className="actions" style={{ gap: 8 }}>
        <button className="btn" onClick={() => { onClose(); go("setup"); }}>⚙︎ Trade Setup mein badlein</button>
        <button className="btn" onClick={() => { onClose(); go("builder"); }}>🧩 Strategy Builder</button>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  </Modal>;
}
