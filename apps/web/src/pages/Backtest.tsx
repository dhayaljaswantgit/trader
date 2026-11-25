import { useEffect, useState } from "react";
import { GUIDE } from "./strategyGuide.ts";
import { api, usePoll, fmt, inr, Pnl, LineChart, istDateTime, Select, Modal, useCrypto } from "../lib.tsx";
import { StrategyBoard } from "./StrategyBoard.tsx";

type M = { trades: number; winRate: number | null; avgWin: number | null; avgLoss: number | null; expectancy: number | null; expectancyCI90: [number, number] | null; profitFactor: number | null; netPnl: number; returnPct: number; maxDrawdownPct: number; sharpe: number | null; sortino: number | null; maxConsecLosses: number; exposurePct: number; totalCharges: number };
export type R = { id: string; label: string; bars: number; from: number; to: number; tradeCount: number; metrics: M; inSample: M; outOfSample: M; buyHoldReturnPct: number; equity: Array<{ t: number; equity: number }>; trades: any[]; slippageSensitivity: Array<{ slippageBps: number; netPnl: number; expectancy: number | null }>; assumptions: string[] ; daily?: Array<{ day: string; trades: number; wins: number; gross: number; charges: number; net: number }>; config?: { product?: string } ; runConfig?: Record<string, any> };

type Day = { day: string; trades: number; wins: number; gross: number; charges: number; net: number };
function DailyPnl({ days }: { days: Day[] }) {
  const [showAll, setShowAll] = useState(false);
  const up = days.filter(d => d.net > 0), dn = days.filter(d => d.net < 0);
  const best = days.reduce((a, d) => d.net > a.net ? d : a, days[0]!), worst = days.reduce((a, d) => d.net < a.net ? d : a, days[0]!);
  const total = days.reduce((a, d) => a + d.net, 0);
  let streak = 0, maxStreak = 0; for (const d of days) { streak = d.net < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  const max = Math.max(1, ...days.map(d => Math.abs(d.net)));
  const months = new Map<string, { m: string; days: number; up: number; net: number }>();
  for (const d of days) { const k = d.day.slice(0, 7), x = months.get(k) ?? { m: k, days: 0, up: 0, net: 0 }; x.days++; if (d.net > 0) x.up++; x.net += d.net; months.set(k, x); }
  const mlist = [...months.values()]; const mUp = mlist.filter(m => m.net > 0).length;
  const money = (v: number) => (v >= 0 ? "+" : "−") + inr(Math.abs(v), 0);
  const nice = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });
  return <section className="card">
    <h2>📅 Daily P&L <span className="sub">— har trading din ka shudh (net) profit/loss · sirf jin dino trade hua</span></h2>
    <div className="kpis">
      <div className="kpi"><div className="l">Profit wale din</div><div className="v up">{up.length} / {days.length}</div><div className="s">{((up.length / days.length) * 100).toFixed(1)}% din profit · {dn.length} loss</div></div>
      <div className="kpi"><div className="l">Avg per din</div><div className={`v ${total >= 0 ? "up" : "down"}`}>{money(total / days.length)}</div><div className="s">avg profit din {money(up.reduce((a, d) => a + d.net, 0) / Math.max(1, up.length))} · loss din {money(dn.reduce((a, d) => a + d.net, 0) / Math.max(1, dn.length))}</div></div>
      <div className="kpi"><div className="l">Best din</div><div className="v up">{money(best.net)}</div><div className="s">{nice(best.day)}</div></div>
      <div className="kpi"><div className="l">Worst din</div><div className="v down">{money(worst.net)}</div><div className="s">{nice(worst.day)}</div></div>
      <div className="kpi"><div className="l">Lagatar loss wale din</div><div className="v">{maxStreak}</div><div className="s">max streak</div></div>
      <div className="kpi"><div className="l">Profit wale mahine</div><div className="v">{mUp} / {mlist.length}</div><div className="s">{((mUp / mlist.length) * 100).toFixed(0)}% months</div></div>
    </div>
    <div className="daybars" title="Har bar = ek din (hara profit, laal loss)">{days.map(d => <div key={d.day} className="db" title={`${nice(d.day)}: ${money(d.net)} · ${d.trades} trade(s)`}>
      <i style={{ height: `${(Math.abs(d.net) / max) * 50}%`, [d.net >= 0 ? "bottom" : "top"]: "50%", background: d.net >= 0 ? "var(--up)" : "var(--down)" }} /></div>)}</div>
    <div className="actions muted num" style={{ justifyContent: "space-between", fontSize: 11 }}><span>{nice(days[0]!.day)}</span><span>{nice(days[days.length - 1]!.day)}</span></div>
    <div className="grid g2" style={{ marginTop: 14 }}>
      <div><h3 className="h3">Mahine-wise</h3><div className="table-wrap" style={{ maxHeight: 320, overflowY: "auto" }}><table><thead><tr><th>Month</th><th className="r">Trading din</th><th className="r">Profit din</th><th className="r">Net</th></tr></thead>
        <tbody>{[...mlist].reverse().map(m => <tr key={m.m}><td>{new Date(m.m + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })}</td><td className="r num">{m.days}</td><td className="r num">{m.up}</td><td className={`r num ${m.net >= 0 ? "up" : "down"}`}><b>{money(m.net)}</b></td></tr>)}</tbody></table></div></div>
      <div><h3 className="h3">Din-wise {!showAll && days.length > 30 ? "(last 30)" : ""}</h3><div className="table-wrap" style={{ maxHeight: 320, overflowY: "auto" }}><table><thead><tr><th>Din</th><th className="r">Trades</th><th className="r">Gross</th><th className="r">Charges</th><th className="r">Net</th></tr></thead>
        <tbody>{[...days].reverse().slice(0, showAll ? undefined : 30).map(d => <tr key={d.day}><td className="num">{nice(d.day)}</td><td className="r num">{d.trades}</td><td className="r num">{money(d.gross)}</td><td className="r num muted">{inr(d.charges, 0)}</td><td className={`r num ${d.net >= 0 ? "up" : "down"}`}><b>{money(d.net)}</b></td></tr>)}</tbody></table></div>
        {days.length > 30 && <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setShowAll(!showAll)}>{showAll ? "Sirf last 30" : `Saare ${days.length} din dikhao`}</button>}</div>
    </div>
  </section>;
}

export function ResultPage({ r, info, onClose, onUseFilters, onSaveFilter }: { r: R; info?: { name: string; family: string; description: string }; onClose: () => void;
  /** load this run's settings into the Backtest Lab form */ onUseFilters?: () => void; /** save this run's settings as a named saved filter */ onSaveFilter?: (name: string) => void }) {
  const [saving, setSaving] = useState(false); const [fname, setFname] = useState(r.label); const [saved, setSaved] = useState("");
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = ""; }; }, [onClose]);
  const Row = ({ m, label }: { m: M; label: string }) => <tr><td><b>{label}</b></td><td className="r num">{m.trades}</td><td className="r num">{m.winRate == null ? "—" : (m.winRate * 100).toFixed(1) + "%"}</td>
    <td className="r num">{inr(m.expectancy)}</td><td className="r num">{fmt(m.profitFactor)}</td><td className="r"><Pnl v={m.netPnl} /></td><td className="r num">{fmt(m.sharpe)}</td></tr>;
  const capital = r.equity[0]?.equity ?? 0, gross = r.metrics.netPnl + r.metrics.totalCharges, g = info ? GUIDE[info.family] : undefined;
  const money = (v: number) => (v >= 0 ? "+" : "−") + inr(Math.abs(v), 0);
  return <div className="detail-page" role="dialog" aria-label="Backtest result"><div className="detail-inner">
    <div className="card-head" style={{ marginBottom: 0, gap: 8 }}><button className="btn sm" onClick={onClose}>← Back</button><h2 style={{ margin: "0 auto 0 0" }}>{r.label}</h2>
      {onUseFilters && r.runConfig && <button className="btn sm primary" onClick={onUseFilters} title="Is backtest ki saari settings Backtest Lab form mein bhar do">⤴ Use these filters</button>}
      {onSaveFilter && r.runConfig && !saving && <button className="btn sm" onClick={() => setSaving(true)} title="Is backtest ki settings ko naam dekar Saved filters mein rakho">💾 Save as filter</button>}
      {saving && <span className="actions" style={{ gap: 6 }}><input className="input" style={{ width: 280, padding: "5px 10px" }} value={fname} onChange={e => setFname(e.target.value)} autoFocus />
        <button className="btn sm primary" disabled={!fname.trim()} onClick={() => { onSaveFilter!(fname.trim()); setSaving(false); setSaved(fname.trim()); }}>Save</button>
        <button className="btn sm" onClick={() => setSaving(false)}>Cancel</button></span>}
      {saved && <span className="up" style={{ fontSize: 12 }}>✓ "{saved}" Saved filters mein add ho gaya</span>}</div>
    {!r.runConfig && (onUseFilters || onSaveFilter) && <div className="note warn">Is purane backtest ki settings save nahi hui thi — filters load nahi ho sakte. Naya backtest chalayein.</div>}
    <section className="card">
      <h2>💰 Paisa — kitna laga, kitna bana</h2>
      <div className="money-flow">
        <div className="mf"><span>Capital lagaya</span><b className="num">{inr(capital, 0)}</b></div><div className="mf-op">→</div>
        <div className="mf"><span>Gross P&L (charges se pehle)</span><b className={`num ${gross >= 0 ? "up" : "down"}`}>{money(gross)}</b><small>slippage ke baad</small></div><div className="mf-op">−</div>
        <div className="mf"><span>Charges diye</span><b className="num warn">{inr(r.metrics.totalCharges, 0)}</b><small>brokerage + STT + exchange + GST + stamp</small></div><div className="mf-op">=</div>
        <div className="mf hi"><span>Shudh (net) profit / loss</span><b className={`num ${r.metrics.netPnl >= 0 ? "up" : "down"}`}>{money(r.metrics.netPnl)}</b><small>{fmt(r.metrics.returnPct)}% · buy&hold {fmt(r.buyHoldReturnPct)}%</small></div>
      </div>
    </section>
    {r.daily && r.daily.length > 0 && <DailyPnl days={r.daily} />}
      <section className="card">
        <div className="card-head"><h2>{r.label}</h2><span className="muted num" style={{ fontSize: 12 }}>{istDateTime(r.from)} → {istDateTime(r.to)} · {r.bars.toLocaleString("en-IN")} bars</span>
          <a className="btn sm" href={`/api/backtests/${r.id}/csv`}>⬇ Trade ledger CSV</a></div>
        <div className="kpis">
          <div className="kpi"><div className="l">Net P&L (after costs)</div><div className="v"><Pnl v={r.metrics.netPnl} /></div><div className="s">{fmt(r.metrics.returnPct)}% · buy&hold {fmt(r.buyHoldReturnPct)}%</div></div>
          <div className="kpi"><div className="l">Trades</div><div className="v">{r.tradeCount}</div><div className="s">exposure {fmt(r.metrics.exposurePct, 1)}%</div></div>
          <div className="kpi"><div className="l">Win rate</div><div className="v">{r.metrics.winRate == null ? "—" : (r.metrics.winRate * 100).toFixed(1) + "%"}</div><div className="s">avg {inr(r.metrics.avgWin, 0)} / {inr(r.metrics.avgLoss, 0)}</div></div>
          <div className="kpi"><div className="l">Expectancy / trade</div><div className="v">{inr(r.metrics.expectancy)}</div><div className="s">90% CI {r.metrics.expectancyCI90 ? `${inr(r.metrics.expectancyCI90[0], 0)} … ${inr(r.metrics.expectancyCI90[1], 0)}` : "n/a (<10 trades)"}</div></div>
          <div className="kpi"><div className="l">Profit factor</div><div className="v">{fmt(r.metrics.profitFactor)}</div></div>
          <div className="kpi"><div className="l">Max drawdown</div><div className="v down">{fmt(r.metrics.maxDrawdownPct)}%</div><div className="s">max {r.metrics.maxConsecLosses} losses in a row</div></div>
          <div className="kpi"><div className="l">Sharpe / Sortino</div><div className="v" style={{ fontSize: 17 }}>{fmt(r.metrics.sharpe)} / {fmt(r.metrics.sortino)}</div></div>
          <div className="kpi"><div className="l">Total charges</div><div className="v" style={{ fontSize: 17 }}>{inr(r.metrics.totalCharges, 0)}</div></div>
        </div>
        {r.metrics.expectancyCI90 && r.metrics.expectancyCI90[0] < 0 && r.metrics.expectancyCI90[1] > 0 && <div className="note warn" style={{ marginTop: 12 }}>Expectancy ka 90% confidence interval zero ko cross karta hai → statistically ye edge proven nahi hai.</div>}
        {r.outOfSample.netPnl <= 0 && r.outOfSample.trades > 0 && <div className="note bad" style={{ marginTop: 12 }}>Out-of-sample period mein strategy profitable nahi rahi. Promotion gate FAIL — live ke liye eligible nahi.</div>}
        <div style={{ marginTop: 14 }}><LineChart points={r.equity.map(e => ({ t: e.t, v: e.equity }))} height={280} /></div>
      </section>
      <div className="grid g2">
        <section className="card"><h2>In-sample vs Out-of-sample <span className="sub">— last 30% unseen</span></h2>
          <p className="muted" style={{ fontSize: 12.5, marginTop: -6 }}>Poore period ko 2 hisson mein baanta: <b>In-sample</b> = pehla 70% (purana data), <b>Out-of-sample</b> = aakhri 30% (sabse naya data, jaise "future"). Agar strategy dono mein profit kare to edge asli hone ke chance zyada; sirf pehle hisse mein profit aur naye mein loss = strategy purane data par "fit" ho gayi, future mein fail ho sakti hai.</p>
          <div className="table-wrap"><table><thead><tr><th></th><th className="r">Trades</th><th className="r">Win%</th><th className="r">Expect.</th><th className="r">PF</th><th className="r">Net</th><th className="r">Sharpe</th></tr></thead>
            <tbody><Row m={r.inSample} label="In-sample (70%)" /><Row m={r.outOfSample} label="Out-of-sample (30%)" /></tbody></table></div></section>
        <section className="card"><h2>Slippage sensitivity</h2>
          <div className="table-wrap"><table><thead><tr><th>Slippage / side</th><th className="r">Net P&L</th><th className="r">Expectancy</th></tr></thead>
            <tbody>{r.slippageSensitivity.map(s => <tr key={s.slippageBps}><td className="num">{s.slippageBps} {r.config?.product === "OPTIONS" ? "pts" : "bps"}</td><td className="r"><Pnl v={s.netPnl} /></td><td className="r num">{inr(s.expectancy)}</td></tr>)}</tbody></table></div></section>
      </div>
      <section className="card"><h2>Assumptions <span className="sub">— results inhi par depend karte hain</span></h2><ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>{r.assumptions.map(a => <li key={a}>{a}</li>)}</ul></section>
      <section className="card"><h2>Trades <span className="sub">— last {r.trades.length} of {r.tradeCount}</span></h2>
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}><table><thead><tr><th>#</th><th>Entry</th><th>Exit</th><th>Side</th><th className="r">Qty</th><th className="r">Entry</th><th className="r">Exit</th><th className="r">Charges</th><th className="r">Net</th><th>Reason</th><th>Sample</th></tr></thead>
          <tbody>{[...r.trades].reverse().map(t => <tr key={t.n}><td className="num muted">{t.n}</td><td className="num" style={{ fontSize: 12 }}>{istDateTime(t.entryTime)}</td><td className="num" style={{ fontSize: 12 }}>{istDateTime(t.exitTime)}</td>
            <td><span className={`pill ${t.side}`}>{t.side}</span></td><td className="r num">{t.qty}</td><td className="r num">{fmt(t.entry)}</td><td className="r num">{fmt(t.exit)}</td><td className="r num muted">{fmt(t.charges)}</td>
            <td className="r"><Pnl v={t.netPnl} /></td><td><span className="pill NEUTRAL">{t.exitReason}</span></td><td className="muted">{t.sample}</td></tr>)}</tbody></table></div></section>
    {info && <section className="card"><h2>🧠 Ye strategy kya hai</h2>
      <p style={{ marginTop: 0 }}><b>{info.name}</b> — {info.description}</p>
      {g && <div className="guide-facts"><div>{g.idea}</div><div><span className="tag">Kis market mein</span>{g.market}</div><div><span className="tag">Mindset</span>{g.mindset}</div><div><span className="tag">Kiske liye bani hai</span>{g.bestFor}</div></div>}
    </section>}
  </div></div>;
}

export type BacktestTab = "lab" | "all";

export function Backtest({ tab }: { tab: BacktestTab }) {
  const { data: prefs } = usePoll<any>("/api/preferences", 15000); // refresh so newly built strategies appear
  type Form = typeof DEFAULT_FORM;
  const DEFAULT_FORM = { key: "", strategyId: "trend-breakout", style: "INTRADAY", interval: "D", years: "10", capital: "100000", riskPct: "1", slippageBps: "5", allowShort: true, sizingMode: "risk", capitalPerLot: "15000", lots: "1", slipPts: "0.5", leverage: "10" };
  /** A saved run's config → Backtest Lab form (built-in and custom strategies). */
  const formFromRun = (c: Record<string, any>, assumptions: string[] = [], label = ""): Form => {
    // Older runs didn't store leverage / lots / raw crypto slippage — recover them from the result text and label.
    const txt = assumptions.join(" ");
    const levTxt = txt.match(/÷\s*(\d+(?:\.\d+)?)×\s*leverage/)?.[1];
    const slipUsd = txt.match(/slippage\s+(\d+(?:\.\d+)?)\s*USD\/side/)?.[1];
    const lotsTxt = label.match(/·\s*(\d+)\s*lot/)?.[1];
    const oldFormat = c.custom && c.leverage === undefined;
    return { ...DEFAULT_FORM,
    key: c.key ?? DEFAULT_FORM.key, interval: c.daily ? "D" : String(c.interval ?? DEFAULT_FORM.interval), years: String(c.years ?? DEFAULT_FORM.years), capital: String(c.startingCapital ?? DEFAULT_FORM.capital),
    ...(c.custom ? { strategyId: `custom:${c.specId}`, sizingMode: c.sizingMode ?? "fixed", riskPct: String(c.riskPct ?? DEFAULT_FORM.riskPct), lots: String(c.lots ?? lotsTxt ?? 1),
        capitalPerLot: String(c.capitalPerLot ?? 15000), leverage: String(c.leverage ?? levTxt ?? 10), slipPts: String(oldFormat && slipUsd ? slipUsd : c.slippagePoints ?? 0.5) }
      : { strategyId: c.strategyId ?? DEFAULT_FORM.strategyId, riskPct: String(c.riskPerTradePct ?? DEFAULT_FORM.riskPct), slippageBps: String(c.slippageBps ?? DEFAULT_FORM.slippageBps), style: c.style ?? DEFAULT_FORM.style }) };
  };
  const loadLS = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; } };
  const [f, setF] = useState<Form>(() => loadLS("btForm", DEFAULT_FORM));
  useEffect(() => { try { localStorage.setItem("btForm", JSON.stringify(f)); } catch { /* ignore */ } }, [f]);
  const [presets, setPresets] = useState<Record<string, Form>>(() => { try { return JSON.parse(localStorage.getItem("btPresets") ?? "{}"); } catch { return {}; } });
  const [presetName, setPresetName] = useState(""); const [presetSel, setPresetSel] = useState("");
  // Built-in suggestion from the N10 sizing research (shown until the user has their own presets with that name)
  const n10Id = (prefs?.strategyOptions ?? []).find((o: any) => o.custom && String(o.name).startsWith("N10"))?.id as string | undefined;
  // Suggested presets = the exact N10 setups from the sizing research (NIFTY 5-min, 5y, risk-based, ₹15k/lot, 0.5 pt slippage).
  const n10 = (cap: string, risk: string): Form => ({ ...DEFAULT_FORM, key: "IDX_I:13", strategyId: n10Id!, interval: "5", years: "5", style: "INTRADAY",
    capital: cap, riskPct: risk, sizingMode: "risk", capitalPerLot: "15000", lots: "1", slipPts: "0.5", leverage: "10" });
  const suggested: Record<string, Form> = n10Id ? {
    "⭐ N10 · ₹1L · risk 2% (very risky)": n10("100000", "2"),
    "⭐ N10 · ₹3L · risk 1% (balanced)": n10("300000", "1"),
    "⭐ N10 · ₹5L · risk 1% (recommended)": n10("500000", "1"),
    "⭐ N10 · ₹5L · risk 0.5% (safest)": n10("500000", "0.5"),
  } : {};
  // Crypto (Delta) presets from the Turtle 55/20 research — daily candles, 3 years, no/low leverage
  const turtleId = (prefs?.strategyOptions ?? []).find((o: any) => o.custom && String(o.name).includes("Turtle 55/20"))?.id as string | undefined;
  const turtle = (sym: "BTCUSD" | "ETHUSD", over: Partial<Form>): Form => ({ ...DEFAULT_FORM, key: `DELTA:${sym}`, strategyId: turtleId!, interval: "D", years: "3", style: "INTRADAY",
    capital: "100000", riskPct: "2", sizingMode: "risk", leverage: "10", slipPts: sym === "BTCUSD" ? "2" : "0.2", ...over });
  if (turtleId) Object.assign(suggested, {
    "⭐ ₿ Turtle 55/20 · BTC · Daily · ₹1L · risk 2% (balanced)": turtle("BTCUSD", {}),
    "⭐ ₿ Turtle 55/20 · ETH · Daily · ₹1L · risk 2% (balanced)": turtle("ETHUSD", {}),
    "⭐ ₿ Turtle 55/20 · ETH · Daily · ₹1L · full capital 1× (aggressive)": turtle("ETHUSD", { sizingMode: "capital", leverage: "1" }),
  });
  const allPresets = { ...suggested, ...presets };
  useEffect(() => { if (presetSel && allPresets[presetSel] && JSON.stringify({ ...DEFAULT_FORM, ...allPresets[presetSel] }) !== JSON.stringify(f)) setPresetSel(""); }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const savePresets = (p: Record<string, Form>) => { setPresets(p); try { localStorage.setItem("btPresets", JSON.stringify(p)); } catch { /* ignore */ } };
  const { data: runs, reload: reloadRuns } = usePoll<any[]>("/api/backtests", 0);
  const [r, setR] = useState<R | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const key = f.key || prefs?.selected.find((s: any) => s.instrumentType === "EQUITY")?.key || prefs?.selected[0]?.key || "";
  const custom = f.strategyId.startsWith("custom:");
  const cryptoList = useCrypto(); const isCryptoKey = key.startsWith("DELTA:");
  const [applyOpen, setApplyOpen] = useState(false); const [onlyThis, setOnlyThis] = useState(true); const [applyMsg, setApplyMsg] = useState("");
  const capLots = Math.min(20, Math.floor(Number(f.capital) / (Number(f.capitalPerLot) || 15000)));
  const usedLots = f.sizingMode === "fixed" ? Math.min(Number(f.lots) || 1, capLots) : null;
  const risky = (f.sizingMode === "fixed" && (usedLots ?? 0) * 15000 > Number(f.capital) * 0.5) || (f.sizingMode === "risk" && Number(f.riskPct) >= 2) || f.sizingMode === "capital";
  const applyLive = async () => {
    setErr(""); setApplyMsg("");
    try {
      const r = await api<{ strategy: string; selected: number; sessionCapital: number | null }>("/api/builder/apply-live", { json: { strategyId: f.strategyId, capital: Number(f.capital), sizingMode: f.sizingMode,
        lots: Number(f.lots), riskPct: Number(f.riskPct), capitalPerLot: Number(f.capitalPerLot), slippagePoints: Number(f.slipPts), onlyThis } });
      setApplyOpen(false);
      setApplyMsg(`✓ "${r.strategy}" Trade Setup mein select ho gayi (${r.selected} strategy selected) · live sizing set · default capital ₹${Number(f.capital).toLocaleString("en-IN")}.` +
        (r.sessionCapital != null && r.sessionCapital !== Number(f.capital) ? ` ⚠ Aaj ka session ₹${r.sessionCapital.toLocaleString("en-IN")} capital par chal raha hai — Dashboard → ✎ Edit limits se capital ₹${Number(f.capital).toLocaleString("en-IN")} karein.` : r.sessionCapital == null ? " Ab Dashboard → Start Day → ▶ Start auto engine." : ""));
    } catch (e) { setErr((e as Error).message); }
  };
  const run = async () => {
    setErr(""); setBusy(true);
    const extra = custom ? { sizingMode: f.sizingMode, riskPct: Number(f.riskPct), capitalPerLot: Number(f.capitalPerLot), lots: Number(f.lots), slippagePoints: Number(f.slipPts), leverage: Number(f.leverage) || 10 } : {};
    try { setR(await api<R>("/api/backtest", { json: { ...f, ...extra, key, years: Number(f.years) } })); reloadRuns(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const intraday = f.interval !== "D";

  const info = (prefs?.strategyOptions ?? []).find((o: any) => r && r.label.includes(` · ${o.name} · `));
  return <>

    {tab === "lab" && <>
    <section className="card">
      <h2>⟲ Backtest Lab <span className="sub">— har strategy, 10 saal tak</span></h2>
      <div className="form-grid">
        <div className="field"><span>Instrument</span><Select options={[...(prefs?.selected ?? []), ...((prefs?.selected ?? []).some((x: any) => x.key === "IDX_I:13") ? [] : [{ key: "IDX_I:13", symbol: "NIFTY", name: "Nifty 50", instrumentType: "INDEX" }]), ...cryptoList].map((s: any) => ({ value: s.key, label: s.symbol, sub: s.name, group: s.instrumentType === "INDEX" ? "Indices" : s.instrumentType === "CRYPTO_PERP" ? "₿ Crypto · Delta Exchange" : "Stocks" })).sort((a: any, b: any) => Number(a.group !== "Indices") - Number(b.group !== "Indices"))} value={key} onChange={v => set("key", v)} search placeholder="Instrument" ariaLabel="Instrument" /></div>
        <div className="field"><span>Strategy</span><Select search options={(prefs?.strategyOptions ?? []).map((s: any) => ({ value: s.id, label: s.name, sub: s.description, group: s.custom ? "⭐ My custom (Strategy Builder)" : s.family }))} value={f.strategyId} onChange={v => set("strategyId", v)} ariaLabel="Strategy" /></div>
        <div className="field"><span>Timeframe</span><Select options={[{ value: "D", label: "Daily", sub: "up to 10 years" }, { value: "15", label: "15-min", sub: "up to 5 years" }, { value: "5", label: "5-min", sub: "up to 5 years" }, { value: "1", label: "1-min scalping", sub: "up to 5 years" }]}
          value={f.interval} onChange={v => setF({ ...f, interval: v, years: v === "D" ? "10" : "1" })} ariaLabel="Timeframe" /></div>
        <label className="field"><span>Period: {f.years} year(s)</span><input type="range" min={intraday ? 0.25 : 1} max={intraday ? 5 : 10} step={intraday ? 0.25 : 1} value={f.years} onChange={e => set("years", e.target.value)} /></label>
        {intraday && !custom && <div className="field"><span>Style params</span><Select options={[{ value: "INTRADAY", label: "Intraday" }, { value: "SCALPING", label: "Scalper" }, { value: "POSITIONAL", label: "Carry forward" }]} value={f.style} onChange={v => set("style", v)} ariaLabel="Style params" /></div>}
        <label className="field"><span>Capital (₹)</span><input className="input num" value={f.capital} onChange={e => set("capital", e.target.value)} /></label>
        {custom && <div className="field"><span>Lot sizing</span><Select value={f.sizingMode} onChange={v => set("sizingMode", v)} ariaLabel="Lot sizing" options={[
          { value: "risk", label: "Risk-based", sub: "stop hit ≈ Risk/trade % of capital" }, { value: "capital", label: "Capital-based", sub: "lots = capital ÷ ₹ per lot" },
          { value: "fixed", label: "Fixed lots", sub: "capital P&L ko change nahi karta" }]} /></div>}
        {custom && isCryptoKey && <label className="field"><span>Leverage (×) — margin per contract</span><input className="input num" value={f.leverage} onChange={e => set("leverage", e.target.value)} title="Margin per contract = notional ÷ leverage" /></label>}
        {custom && !isCryptoKey && f.sizingMode !== "fixed" && <label className="field"><span>₹ per lot (premium/margin)</span><input className="input num" value={f.capitalPerLot} onChange={e => set("capitalPerLot", e.target.value)} title="1 lot kharidne ke liye kitna paisa lagta hai (ATM NIFTY ≈ ₹15,000)" /></label>}
        {custom && f.sizingMode === "fixed" && <label className="field"><span>Lots / trade</span><input className="input num" value={f.lots} onChange={e => set("lots", e.target.value)} /></label>}
        {(!custom || f.sizingMode === "risk") && <label className="field"><span>Risk / trade (%)</span><input className="input num" value={f.riskPct} onChange={e => set("riskPct", e.target.value)} /></label>}
        {custom ? <label className="field"><span>{isCryptoKey ? "Slippage (USD / side)" : "Slippage (index pts / side)"}</span><input className="input num" value={f.slipPts} onChange={e => set("slipPts", e.target.value)} /></label>
          : <label className="field"><span>Slippage (bps / side)</span><input className="input num" value={f.slippageBps} onChange={e => set("slippageBps", e.target.value)} /></label>}
      </div>
      <div className="actions preset-bar" style={{ marginTop: 12, gap: 8, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>💾 Saved filters:</span>
        {Object.keys(allPresets).length > 0 && <Select size="sm" width={260} value={presetSel} placeholder="Load saved filters…" ariaLabel="Saved filters"
          onChange={n => { setPresetSel(n); if (allPresets[n]) setF({ ...DEFAULT_FORM, ...allPresets[n] }); }} options={Object.keys(allPresets).map(n => ({ value: n, label: n, group: n.startsWith("⭐ ₿") ? "₿ Crypto (Delta) — research" : n.startsWith("⭐") ? "🇮🇳 NIFTY (Dhan) — research" : "My saved" }))} />}
        {presetSel && presets[presetSel] && <button className="btn sm" onClick={() => { const p = { ...presets }; delete p[presetSel]; savePresets(p); setPresetSel(""); }}>✕ Delete "{presetSel}"</button>}
        <input className="input" style={{ width: 200, padding: "5px 10px" }} placeholder="Naam (e.g. N10 realistic 3L)" value={presetName} onChange={e => setPresetName(e.target.value)} />
        <button className="btn sm" disabled={!presetName.trim()} onClick={() => { const n = presetName.trim(); savePresets({ ...presets, [n]: f }); setPresetSel(n); setPresetName(""); }}>Save current filters</button>
        <span className="muted" style={{ fontSize: 11 }}>(last used filters apne aap yaad rehte hain · is browser mein save)</span>
      </div>
      <div className="actions" style={{ marginTop: 14, alignItems: "center" }}>
        <button className="btn primary big" disabled={busy || !key} onClick={run}>{busy ? "⏳ Running… (Dhan data fetch mein time lag sakta hai)" : "▶ Run backtest"}</button>
        {custom && <button className="btn big" onClick={() => setApplyOpen(true)} title="In filters ko live paper trading (Trade Setup) mein lagao">🚀 Use in Trade Setup</button>}
        {err && <span className="err" role="alert">{err}</span>}
      </div>
      {applyMsg && <div className="note" style={{ marginTop: 10 }}>{applyMsg}</div>}
      {applyOpen && <Modal title="🚀 Ye filters live paper trading mein lagayein?" onClose={() => setApplyOpen(false)}>
        <ul className="steps" style={{ listStyle: "disc", marginTop: 0 }}>
          <li>Strategy: <b>{(prefs?.strategyOptions ?? []).find((o: any) => o.id === f.strategyId)?.name}</b> → Trade Setup mein <b>select</b></li>
          <li>Lot sizing (live): <b>{f.sizingMode === "fixed" ? `Fixed ${f.lots} lot${Number(f.lots) > capLots ? ` → max ${capLots} use honge (capital ₹${Number(f.capital).toLocaleString("en-IN")} ÷ ₹${Number(f.capitalPerLot || 15000).toLocaleString("en-IN")}/lot, max 20)` : ""}` : f.sizingMode === "risk" ? `Risk ${f.riskPct}% per trade` : `Capital ÷ ₹${f.capitalPerLot}/lot`}</b></li>
          <li>Default capital: <b>₹{Number(f.capital).toLocaleString("en-IN")}</b>{f.sizingMode === "risk" ? <> · risk/trade <b>{f.riskPct}%</b></> : null} (Start Day form mein pre-fill)</li>
          <li>Kis par chalegi: strategy ka "Run on" (N-series = sirf NIFTY), timeframe strategy ka live timeframe</li>
        </ul>
        {risky && <div className="note bad" style={{ marginBottom: 10 }}>⚠ <b>Ye setup bahut risky hai.</b> {f.sizingMode === "fixed" ? `Har trade mein ${usedLots} lot (${(usedLots ?? 0) * 75} qty) — ` : ""}isi tarah ka sizing (N10, ₹5L, 20 lots) 5 saal ke backtest mein <b>account wipe-out (−103%)</b> kar chuka hai; 6 mahine ka profit lucky period tha. Recommended: <b>Risk-based 1%</b>. Phir bhi paper mode hai — decision aapka.</div>}
        <label className="actions" style={{ gap: 8, cursor: "pointer", marginBottom: 12 }}><input type="checkbox" checked={onlyThis} onChange={e => setOnlyThis(e.target.checked)} /> Sirf yahi strategy chalaye (baaki strategies untick)</label>
        <div className="actions" style={{ gap: 8 }}><button className="btn primary" onClick={applyLive}>✓ Apply to Trade Setup</button><button className="btn" onClick={() => setApplyOpen(false)}>Cancel</button></div>
      </Modal>}
      {key.startsWith("DELTA:") ? <div className="note" style={{ marginTop: 12 }}>₿ <b>Delta (crypto):</b> data Dec 2023 se available (~3 saal). Perpetual futures, 24x7, USD → ₹ fixed rate, fees 0.05% + GST, slippage USD mein. Funding payments model nahi hain.
        Research: crypto par <b>intraday (1/5/15-min) lagbhag sab strategies loss</b> mein; <b>Daily</b> timeframe behtar.</div>
        : <div className="note" style={{ marginTop: 12 }}>Daily = 10 saal tak (Dhan daily data listing se available). Intraday = max 5 saal (Dhan limit). Ye backtest <b>underlying price</b> par hai — option premium/theta/IV model nahi hai, isliye option P&L ka claim nahi karta.</div>}
    </section>


    <section className="card">
      <h2>📁 My Backtests <span className="sub">— upar ke form se chalaye gaye har backtest yahan save hota hai · row par click = poora result</span></h2>
      {!runs?.length ? <div className="empty">Abhi koi backtest nahi chalaya</div> : <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}><table>
        <thead><tr><th>Kab</th><th>Instrument · Strategy · Timeframe · Period</th><th>Data</th><th className="r">Trades</th><th className="r">Win %</th><th className="r">Charges</th><th className="r">Net P&L</th><th className="r">Max DD</th><th></th><th></th></tr></thead>
        <tbody>{runs.map(x => <tr key={x.id} className={`click ${r?.id === x.id ? "sel" : ""}`} onClick={async () => { setErr(""); try { const res = await api<R & { runConfig?: any }>(`/api/backtests/${x.id}`); setR(res);
            if (res.runConfig) setF(formFromRun(res.runConfig, res.assumptions, res.label)); // form and result match
            } catch (e) { setErr((e as Error).message); } }}>
          <td className="num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{istDateTime(x.createdAt)}</td><td><b>{x.label}</b></td>
          <td><span className={`pill ${x.dataSource === "DHAN" ? "UP" : "NO_TRADE"}`} title={x.dataSource === "MOCK" ? "Synthetic data — real market nahi" : "Real Dhan data"}>{x.dataSource}</span></td>
          <td className="r num">{x.metrics.trades}</td><td className="r num">{x.metrics.winRate == null ? "—" : (x.metrics.winRate * 100).toFixed(1) + "%"}</td>
          <td className="r num muted">{x.metrics.totalCharges != null ? inr(x.metrics.totalCharges, 0) : "—"}</td><td className="r"><Pnl v={x.metrics.netPnl} /></td><td className="r num">{fmt(x.metrics.maxDrawdownPct)}%</td>
          <td><span className="btn sm" style={{ whiteSpace: "nowrap" }}>Details →</span></td>
          <td style={{ whiteSpace: "nowrap" }}><a className="btn sm" href={`/api/backtests/${x.id}/csv`} onClick={e => e.stopPropagation()}>CSV</a></td></tr>)}</tbody></table></div>}
    </section>

    </>}

    {tab === "all" && prefs && <section className="card"><StrategyBoard readOnly instruments={prefs.selected} options={prefs.strategyOptions} value={[]} onChange={() => undefined} /></section>}

    {r && <ResultPage r={r} info={info} onClose={() => setR(null)}
      onUseFilters={() => { setF(formFromRun(r.runConfig!, r.assumptions, r.label)); setPresetSel(""); setR(null); setApplyMsg("⤴ Backtest ki settings filters mein load ho gayi — ab badal kar dobara chalayein ya 💾 Save karein."); window.scrollTo({ top: 0 }); }}
      onSaveFilter={name => { savePresets({ ...presets, [name]: formFromRun(r.runConfig!, r.assumptions, r.label) }); }} />}
  </>;
}
