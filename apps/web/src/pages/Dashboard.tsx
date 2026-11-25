import { StopCell } from "./StopCell.tsx";
import { useEffect, useState } from "react";
import { getVenue, api, usePoll, inr, fmt, Pnl, Chip, Switch, ConfirmModal, istTime } from "../lib.tsx";
import type { Health } from "../App.tsx";
import { TradingPlan } from "./TradingPlan.tsx";

export type Session = { tradingDate: string; mode: string; capitalInr: string; maxLossInr: string; maxProfitInr: string | null; riskPerTradePct: string; status: string; realizedPnlInr: string; unrealizedPnlInr: string; consecutiveLosses: number; maxConsecutiveLosses?: number; startedAt: string };
export type Trade = { id: string; contract: string; underlying: string; kind: string; product: string; side: string; quantity: number; lotSize: number; entryPrice: string; stopPrice: string; targetPrice: string; lastPrice: string; exitPrice: string | null; pnlInr: string | null; entryCharges: string; exitCharges: string; exitReason: string | null; strategyId: string; openedAt: string; closedAt: string | null; dataSource: string; fillNote: string };

export const livePnl = (t: Trade) => (Number(t.lastPrice) - Number(t.entryPrice)) * (t.side === "LONG" ? 1 : -1) * t.quantity - Number(t.entryCharges);
function ValueCell({ t, lev }: { t: Trade; lev: number | null }) {
  const inv = Number(t.entryPrice) * t.quantity, now = Number(t.lastPrice) * t.quantity, pnl = livePnl(t);
  return <div className="num" style={{ lineHeight: 1.35, whiteSpace: "nowrap" }}>
    <div>{inr(inv, 0)} → <span style={{ color: pnl >= 0 ? "var(--up)" : "var(--down)" }}>{inr(inv + pnl, 0)}</span></div>
    <small className="muted">{lev ? `Margin ${inr(inv / lev, 0)} (${lev}×) · ` : ""}Mkt value {inr(now, 0)} · {fmt((pnl / (lev ? inv / lev : inv)) * 100)}%</small>
  </div>;
}
const STATUS: Record<string, [string, "ok" | "bad" | "warn" | "info"]> = {
  ACTIVE: ["Active — trading allowed", "ok"], HALTED_LOSS: ["Halted — max loss hit", "bad"], HALTED_PROFIT: ["Halted — profit target hit", "info"],
  HALTED_CONSECUTIVE_LOSSES: ["Paused — consecutive losses", "warn"], EMERGENCY_STOP: ["EMERGENCY STOP", "bad"], CLOSED: ["Closed", "warn"],
};

function StartDay({ onStarted }: { onStarted: () => void }) {
  const { data: prefs } = usePoll<any>("/api/preferences", 0);
  const [f, setF] = useState({ capital: "100000", maxLoss: "1000", unlimited: true, maxProfit: "3000", risk: "0.25", streak: "3" });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (prefs) setF({ capital: String(prefs.defaultCapital), maxLoss: String(prefs.defaultMaxLoss), unlimited: prefs.defaultMaxProfit === null, maxProfit: String(prefs.defaultMaxProfit ?? 3000), risk: String(prefs.defaultRiskPct), streak: String(prefs.defaultMaxConsecutiveLosses ?? 3) }); }, [prefs]);
  const perTrade = Number(f.capital) * Number(f.risk) / 100;
  const submit = async () => {
    setErr(""); setBusy(true);
    try { await api("/api/session/start", { json: { capitalInr: f.capital, maxLossInr: f.maxLoss, maxProfitInr: f.unlimited ? null : f.maxProfit, riskPerTradePct: f.risk, maxConsecutiveLosses: f.streak } }); onStarted(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="card">
    <h2>☀️ Aaj ka trading day shuru karein <span className="sub">— sirf aaj ke liye limits</span></h2>
    <div className="form-grid">
      <label className="field"><span>Aaj kitna capital use karna hai (₹)</span><input className="input num" type="number" min={1} value={f.capital} onChange={e => setF({ ...f, capital: e.target.value })} /></label>
      <label className="field"><span>Max loss — isse zyada nuksaan nahi (₹) *</span><input className="input num" type="number" min={1} value={f.maxLoss} onChange={e => setF({ ...f, maxLoss: e.target.value })} /></label>
      <label className="field"><span>Risk per trade (% of capital)</span><input className="input num" type="number" step="0.05" min={0.05} max={5} value={f.risk} onChange={e => setF({ ...f, risk: e.target.value })} /></label>
      <label className="field"><span>Lagatar kitne loss ke baad ruk jao</span><input className="input num" type="number" step={1} min={1} max={50} value={f.streak} onChange={e => setF({ ...f, streak: e.target.value })} /></label>
      <div className="field"><span>Max profit</span>
        <div className="tabs"><button className={f.unlimited ? "on" : ""} onClick={() => setF({ ...f, unlimited: true })}>∞ Unlimited</button><button className={!f.unlimited ? "on" : ""} onClick={() => setF({ ...f, unlimited: false })}>Target set karo</button></div></div>
      {!f.unlimited && <label className="field"><span>Profit target — itna hone par ruk jao (₹)</span><input className="input num" type="number" min={1} value={f.maxProfit} onChange={e => setF({ ...f, maxProfit: e.target.value })} /></label>}
    </div>
    <div className="note" style={{ marginTop: 14 }}>
      Har trade mein max risk ≈ <b className="num">{inr(perTrade, 0)}</b>. Max loss <b className="num">{inr(f.maxLoss, 0)}</b> touch hote hi (open trades ka unrealized loss bhi count hoga) sab positions close ho jayengi aur din ke liye trading band.
      {f.unlimited ? " Profit par koi limit nahi — trailing stop profit protect karega." : ` Profit ${inr(f.maxProfit, 0)} pahunchte hi sab close.`} Din ke beech bhi limits Dashboard se edit kar sakte hain.
    </div>
    {err && <p className="err" role="alert">{err}</p>}
    <div className="actions" style={{ marginTop: 14 }}><button className="btn primary big" disabled={busy} onClick={submit}>▶ Start Day (Paper)</button></div>
  </section>;
}

function EditLimits({ s, maxOpen, onClose, onSaved }: { s: Session; maxOpen: number; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ capital: String(Number(s.capitalInr)), maxLoss: String(Number(s.maxLossInr)), unlimited: s.maxProfitInr === null,
    maxProfit: String(s.maxProfitInr ? Number(s.maxProfitInr) : 3000), risk: String(Number(s.riskPerTradePct)), streak: String(s.maxConsecutiveLosses ?? 3), maxOpen: String(maxOpen) });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF({ ...f, [k]: v });
  const save = async () => {
    setErr(""); setBusy(true);
    try { await api("/api/session/limits", { json: { capitalInr: f.capital, maxLossInr: f.maxLoss, maxProfitInr: f.unlimited ? null : f.maxProfit, riskPerTradePct: f.risk, maxConsecutiveLosses: f.streak } });
      await api("/api/preferences", { method: "PUT", json: { maxOpenPositions: Number(f.maxOpen) } }); onSaved(); onClose(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="card">
    <div className="card-head"><h2>✎ Aaj ki limits edit karein <span className="sub">— turant lagu, restart ki zarurat nahi</span></h2></div>
    <div className="form-grid">
      <label className="field"><span>Capital (₹)</span><input className="input num" type="number" min={1} value={f.capital} onChange={e => set("capital", e.target.value)} /></label>
      <label className="field"><span>Max loss / day (₹)</span><input className="input num" type="number" min={1} value={f.maxLoss} onChange={e => set("maxLoss", e.target.value)} /></label>
      <label className="field"><span>Risk per trade (%) ≈ {inr(Number(f.capital) * Number(f.risk) / 100, 0)}</span><input className="input num" type="number" step="0.05" min={0.05} max={5} value={f.risk} onChange={e => set("risk", e.target.value)} /></label>
      <label className="field"><span>Loss streak limit</span><input className="input num" type="number" step={1} min={1} max={50} value={f.streak} onChange={e => set("streak", e.target.value)} /></label>
      <label className="field"><span>Max open positions (ek saath)</span><input className="input num" type="number" step={1} min={1} max={10} value={f.maxOpen} onChange={e => set("maxOpen", e.target.value)} /></label>
      <div className="field"><span>Max profit</span>
        <div className="tabs"><button className={f.unlimited ? "on" : ""} onClick={() => set("unlimited", true)}>∞ Unlimited</button><button className={!f.unlimited ? "on" : ""} onClick={() => set("unlimited", false)}>Target set karo</button></div></div>
      {!f.unlimited && <label className="field"><span>Profit target (₹)</span><input className="input num" type="number" min={1} value={f.maxProfit} onChange={e => set("maxProfit", e.target.value)} /></label>}
    </div>
    {err && <p className="err" role="alert">{err}</p>}
    <div className="actions" style={{ marginTop: 14 }}><button className="btn primary" disabled={busy} onClick={save}>✓ Save limits</button><button className="btn" onClick={onClose}>Cancel</button></div>
  </section>;
}

export function Dashboard({ health, go }: { health: Health | null; go: (p: any) => void }) {
  const { data: sd, reload } = usePoll<{ session: Session | null; tradingDate: string }>("/api/session", 3000);
  const { data: pos, reload: reloadPos } = usePoll<{ open: Trade[]; closed: Trade[] }>("/api/positions", 3000);
  const { data: eng, reload: reloadEng } = usePoll<{ running: boolean; log: string[]; lastError: string | null }>("/api/engine", 3000);
  const { data: prefs, reload: reloadPrefs } = usePoll<any>("/api/preferences", 0);
  const { data: sigs } = usePoll<any[]>("/api/signals?action=ENTER", 6000);
  const [lev, setLev] = useState<number | null>(null);
  useEffect(() => { if (getVenue() === "DELTA") api<{ leverage: number }>("/api/delta/status").then(d => setLev(Number(d.leverage) || null)).catch(() => {}); }, []);
  const [modal, setModal] = useState<"" | "close" | "stop">(""); const [editing, setEditing] = useState(false); const [plan, setPlan] = useState(false); const [err, setErr] = useState("");
  const s = sd?.session;
  const all = () => { reload(); reloadPos(); reloadEng(); };

  if (sd && !s) return <><StartDay onStarted={all} />
    <div className="grid g3">
      <div className="card"><h2>1 · Setup</h2><p className="muted">{getVenue() === "DELTA" ? "Crypto perpetuals (BTC, ETH…), styles aur strategies choose karein." : "Styles (Intraday / Scalper / Carry forward), segments (Equity / Futures / Options), stocks aur strategies choose karein."}</p><button className="btn" onClick={() => go("setup")}>Open Trade Setup →</button></div>
      <div className="card"><h2>2 · Backtest</h2><p className="muted">Strategy ko 10 saal tak ke data par test karein — costs aur slippage ke saath.</p><button className="btn" onClick={() => go("backtest")}>Open Backtest Lab →</button></div>
      <div className="card"><h2>3 · {getVenue() === "DELTA" ? "Delta connection" : "Dhan connect"}</h2><p className="muted">{getVenue() === "DELTA" ? "Delta already connected hai (public data, koi key nahi). Settings mein ₹/USD rate aur leverage set karein." : "Live market data ke liye Settings mein Client ID + Access Token daalein."}</p><button className="btn" onClick={() => go("settings")}>Open Settings →</button></div>
    </div></>;
  if (!s) return <div className="empty">Loading…</div>;

  const realized = Number(s.realizedPnlInr), unreal = Number(s.unrealizedPnlInr), pnl = realized + unreal;
  const maxLoss = Number(s.maxLossInr), lossUsed = Math.min(Math.max(-pnl / maxLoss, 0), 1);
  const target = s.maxProfitInr ? Number(s.maxProfitInr) : null;
  const [stLabel, stKind] = STATUS[s.status] ?? [s.status, "warn"];
  const toggleEngine = async () => { setErr(""); try { await api(eng?.running ? "/api/engine/stop" : "/api/engine/start", { method: "POST" }); reloadEng(); } catch (e) { setErr((e as Error).message); } };
  const maxOpen: number = prefs?.maxOpenPositions ?? 1;
  const toggleAuto = async (v: boolean) => { await api("/api/preferences", { method: "PUT", json: { autoPaper: v } }); reloadPrefs(); };

  return <>
    <section className="card">
      <div className="card-head"><h2>Today · {s.tradingDate}</h2><Chip kind={stKind}>{stLabel}</Chip><Chip kind="warn">PAPER</Chip><button className="btn sm" onClick={() => setEditing(!editing)}>✎ Edit limits</button></div>
      <div className="grid g-main" style={{ alignItems: "center" }}>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>SESSION P&L (realized + unrealized)</div>
          <Pnl v={pnl} big />
          <div className="muted num" style={{ fontSize: 13 }}>Realized {inr(realized)} · Unrealized {inr(unreal)} · Return {fmt((pnl / Number(s.capitalInr)) * 100)}%</div>
          <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
            <div><div className="actions" style={{ justifyContent: "space-between", fontSize: 12 }}><span className="muted">Loss budget used</span><span className="num">{inr(Math.max(-pnl, 0), 0)} / {inr(maxLoss, 0)}</span></div>
              <div className="bar" aria-label="loss budget used"><i style={{ width: `${lossUsed * 100}%`, background: lossUsed > 0.75 ? "var(--down)" : lossUsed > 0.4 ? "var(--warn)" : "var(--info)" }} /></div></div>
            <div><div className="actions" style={{ justifyContent: "space-between", fontSize: 12 }}><span className="muted">Profit target</span><span className="num">{target ? `${inr(Math.max(pnl, 0), 0)} / ${inr(target, 0)}` : "∞ Unlimited"}</span></div>
              <div className="bar"><i style={{ width: target ? `${Math.min(Math.max(pnl / target, 0), 1) * 100}%` : "100%", background: target ? "var(--up)" : "linear-gradient(90deg, #2fd08a33, #2fd08a05)" }} /></div></div>
          </div>
        </div>
        <div className="kpis" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div className="kpi"><div className="l">Capital</div><div className="v">{inr(s.capitalInr, 0)}</div></div>
          <div className="kpi"><div className="l">Risk / trade</div><div className="v">{inr(Number(s.capitalInr) * Number(s.riskPerTradePct) / 100, 0)}</div><div className="s">{s.riskPerTradePct}%</div></div>
          <div className="kpi"><div className="l">Open positions</div><div className="v">{pos?.open.length ?? 0}<span className="muted" style={{ fontSize: 13 }}> / {maxOpen} max</span></div></div>
          <div className="kpi"><div className="l">Loss streak</div><div className="v">{s.consecutiveLosses}<span className="muted" style={{ fontSize: 13 }}> / {s.maxConsecutiveLosses ?? 3}</span></div></div>
        </div>
      </div>
    </section>

    {editing && <EditLimits s={s} maxOpen={maxOpen} onClose={() => setEditing(false)} onSaved={() => { reload(); reloadPrefs(); }} />}

    <section className="card">
      <div className="card-head"><h2>Controls</h2></div>
      <div className="actions" style={{ alignItems: "center", gap: 16 }}>
        <button className={`btn big ${eng?.running ? "danger" : "go"}`} onClick={toggleEngine} disabled={s.status === "EMERGENCY_STOP"}>{eng?.running ? "■ Stop auto engine" : "▶ Start auto engine"}</button>
        <button className="btn big" onClick={() => setPlan(true)} title="Kaunsi strategy, kis par, kitne lot, kaunse rules — sab dekhein">👁 Trading plan</button>
        <Switch on={!!prefs?.autoEngine} onChange={async v => { await api("/api/preferences", { method: "PUT", json: { autoEngine: v } }); reloadPrefs(); }}
          label="Auto-start engine" sub={prefs?.autoEngine ? "Market khulte hi engine apne aap chalu" : "Roz manually Start karna padega"} />
        <Switch on={!!prefs?.autoPaper} onChange={toggleAuto} label="Auto paper entries" sub={prefs?.autoPaper ? "ENTER signals → paper trades" : "Sirf signals, entry nahi"} />
        <span style={{ flex: 1 }} />
        <button className="btn big" onClick={() => setModal("close")} disabled={!pos?.open.length}>✕ Close all positions</button>
        <button className="btn big danger" onClick={() => setModal("stop")} disabled={s.status === "EMERGENCY_STOP"}>⛔ EMERGENCY STOP</button>
      </div>
      {prefs && <p className="muted" style={{ margin: "12px 0 0", fontSize: 13 }}>Styles: <b>{prefs.styles.join(", ")}</b> · {getVenue() === "DELTA" ? <>Market: <b>₿ Delta perpetual futures (24x7)</b></> : <>Segments: <b>{prefs.segments.join(", ")}</b></>} · Strategies: <b>{prefs.strategies.length ? prefs.strategies.map((id: string) => prefs.strategyOptions?.find((o: { id: string; name: string }) => o.id === id)?.name ?? id).join(", ") : "none (Setup mein enable karein)"}</b> · Instruments: <b>{prefs.instrumentKeys.length}</b></p>}
      {err && <p className="err" role="alert">{err}</p>}
      {eng?.lastError && <p className="err">Last engine error: {eng.lastError}</p>}
      {health && !health.marketOpen && <div className="note warn" style={{ marginTop: 12 }}>Market abhi band hai (09:15–15:30 IST, Mon–Fri). Engine nayi entries sirf market hours mein lega. Exchange holidays abhi model nahi hain.</div>}
    </section>

    <div className="grid g-main">
      <section className="card">
        <div className="card-head"><h2>Open positions</h2><button className="btn sm" onClick={() => go("trades")}>All trades →</button></div>
        {!pos?.open.length ? <div className="empty">Koi open position nahi</div> :
          <div className="table-wrap"><table><thead><tr><th>Contract</th><th>Side</th><th className="r">Qty</th><th className="r">Entry</th><th className="r">LTP</th><th className="r">Invested → Now</th><th className="r">SL / TGT</th><th className="r">P&L</th><th></th></tr></thead>
            <tbody>{pos.open.map(t => <tr key={t.id}>
              <td className="sym"><b>{t.contract}</b><small>{t.kind} · {t.product} · {t.strategyId}</small></td><td><span className={`pill ${t.side}`}>{t.side}</span></td>
              <td className="r num">{t.quantity}</td><td className="r num">{fmt(t.entryPrice)}</td><td className="r num">{fmt(t.lastPrice)}</td>
              <td className="r"><ValueCell t={t} lev={lev} /></td>
              <td className="r"><StopCell t={t} onSaved={reloadPos} /></td><td className="r"><Pnl v={livePnl(t)} /></td>
              <td><button className="btn sm" onClick={async () => { await api(`/api/positions/${t.id}/close`, { method: "POST" }); all(); }}>Close</button></td></tr>)}</tbody></table></div>}
      </section>
      <section className="card">
        <h2>Engine activity</h2>
        {eng?.log.length ? <div className="log">{eng.log.map((l, i) => <div key={i}>{l}</div>)}</div> : <div className="empty">Engine start karein — yahan live activity dikhegi</div>}
      </section>
    </div>

    <section className="card">
      <div className="card-head"><h2>Latest ENTER signals</h2><button className="btn sm" onClick={() => go("signals")}>Signal explorer →</button></div>
      {!sigs?.length ? <div className="empty">Abhi koi ENTER signal nahi. "No trade" bhi ek valid decision hai.</div> :
        <div className="table-wrap"><table><thead><tr><th>Time</th><th>Underlying</th><th>Strategy</th><th>Direction</th><th className="r">Entry</th><th className="r">Stop</th><th className="r">Target</th></tr></thead>
          <tbody>{sigs.slice(0, 8).map(x => <tr key={x.id}><td className="num">{istTime(x.createdAt)}</td><td><b>{x.underlying}</b></td><td>{x.strategyId}</td><td><span className={`pill ${x.direction}`}>{x.direction}</span></td>
            <td className="r num">{fmt(x.entry)}</td><td className="r num">{fmt(x.stop)}</td><td className="r num">{fmt(x.target)}</td></tr>)}</tbody></table></div>}
    </section>

    {plan && <TradingPlan onClose={() => setPlan(false)} go={go} />}
    {modal === "close" && <ConfirmModal title="Close all positions?" phrase="CLOSE ALL" cta="Close all now" onClose={() => setModal("")}
      body={<>Saari <b>{pos?.open.length}</b> open paper positions abhi ke bid/ask par close hongi. Engine chalta rahega.</>}
      onConfirm={async () => { await api("/api/positions/close-all", { json: { confirm: "CLOSE ALL" } }); all(); }} />}
    {modal === "stop" && <ConfirmModal title="EMERGENCY STOP" phrase="STOP" cta="Stop everything" onClose={() => setModal("")}
      body={<>Auto engine band hoga, saari positions close hongi, aur <b>aaj ke liye</b> nayi entries block ho jayengi.</>}
      onConfirm={async () => { await api("/api/emergency-stop", { method: "POST" }); all(); }} />}
  </>;
}
