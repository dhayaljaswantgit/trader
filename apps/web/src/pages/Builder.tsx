import { useEffect, useMemo, useState } from "react";
import { api, usePoll, inr, fmt, istDateTime, Select, ConfirmModal, useCrypto } from "../lib.tsx";
import { ResultPage, type R } from "./Backtest.tsx";

// ---- spec types (mirror of packages/quant/src/spec.ts) ----
type Field = "open" | "high" | "low" | "close";
type Operand = { k: "price" | "prevCandle" | "prevDay"; f: Field } | { k: "today"; f: "open" | "high" | "low" } | { k: "orHigh" | "orLow"; m: number }
  | { k: "ema" | "sma" | "rsi" | "atr" | "adx"; n: number } | { k: "vwap" } | { k: "supertrend"; n: number; m: number } | { k: "highest" | "lowest"; n: number } | { k: "value"; v: number };
type Op = ">" | "<" | ">=" | "<=" | "crossAbove" | "crossBelow";
type Cond = { t: "compare"; a: Operand; op: Op; b: Operand; offset?: number } | { t: "consecutive"; n: number; a: Operand; op: ">" | "<" | ">=" | "<="; b: Operand; offset?: number }
  | { t: "candle"; color: "green" | "red"; n: number } | { t: "prevDayColor"; color: "green" | "red" } | { t: "gap"; dir: "up" | "down"; minPoints?: number; minPct?: number } | { t: "time"; from: string; to: string };
type Side = { enabled: boolean; entry: Cond[]; exit: Cond[] };
export type Spec = {
  name: string; description?: string; version?: number; timeframe?: "1" | "5" | "15" | "D"; instruments?: string[]; entryMode: "barClose" | "dayOpen"; long: Side; short: Side;
  stop: { type: "none" | "points" | "pct" | "atr" | "pivot"; value: number }; target: { type: "none" | "points" | "pct" | "rr"; value: number };
  trailing: { type: "none" | "step" | "trail" | "pivot"; every: number; by: number; k?: number }; session: { squareOff: string; noEntryAfter: string; maxTradesPerDay: number; dayProfitLock?: number; dayLossLimit?: number; windows?: Array<{ from: string; to: string }>; exitAtWindowEnd?: boolean };
  sizing: { qty: number; delta: number; mode?: "fixed" | "capital" | "risk"; lots?: number; capitalPerLot?: number; riskPct?: number }; costs: { perTrade: number; slippagePoints: number; perExtraLot?: number };
};
type Row = { id: string; name: string; spec: Spec; updatedAt: string };

// ---- operand catalogue ----
const OPERANDS: Array<{ v: string; label: string; group: string; make: () => Operand }> = [
  ...(["close", "open", "high", "low"] as Field[]).map(f => ({ v: `price.${f}`, label: `Candle ${f}`, group: "Current candle", make: () => ({ k: "price", f }) as Operand })),
  ...(["close", "open", "high", "low"] as Field[]).map(f => ({ v: `prevCandle.${f}`, label: `Previous candle ${f}`, group: "Previous candle", make: () => ({ k: "prevCandle", f }) as Operand })),
  ...(["close", "open", "high", "low"] as Field[]).map(f => ({ v: `prevDay.${f}`, label: `Yesterday ${f}`, group: "Previous day", make: () => ({ k: "prevDay", f }) as Operand })),
  ...(["open", "high", "low"] as const).map(f => ({ v: `today.${f}`, label: f === "open" ? "Today open (09:15)" : `Today ${f} so far`, group: "Today", make: () => ({ k: "today", f }) as Operand })),
  { v: "orHigh", label: "Opening range high", group: "Today", make: () => ({ k: "orHigh", m: 15 }) }, { v: "orLow", label: "Opening range low", group: "Today", make: () => ({ k: "orLow", m: 15 }) },
  { v: "ema", label: "EMA", group: "Indicators", make: () => ({ k: "ema", n: 20 }) }, { v: "sma", label: "SMA", group: "Indicators", make: () => ({ k: "sma", n: 20 }) },
  { v: "vwap", label: "VWAP (needs volume)", group: "Indicators", make: () => ({ k: "vwap" }) }, { v: "supertrend", label: "Supertrend line", group: "Indicators", make: () => ({ k: "supertrend", n: 10, m: 3 }) },
  { v: "rsi", label: "RSI", group: "Indicators", make: () => ({ k: "rsi", n: 14 }) }, { v: "adx", label: "ADX", group: "Indicators", make: () => ({ k: "adx", n: 14 }) },
  { v: "atr", label: "ATR", group: "Indicators", make: () => ({ k: "atr", n: 14 }) },
  { v: "highest", label: "Highest high (last N candles)", group: "Channels", make: () => ({ k: "highest", n: 20 }) }, { v: "lowest", label: "Lowest low (last N candles)", group: "Channels", make: () => ({ k: "lowest", n: 20 }) }, { v: "value", label: "Fixed number", group: "Number", make: () => ({ k: "value", v: 0 }) },
];
const opKey = (o: Operand) => "f" in o ? `${o.k}.${o.f}` : o.k;
const opText = (o: Operand): string => {
  switch (o.k) {
    case "price": return `candle ${o.f}`; case "prevCandle": return `previous candle ${o.f}`; case "prevDay": return `yesterday's ${o.f}`;
    case "today": return o.f === "open" ? "today's open" : `today's ${o.f}`; case "orHigh": return `${o.m}-min opening-range high`; case "orLow": return `${o.m}-min opening-range low`;
    case "highest": return `${o.n}-candle highest high`; case "lowest": return `${o.n}-candle lowest low`;
    case "vwap": return "VWAP"; case "supertrend": return `Supertrend(${o.n},${o.m})`; case "value": return String(o.v); default: return `${o.k.toUpperCase()}(${o.n})`;
  }
};
const OPS: Array<{ v: Op; label: string }> = [{ v: ">", label: "above (>)" }, { v: "<", label: "below (<)" }, { v: ">=", label: "≥" }, { v: "<=", label: "≤" }, { v: "crossAbove", label: "crosses above" }, { v: "crossBelow", label: "crosses below" }];
const opWord = (op: string) => ({ ">": "is above", "<": "is below", ">=": "is ≥", "<=": "is ≤", crossAbove: "crosses above", crossBelow: "crosses below" } as Record<string, string>)[op] ?? op;
const off = (o?: number) => o ? ` ${o > 0 ? "+" : "−"} ${Math.abs(o)} pts` : "";
export function condText(c: Cond): string {
  switch (c.t) {
    case "compare": return `${opText(c.a)} ${opWord(c.op)} ${opText(c.b)}${off(c.offset)}`;
    case "consecutive": return `${c.n} candle(s) in a row: ${opText(c.a)} ${opWord(c.op)} ${opText(c.b)}${off(c.offset)}`;
    case "candle": return `${c.n} ${c.color} candle(s) in a row`;
    case "prevDayColor": return `yesterday was a ${c.color} day`;
    case "gap": return `gap ${c.dir} at open${c.minPoints ? ` ≥ ${c.minPoints} pts` : ""}${c.minPct ? ` ≥ ${c.minPct}%` : ""}`;
    case "time": return `time between ${c.from} and ${c.to}`;
  }
}
const COND_TYPES: Array<{ v: Cond["t"]; label: string; sub: string; make: () => Cond }> = [
  { v: "compare", label: "Compare (A vs B)", sub: "price / level / indicator above, below, crosses", make: () => ({ t: "compare", a: { k: "price", f: "close" }, op: ">", b: { k: "prevDay", f: "close" } }) },
  { v: "consecutive", label: "N candles in a row closing vs level", sub: "e.g. 2 closes below yesterday's close", make: () => ({ t: "consecutive", n: 2, a: { k: "price", f: "close" }, op: "<", b: { k: "prevDay", f: "close" } }) },
  { v: "candle", label: "N green / red candles in a row", sub: "candle colour", make: () => ({ t: "candle", color: "green", n: 2 }) },
  { v: "prevDayColor", label: "Yesterday green / red", sub: "previous day's candle", make: () => ({ t: "prevDayColor", color: "green" }) },
  { v: "gap", label: "Gap up / down at open", sub: "today's open vs yesterday's close", make: () => ({ t: "gap", dir: "up", minPoints: 0 }) },
  { v: "time", label: "Time window", sub: "candle close time (IST)", make: () => ({ t: "time", from: "09:30", to: "14:30" }) },
];
/** Mirror a CALL-side condition into the PUT side. */
const flipOp = (op: string) => ({ ">": "<", "<": ">", ">=": "<=", "<=": ">=", crossAbove: "crossBelow", crossBelow: "crossAbove" } as Record<string, string>)[op] ?? op;
const flipOperand = (o: Operand): Operand => o.k === "highest" ? { k: "lowest", n: o.n } : o.k === "lowest" ? { k: "highest", n: o.n } : o.k === "today" && o.f !== "open" ? { k: "today", f: o.f === "high" ? "low" : "high" } : o.k === "orHigh" ? { k: "orLow", m: o.m } : o.k === "orLow" ? { k: "orHigh", m: o.m }
  : "f" in o && (o.f === "high" || o.f === "low") ? { ...o, f: o.f === "high" ? "low" : "high" } as Operand : o;
function mirror(c: Cond): Cond {
  switch (c.t) {
    case "compare": return { ...c, a: flipOperand(c.a), b: flipOperand(c.b), op: flipOp(c.op) as Op, offset: c.offset ? -c.offset : undefined };
    case "consecutive": return { ...c, a: flipOperand(c.a), b: flipOperand(c.b), op: flipOp(c.op) as ">", offset: c.offset ? -c.offset : undefined };
    case "candle": case "prevDayColor": return { ...c, color: c.color === "green" ? "red" : "green" };
    case "gap": return { ...c, dir: c.dir === "up" ? "down" : "up" };
    default: return c;
  }
}
const BLANK: Spec = { name: "New strategy", description: "", entryMode: "barClose",
  long: { enabled: true, entry: [], exit: [] }, short: { enabled: false, entry: [], exit: [] },
  stop: { type: "points", value: 20 }, target: { type: "none", value: 0 }, trailing: { type: "none", every: 5, by: 1 },
  session: { squareOff: "15:15", noEntryAfter: "14:45", maxTradesPerDay: 1 }, sizing: { qty: 75, delta: 0.5 }, costs: { perTrade: 60, slippagePoints: 0.5 } };

// ---- small inputs ----
const Num = ({ v, on, w = 70, step = 1 }: { v: number | undefined; on: (n: number) => void; w?: number; step?: number }) =>
  <input className="input num" style={{ width: w, padding: "5px 8px" }} type="number" step={step} value={v ?? 0} onChange={e => on(Number(e.target.value))} />;
function OperandPick({ o, on }: { o: Operand; on: (o: Operand) => void }) {
  return <span className="opnd">
    <Select size="sm" width={180} search value={opKey(o)} onChange={v => on(OPERANDS.find(x => x.v === v)!.make())} ariaLabel="Operand"
      options={OPERANDS.map(x => ({ value: x.v, label: x.label, group: x.group }))} />
    {"n" in o && <><span className="muted">period</span><Num v={o.n} on={n => on({ ...o, n } as Operand)} w={60} /></>}
    {"m" in o && o.k === "supertrend" && <><span className="muted">mult</span><Num v={o.m} on={m => on({ ...o, m } as Operand)} w={56} step={0.5} /></>}
    {"m" in o && o.k !== "supertrend" && <><span className="muted">min</span><Num v={o.m} on={m => on({ ...o, m } as Operand)} w={60} /></>}
    {o.k === "value" && <Num v={o.v} on={v => on({ k: "value", v })} w={90} step={0.5} />}
  </span>;
}
function CondEdit({ c, on, del }: { c: Cond; on: (c: Cond) => void; del: () => void }) {
  return <div className="cond">
    <div className="cond-row">
      <Select size="sm" width={230} value={c.t} onChange={t => on(COND_TYPES.find(x => x.v === t)!.make())} ariaLabel="Condition type" options={COND_TYPES.map(x => ({ value: x.v, label: x.label, sub: x.sub }))} />
      {c.t === "compare" && <><OperandPick o={c.a} on={a => on({ ...c, a })} /><Select size="sm" width={140} value={c.op} onChange={op => on({ ...c, op: op as Op })} ariaLabel="Operator" options={OPS.map(o => ({ value: o.v, label: o.label }))} />
        <OperandPick o={c.b} on={b => on({ ...c, b })} /><span className="muted">±pts</span><Num v={c.offset} on={offset => on({ ...c, offset: offset || undefined })} w={64} step={0.5} /></>}
      {c.t === "consecutive" && <><Num v={c.n} on={n => on({ ...c, n: Math.max(1, n) })} w={56} /><span className="muted">candles:</span><OperandPick o={c.a} on={a => on({ ...c, a })} />
        <Select size="sm" width={110} value={c.op} onChange={op => on({ ...c, op: op as ">" })} ariaLabel="Operator" options={OPS.slice(0, 4).map(o => ({ value: o.v, label: o.label }))} />
        <OperandPick o={c.b} on={b => on({ ...c, b })} /><span className="muted">±pts</span><Num v={c.offset} on={offset => on({ ...c, offset: offset || undefined })} w={64} step={0.5} /></>}
      {c.t === "candle" && <><Num v={c.n} on={n => on({ ...c, n: Math.max(1, n) })} w={56} /><div className="tabs">{(["green", "red"] as const).map(x => <button key={x} className={c.color === x ? "on" : ""} onClick={() => on({ ...c, color: x })}>{x === "green" ? "🟩 green" : "🟥 red"}</button>)}</div></>}
      {c.t === "prevDayColor" && <div className="tabs">{(["green", "red"] as const).map(x => <button key={x} className={c.color === x ? "on" : ""} onClick={() => on({ ...c, color: x })}>{x === "green" ? "🟩 green day" : "🟥 red day"}</button>)}</div>}
      {c.t === "gap" && <><div className="tabs">{(["up", "down"] as const).map(x => <button key={x} className={c.dir === x ? "on" : ""} onClick={() => on({ ...c, dir: x })}>{x === "up" ? "▲ gap up" : "▼ gap down"}</button>)}</div>
        <span className="muted">min pts</span><Num v={c.minPoints} on={minPoints => on({ ...c, minPoints })} w={64} /><span className="muted">min %</span><Num v={c.minPct} on={minPct => on({ ...c, minPct })} w={64} step={0.1} /></>}
      {c.t === "time" && <><input className="input num" style={{ width: 90, padding: "5px 8px" }} type="time" value={c.from} onChange={e => on({ ...c, from: e.target.value })} /><span className="muted">to</span>
        <input className="input num" style={{ width: 90, padding: "5px 8px" }} type="time" value={c.to} onChange={e => on({ ...c, to: e.target.value })} /></>}
      <span style={{ flex: 1 }} /><button className="btn sm" onClick={del} aria-label="Remove condition">✕</button>
    </div>
    <div className="cond-text">→ {condText(c)}</div>
  </div>;
}
function CondList({ title, sub, list, on, addLabel }: { title: string; sub: string; list: Cond[]; on: (l: Cond[]) => void; addLabel: string }) {
  return <div className="cond-list">
    <div className="h3" style={{ marginTop: 6 }}>{title} <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>— {sub}</span></div>
    {list.map((c, k) => <CondEdit key={k} c={c} on={nc => on(list.map((x, j) => j === k ? nc : x))} del={() => on(list.filter((_, j) => j !== k))} />)}
    {!list.length && <div className="muted" style={{ fontSize: 13, padding: "4px 0" }}>Koi condition nahi</div>}
    <button className="btn sm" onClick={() => on([...list, COND_TYPES[0]!.make()])}>+ {addLabel}</button>
  </div>;
}

// ---- multi-timeframe test summary ----
type Multi = { tf: string; r?: R; err?: string };
const TFS = [{ v: "1", label: "1-min", years: 1 }, { v: "5", label: "5-min", years: 2 }, { v: "15", label: "15-min", years: 2 }, { v: "D", label: "Daily", years: 10 }];

export function Builder() {
  const { data: rows, reload } = usePoll<Row[]>("/api/builder/strategies", 0);
  const { data: prefs } = usePoll<any>("/api/preferences", 0); const cryptoList = useCrypto();
  const [selId, setSelId] = useState<string | null>(null); const [spec, setSpec] = useState<Spec | null>(null); const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState<string[]>([]); const [busy, setBusy] = useState(""); const [del, setDel] = useState<Row | null>(null);
  const [t, setT] = useState({ key: "IDX_I:13", interval: "5", years: "2", capital: "100000" });
  const [result, setResult] = useState<R | null>(null); const [multi, setMulti] = useState<Multi[] | null>(null);

  useEffect(() => { if (rows?.length && !selId) { setSelId(rows[0]!.id); setSpec(structuredClone(rows[0]!.spec)); } }, [rows, selId]);
  const instruments = useMemo(() => {
    const list = [...(prefs?.selected ?? [])] as Array<{ key: string; symbol: string; name: string; instrumentType: string }>;
    if (!list.some(i => i.key === "IDX_I:13")) list.unshift({ key: "IDX_I:13", symbol: "NIFTY", name: "Nifty 50", instrumentType: "INDEX" });
    return [...list, ...cryptoList];
  }, [prefs, cryptoList]);
  const edit = (p: Partial<Spec>) => { setSpec(s => s ? { ...s, ...p } : s); setDirty(true); };
  const pick = (r: Row) => { if (dirty && !window.confirm("Unsaved changes chhod dein?")) return; setSelId(r.id); setSpec(structuredClone(r.spec)); setDirty(false); setErr([]); setMsg(""); setMulti(null); };
  const save = async (asNew = false): Promise<string | null> => {
    if (!spec) return null; setErr([]); setMsg("");
    try {
      const row = await api<Row>(asNew || !selId ? "/api/builder/strategies" : `/api/builder/strategies/${selId}`, { method: asNew || !selId ? "POST" : "PUT", json: { spec } });
      setSelId(row.id); setDirty(false); setMsg("✓ Saved"); reload(); setTimeout(() => setMsg(""), 2000); return row.id;
    } catch (e) { const m = (e as Error).message; setErr(m.split(/;|\n/).filter(Boolean)); return null; }
  };
  const newStrategy = async (from: "blank" | "preset") => {
    const s = from === "blank" ? structuredClone(BLANK) : { ...(await api<Spec>("/api/builder/preset")), name: "Jassu Market Trend (copy)" };
    setSelId(null); setSpec(s); setDirty(true); setMulti(null);
  };
  const runOne = async (interval: string, years: string): Promise<R> => {
    const id = dirty || !selId ? await save() : selId; if (!id) throw new Error("Save failed — errors upar dekhein");
    return api<R>("/api/builder/backtest", { json: { id, key: t.key, interval, years: Number(years), capital: Number(t.capital) } });
  };
  const test = async () => { setBusy("one"); setErr([]); try { setResult(await runOne(t.interval, t.years)); } catch (e) { setErr([(e as Error).message]); } finally { setBusy(""); } };
  const testAll = async () => {
    setBusy("all"); setErr([]); const out: Multi[] = TFS.map(x => ({ tf: x.label })); setMulti([...out]);
    for (const [k, x] of TFS.entries()) { try { out[k] = { tf: x.label, r: await runOne(x.v, String(x.years)) }; } catch (e) { out[k] = { tf: x.label, err: (e as Error).message }; } setMulti([...out]); }
    setBusy("");
  };

  const summary = spec ? [
    spec.entryMode === "dayOpen" ? "Entry: 09:15 open par check (sirf open tak ki info)" : "Entry: candle close par check → agle candle ke open par trade",
    spec.long.enabled ? `BUY CALL jab: ${spec.long.entry.map(condText).join(" AND ") || "—"}. Exit jab: ${spec.long.exit.map(condText).join(" OR ") || "sirf stop/target/square-off"}.` : null,
    spec.short.enabled ? `BUY PUT jab: ${spec.short.entry.map(condText).join(" AND ") || "—"}. Exit jab: ${spec.short.exit.map(condText).join(" OR ") || "sirf stop/target/square-off"}.` : null,
    `Stop: ${spec.stop.type === "pivot" ? `nearest pivot − ${spec.stop.value} pts` : spec.stop.type === "none" ? "none" : `${spec.stop.value} ${spec.stop.type === "pct" ? "%" : spec.stop.type === "atr" ? "× ATR" : "pts"}`} · Target: ${spec.target.type === "none" ? "none" : `${spec.target.value} ${spec.target.type === "pct" ? "%" : spec.target.type === "rr" ? "× risk" : "pts"}`}`,
    spec.trailing.type === "pivot" ? `Trailing: ${spec.trailing.every ? `${spec.trailing.every} pts profit ke baad ` : ""}stop har naye confirmed pivot (swing ${"low/high"}, k=${spec.trailing.k ?? 3}) ke ${spec.trailing.by} pts peeche shift` :
    spec.trailing.type === "step" ? `Trailing: har ${spec.trailing.every} pts profit (candle close par) → stop ${spec.trailing.by} pt aage (entry + ${spec.trailing.by}, + ${spec.trailing.by * 2}, …)` : spec.trailing.type === "trail" ? `Trailing: ${spec.trailing.every} pts profit ke baad stop best close se ${spec.trailing.by} pts peeche` : "Trailing: off",
    spec.session.windows?.length ? `Trading windows: ${spec.session.windows.map(w => `${w.from}–${w.to}`).join(", ")}${spec.session.exitAtWindowEnd ? " (window khatam = trade band)" : " (entry sirf windows mein)"}` : null,
    `Square-off ${spec.session.squareOff} · no entry after ${spec.session.noEntryAfter} · max ${spec.session.maxTradesPerDay} trade/day${spec.session.dayProfitLock ? ` · din ka profit +₹${spec.session.dayProfitLock} par stop` : ""}${spec.session.dayLossLimit ? ` · din ka loss −₹${spec.session.dayLossLimit} par stop` : ""} · P&L = points × δ${spec.sizing.delta} × lot ${spec.sizing.qty} × ${(spec.sizing.mode ?? "fixed") === "fixed" ? `${spec.sizing.lots ?? 1} lot(s)` : spec.sizing.mode === "capital" ? `(capital ÷ ₹${spec.sizing.capitalPerLot ?? 15000}) lots` : `risk ${spec.sizing.riskPct ?? 1}% lots`} − ₹${spec.costs.perTrade}/trade − ${spec.costs.slippagePoints} pt slippage/side`,
  ].filter(Boolean) as string[] : [];

  return <div className="builder">
    <aside className="card builder-list">
      <div className="card-head"><h2>🧩 My strategies</h2></div>
      <div className="actions" style={{ gap: 6, marginBottom: 10 }}><button className="btn sm primary" onClick={() => newStrategy("blank")}>+ New</button><button className="btn sm" onClick={() => newStrategy("preset")}>+ From Jassu template</button></div>
      {(rows ?? []).map(r => <div key={r.id} className={`bl-item ${selId === r.id ? "on" : ""}`} onClick={() => pick(r)}>
        <b>{r.name}</b><small className="muted">updated {istDateTime(r.updatedAt)}</small>
        <div className="actions" style={{ gap: 6, marginTop: 6 }}>
          <button className="btn sm" onClick={e => { e.stopPropagation(); setSelId(null); setSpec({ ...structuredClone(r.spec), name: `${r.name} (copy)` }); setDirty(true); }}>Duplicate</button>
          <button className="btn sm danger" onClick={e => { e.stopPropagation(); setDel(r); }}>Delete</button></div>
      </div>)}
      {selId === null && spec && <div className="bl-item on"><b>{spec.name}</b><small className="warn">unsaved new strategy</small></div>}
    </aside>

    {spec && <div className="builder-main">
      <section className="card">
        <div className="card-head"><h2>✏️ Strategy</h2>{dirty && <span className="pill WATCH">unsaved</span>}{msg && <span className="up">{msg}</span>}
          <span style={{ flex: 1 }} /><button className="btn" onClick={() => save(true)}>Save as new</button><button className="btn primary" onClick={() => save()}>💾 Save</button></div>
        {err.length > 0 && <div className="note bad" style={{ marginBottom: 10 }}>{err.map((e, k) => <div key={k}>{e}</div>)}</div>}
        <div className="form-grid">
          <label className="field"><span>Name</span><input className="input" value={spec.name} onChange={e => edit({ name: e.target.value })} /></label>
          <label className="field" style={{ gridColumn: "span 2" }}><span>Description (optional)</span><input className="input" value={spec.description ?? ""} onChange={e => edit({ description: e.target.value })} /></label>
          <div className="field"><span>Live timeframe (auto paper trading)</span><div className="tabs">{(["1", "5", "15", "D"] as const).map(x =>
            <button key={x} className={(spec.timeframe ?? "5") === x ? "on" : ""} onClick={() => edit({ timeframe: x })}>{x === "D" ? "Daily" : `${x}-min`}</button>)}</div></div>
          <div className="field" style={{ gridColumn: "span 2" }}><span>Live mein kis par chale (khali = Trade Setup ki saari list)</span><div className="actions" style={{ gap: 6, flexWrap: "wrap" }}>
            {(spec.instruments ?? []).map(k => <span key={k} className="pill NEUTRAL" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>{instruments.find(i => i.key === k)?.symbol ?? k}
              <button className="btn sm" style={{ padding: "0 6px" }} aria-label="Remove" onClick={() => edit({ instruments: spec.instruments!.filter(x => x !== k) })}>✕</button></span>)}
            <Select size="sm" width={170} search value="" placeholder="+ instrument" ariaLabel="Add instrument" onChange={k => edit({ instruments: [...new Set([...(spec.instruments ?? []), k])] })}
              options={instruments.filter(i => !(spec.instruments ?? []).includes(i.key)).map(i => ({ value: i.key, label: i.symbol, sub: i.name, group: i.instrumentType === "INDEX" ? "Indices" : "Stocks" }))} /></div></div>
          <div className="field"><span>Entry kab check ho</span><div className="tabs">
            <button className={spec.entryMode === "dayOpen" ? "on" : ""} onClick={() => edit({ entryMode: "dayOpen" })} title="Sirf 09:15 open par, din mein ek baar">09:15 open par</button>
            <button className={spec.entryMode === "barClose" ? "on" : ""} onClick={() => edit({ entryMode: "barClose" })} title="Har candle close par check, agle candle ke open par entry">Har candle close par</button></div></div>
        </div>
      </section>

      <div className="grid g2">
        {(["long", "short"] as const).map(side => { const s = spec[side], L = side === "long";
          return <section key={side} className={`card side-card ${s.enabled ? "" : "off"}`}>
            <div className="card-head"><h2>{L ? "📈 BUY CALL (long)" : "📉 BUY PUT (short)"}</h2>
              <label className="actions" style={{ gap: 6, cursor: "pointer" }}><input type="checkbox" checked={s.enabled} onChange={e => edit({ [side]: { ...s, enabled: e.target.checked } } as Partial<Spec>)} /> enabled</label>
              {!L && <button className="btn sm" title="CALL side ki conditions ulta karke PUT side mein copy karo" onClick={() => edit({ short: { enabled: true, entry: spec.long.entry.map(mirror), exit: spec.long.exit.map(mirror) } })}>⇅ Mirror from CALL</button>}</div>
            <CondList title="Entry" sub="SAARI conditions true honi chahiye (AND)" list={s.entry} on={entry => edit({ [side]: { ...s, entry } } as Partial<Spec>)} addLabel="entry condition" />
            <CondList title="Exit" sub="KOI BHI ek true ho to exit (OR), candle close par" list={s.exit} on={exit => edit({ [side]: { ...s, exit } } as Partial<Spec>)} addLabel="exit condition" />
          </section>; })}
      </div>

      <section className="card">
        <h2>🛡️ Risk, trailing, session, sizing</h2>
        <div className="form-grid">
          <div className="field"><span>Stop loss</span><div className="actions" style={{ gap: 6 }}>
            <Select size="sm" width={120} value={spec.stop.type} onChange={v => edit({ stop: { ...spec.stop, type: v as Spec["stop"]["type"] } })} ariaLabel="Stop type" options={[{ value: "none", label: "None" }, { value: "points", label: "Points" }, { value: "pct", label: "%" }, { value: "atr", label: "× ATR" }, { value: "pivot", label: "Nearest pivot", sub: "swing low/high − buffer pts" }]} />
            {spec.stop.type !== "none" && <>{spec.stop.type === "pivot" && <span className="muted">buffer pts</span>}<Num v={spec.stop.value} on={value => edit({ stop: { ...spec.stop, value } })} step={0.5} /></>}</div></div>
          <div className="field"><span>Target</span><div className="actions" style={{ gap: 6 }}>
            <Select size="sm" width={120} value={spec.target.type} onChange={v => edit({ target: { ...spec.target, type: v as Spec["target"]["type"] } })} ariaLabel="Target type" options={[{ value: "none", label: "None" }, { value: "points", label: "Points" }, { value: "pct", label: "%" }, { value: "rr", label: "× risk (R:R)" }]} />
            {spec.target.type !== "none" && <Num v={spec.target.value} on={value => edit({ target: { ...spec.target, value } })} step={0.5} />}</div></div>
          <div className="field" style={{ gridColumn: "span 2" }}><span>Trailing stop (candle close par update)</span><div className="actions" style={{ gap: 6 }}>
            <Select size="sm" width={200} value={spec.trailing.type} onChange={v => edit({ trailing: { ...spec.trailing, type: v as Spec["trailing"]["type"] } })} ariaLabel="Trailing" options={[{ value: "none", label: "Off" }, { value: "step", label: "Step: har X pts → SL +Y pts" }, { value: "trail", label: "Trail: best close se Y pts peeche" }, { value: "pivot", label: "Pivot: nearest swing low/high ke peeche" }]} />
            {spec.trailing.type === "pivot" && <><span className="muted">start after</span><Num v={spec.trailing.every} on={every => edit({ trailing: { ...spec.trailing, every } })} step={0.5} /><span className="muted">pts profit · buffer</span>
              <Num v={spec.trailing.by} on={by => edit({ trailing: { ...spec.trailing, by } })} step={0.5} /><span className="muted">pts · pivot strength k</span><Num v={spec.trailing.k ?? 3} on={k => edit({ trailing: { ...spec.trailing, k: Math.max(1, Math.round(k)) } })} w={56} /></>}
            {(spec.trailing.type === "step" || spec.trailing.type === "trail") && <><span className="muted">{spec.trailing.type === "step" ? "har" : "after"}</span><Num v={spec.trailing.every} on={every => edit({ trailing: { ...spec.trailing, every } })} step={0.5} /><span className="muted">pts →</span>
              <Num v={spec.trailing.by} on={by => edit({ trailing: { ...spec.trailing, by } })} step={0.5} /><span className="muted">pts</span></>}</div></div>
          <label className="field"><span>Square-off</span><input className="input num" type="time" value={spec.session.squareOff} onChange={e => edit({ session: { ...spec.session, squareOff: e.target.value } })} /></label>
          <label className="field"><span>No entry after</span><input className="input num" type="time" value={spec.session.noEntryAfter} onChange={e => edit({ session: { ...spec.session, noEntryAfter: e.target.value } })} /></label>
          <label className="field"><span>Max trades / day</span><input className="input num" type="number" min={1} value={spec.session.maxTradesPerDay} onChange={e => edit({ session: { ...spec.session, maxTradesPerDay: Math.max(1, Number(e.target.value)) } })} /></label>
          <div className="field" style={{ gridColumn: "1 / -1" }}><span>Trading windows (IST) — khali = poora din · entry sirf in windows mein</span>
            <div className="actions" style={{ gap: 8, flexWrap: "wrap" }}>
              {(spec.session.windows ?? []).map((w, k) => <span key={k} className="actions" style={{ gap: 4, border: "1px solid var(--line)", borderRadius: 8, padding: "4px 6px" }}>
                <input className="input num" style={{ width: 92, padding: "4px 6px" }} type="time" value={w.from} onChange={e => edit({ session: { ...spec.session, windows: spec.session.windows!.map((x, j) => j === k ? { ...x, from: e.target.value } : x) } })} />
                <span className="muted">–</span>
                <input className="input num" style={{ width: 92, padding: "4px 6px" }} type="time" value={w.to} onChange={e => edit({ session: { ...spec.session, windows: spec.session.windows!.map((x, j) => j === k ? { ...x, to: e.target.value } : x) } })} />
                <button className="btn sm" aria-label="Remove window" onClick={() => edit({ session: { ...spec.session, windows: spec.session.windows!.filter((_, j) => j !== k) } })}>✕</button></span>)}
              <button className="btn sm" onClick={() => edit({ session: { ...spec.session, windows: [...(spec.session.windows ?? []), { from: "09:15", to: "10:00" }] } })}>+ window</button>
              {!!spec.session.windows?.length && <label className="actions" style={{ gap: 6, cursor: "pointer" }}><input type="checkbox" checked={!!spec.session.exitAtWindowEnd} onChange={e => edit({ session: { ...spec.session, exitAtWindowEnd: e.target.checked } })} /> window khatam hote hi trade band</label>}
            </div></div>
          <label className="field"><span>Din ka profit lock ₹ (0 = off)</span><input className="input num" type="number" min={0} value={spec.session.dayProfitLock ?? 0} onChange={e => edit({ session: { ...spec.session, dayProfitLock: Math.max(0, Number(e.target.value)) } })} title="Din ka net profit itna hote hi us din aur entry nahi" /></label>
          <label className="field"><span>Din ka loss limit ₹ (0 = off)</span><input className="input num" type="number" min={0} value={spec.session.dayLossLimit ?? 0} onChange={e => edit({ session: { ...spec.session, dayLossLimit: Math.max(0, Number(e.target.value)) } })} title="Din ka net loss itna hote hi us din aur entry nahi" /></label>
          <div className="field"><span>Lot sizing</span><Select size="sm" value={spec.sizing.mode ?? "fixed"} onChange={v => edit({ sizing: { ...spec.sizing, mode: v as "fixed" } })} ariaLabel="Lot sizing" options={[
            { value: "fixed", label: "Fixed lots", sub: "capital P&L ko change nahi karta" }, { value: "capital", label: "Capital-based", sub: "lots = capital ÷ ₹ per lot" }, { value: "risk", label: "Risk-based", sub: "stop hit ≈ risk % of capital" }]} /></div>
          {(spec.sizing.mode ?? "fixed") === "fixed" ? <label className="field"><span>Lots / trade</span><input className="input num" type="number" min={1} value={spec.sizing.lots ?? 1} onChange={e => edit({ sizing: { ...spec.sizing, lots: Math.max(1, Number(e.target.value)) } })} /></label>
            : <label className="field"><span>₹ per lot (premium/margin)</span><input className="input num" type="number" min={1} value={spec.sizing.capitalPerLot ?? 15000} onChange={e => edit({ sizing: { ...spec.sizing, capitalPerLot: Number(e.target.value) } })} /></label>}
          {spec.sizing.mode === "risk" && <label className="field"><span>Risk / trade (% of capital)</span><input className="input num" type="number" step={0.25} value={spec.sizing.riskPct ?? 1} onChange={e => edit({ sizing: { ...spec.sizing, riskPct: Number(e.target.value) } })} /></label>}
          <label className="field"><span>₹ charges per extra lot</span><input className="input num" type="number" value={spec.costs.perExtraLot ?? 15} onChange={e => edit({ costs: { ...spec.costs, perExtraLot: Number(e.target.value) } })} /></label>
          <label className="field"><span>Lot size (qty per lot — Dhan par check karein)</span><input className="input num" type="number" min={1} value={spec.sizing.qty} onChange={e => edit({ sizing: { ...spec.sizing, qty: Number(e.target.value) } })} /></label>
          <div className="field"><span>P&L model</span><div className="tabs">
            <button className={spec.sizing.delta === 0.5 ? "on" : ""} onClick={() => edit({ sizing: { ...spec.sizing, delta: 0.5 } })} title="ATM option ≈ index ka aadha move">ATM option δ0.5</button>
            <button className={spec.sizing.delta === 1 ? "on" : ""} onClick={() => edit({ sizing: { ...spec.sizing, delta: 1 } })} title="Futures = index ka poora move">Futures δ1</button></div></div>
          <label className="field"><span>Charges ₹ / trade (round trip)</span><input className="input num" type="number" value={spec.costs.perTrade} onChange={e => edit({ costs: { ...spec.costs, perTrade: Number(e.target.value) } })} /></label>
          <label className="field"><span>Slippage (index pts / side)</span><input className="input num" type="number" step={0.25} value={spec.costs.slippagePoints} onChange={e => edit({ costs: { ...spec.costs, slippagePoints: Number(e.target.value) } })} /></label>
        </div>
      </section>

      <section className="card">
        <h2>📜 Rules — plain language</h2>
        <ul className="steps" style={{ listStyle: "disc" }}>{summary.map((s, k) => <li key={k}>{s}</li>)}</ul>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Option P&L = index points × delta (approx). Theta (time decay), IV aur bid-ask spread model nahi hain — real option P&L isse kam ho sakta hai.</p>
      </section>

      <section className="card">
        <div className="card-head"><h2>🧪 Test</h2></div>
        <div className="form-grid">
          <div className="field"><span>Instrument</span><Select search value={t.key} onChange={key => setT({ ...t, key })} ariaLabel="Instrument"
            options={instruments.map(i => ({ value: i.key, label: i.symbol, sub: i.name, group: i.instrumentType === "INDEX" ? "Indices" : i.instrumentType === "CRYPTO_PERP" ? "₿ Crypto · Delta Exchange" : "Stocks" })).sort((a, b) => Number(a.group !== "Indices") - Number(b.group !== "Indices"))} /></div>
          <div className="field"><span>Timeframe</span><Select value={t.interval} onChange={v => setT({ ...t, interval: v, years: v === "D" ? "10" : v === "1" ? "1" : "2" })} ariaLabel="Timeframe"
            options={[{ value: "1", label: "1-min" }, { value: "5", label: "5-min" }, { value: "15", label: "15-min" }, { value: "D", label: "Daily" }]} /></div>
          <label className="field"><span>Period: {t.years} year(s)</span><input type="range" min={t.interval === "D" ? 1 : 0.25} max={t.interval === "D" ? 10 : 5} step={t.interval === "D" ? 1 : 0.25} value={t.years} onChange={e => setT({ ...t, years: e.target.value })} /></label>
          <label className="field"><span>Capital (₹)</span><input className="input num" value={t.capital} onChange={e => setT({ ...t, capital: e.target.value })} /></label>
        </div>
        <div className="actions" style={{ marginTop: 12, gap: 8 }}>
          <button className="btn primary big" disabled={!!busy} onClick={test}>{busy === "one" ? "⏳ Testing…" : "▶ Save & test"}</button>
          <button className="btn big" disabled={!!busy} onClick={testAll} title="1-min (1y), 5-min (2y), 15-min (2y), Daily (10y)">{busy === "all" ? "⏳ Testing all timeframes…" : "▶ Test on ALL timeframes"}</button>
        </div>
        {multi && <div className="table-wrap" style={{ marginTop: 14 }}><table>
          <thead><tr><th>Timeframe</th><th className="r">Trades</th><th className="r">Win %</th><th className="r">Profit factor</th><th className="r">Gross</th><th className="r">Charges</th><th className="r">Net P&L</th><th className="r">Out-of-sample</th><th>Result</th><th></th></tr></thead>
          <tbody>{multi.map(m => { const r = m.r, M = r?.metrics, pass = !!r && M!.netPnl > 0 && r.outOfSample.netPnl > 0 && (M!.profitFactor ?? 0) > 1;
            return <tr key={m.tf}><td><b>{m.tf}</b></td>
              {r ? <><td className="r num">{r.tradeCount}</td><td className="r num">{M!.winRate != null ? (M!.winRate * 100).toFixed(1) + "%" : "—"}</td><td className={`r num ${(M!.profitFactor ?? 0) >= 1 ? "up" : "down"}`}>{fmt(M!.profitFactor)}</td>
                <td className="r num">{inr(M!.netPnl + M!.totalCharges, 0)}</td><td className="r num muted">{inr(M!.totalCharges, 0)}</td><td className={`r num ${M!.netPnl >= 0 ? "up" : "down"}`}><b>{inr(M!.netPnl, 0)}</b></td>
                <td className={`r num ${r.outOfSample.netPnl >= 0 ? "up" : "down"}`}>{inr(r.outOfSample.netPnl, 0)}</td>
                <td>{pass ? <span className="pill ENTER">PASS</span> : <span className="pill SHORT">FAIL</span>}</td><td><button className="btn sm" onClick={() => setResult(r)}>Details →</button></td></>
                : <td colSpan={9} className={m.err ? "err" : "muted"}>{m.err ?? "⏳ running…"}</td>}</tr>; })}</tbody></table>
          <p className="muted" style={{ fontSize: 12 }}>PASS = net profit &gt; 0, profit factor &gt; 1, aur unseen last 30% (out-of-sample) mein bhi profit. Har run "My Backtests" (Backtest Lab) mein bhi save hota hai.</p></div>}
      </section>
    </div>}

    {result && <ResultPage r={result} onClose={() => setResult(null)} />}
    {del && <ConfirmModal title={`Delete "${del.name}"?`} phrase="DELETE" cta="Delete strategy" onClose={() => setDel(null)}
      body={<>Ye strategy permanently delete ho jayegi (iske purane backtests My Backtests mein rahenge).</>}
      onConfirm={async () => { await api(`/api/builder/strategies/${del.id}`, { method: "DELETE" }); if (selId === del.id) { setSelId(null); setSpec(null); } setDel(null); reload(); }} />}
  </div>;
}
