import { useEffect, useMemo, useState } from "react";
import { usePoll, inr, fmt, istDateTime, LineChart, Select } from "../lib.tsx";
import { GUIDE } from "./strategyGuide.ts";

type Agg = { trades: number; wins: number; gross: number; charges: number; net: number };
type Tuple = [number, 1 | -1, number, number, number, number, number, number, number, number, string, 0 | 1];
type Detail = {
  run: { id: string; createdAt: string; dataSource: string; config: { interval: string; from: number; to: number; instruments: string[]; capitalPerInstrument: number; riskPerTradePct: number; slippageBps: number; product: string; oosFraction: number } };
  row: null | { name: string; family: string; trades: number; winRate: number | null; profitFactor: number | null; grossProfitFactor: number | null; netPnl: number; capital?: number; charges?: number; grossPnl?: number;
    returnPct: number; maxDrawdownPct: number; robust: boolean; profitableInstruments: number; testedInstruments: number;
    inSample: { trades: number; returnPct: number; profitFactor: number | null }; outOfSample: { trades: number; returnPct: number; profitFactor: number | null; winRate: number | null } };
  info: null | { name: string; family: string; description: string; needsVolume: boolean; intradayOnly: boolean; dailyOnly: boolean };
  detail: null | { symbols: string[]; instruments: Array<Agg & { symbol: string; maxDrawdownPct: number }>; years: Array<Agg & { year: number }>;
    exitReasons: Array<Agg & { reason: string }>; equity: Array<{ t: number; v: number }>; trades: Tuple[] };
};

const REASON: Record<string, string> = { STOP: "Stop loss hit", STOP_GAP: "Stop (gap ke saath)", TARGET: "Target hit", TARGET_GAP: "Target (gap ke saath)", SQUARE_OFF: "Square-off 15:15",
  TIME_STOP: "Max holding time", SESSION_END: "Session end", END_OF_DATA: "Data khatam", EXIT_RULE: "Exit rule (bounce/signal)" };
const money = (v: number) => (v >= 0 ? "+" : "−") + inr(Math.abs(v), 0);
const cls = (v: number) => v > 0 ? "up" : v < 0 ? "down" : "";
const day = (t: number) => istDateTime(t).replace(/,? (at )?\d{1,2}:\d{2}.*$/, "");
const PAGE = 100;

function Bars({ items }: { items: Array<{ label: string; v: number; sub?: string }> }) {
  const max = Math.max(1, ...items.map(i => Math.abs(i.v)));
  return <div className="hbars">{items.map(i => <div key={i.label} className="hbar">
    <span className="hb-l">{i.label}</span>
    <div className="hb-track"><div className="hb-mid" />
      <i style={{ width: `${(Math.abs(i.v) / max) * 50}%`, [i.v >= 0 ? "left" : "right"]: "50%", background: i.v >= 0 ? "var(--up)" : "var(--down)" }} /></div>
    <span className={`hb-v num ${cls(i.v)}`}>{money(i.v)}{i.sub && <small className="muted"> {i.sub}</small>}</span>
  </div>)}</div>;
}

export function StrategyDetail({ runId, strategyId, onClose, initialSymbol }: { runId: string; strategyId: string; onClose: () => void; initialSymbol?: string }) {
  const { data: d, error } = usePoll<Detail>(`/api/leaderboard/${runId}/strategy/${encodeURIComponent(strategyId)}`, 0);
  const [fSym, setFSym] = useState(initialSymbol ?? "ALL"); const [fRes, setFRes] = useState("ALL"); const [fSide, setFSide] = useState("ALL"); const [pg, setPg] = useState(0);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = ""; }; }, [onClose]);
  useEffect(() => setPg(0), [fSym, fRes, fSide]);

  const det = d?.detail, row = d?.row, cfg = d?.run.config, daily = cfg?.interval === "Daily";
  const T = det?.trades ?? [];
  const s = useMemo(() => {
    if (!T.length) return null;
    const wins = T.filter(t => t[9] > 0), losses = T.filter(t => t[9] <= 0), sum = (a: Tuple[], k: number) => a.reduce((x, t) => x + Number(t[k]), 0);
    let streak = 0, maxStreak = 0; for (const t of T) { streak = t[9] <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
    const holdS = T.map(t => t[3] - t[2]), avgHold = holdS.reduce((a, b) => a + b, 0) / holdS.length;
    const longs = T.filter(t => t[1] === 1), shorts = T.filter(t => t[1] === -1);
    const pct = T.map(t => (t[9] / (t[4] * t[6])) * 100).filter(Number.isFinite);
    const lo = Math.max(-6, Math.min(...pct)), hi = Math.min(6, Math.max(...pct)), nb = 24, w = (hi - lo) / nb || 1;
    const hist = Array.from({ length: nb }, (_, k) => ({ from: lo + k * w, n: 0 })); for (const p of pct) hist[Math.min(nb - 1, Math.max(0, Math.floor((p - lo) / w)))]!.n++;
    return { avgWin: wins.length ? sum(wins, 9) / wins.length : 0, avgLoss: losses.length ? sum(losses, 9) / losses.length : 0,
      best: Math.max(...T.map(t => t[9])), worst: Math.min(...T.map(t => t[9])), maxStreak, avgHold,
      long: { n: longs.length, net: sum(longs, 9), wins: longs.filter(t => t[9] > 0).length }, short: { n: shorts.length, net: sum(shorts, 9), wins: shorts.filter(t => t[9] > 0).length },
      avgCharge: sum(T, 8) / T.length, hist, maxHist: Math.max(...hist.map(h => h.n)) };
  }, [T]);

  const filtered = useMemo(() => T.filter(t => (fSym === "ALL" || det!.symbols[t[0]] === fSym) && (fRes === "ALL" || (fRes === "WIN" ? t[9] > 0 : t[9] <= 0)) && (fSide === "ALL" || (fSide === "LONG" ? t[1] === 1 : t[1] === -1)))
    .slice().reverse(), [T, fSym, fRes, fSide, det]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const hold = (sec: number) => daily ? `${(sec / 86400).toFixed(1)} din` : sec >= 3600 ? `${(sec / 3600).toFixed(1)} ghante` : `${Math.round(sec / 60)} min`;
  const csv = () => {
    const h = "instrument,side,entryTimeIST,exitTimeIST,entry,exit,qty,grossPnl,charges,netPnl,exitReason,sample";
    const lines = filtered.map(t => [det!.symbols[t[0]], t[1] === 1 ? "LONG" : "SHORT", istDateTime(t[2]), istDateTime(t[3]), t[4], t[5], t[6], t[7], t[8], t[9], t[10], t[11] ? "OUT" : "IN"].map(v => `"${v}"`).join(","));
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([[h, ...lines].join("\n")], { type: "text/csv" })); a.download = `${strategyId}-trades.csv`; a.click();
  };

  const g = d?.info ? GUIDE[d.info.family] : undefined;
  const best = det?.instruments.filter(i => i.trades > 0) ?? [];

  return <div className="detail-page" role="dialog" aria-label="Strategy detail">
    <div className="detail-inner">
      <div className="card-head" style={{ marginBottom: 6 }}>
        <button className="btn sm" onClick={onClose}>← Back</button>
        <h2 style={{ margin: 0 }}>{d?.info?.name ?? strategyId}</h2>
        {row?.robust && <span className="pill ENTER">Robust ✓</span>}
        {d?.info && <span className="muted" style={{ fontSize: 13 }}>{d.info.family}</span>}
      </div>
      {error && <div className="note bad">{error}</div>}
      {!d && !error && <div className="empty">Loading…</div>}
      {d && !det && <div className="note warn">Is run mein trade-by-trade details save nahi hue the (purana run). Strategies table par <b>Re-run backtest</b> dabayein — naye run mein har trade ki detail milegi.</div>}

      {cfg && <p className="muted num" style={{ fontSize: 12, margin: "0 0 14px" }}>
        {d!.run.dataSource} data · {cfg.interval} candles · {day(cfg.from)} → {day(cfg.to)} · {cfg.instruments.length} instruments · ₹{fmt(cfg.capitalPerInstrument, 0)}/instrument · risk {cfg.riskPerTradePct}%/trade · slippage {cfg.slippageBps} bps/side · charges: {cfg.product.replace("_", " ").toLowerCase()} · last {Math.round(cfg.oosFraction * 100)}% = out-of-sample
      </p>}

      {row && <section className="card">
        <h2>💰 Paisa — kitna laga, kitna bana</h2>
        <div className="money-flow">
          <div className="mf"><span>Capital lagaya</span><b className="num">{row.capital != null ? inr(row.capital, 0) : "—"}</b><small>₹{fmt(cfg?.capitalPerInstrument ?? 0, 0)} × {row.testedInstruments} instruments</small></div>
          <div className="mf-op">→</div>
          <div className="mf"><span>Gross P&L (charges se pehle)</span><b className={`num ${cls(row.grossPnl ?? 0)}`}>{row.grossPnl != null ? money(row.grossPnl) : "—"}</b><small>slippage ke baad</small></div>
          <div className="mf-op">−</div>
          <div className="mf"><span>Charges diye</span><b className="num warn">{row.charges != null ? inr(row.charges, 0) : "—"}</b><small>brokerage + STT + exchange + GST + stamp</small></div>
          <div className="mf-op">=</div>
          <div className="mf hi"><span>Shudh (net) profit / loss</span><b className={`num ${cls(row.netPnl)}`}>{money(row.netPnl)}</b><small>{row.returnPct >= 0 ? "+" : ""}{row.returnPct.toFixed(2)}% on capital</small></div>
        </div>
        <div className="kpis" style={{ marginTop: 14 }}>
          <div className="kpi"><div className="l">Trades</div><div className="v">{fmt(row.trades, 0)}</div><div className="s">{s ? `${fmt(s.avgCharge, 0)} ₹ charges / trade` : ""}</div></div>
          <div className="kpi"><div className="l">Win rate</div><div className="v">{row.winRate != null ? (row.winRate * 100).toFixed(1) + "%" : "—"}</div><div className="s">{row.trades ? `${Math.round((row.winRate ?? 0) * row.trades)} jeete · ${row.trades - Math.round((row.winRate ?? 0) * row.trades)} haare` : ""}</div></div>
          <div className="kpi"><div className="l">Profit factor</div><div className={`v ${cls((row.profitFactor ?? 0) - 1)}`}>{row.profitFactor?.toFixed(2) ?? "—"}</div><div className="s">before charges {row.grossProfitFactor?.toFixed(2) ?? "—"}</div></div>
          <div className="kpi"><div className="l">Max drawdown</div><div className="v">{row.maxDrawdownPct.toFixed(1)}%</div><div className="s">worst single instrument</div></div>
          {s && <div className="kpi"><div className="l">Avg win / avg loss</div><div className="v" style={{ fontSize: 18 }}><span className="up">{money(s.avgWin)}</span> / <span className="down">{money(s.avgLoss)}</span></div><div className="s">best {money(s.best)} · worst {money(s.worst)}</div></div>}
          {s && <div className="kpi"><div className="l">Lagatar losses (max)</div><div className="v">{s.maxStreak}</div><div className="s">avg hold {hold(s.avgHold)}</div></div>}
        </div>
      </section>}

      {det && det.equity.length > 1 && <section className="card">
        <h2>📈 Equity curve <span className="sub">— saare instruments ka cumulative net P&L (₹), har trade ke baad</span></h2>
        <LineChart points={det.equity} height={260} baseline={0} />
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Upar jaati line = paisa bana; neeche = loss. Seedhi, smooth upar jaati line accha sanket hai; tez giraavat (drawdown) risk dikhati hai.</p>
      </section>}

      {(g || d?.info) && <section className="card">
        <h2>🧠 Ye strategy kya hai aur kaise kaam karti hai</h2>
        {d?.info && <p style={{ marginTop: 0 }}><b>Rule:</b> {d.info.description}</p>}
        {g && <div className="grid g2" style={{ gap: 18 }}>
          <div>
            <p style={{ marginTop: 0 }}>{g.idea}</p>
            <h3 className="h3">Step by step</h3><ol className="steps">{g.how.map((x, i) => <li key={i}>{x}</li>)}</ol>
          </div>
          <div className="guide-facts">
            <div><span className="tag">Type</span>{g.style === "trend" ? "Trend-following — trend ke saath chalo" : g.style === "reversion" ? "Mean reversion — extreme se wapas average ki taraf" : g.style === "breakout" ? "Breakout — range/level tootne par" : "Mixed — setup ke hisaab se trend ya reversion"}</div>
            <div><span className="tag">Kis market mein</span>{g.market}</div>
            <div><span className="tag">Mindset</span>{g.mindset}</div>
            <div><span className="tag">Galtiyan jo na karein</span><ul>{g.mistakes.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
            <div><span className="tag">Kiske liye bani hai</span>{g.bestFor}{d?.info?.needsVolume ? " · Volume chahiye (spot index par signal nahi aayega)." : ""}{d?.info?.dailyOnly ? " · Sirf daily candles." : d?.info?.intradayOnly ? " · Sirf intraday candles." : ""}</div>
          </div>
        </div>}
        {best.length > 0 && <div className="note" style={{ marginTop: 14 }}>
          <b>Is backtest mein sabse acchi chali:</b> {best.slice(0, 3).map(i => `${i.symbol} (${money(i.net)})`).join(", ")}.
          {" "}<b>Sabse kharab:</b> {best.slice(-3).reverse().map(i => `${i.symbol} (${money(i.net)})`).join(", ")}.
          {row && <> {row.profitableInstruments}/{row.testedInstruments} instruments par profit.</>}
          {row && <> Out-of-sample (unseen last {Math.round((cfg?.oosFraction ?? 0.3) * 100)}%): {row.outOfSample.trades} trades, return {row.outOfSample.returnPct >= 0 ? "+" : ""}{row.outOfSample.returnPct.toFixed(2)}%, PF {row.outOfSample.profitFactor?.toFixed(2) ?? "—"} — {row.outOfSample.returnPct > 0 && row.inSample.returnPct > 0 ? "dono hisson mein profit (consistent)." : "dono hisson mein consistent nahi."}</>}
          <br /><span className="muted">Past performance future ki guarantee nahi. Instrument choice isi data se hai — naye data par paper-trade karke confirm karein.</span>
        </div>}
      </section>}

      {det && <div className="grid g2">
        <section className="card"><h2>🏷️ Instrument-wise P&L <span className="sub">— net, charges ke baad</span></h2>
          <Bars items={det.instruments.map(i => ({ label: i.symbol, v: i.net, sub: i.trades ? `${i.trades} tr · ${Math.round((i.wins / i.trades) * 100)}% win` : "no trades" }))} />
        </section>
        <section className="card"><h2>📅 Saal-wise P&L</h2>
          <Bars items={det.years.map(y => ({ label: String(y.year), v: y.net, sub: `${y.trades} tr · ${y.trades ? Math.round((y.wins / y.trades) * 100) : 0}% win` }))} />
        </section>
      </div>}

      {det && s && <div className="grid g2">
        <section className="card"><h2>📊 Har trade ka result (% of position)</h2>
          <div className="hist">{s.hist.map((h, k) => <div key={k} className="hist-col" title={`${h.from.toFixed(2)}% … : ${h.n} trades`}>
            <i style={{ height: `${(h.n / s.maxHist) * 100}%`, background: h.from + (s.hist[1]!.from - s.hist[0]!.from) / 2 >= 0 ? "var(--up)" : "var(--down)" }} /></div>)}</div>
          <div className="actions muted num" style={{ justifyContent: "space-between", fontSize: 11 }}><span>{s.hist[0]!.from.toFixed(1)}%</span><span>0%</span><span>{(s.hist[s.hist.length - 1]!.from).toFixed(1)}%+</span></div>
          <p className="muted" style={{ fontSize: 12 }}>Laal = loss wale trades, hara = profit wale. Trend strategies mein bahut chhote laal + kuch bade hare; reversion mein bahut hare + kabhi bada laal.</p>
        </section>
        <section className="card"><h2>🚪 Trade kaise band huye</h2>
          <div className="table-wrap"><table><thead><tr><th>Exit</th><th className="r">Trades</th><th className="r">Win %</th><th className="r">Net P&L</th></tr></thead>
            <tbody>{det.exitReasons.map(r => <tr key={r.reason}><td>{REASON[r.reason] ?? r.reason}</td><td className="r num">{fmt(r.trades, 0)}</td><td className="r num">{Math.round((r.wins / r.trades) * 100)}%</td><td className={`r num ${cls(r.net)}`}>{money(r.net)}</td></tr>)}</tbody></table></div>
          <h3 className="h3" style={{ marginTop: 14 }}>Long vs Short</h3>
          <div className="table-wrap"><table><tbody>
            <tr><td><span className="pill LONG">LONG</span></td><td className="r num">{fmt(s.long.n, 0)} trades</td><td className="r num">{s.long.n ? Math.round((s.long.wins / s.long.n) * 100) : 0}% win</td><td className={`r num ${cls(s.long.net)}`}>{money(s.long.net)}</td></tr>
            <tr><td><span className="pill SHORT">SHORT</span></td><td className="r num">{fmt(s.short.n, 0)} trades</td><td className="r num">{s.short.n ? Math.round((s.short.wins / s.short.n) * 100) : 0}% win</td><td className={`r num ${cls(s.short.net)}`}>{money(s.short.net)}</td></tr>
          </tbody></table></div>
        </section>
      </div>}

      {det && <section className="card">
        <div className="card-head"><h2>🧾 Saare trades <span className="sub">— {fmt(filtered.length, 0)} of {fmt(T.length, 0)} · newest first</span></h2>
          <button className="btn sm" onClick={csv}>⬇ CSV</button></div>
        <div className="actions" style={{ gap: 8, marginBottom: 10 }}>
          <Select size="sm" width={170} value={fSym} onChange={setFSym} ariaLabel="Instrument" options={[{ value: "ALL", label: "All instruments" }, ...det.symbols.map(x => ({ value: x, label: x }))]} />
          <div className="tabs">{[["ALL", "All"], ["WIN", "Profit"], ["LOSS", "Loss"]].map(([k, l]) => <button key={k} className={fRes === k ? "on" : ""} onClick={() => setFRes(k!)}>{l}</button>)}</div>
          <div className="tabs">{[["ALL", "Both"], ["LONG", "Long"], ["SHORT", "Short"]].map(([k, l]) => <button key={k} className={fSide === k ? "on" : ""} onClick={() => setFSide(k!)}>{l}</button>)}</div>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Instrument</th><th>Side</th><th>Entry</th><th>Exit</th><th className="r">Entry ₹</th><th className="r">Exit ₹</th><th className="r">Qty</th><th className="r">Gross</th><th className="r">Charges</th><th className="r">Net P&L</th><th>Exit reason</th><th></th></tr></thead>
          <tbody>{filtered.slice(pg * PAGE, pg * PAGE + PAGE).map((t, k) => <tr key={k}>
            <td className="num dim">{filtered.length - (pg * PAGE + k)}</td><td><b>{det.symbols[t[0]]}</b></td><td><span className={`pill ${t[1] === 1 ? "LONG" : "SHORT"}`}>{t[1] === 1 ? "LONG" : "SHORT"}</span></td>
            <td className="num" style={{ whiteSpace: "nowrap" }}>{istDateTime(t[2])}</td><td className="num" style={{ whiteSpace: "nowrap" }}>{istDateTime(t[3])}</td>
            <td className="r num">{fmt(t[4])}</td><td className="r num">{fmt(t[5])}</td><td className="r num">{fmt(t[6], 0)}</td>
            <td className={`r num ${cls(t[7])}`}>{fmt(t[7])}</td><td className="r num muted">{fmt(t[8])}</td><td className={`r num ${cls(t[9])}`}><b>{fmt(t[9])}</b></td>
            <td style={{ fontSize: 12 }}>{REASON[t[10]] ?? t[10]}</td><td>{t[11] ? <span className="pill WATCH" title="Out-of-sample period">OOS</span> : null}</td></tr>)}</tbody>
        </table></div>
        {pages > 1 && <div className="actions" style={{ justifyContent: "center", marginTop: 10, gap: 8 }}>
          <button className="btn sm" disabled={pg === 0} onClick={() => setPg(pg - 1)}>← Prev</button>
          <span className="muted num" style={{ fontSize: 12 }}>Page {pg + 1} / {pages}</span>
          <button className="btn sm" disabled={pg >= pages - 1} onClick={() => setPg(pg + 1)}>Next →</button></div>}
      </section>}
    </div>
  </div>;
}
