import { useEffect, useState } from "react";
import { api, usePoll, MultiSelect, Switch } from "../lib.tsx";
import { StrategyBoard } from "./StrategyBoard.tsx";

type Inst = { key: string; symbol: string; name: string; instrumentType: string; fnoEligible: boolean; fnoLotSize: number | null };

export function Setup() {
  const { data: p, reload } = usePoll<any>("/api/preferences", 0);
  const [f, setF] = useState<any>(null); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [q, setQ] = useState(""); const [results, setResults] = useState<Inst[]>([]); const [selected, setSelected] = useState<Inst[]>([]);
  useEffect(() => { if (p) { setF({ ...p, defaultMaxProfit: p.defaultMaxProfit ?? "" }); setSelected(p.selected); } }, [p]);
  useEffect(() => { const t = setTimeout(async () => { try { setResults(await api(`/api/instruments?q=${encodeURIComponent(q)}`)); } catch { /* */ } }, 200); return () => clearTimeout(t); }, [q]);
  if (!f) return <div className="empty">Loading…</div>;
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const save = async () => {
    setErr(""); setMsg("");
    try {
      await api("/api/preferences", { method: "PUT", json: { styles: f.styles, segments: f.segments, strategies: f.strategies, autoPaper: f.autoPaper, autoStartDaily: f.autoStartDaily,
        instrumentKeys: selected.map(s => s.key), defaultCapital: f.defaultCapital, defaultMaxLoss: f.defaultMaxLoss, defaultMaxProfit: f.defaultMaxProfit === "" ? null : f.defaultMaxProfit, defaultRiskPct: f.defaultRiskPct, defaultMaxConsecutiveLosses: f.defaultMaxConsecutiveLosses } });
      setMsg("✓ Saved"); reload(); setTimeout(() => setMsg(""), 2500);
    } catch (e) { setErr((e as Error).message); }
  };
  const has = (k: string) => selected.some(s => s.key === k);
  const addMany = (list: Inst[]) => { const m = new Map(selected.map(x => [x.key, x])); for (const i of list) m.set(i.key, i); setSelected([...m.values()].slice(0, 80)); };
  const preset = async (which: "idx" | "n50") => {
    setErr(""); setMsg("");
    try {
      const pr = await api<{ fnoIndices: Inst[]; nifty50: Inst[]; missing: string[]; n50Error: string | null; note: string | null }>("/api/instruments/presets");
      if (which === "idx") { if (!pr.fnoIndices.length) throw new Error(pr.note ?? "No F&O indices found"); addMany(pr.fnoIndices); setMsg(`+ ${pr.fnoIndices.length} indices added — Save karna na bhoolein`); }
      else { if (pr.n50Error) throw new Error(pr.n50Error); addMany(pr.nifty50); setMsg(`+ ${pr.nifty50.length} NIFTY 50 stocks added${pr.missing.length ? ` (not found: ${pr.missing.join(", ")})` : ""} — Save karna na bhoolein`); }
    } catch (e) { setErr((e as Error).message); }
  };
  const nonFno = selected.filter(s => s.instrumentType === "EQUITY" && !s.fnoEligible);

  return <>
    <section className="card">
      <h2>Trading style <span className="sub">— ek ya zyada choose karein</span></h2>
      <MultiSelect value={f.styles} onChange={v => set("styles", v)} options={[
        { id: "INTRADAY", icon: "📈", label: "Intraday", sub: "5-min signals · 3:15 PM tak square-off" },
        { id: "SCALPING", icon: "⚡", label: "Scalper", sub: "1-min signals · chhote target, tight stop" },
        { id: "POSITIONAL", icon: "🌙", label: "Carry forward", sub: "15-min signals · position overnight reh sakti hai" }]} />
      <h2 style={{ marginTop: 20 }}>Kisme trade karna hai <span className="sub">— segments (priority: Options → Futures → Equity)</span></h2>
      <MultiSelect value={f.segments} onChange={v => set("segments", v)} options={[
        { id: "OPTIONS", icon: "🎯", label: "Options", sub: "Sirf BUY (CE/PE) · ATM · max loss = premium" },
        { id: "FUTURES", icon: "📊", label: "Futures", sub: "Nearest expiry · long/short with stop" },
        { id: "EQUITY", icon: "🏦", label: "Equity (cash)", sub: "Stock khud · intraday short allowed" }]} />
      {f.segments.includes("FUTURES") && <div className="note warn" style={{ marginTop: 12 }}>Futures mein lot size bada hota hai — risk per trade chhota ho to "1 lot bhi risk budget se bada" ki wajah se entry skip hogi. Ye safety hai, bug nahi.</div>}
      {f.styles.includes("POSITIONAL") && <div className="note warn" style={{ marginTop: 12 }}>Carry forward mein overnight gap risk hota hai — stop-loss gap par apne price par fill nahi hota.</div>}
    </section>

    <section className="card">
      <StrategyBoard instruments={p.selected} options={p.strategyOptions} value={f.strategies} onChange={v => set("strategies", v)} />
      <div className="grid g2" style={{ marginTop: 18 }}>
        <Switch on={f.autoPaper} onChange={v => set("autoPaper", v)} label="Auto paper trading" sub="ENTER signal par risk check ke baad paper trade apne aap lega" />
        <Switch on={f.autoStartDaily} onChange={v => set("autoStartDaily", v)} label="Har din auto-start" sub="09:15 IST par neeche ki default limits se din apne aap shuru" />
      </div>
    </section>

    <section className="card">
      <h2>Default daily limits <span className="sub">— Start Day form mein pre-fill + auto-start mein use</span></h2>
      <div className="form-grid">
        <label className="field"><span>Capital (₹)</span><input className="input num" type="number" value={f.defaultCapital} onChange={e => set("defaultCapital", e.target.value)} /></label>
        <label className="field"><span>Max loss / day (₹) *</span><input className="input num" type="number" value={f.defaultMaxLoss} onChange={e => set("defaultMaxLoss", e.target.value)} /></label>
        <label className="field"><span>Max profit / day (₹) — khali = Unlimited</span><input className="input num" type="number" placeholder="∞ Unlimited" value={f.defaultMaxProfit} onChange={e => set("defaultMaxProfit", e.target.value)} /></label>
        <label className="field"><span>Risk per trade (%)</span><input className="input num" type="number" step="0.05" value={f.defaultRiskPct} onChange={e => set("defaultRiskPct", e.target.value)} /></label>
        <label className="field"><span>Loss streak limit (lagatar losses)</span><input className="input num" type="number" step={1} min={1} max={50} value={f.defaultMaxConsecutiveLosses} onChange={e => set("defaultMaxConsecutiveLosses", e.target.value)} /></label>
      </div>
    </section>

    <section className="card">
      <div className="card-head"><h2>Stocks & indices <span className="sub">— {selected.length} selected (max 80)</span></h2>
        <button className="btn sm" onClick={() => preset("idx")}>+ Sabhi F&O indices</button>
        <button className="btn sm" onClick={() => preset("n50")}>+ NIFTY 50 stocks</button>
        <button className="btn sm" disabled={!selected.length} onClick={() => setSelected([])}>Clear all</button></div>
      {selected.length > 25 && f.styles.includes("SCALPING") && <div className="note warn" style={{ marginBottom: 12 }}>{selected.length} instruments + Scalper (1-min): har minute {selected.length} candle requests jayengi (Dhan rate limits). Signals thode der se aa sakte hain — scalping ke liye 10–15 liquid instruments behtar hain.</div>}
      <div className="seg" style={{ marginBottom: 14 }}>
        {selected.map(s => <button key={s.key} className="opt on" style={{ minWidth: 0, padding: "6px 10px" }} onClick={() => setSelected(selected.filter(x => x.key !== s.key))} title="Remove">
          <span><b style={{ fontSize: 13 }}>{s.symbol} ✕</b><small>{s.instrumentType === "INDEX" ? "Index" : s.fnoEligible ? "F&O" : "Cash only"}</small></span></button>)}
      </div>
      <input className="input" placeholder="🔍  Search NSE stock / index (e.g. TATAMOTORS, INFY, NIFTY)…" value={q} onChange={e => setQ(e.target.value)} />
      <div className="table-wrap" style={{ maxHeight: 300, overflowY: "auto", marginTop: 8 }}><table><tbody>
        {results.map(r => <tr key={r.key} className="click" onClick={() => !has(r.key) && setSelected([...selected, r])}>
          <td className="sym"><b>{r.symbol}</b><small>{r.name}</small></td><td>{r.instrumentType === "INDEX" ? <span className="pill NEUTRAL">INDEX</span> : r.fnoEligible ? <span className="pill UP">F&O · lot {r.fnoLotSize}</span> : <span className="pill NO_TRADE">CASH ONLY</span>}</td>
          <td className="r">{has(r.key) ? <span className="muted">✓ added</span> : <span className="btn sm">+ Add</span>}</td></tr>)}
      </tbody></table></div>
      {nonFno.length > 0 && (f.segments.includes("OPTIONS") || f.segments.includes("FUTURES")) && <div className="note warn" style={{ marginTop: 12 }}>{nonFno.map(n => n.symbol).join(", ")} F&O mein listed nahi — inke liye sirf Equity segment kaam karega.</div>}
    </section>

    <div className="actions" style={{ position: "sticky", bottom: 16, justifyContent: "flex-end", alignItems: "center" }}>
      {err && <span className="err" role="alert">{err}</span>}{msg && <span className="up">{msg}</span>}
      <button className="btn primary big" onClick={save}>💾 Save setup</button>
    </div>
  </>;
}
