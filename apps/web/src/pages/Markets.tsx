import { useEffect, useMemo, useState } from "react";
import { usePoll, fmt, pct, CandleChart, Chip, istTime, Switch, SymbolPicker, type Bar } from "../lib.tsx";
import { MiniChain } from "./OptionChain.tsx";

type Item = { key: string; symbol: string; name: string; kind: string; fno: boolean; changePct: number | null; stale: boolean; trend: string | null;
  quote: { ltp: number; bid: number | null; ask: number | null; volume: number | null; high: number | null; low: number | null; receivedTs: string; source: string } | null;
  indicators: { ema9: number | null; ema21: number | null; rsi14: number | null; atr14: number | null; adx14: number | null; vwap: number | null; relVolume: number | null } | null;
  signal: { action: string; direction: string; strategy: string } | null };
type Pane = { key: string | null; iv: string };

const LAYOUTS: Record<number, { cols: number; label: string }> = { 1: { cols: 1, label: "▢ 1" }, 2: { cols: 2, label: "▥ 2" }, 4: { cols: 2, label: "⊞ 4" }, 6: { cols: 3, label: "⊞ 6" } };
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

function ChartPane({ pane, items, onChange, active, onActivate, height, fullscreen, onFullscreen, showStats }: {
  pane: Pane; items: Item[]; onChange: (p: Pane) => void; active: boolean; onActivate: () => void; height: number; fullscreen: boolean; onFullscreen: () => void; showStats: boolean;
}) {
  const key = pane.key ?? items[0]?.key ?? null;
  const days = pane.iv === "D" ? 365 : pane.iv === "1" ? 2 : pane.iv === "60" ? 20 : 4; // what the chart shows
  // extra history so EMA 200 is already settled at the left edge of the view
  const loadDays = pane.iv === "D" ? 730 : pane.iv === "1" ? 3 : pane.iv === "60" ? 90 : pane.iv === "15" ? 30 : 12;
  const { data: c, error } = usePoll<{ bars: Bar[]; ema9: number[]; ema21: number[]; vwap: number[]; symbol: string; source: string }>(key ? `/api/candles?key=${encodeURIComponent(key)}&interval=${pane.iv}&days=${loadDays}` : null, 30000);
  const overlays = useMemo(() => {
    if (!c) return [];
    const ema = (n: number) => { const k = 2 / (n + 1); let e: number | null = null; return c.bars.map((b, i) => (e = e == null ? b.c : b.c * k + e * (1 - k), i >= n - 1 ? e : null)); };
    return [{ name: "VWAP", color: "#ffb547", data: c.vwap }, { name: "EMA 9", color: "#5cc8ff", data: c.ema9 }, { name: "EMA 21", color: "#a78bfa", data: c.ema21 },
      { name: "EMA 50", color: "#2fd08a", data: ema(50) }, { name: "EMA 100", color: "#ff8a3d", data: ema(100) }, { name: "EMA 200", color: "#ff5d73", data: ema(200) }];
  }, [c]);
  const showFrom = useMemo(() => Math.floor(Date.now() / 1000) - days * 86400, [days, c]);
  const cur = items.find(i => i.key === key);
  return <div className="card" onClick={onActivate} style={{ padding: 12, outline: active ? "2px solid var(--accent)" : "none", outlineOffset: -1, display: "flex", flexDirection: "column", minHeight: 0, height: fullscreen ? "100%" : undefined, overflow: "hidden" }}>
    <div className="card-head" style={{ marginBottom: 8, gap: 8 }}>
      <SymbolPicker items={items} value={key} onChange={k => onChange({ ...pane, key: k })} />
      {cur?.quote && <span className="num"><b>{fmt(cur.quote.ltp)}</b> <span className={(cur.changePct ?? 0) >= 0 ? "up" : "down"}>{pct(cur.changePct, 2)}</span></span>}
      <span style={{ flex: 1 }} />
      <div className="tabs">{["1", "5", "15", "60", "D"].map(x => <button key={x} className={pane.iv === x ? "on" : ""} onClick={() => onChange({ ...pane, iv: x })}>{x === "D" ? "1D" : x + "m"}</button>)}</div>
      {c && <Chip kind={c.source === "DHAN" ? "ok" : "warn"}>{c.source}</Chip>}
      <button className="btn sm" onClick={e => { e.stopPropagation(); onFullscreen(); }} title={fullscreen ? "Exit full screen (Esc)" : "Full screen"} aria-label="Toggle full screen">{fullscreen ? "✕" : "⛶"}</button>
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>
      {error ? <div className="note bad">{error}</div> : c?.bars.length ? <CandleChart bars={c.bars} overlays={overlays} height={height} fill={fullscreen} showFrom={showFrom} viewKey={`${key}|${pane.iv}`} /> : <div className="empty" style={{ height: fullscreen ? "100%" : height }}>Candles load ho rahe hain…</div>}
    </div>
    {showStats && cur?.indicators && <div className="kpis" style={{ marginTop: 10 }}>
      {[["VWAP", fmt(cur.indicators.vwap)], ["EMA 9 / 21", `${fmt(cur.indicators.ema9)} / ${fmt(cur.indicators.ema21)}`], ["RSI 14", fmt(cur.indicators.rsi14, 1)], ["ATR 14", fmt(cur.indicators.atr14)], ["ADX 14", fmt(cur.indicators.adx14, 1)], ["Rel. volume", cur.indicators.relVolume ? cur.indicators.relVolume.toFixed(2) + "×" : "n/a"]]
        .map(([l, v]) => <div className="kpi" key={l} style={{ padding: "8px 12px" }}><div className="l">{l}</div><div className="v" style={{ fontSize: 15 }}>{v}</div></div>)}
    </div>}
  </div>;
}

export function Markets() {
  const { data, error } = usePoll<{ source: string; error: string | null; items: Item[] }>("/api/watchlist", 3000);
  const [layout, setLayout] = useState<number>(() => load("mk.layout", 1));
  const [panes, setPanes] = useState<Pane[]>(() => load("mk.panes", [{ key: null, iv: "5" }]));
  const [activeIdx, setActiveIdx] = useState(0);
  const [full, setFull] = useState<number | null>(null); // index of pane in full screen, or -1 for whole grid
  const [q, setQ] = useState(""); const [sort, setSort] = useState<"symbol" | "chg" | "signal">("symbol");
  const [showChain, setShowChain] = useState<boolean>(() => load("mk.chain", true));
  useEffect(() => save("mk.chain", showChain), [showChain]);
  const items = data?.items ?? [];

  useEffect(() => { // keep panes array sized to layout; default each new pane to a different symbol
    setPanes(ps => { const n = [...ps]; while (n.length < layout) n.push({ key: items[n.length]?.key ?? null, iv: "5" }); return n.slice(0, Math.max(layout, 1)); });
    if (activeIdx >= layout) setActiveIdx(0);
  }, [layout, items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => save("mk.layout", layout), [layout]);
  useEffect(() => save("mk.panes", panes), [panes]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && setFull(null); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, []);
  const isFull = full !== null;
  useEffect(() => { // lock page scroll + use the browser's real full screen (hides tabs/address bar)
    document.body.style.overflow = isFull ? "hidden" : "";
    try {
      if (isFull && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => undefined);
      if (!isFull && document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    } catch { /* not supported */ }
    const onFs = () => { if (!document.fullscreenElement) setFull(null); };
    document.addEventListener("fullscreenchange", onFs);
    return () => { document.removeEventListener("fullscreenchange", onFs); document.body.style.overflow = ""; };
  }, [isFull]);

  const setPane = (i: number, p: Pane) => setPanes(ps => ps.map((x, j) => (j === i ? p : x)));
  const shown = panes.slice(0, layout);
  const cols = LAYOUTS[layout]!.cols, rows = Math.ceil(layout / cols);
  const paneH = layout === 1 ? 420 : layout === 2 ? 360 : 260;

  const filtered = items.filter(i => !q || i.symbol.includes(q.toUpperCase()) || i.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => sort === "chg" ? (b.changePct ?? -99) - (a.changePct ?? -99) : sort === "signal" ? (b.signal?.action === "ENTER" ? 2 : b.signal?.action === "WATCH" ? 1 : 0) - (a.signal?.action === "ENTER" ? 2 : a.signal?.action === "WATCH" ? 1 : 0) : a.symbol.localeCompare(b.symbol));
  const inPane = (k: string) => shown.findIndex((p, i) => (p.key ?? items[i]?.key) === k);

  const activeKey = shown[activeIdx]?.key ?? items[activeIdx]?.key ?? items[0]?.key ?? null;
  const activeItem = items.find(i => i.key === activeKey);
  const chainPanel = <div style={{ minWidth: 0, display: "flex", flexDirection: "column", maxHeight: isFull ? "100%" : layout === 1 ? 640 : 760 }}>
    {activeItem?.kind !== "CRYPTO_PERP" && <MiniChain symKey={activeKey} symbol={activeItem?.symbol ?? "—"} eligible={!!activeItem && (activeItem.kind === "INDEX" || activeItem.fno)} />}</div>;
  const grid = <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 12, ...(isFull ? { flex: 1, minHeight: 0, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` } : {}) }}>
    {shown.map((p, i) => <ChartPane key={i} pane={p} items={items} onChange={np => setPane(i, np)} active={i === activeIdx && layout > 1} onActivate={() => setActiveIdx(i)}
      height={paneH} fullscreen={full !== null} onFullscreen={() => setFull(full === null ? (layout === 1 ? 0 : -1) : null)} showStats={layout === 1 && full === null} />)}
  </div>;

  return <>
    {(error || data?.error) && <div className="note bad">{error || data?.error}</div>}
    <section className="card" style={{ padding: 14 }}>
      <div className="card-head" style={{ marginBottom: 12 }}>
        <h2>Charts <span className="sub">completed candles · VWAP · EMA 9/21/50/100/200 · IST{layout > 1 ? " · watchlist row click = highlighted chart badlega" : ""}</span></h2>
        <span className="muted" style={{ fontSize: 12 }}>Layout</span>
        <div className="tabs">{Object.entries(LAYOUTS).map(([n, l]) => <button key={n} className={layout === Number(n) ? "on" : ""} onClick={() => setLayout(Number(n))}>{l.label}</button>)}</div>
        <Switch on={showChain} onChange={setShowChain} label="Option chain" />
        <button className="btn sm" onClick={() => setFull(layout === 1 ? 0 : -1)}>⛶ Full screen</button>
      </div>
      {full === null && (showChain ? <div className="mk-split">{grid}{chainPanel}</div> : grid)}
    </section>
    {full !== null && <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "var(--bg)", padding: 10, overflow: "hidden", display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="actions" style={{ alignItems: "center", flex: "none" }}>
        <b>Full screen</b><div className="tabs">{Object.entries(LAYOUTS).map(([n, l]) => <button key={n} className={layout === Number(n) ? "on" : ""} onClick={() => { setLayout(Number(n)); setFull(Number(n) === 1 ? 0 : -1); }}>{l.label}</button>)}</div>
        <span style={{ flex: 1 }} /><span className="muted" style={{ fontSize: 12 }}>Esc to exit</span><button className="btn sm" onClick={() => setFull(null)}>✕ Exit</button></div>
      {showChain ? <div className="mk-split" style={{ flex: 1, minHeight: 0 }}>{grid}{chainPanel}</div> : grid}
    </div>}

    <section className="card">
      <div className="card-head"><h2>Watchlist <span className="sub">{filtered.length}/{items.length} · 5-min indicators</span></h2>
        <input className="input" style={{ maxWidth: 260 }} placeholder="🔍  Search symbol / name…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search watchlist" />
        <div className="tabs"><button className={sort === "symbol" ? "on" : ""} onClick={() => setSort("symbol")}>A–Z</button><button className={sort === "chg" ? "on" : ""} onClick={() => setSort("chg")}>% change</button><button className={sort === "signal" ? "on" : ""} onClick={() => setSort("signal")}>Signals first</button></div></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Symbol</th><th className="r">LTP</th><th className="r">Chg</th><th className="r">Bid / Ask</th><th className="r">Volume</th><th>Trend</th><th className="r">VWAP</th><th className="r">RSI</th><th className="r">ATR</th><th>Signal</th><th>Updated</th></tr></thead>
        <tbody>{filtered.map(i => { const pi = inPane(i.key); return <tr key={i.key} className={`click ${pi >= 0 ? "sel" : ""}`} onClick={() => setPane(activeIdx, { ...(panes[activeIdx] ?? { iv: "5" }), key: i.key })}>
          <td className="sym"><b>{i.symbol}{pi >= 0 && layout > 1 && <span className="dim"> · chart {pi + 1}</span>}</b><small>{i.kind === "CRYPTO_PERP" ? "Perpetual · USD" : i.kind === "INDEX" ? "Index" : i.fno ? "F&O" : "Cash"}</small></td>
          <td className="r num"><b>{fmt(i.quote?.ltp)}</b></td>
          <td className={`r num ${(i.changePct ?? 0) >= 0 ? "up" : "down"}`}>{pct(i.changePct, 2)}</td>
          <td className="r num muted">{i.quote?.bid ? `${fmt(i.quote.bid)} / ${fmt(i.quote.ask)}` : "n/a"}</td>
          <td className="r num muted">{i.quote?.volume ? i.quote.volume.toLocaleString("en-IN") : "n/a"}</td>
          <td>{i.trend ? <span className={`pill ${i.trend}`}>{i.trend === "UP" ? "▲ UP" : i.trend === "DOWN" ? "▼ DOWN" : "◆ SIDE"}</span> : <span className="dim">n/a</span>}</td>
          <td className="r num">{fmt(i.indicators?.vwap)}</td><td className="r num">{fmt(i.indicators?.rsi14, 1)}</td><td className="r num">{fmt(i.indicators?.atr14)}</td>
          <td>{i.signal ? <span className={`pill ${i.signal.action}`}>{i.signal.action} {i.signal.direction === "BULLISH" ? "▲" : i.signal.direction === "BEARISH" ? "▼" : ""}</span> : <span className="dim">—</span>}</td>
          <td className="num" style={{ fontSize: 12 }}>{i.stale ? <span className="warn">⚠ STALE</span> : <span className="muted">{istTime(i.quote?.receivedTs)}</span>}</td>
        </tr>; })}</tbody></table></div>
      {!filtered.length && <div className="empty">"{q}" watchlist mein nahi hai — Trade Setup se add karein</div>}
    </section>
  </>;
}
