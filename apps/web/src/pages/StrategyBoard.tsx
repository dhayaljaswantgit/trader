import { useMemo, useState } from "react";
import { api, usePoll, fmt, inr, istDateTime, Select, useCrypto, getVenue } from "../lib.tsx";
import { StrategyDetail } from "./StrategyDetail.tsx";

type Opt = { id: string; name: string; description: string; family: string; needsVolume: boolean; intradayOnly: boolean; custom?: boolean; liveSupported?: boolean };
type Row = {
  id: string; name: string; family: string; trades: number; winRate: number | null; profitFactor: number | null; grossProfitFactor: number | null; netPnl: number; capital?: number; charges?: number; grossPnl?: number; returnPct: number;
  avgTradePct: number | null; maxDrawdownPct: number; profitableInstruments: number; testedInstruments: number; robust: boolean;
  inSample: { trades: number; returnPct: number; profitFactor: number | null }; outOfSample: { trades: number; returnPct: number; profitFactor: number | null; winRate: number | null };
  perInstrument?: Record<string, { trades: number; wins: number; gross: number; charges: number; net: number; profitFactor: number | null; grossProfitFactor: number | null;
    maxDrawdownPct: number; isNet: number; oosNet: number; oosTrades: number; oosProfitFactor: number | null; oosWins: number }>;
};
type Inst = { key: string; symbol: string; name: string; instrumentType: string };
/** One instrument's numbers, shaped like a combined row. */
function forInstrument(r: Row, sym: string, cap: number): Row | null {
  const p = r.perInstrument?.[sym]; if (!p || !p.trades) return null;
  return { ...r, trades: p.trades, winRate: p.wins / p.trades, profitFactor: p.profitFactor, grossProfitFactor: p.grossProfitFactor, netPnl: p.net, capital: cap, charges: p.charges, grossPnl: p.gross,
    returnPct: (p.net / cap) * 100, maxDrawdownPct: p.maxDrawdownPct, profitableInstruments: p.net > 0 ? 1 : 0, testedInstruments: 1,
    inSample: { trades: p.trades - p.oosTrades, returnPct: (p.isNet / cap) * 100, profitFactor: null },
    outOfSample: { trades: p.oosTrades, returnPct: (p.oosNet / cap) * 100, profitFactor: p.oosProfitFactor, winRate: p.oosTrades ? p.oosWins / p.oosTrades : null },
    robust: p.trades >= 30 && p.oosTrades >= 8 && (p.profitFactor ?? 0) >= 1.1 && p.isNet > 0 && p.oosNet > 0 };
}
type Lb = { status: { running: boolean; phase: string; done: number; total: number; error: string | null }; run: null | { id: string; createdAt: string; dataSource: string; rows: Row[]; config: { interval: string; capitalPerInstrument?: number; years: number; from: number; to: number; instruments: string[]; slippageBps: number; riskPerTradePct: number } } };

type SortKey = "netPnl" | "capital" | "charges" | "grossPnl" | "returnPct" | "winRate" | "profitFactor" | "grossProfitFactor" | "oos" | "oosPf" | "trades" | "maxDrawdownPct" | "name";
const COLS: Array<{ k: SortKey; label: string; title: string }> = [
  { k: "winRate", label: "Win %", title: "Share of trades that made money (after charges)" },
  { k: "profitFactor", label: "Profit factor", title: "Gross profit ÷ gross loss. Above 1 = made money; 1.3+ is good" },
  { k: "grossProfitFactor", label: "PF before charges", title: "Profit factor before brokerage/STT/exchange charges (slippage included). Above 1 here but below 1 after = costs eat the edge" },
  { k: "capital", label: "Capital used", title: "₹1,00,000 per instrument × instruments where the strategy traded" },
  { k: "grossPnl", label: "Gross P&L ₹", title: "Profit/loss before charges (slippage included)" },
  { k: "charges", label: "Charges ₹", title: "Brokerage + STT + exchange + GST + stamp duty paid across all trades" },
  { k: "netPnl", label: "Net P&L ₹", title: "Shudh profit/loss = Gross − Charges, across all instruments" },
  { k: "returnPct", label: "Return", title: "Net return on capital over the whole period, averaged per instrument" },
  { k: "oos", label: "Out-of-sample", title: "Return on the last 30% of the period only — data never used to judge the strategy" },
  { k: "oosPf", label: "OOS PF", title: "Profit factor on the out-of-sample part" },
  { k: "trades", label: "Trades", title: "Total trades across all instruments" },
  { k: "maxDrawdownPct", label: "Max DD", title: "Worst peak-to-trough equity fall on any single instrument" },
];
const pctTxt = (v: number | null | undefined, dp = 1) => v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
const sign = (v: number | null | undefined) => v === null || v === undefined ? "" : v > 0 ? "up" : v < 0 ? "down" : "";

/** readOnly: results only (Backtest Lab) — no selection checkboxes. */
export function StrategyBoard({ options, value, onChange, readOnly, instruments = [] }: { options: Opt[]; value: string[]; onChange: (v: string[]) => void; readOnly?: boolean; instruments?: Inst[] }) {
  const [inst, setInst] = useState("ALL"); const [target, setTarget] = useState("BASKET"); const crypto = useCrypto();
  const { data, reload } = usePoll<Lb>("/api/leaderboard", 2500);
  const [q, setQ] = useState(""); const [fam, setFam] = useState("ALL"); const [only, setOnly] = useState<"" | "robust" | "selected">("");
  const [iv, setIv] = useState<"5" | "15" | "D">("5"); const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "returnPct", desc: true }); const [err, setErr] = useState("");
  const runInsts = data?.run?.config.instruments ?? [];
  const instKey = runInsts.includes(inst) ? inst : "ALL";
  const rows = useMemo(() => { const cap = data?.run?.config.capitalPerInstrument ?? 100000; const m = new Map<string, Row>();
    for (const r of data?.run?.rows ?? []) { const v = instKey === "ALL" ? r : forInstrument(r, instKey, cap); if (v) m.set(r.id, v); }
    return m; }, [data?.run, instKey]);
  const st = data?.status, run = data?.run;
  const families = useMemo(() => [...new Set(options.map(o => o.family))], [options]);

  const val = (o: Opt, k: SortKey): number | string => {
    const r = rows.get(o.id); if (k === "name") return o.name; if (!r) return -Infinity;
    return k === "oos" ? r.outOfSample.returnPct : k === "oosPf" ? r.outOfSample.profitFactor ?? -Infinity : (r[k] as number | null) ?? -Infinity;
  };
  const list = options
    .filter(o => fam === "ALL" || o.family === fam)
    .filter(o => !q || (o.name + " " + o.family + " " + o.description).toLowerCase().includes(q.toLowerCase()))
    .filter(o => only === "" || (only === "robust" ? rows.get(o.id)?.robust : value.includes(o.id)))
    .sort((a, b) => { const x = val(a, sort.k), y = val(b, sort.k); const c = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number); return sort.desc ? -c : c; });

  const toggle = (id: string) => readOnly || options.find(o => o.id === id)?.liveSupported === false ? undefined : onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  const robustIds = [...rows.values()].filter(r => r.robust).sort((a, b) => b.outOfSample.returnPct - a.outOfSample.returnPct).map(r => r.id);
  const runAll = async () => { setErr(""); try { await api("/api/leaderboard/run", { json: { years: 1, interval: iv === "D" ? "D" : Number(iv), ...(target !== "BASKET" ? { keys: [target] } : {}) } }); reload(); } catch (e) { setErr((e as Error).message); } };
  const th = (k: SortKey, label: string, title: string, right = true) =>
    <th className={right ? "r" : ""} title={title} style={{ cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => setSort(s => ({ k, desc: s.k === k ? !s.desc : k !== "name" && k !== "maxDrawdownPct" }))}>
      {label}{sort.k === k ? (sort.desc ? " ↓" : " ↑") : ""}</th>;

  return <>
    <div className="card-head" style={{ marginBottom: 10 }}>
      <h2>{readOnly ? "📊 All strategies backtest" : "Strategies"} <span className="sub">— {options.length} strategies{readOnly ? " · selection Trade Setup page par" : ` · ${value.length} selected · default OFF`}</span></h2>
      {st?.running
        ? <div style={{ minWidth: 260 }}><div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{st.phase} · {st.done}/{st.total}</div>
            <div className="bar"><i style={{ width: `${st.total ? (st.done / st.total) * 100 : 3}%`, background: "var(--accent)" }} /></div></div>
        : <div className="actions" style={{ gap: 8 }}>
            <div className="tabs" title="Candle size for the backtest">{(["5", "15", "D"] as const).map(x => <button key={x} className={iv === x ? "on" : ""} onClick={() => setIv(x)}>{x === "D" ? "Daily (10y)" : `${x}-min`}</button>)}</div>
            <Select size="sm" width={200} value={target} onChange={setTarget} ariaLabel="Test on" search
              options={[getVenue() === "DELTA" ? { value: "BASKET", label: "Crypto basket · 4", sub: "BTC, ETH, SOL, XRP perpetuals", group: "Default" } : { value: "BASKET", label: "Basket · 12 instruments", sub: "NIFTY, BANKNIFTY + 10 large-caps", group: "Default" },
                ...instruments.map(i => ({ value: i.key, label: i.symbol, sub: i.name, group: i.instrumentType === "INDEX" ? "Indices" : "Stocks" })),
                ...crypto.map(i => ({ value: i.key, label: i.symbol, sub: i.name, group: "₿ Crypto · Delta Exchange" }))]} />
            <button className="btn primary" onClick={runAll}>▶ {run ? "Re-run" : "Run"} backtest on all strategies</button></div>}
    </div>

    {run ? <div className="note" style={{ marginBottom: 12 }}>
      <b>Last backtest:</b> {istDateTime(run.createdAt)} · <b>{run.dataSource}</b> data · <b>{run.config.interval}</b> candles · {istDateTime(run.config.from)} → {istDateTime(run.config.to)} ·
      {" "}{run.config.instruments.length} instruments ({run.config.instruments.join(", ")}) · risk {run.config.riskPerTradePct}%/trade · slippage {run.config.slippageBps} bps + charges.
      <br /><span className="muted">{getVenue() === "DELTA" ? <>₿ Crypto: Delta perpetual futures, USD → ₹ at fixed rate, fees 0.05% + GST, funding not modelled.</> : <>P&L is on the <b>underlying</b> (stock/index price), not option premium.</>} <b>Robust ✓</b> = ≥50 trades, profit factor ≥ 1.1, and profitable in <b>both</b> the first 70% and the unseen last 30%.
      Past results do not guarantee future profit — paper-trade before trusting any strategy.</span>
    </div> : !st?.running && <div className="note warn" style={{ marginBottom: 12 }}>Abhi tak koi backtest nahi chala. "Run backtest" dabayein — saari strategies 1 saal ke 5-min data par test hongi (kuch minute lagenge).</div>}
    {st?.error && <p className="err">Backtest failed: {st.error}</p>}
    {err && <p className="err">{err}</p>}

    <div className="actions" style={{ gap: 8, marginBottom: 10, alignItems: "center" }}>
      <input className="input" style={{ width: 220, padding: "6px 10px" }} placeholder="Search strategy…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search strategies" />
      {runInsts.length > 1 && <Select size="sm" width={200} value={instKey} onChange={setInst} ariaLabel="Instrument filter"
        options={[{ value: "ALL", label: "All instruments (combined)" }, ...runInsts.map(s => ({ value: s, label: s, sub: "sirf is instrument ka result" }))]} />}
      <Select size="sm" width={210} value={fam} onChange={setFam} ariaLabel="Family" options={[{ value: "ALL", label: "All families" }, ...families.map(f => ({ value: f, label: f, sub: `${options.filter(o => o.family === f).length} strategies` }))]} />
      <div className="tabs">{(readOnly ? [["", "All"], ["robust", "Robust only"]] as const : [["", "All"], ["robust", "Robust only"], ["selected", "Selected"]] as const).map(([k, l]) => <button key={k} className={only === k ? "on" : ""} onClick={() => setOnly(k)}>{l}</button>)}</div>
      <span style={{ flex: 1 }} />
      {!readOnly && robustIds.length > 0 && <button className="btn sm" onClick={() => onChange(robustIds.slice(0, 5))} title="Select the 5 robust strategies with the best out-of-sample return">★ Top 5 robust select karo</button>}
      {!readOnly && value.length > 0 && <button className="btn sm" onClick={() => onChange([])}>Clear</button>}
    </div>

    <div className="table-wrap" style={{ maxHeight: 560, overflowY: "auto" }}>
      <table>
        <thead style={{ position: "sticky", top: 0, background: "var(--card)", zIndex: 1 }}><tr>
          {!readOnly && <th style={{ width: 28 }}></th>}{th("name", "Strategy", "Sort by name", false)}
          {COLS.map(c => th(c.k, c.label, c.title))}<th className="r" title="Instruments where the strategy made money">Profitable on</th><th></th><th></th>
        </tr></thead>
        <tbody>{list.map(o => { const r = rows.get(o.id), on = value.includes(o.id);
          return <tr key={o.id} className={readOnly ? (r ? "click" : "") : `click ${on ? "sel" : ""}`} onClick={() => readOnly ? (r && run && setOpen(o.id)) : toggle(o.id)}>
            {!readOnly && <td>{o.liveSupported === false ? <span className="chk" style={{ opacity: .35, cursor: "not-allowed" }} title="Live auto-trading ke liye abhi supported nahi — sirf backtest">–</span> : <span className={`chk ${on ? "on" : ""}`}>{on ? "✓" : ""}</span>}</td>}
            <td className="sym" title={o.description}><b>{o.name}</b>{o.custom && <span className="pill WATCH" style={{ marginLeft: 6 }}>CUSTOM{(o as { timeframe?: string }).timeframe ? ` · live ${(o as { timeframe?: string }).timeframe}m` : ""}</span>}{!readOnly && o.liveSupported === false && <small className="warn">sirf backtest — live auto-trading abhi supported nahi</small>}<small>{o.family}{o.needsVolume ? " · needs volume" : ""}</small>{r && run && <small className="num" style={{ color: "var(--info)" }}>{run.dataSource} · {run.config.interval} · {istDateTime(run.config.from).replace(/,? (at )?\d{1,2}:\d{2}.*$/, "")} → {istDateTime(run.config.to).replace(/,? (at )?\d{1,2}:\d{2}.*$/, "")} · {instKey === "ALL" ? `${r.testedInstruments} instruments` : instKey}</small>}<small className="dim" style={{ whiteSpace: "normal", maxWidth: 420 }}>{o.description}</small></td>
            <td className="r num">{r?.winRate != null ? (r.winRate * 100).toFixed(1) + "%" : "—"}</td>
            <td className={`r num ${r?.profitFactor != null ? (r.profitFactor >= 1 ? "up" : "down") : ""}`}>{r?.profitFactor != null ? r.profitFactor.toFixed(2) : "—"}</td>
            <td className={`r num ${r?.grossProfitFactor != null ? (r.grossProfitFactor >= 1 ? "up" : "down") : ""}`}>{r?.grossProfitFactor != null ? r.grossProfitFactor.toFixed(2) : "—"}</td>
            <td className="r num">{r?.capital != null ? inr(r.capital, 0) : "—"}</td>
            <td className={`r num ${sign(r?.grossPnl)}`}>{r?.grossPnl != null ? (r.grossPnl >= 0 ? "+" : "−") + inr(Math.abs(r.grossPnl), 0) : "—"}</td>
            <td className="r num muted">{r?.charges != null ? "−" + inr(r.charges, 0) : "—"}</td>
            <td className={`r num ${sign(r?.netPnl)}`}><b>{r ? (r.netPnl >= 0 ? "+" : "−") + inr(Math.abs(r.netPnl), 0) : "—"}</b></td>
            <td className={`r num ${sign(r?.returnPct)}`}><b>{r ? pctTxt(r.returnPct) : "—"}</b></td>
            <td className={`r num ${sign(r?.outOfSample.returnPct)}`}>{r ? pctTxt(r.outOfSample.returnPct) : "—"}</td>
            <td className="r num">{r?.outOfSample.profitFactor != null ? r.outOfSample.profitFactor.toFixed(2) : "—"}</td>
            <td className="r num">{r ? fmt(r.trades, 0) : "—"}</td>
            <td className="r num">{r ? `${r.maxDrawdownPct.toFixed(1)}%` : "—"}</td>
            <td className="r num">{r ? `${r.profitableInstruments}/${r.testedInstruments}` : "—"}</td>
            <td>{r && run && <button className="btn sm" style={{ whiteSpace: "nowrap" }} onClick={e => { e.stopPropagation(); setOpen(o.id); }}>Details →</button>}</td>
            <td>{r?.robust ? <span className="pill ENTER" title="Profitable in-sample and out-of-sample">Robust ✓</span> : r && r.trades < 50 ? <span className="pill NO_TRADE" title="Too few trades to judge">Few trades</span> : null}</td>
          </tr>; })}
          {!list.length && <tr><td colSpan={17}><div className="empty">Koi strategy match nahi hui{only !== "" && <> — <b>"{only === "selected" ? "Selected" : "Robust only"}"</b> filter laga hai.{" "}
            <button className="btn sm" onClick={() => setOnly("")}>Sab dikhao</button></>}</div></td></tr>}
        </tbody>
      </table>
    </div>
    {open && run && <StrategyDetail runId={run.id} strategyId={open} initialSymbol={instKey === "ALL" ? undefined : instKey} onClose={() => setOpen(null)} />}
  </>;
}
