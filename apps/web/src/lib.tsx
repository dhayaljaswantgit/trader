import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createChart, type IChartApi, type UTCTimestamp, ColorType, CrosshairMode } from "lightweight-charts";

/** Active exchange for this browser tab. Every /api/ call carries ?venue=… so the server uses that exchange's session, setup, engine and trades. */
export type Venue = "DHAN" | "DELTA";
let VENUE: Venue = (() => { try { return localStorage.getItem("venue") === "DELTA" ? "DELTA" : "DHAN"; } catch { return "DHAN"; } })();
export const getVenue = () => VENUE;
export const setVenue = (v: Venue) => { VENUE = v; try { localStorage.setItem("venue", v); } catch { /* ignore */ } };
export const withVenue = (url: string) => url.startsWith("/api/") && !/[?&]venue=/.test(url) ? `${url}${url.includes("?") ? "&" : "?"}venue=${VENUE}` : url;

export async function api<T = any>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  url = withVenue(url);
  const r = await fetch(url, { ...init, method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined, body: init?.json !== undefined ? JSON.stringify(init.json) : undefined });
  const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { j = text; }
  if (!r.ok) throw new Error(j?.issues?.join(", ") ?? j?.message ?? j?.error ?? `HTTP ${r.status}`);
  return j as T;
}

export function usePoll<T>(url: string | null, ms: number): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState("");
  const alive = useRef(true);
  const load = useCallback(async () => { if (!url) return; try { const d = await api<T>(url); if (alive.current) { setData(d); setError(""); } } catch (e) { if (alive.current) setError((e as Error).message); } }, [url]);
  useEffect(() => { alive.current = true; load(); const t = ms ? setInterval(load, ms) : undefined; return () => { alive.current = false; if (t) clearInterval(t); }; }, [load, ms]);
  return { data, error, reload: load };
}

export const inr = (v: number | string | null | undefined, dp = 2) => v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const fmt = (v: number | string | null | undefined, dp = 2) => v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const pct = (v: number | null | undefined, dp = 1) => v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
export const istTime = (iso: string | number | Date | null | undefined) => iso === null || iso === undefined ? "—" : new Date(typeof iso === "number" ? iso * 1000 : iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
export const istDateTime = (iso: string | number | Date | null | undefined) => iso === null || iso === undefined ? "—" : new Date(typeof iso === "number" ? iso * 1000 : iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" });
/** Sign + arrow so P&L is never conveyed by colour alone */
export function Pnl({ v, big }: { v: number | string | null | undefined; big?: boolean }) {
  const n = Number(v ?? 0); const cls = n > 0 ? "up" : n < 0 ? "down" : "muted";
  return <span className={`num ${cls} ${big ? "hero-pnl" : ""}`}>{n > 0 ? "▲ +" : n < 0 ? "▼ −" : ""}{inr(Math.abs(n))}</span>;
}

export function Chip({ kind = "", children, pulse }: { kind?: "ok" | "bad" | "warn" | "info" | ""; children: ReactNode; pulse?: boolean }) {
  return <span className={`chip ${kind} ${pulse ? "pulse" : ""}`}><span className="dot" />{children}</span>;
}
export function Switch({ on, onChange, label, sub }: { on: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return <button type="button" role="switch" aria-checked={on} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
    <span className="track" /><span><b>{label}</b>{sub && <><br /><small className="muted">{sub}</small></>}</span></button>;
}
export function MultiSelect<T extends string>({ options, value, onChange }: { options: Array<{ id: T; label: string; sub?: string; icon?: string }>; value: T[]; onChange: (v: T[]) => void }) {
  return <div className="seg" role="group">{options.map(o => { const on = value.includes(o.id);
    return <button type="button" key={o.id} aria-pressed={on} className={`opt ${on ? "on" : ""}`} onClick={() => onChange(on ? value.filter(x => x !== o.id) : [...value, o.id])}>
      <span className="box">{on ? "✓" : ""}</span><span><b>{o.icon} {o.label}</b>{o.sub && <small>{o.sub}</small>}</span></button>; })}</div>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  // portal to <body> so a dialog opened from a table cell does not inherit its alignment / nowrap
  return createPortal(<div className="modal-bg" onClick={onClose}><div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}><h3>{title}</h3>{children}</div></div>, document.body);
}

/** Typed-confirmation dialog for destructive actions */
export function ConfirmModal({ title, body, phrase, cta, onConfirm, onClose, danger = true }: { title: string; body: ReactNode; phrase: string; cta: string; onConfirm: () => Promise<void>; onClose: () => void; danger?: boolean }) {
  const [txt, setTxt] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  return <Modal title={title} onClose={onClose}>
    <div className="muted" style={{ marginBottom: 14 }}>{body}</div>
    <label className="field"><span>Confirm karne ke liye <b className="num" style={{ color: "var(--fg)" }}>{phrase}</b> type karein</span>
      <input className="input num" autoFocus value={txt} onChange={e => setTxt(e.target.value)} placeholder={phrase} /></label>
    {err && <p className="err" role="alert">{err}</p>}
    <div className="actions" style={{ marginTop: 16, justifyContent: "flex-end" }}>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className={`btn ${danger ? "danger" : "primary"}`} disabled={txt !== phrase || busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>{busy ? "Working…" : cta}</button>
    </div>
  </Modal>;
}

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const baseChart = (el: HTMLElement, h: number): IChartApi => createChart(el, {
  height: h, autoSize: true, layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted"), fontSize: 11 },
  grid: { vertLines: { color: "#ffffff08" }, horzLines: { color: "#ffffff08" } }, rightPriceScale: { borderColor: css("--line") },
  timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false }, crosshair: { mode: CrosshairMode.Normal },
  localization: { timeFormatter: (t: number) => new Date(t * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) },
});
/** lightweight-charts renders in UTC; shift by +5:30 so the axis reads IST. */
const ist = (t: number) => (t + 19800) as UTCTimestamp;

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export function CandleChart({ bars, overlays, markers, height = 380, fill }: { bars: Bar[]; overlays?: Array<{ name: string; color: string; data: Array<number | null> }>; markers?: Array<{ t: number; up: boolean; text: string }>; height?: number; fill?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !bars.length) return;
    const ch = baseChart(ref.current, height);
    const cs = ch.addCandlestickSeries({ upColor: css("--up"), downColor: css("--down"), borderVisible: false, wickUpColor: css("--up"), wickDownColor: css("--down") });
    cs.setData(bars.map(b => ({ time: ist(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    if (bars.some(b => b.v > 0)) {
      const vs = ch.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" } });
      ch.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vs.setData(bars.map(b => ({ time: ist(b.t), value: b.v, color: b.c >= b.o ? "#2fd08a40" : "#ff5d7340" })));
    }
    for (const o of overlays ?? []) {
      const ls = ch.addLineSeries({ color: o.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: o.name });
      ls.setData(bars.flatMap((b, i) => (o.data[i] == null ? [] : [{ time: ist(b.t), value: o.data[i]! }])));
    }
    if (markers?.length) cs.setMarkers(markers.map(m => ({ time: ist(m.t), position: m.up ? "belowBar" : "aboveBar", color: m.up ? css("--up") : css("--down"), shape: m.up ? "arrowUp" : "arrowDown", text: m.text })));
    ch.timeScale().fitContent();
    return () => ch.remove();
  }, [bars, overlays, markers, height]);
  return <div ref={ref} className="chart" style={{ height: fill ? "100%" : height }} />;
}
export function LineChart({ points, height = 240, baseline }: { points: Array<{ t: number; v: number }>; height?: number; baseline?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || points.length < 2) return;
    const ch = baseChart(ref.current, height);
    const s = ch.addBaselineSeries({ baseValue: { type: "price", price: baseline ?? points[0]!.v }, topLineColor: css("--up"), bottomLineColor: css("--down"),
      topFillColor1: "#2fd08a33", topFillColor2: "#2fd08a05", bottomFillColor1: "#ff5d7305", bottomFillColor2: "#ff5d7333", lineWidth: 2 });
    const seen = new Set<number>();
    s.setData(points.map(p => ({ time: ist(p.t), value: p.v })).filter(p => !seen.has(p.time) && (seen.add(p.time), true)).sort((a, b) => a.time - b.time));
    ch.timeScale().fitContent(); return () => ch.remove();
  }, [points, height, baseline]);
  return points.length < 2 ? <div className="empty">Abhi chart ke liye data nahi hai</div> : <div ref={ref} className="chart sm" style={{ height }} />;
}

export type SelectOption = { value: string; label: string; sub?: string; right?: ReactNode; rightSub?: ReactNode; group?: string };
/**
 * Searchable dropdown used everywhere instead of native <select>.
 * The popup is portalled to <body>: it isn't clipped by overflow:hidden cards, and clicks in it
 * don't bubble to a wrapping <label> (which would re-click the trigger).
 */
export function Select({ options, value, onChange, placeholder = "Select…", search, width, size = "md", ariaLabel }: {
  options: SelectOption[]; value: string | null | undefined; onChange: (v: string) => void; placeholder?: string;
  /** Show search box. Default: when there are more than 8 options. */ search?: boolean; width?: number | string; size?: "sm" | "md"; ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(""); const [hi, setHi] = useState(0);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, up: false });
  const btn = useRef<HTMLButtonElement>(null); const pop = useRef<HTMLDivElement>(null); const list = useRef<HTMLDivElement>(null);
  const searchable = search ?? options.length > 8;
  const cur = options.find(o => o.value === value);
  const needle = q.trim().toLowerCase();
  // Word-based search: every typed word must appear somewhere in label / description / group (punctuation ignored).
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9%.\u0900-\u097f]+/g, " ");
  const words = norm(needle).split(" ").filter(w => w.length > 0);
  const hits = !needle ? options : options.filter(o => { const hay = norm(`${o.label} ${o.sub ?? ""} ${o.group ?? ""}`); return words.every(w => hay.includes(w)); })
    .sort((a, b) => Number(!a.label.toLowerCase().startsWith(needle)) - Number(!b.label.toLowerCase().startsWith(needle)));
  const groupNames = [...new Set(hits.map(o => o.group ?? ""))];
  const groups = groupNames.map(g => ({ label: g, rows: hits.filter(o => (o.group ?? "") === g) }));
  const flat = groups.flatMap(g => g.rows);
  const show = () => {
    const r = btn.current!.getBoundingClientRect(); const w = Math.max(r.width, searchable ? 300 : 180);
    const up = r.bottom + 420 > window.innerHeight && r.top > window.innerHeight - r.bottom;
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), width: w, up });
    setQ(""); setHi(Math.max(0, options.findIndex(o => o.value === value))); setOpen(true);
  };
  const pick = (v: string) => { onChange(v); setOpen(false); btn.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    // Close on page scroll only; scrolling inside the list itself must not close it.
    const onScroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away); window.addEventListener("resize", close); window.addEventListener("scroll", onScroll, true);
    return () => { document.removeEventListener("mousedown", away); window.removeEventListener("resize", close); window.removeEventListener("scroll", onScroll, true); };
  }, [open]);
  useEffect(() => {
    const l = list.current, row = l?.querySelector<HTMLElement>(`[data-i="${hi}"]`); if (!l || !row) return;
    if (row.offsetTop < l.scrollTop) l.scrollTop = row.offsetTop - 28;
    else if (row.offsetTop + row.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = row.offsetTop + row.offsetHeight - l.clientHeight + 4;
  }, [hi, open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!open) show(); else setHi(h => Math.min(h + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && open && flat[hi]) { e.preventDefault(); pick(flat[hi].value); }
    else if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); btn.current?.focus(); }
  };
  const focusOnce = useRef(false);
  useEffect(() => { focusOnce.current = false; }, [open]);
  let n = -1;
  return <>
    <button ref={btn} type="button" className={`sel-btn ${size}`} style={{ width }} onClick={() => open ? setOpen(false) : show()} onKeyDown={onKey}
      aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
      <span className={cur ? "" : "dim"}>{cur?.label ?? placeholder}</span><span className="chev">▾</span>
    </button>
    {open && createPortal(<div ref={pop} className="sel-pop" style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}>
      {searchable && <div className="sel-search"><span className="dim">⌕</span>
        <input ref={el => { if (el && !focusOnce.current) { focusOnce.current = true; el.focus({ preventScroll: true }); } }} placeholder="Search…" value={q}
          onChange={e => { setQ(e.target.value); setHi(0); }} onKeyDown={onKey} aria-label="Search options" />
        <span className="dim" style={{ fontSize: 11 }}>{flat.length}</span></div>}
      <div ref={list} className="sel-list" role="listbox" tabIndex={-1} onKeyDown={onKey}>
        {!flat.length && <div className="empty" style={{ padding: 20 }}>“{q}” nahi mila</div>}
        {groups.map(g => <div key={g.label}>
          {g.label && <div className="sel-group">{g.label}</div>}
          {g.rows.map(o => { n++; const idx = n;
            return <div key={o.value} data-i={idx} role="option" aria-selected={o.value === value} className={`sel-row${idx === hi ? " hi" : ""}${o.value === value ? " sel" : ""}`}
              onMouseEnter={() => setHi(idx)} onClick={() => pick(o.value)}>
              <div className="sel-name"><span>{o.label}</span>{o.sub && <small>{o.sub}</small>}</div>
              {(o.right !== undefined || o.rightSub !== undefined) && <div className="sel-px num">{o.right}{o.rightSub !== undefined && <small>{o.rightSub}</small>}</div>}
              {o.value === value && <span className="tick">✓</span>}
            </div>; })}
        </div>)}
      </div>
      {searchable && <div className="sel-foot dim">↑↓ chuno · Enter select · Esc band</div>}
    </div>, document.body)}
  </>;
}

export type PickerItem = { key: string; symbol: string; name: string; kind: string; changePct: number | null; quote: { ltp: number } | null };
/** Symbol dropdown: grouped Indices/Stocks with live price and % change. */
export function SymbolPicker({ items, value, onChange, width, size = "sm" }: { items: PickerItem[]; value: string | null; onChange: (key: string) => void; width?: number | string; size?: "sm" | "md" }) {
  const options = [...items].sort((a, b) => Number(a.kind !== "INDEX") - Number(b.kind !== "INDEX")).map(i => ({
    value: i.key, label: i.symbol, sub: i.name, group: i.kind === "INDEX" ? "Indices" : "Stocks",
    right: i.quote ? fmt(i.quote.ltp) : "—", rightSub: <span className={i.changePct === null ? "dim" : i.changePct >= 0 ? "up" : "down"}>{pct(i.changePct, 2)}</span> }));
  return <Select options={options} value={value} onChange={onChange} search width={width ?? 150} size={size} placeholder="Select symbol" ariaLabel="Symbol" />;
}

export type CryptoInst = { key: string; symbol: string; name: string; instrumentType: string; contractValue: string | null };
/** Delta Exchange perpetuals (BTCUSD, ETHUSD, …), majors first. */
export function useCrypto(): CryptoInst[] {
  const { data } = usePoll<CryptoInst[]>("/api/instruments?kind=CRYPTO_PERP&limit=400", 0);
  const majors = ["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "BNBUSD", "DOGEUSD"];
  return [...(data ?? [])].sort((a, b) => ((majors.indexOf(a.symbol) + 1 || 99) - (majors.indexOf(b.symbol) + 1 || 99)) || a.symbol.localeCompare(b.symbol));
}

/** One click → Dhan's official login page; Dhan sends the browser back to the app with a fresh token. */
export async function authorizeDhan() {
  const r = await api<{ url: string }>("/api/dhan/oauth/start", { method: "POST" });
  window.location.href = r.url;
}

/** Instant login (Client ID + PIN + TOTP set up once) — no browser, one click. */
export const loginDhan = () => api<{ ok: boolean; client: string | null }>("/api/dhan/login", { method: "POST" });
