import { useState } from "react";
import { usePoll, fmt, Chip, istTime, Select, getVenue } from "../lib.tsx";

type Leg = { ltp: number | null; bid: number | null; ask: number | null; volume: number | null; oi: number | null; iv: number | null; delta: number | null; theta: number | null } | null;
type Chain = { spot: number; expiry: string; source: string; fetchedAt: string; strikes: Array<{ strike: number; ce: Leg; pe: Leg }> };

export function OptionChainPage() {
  if (getVenue() === "DELTA") return <section className="card"><h2>Option chain</h2><div className="empty">₿ Delta Exchange par abhi sirf perpetual futures support hain — option chain Dhan (NSE) ke liye hai. Upar-left se 🇮🇳 Dhan par switch karein.</div></section>;
  return <OptionChainInner />;
}
function OptionChainInner() {
  const { data: prefs } = usePoll<any>("/api/preferences", 0);
  const opts = (prefs?.selected ?? []).filter((s: any) => s.instrumentType === "INDEX" || s.fnoEligible);
  const [key, setKey] = useState<string>(""); const [exp, setExp] = useState("");
  const k = key || opts[0]?.key || "";
  const { data, error } = usePoll<{ expiries: string[]; chain: Chain | null }>(k ? `/api/option-chain?key=${encodeURIComponent(k)}${exp ? `&expiry=${exp}` : ""}` : null, 15000);
  const ch = data?.chain;
  const atm = ch ? ch.strikes.reduce((a, b) => Math.abs(b.strike - ch.spot) < Math.abs(a.strike - ch.spot) ? b : a, ch.strikes[0]!)?.strike : null;
  const near = ch && atm !== null ? ch.strikes.filter(s => Math.abs(ch.strikes.findIndex(x => x.strike === s.strike) - ch.strikes.findIndex(x => x.strike === atm)) <= 12) : [];
  const maxOi = Math.max(1, ...near.flatMap(s => [s.ce?.oi ?? 0, s.pe?.oi ?? 0]));
  const spread = (l: Leg) => l?.bid && l?.ask && l.ltp ? `${(((l.ask - l.bid) / l.ltp) * 100).toFixed(1)}%` : "n/a";
  const oiBar = (v: number | null | undefined, right: boolean) => <div style={{ position: "relative" }}><div style={{ position: "absolute", inset: 0, [right ? "left" : "right"]: 0, width: `${((v ?? 0) / maxOi) * 100}%`, background: right ? "#ff5d7322" : "#2fd08a22", borderRadius: 4, marginLeft: right ? 0 : "auto" }} /><span style={{ position: "relative" }}>{v?.toLocaleString("en-IN") ?? "n/a"}</span></div>;

  return <section className="card">
    <div className="card-head"><h2>Option chain</h2>
      <Select options={opts.map((s: any) => ({ value: s.key, label: s.symbol, sub: s.name, group: s.instrumentType === "INDEX" ? "Indices" : "Stocks" })).sort((a: any, b: any) => Number(a.group !== "Indices") - Number(b.group !== "Indices"))} value={k} onChange={v => { setKey(v); setExp(""); }} search width={200} placeholder="Symbol" ariaLabel="Symbol" />
      <Select options={(data?.expiries ?? []).map(e => ({ value: e, label: e }))} value={exp || ch?.expiry || ""} onChange={setExp} width={160} placeholder="Expiry" ariaLabel="Expiry" />
      {ch && <Chip kind={ch.source === "DHAN" ? "ok" : "warn"}>{ch.source === "DHAN" ? "Dhan data" : "MOCK (Black-Scholes model)"}</Chip>}
      {ch && <span className="muted num" style={{ fontSize: 12 }}>Spot {fmt(ch.spot)} · {istTime(ch.fetchedAt)}</span>}</div>
    {error && <div className="note bad">{error}</div>}
    {!opts.length && <div className="empty">Setup mein koi index ya F&O stock select karein</div>}
    {ch && <div className="table-wrap"><table className="oc">
      <thead><tr><th className="r">OI</th><th className="r">Vol</th><th className="r">IV</th><th className="r">Δ</th><th className="r">Θ</th><th className="r">Spread</th><th className="r">Bid / Ask</th><th className="r">CE LTP</th>
        <th style={{ textAlign: "center" }}>Strike</th><th>PE LTP</th><th>Bid / Ask</th><th>Spread</th><th>Δ</th><th>Θ</th><th>IV</th><th>Vol</th><th>OI</th></tr></thead>
      <tbody>{near.map(s => <tr key={s.strike} className={s.strike === atm ? "atm" : ""}>
        <td className={`r num ${s.strike < ch.spot ? "itm" : ""}`}>{oiBar(s.ce?.oi, false)}</td><td className="r num muted">{s.ce?.volume?.toLocaleString("en-IN") ?? "n/a"}</td><td className="r num">{fmt(s.ce?.iv, 1)}</td>
        <td className="r num">{fmt(s.ce?.delta, 2)}</td><td className="r num muted">{fmt(s.ce?.theta, 1)}</td><td className="r num muted">{spread(s.ce)}</td>
        <td className="r num muted">{s.ce?.bid ? `${fmt(s.ce.bid)} / ${fmt(s.ce.ask)}` : "n/a"}</td><td className={`r num ${s.strike < ch.spot ? "itm" : ""}`}><b>{fmt(s.ce?.ltp)}</b></td>
        <td className="strike num">{s.strike}{s.strike === atm && <small className="muted"> ATM</small>}</td>
        <td className={`num ${s.strike > ch.spot ? "itm" : ""}`}><b>{fmt(s.pe?.ltp)}</b></td><td className="num muted">{s.pe?.bid ? `${fmt(s.pe.bid)} / ${fmt(s.pe.ask)}` : "n/a"}</td><td className="num muted">{spread(s.pe)}</td>
        <td className="num">{fmt(s.pe?.delta, 2)}</td><td className="num muted">{fmt(s.pe?.theta, 1)}</td><td className="num">{fmt(s.pe?.iv, 1)}</td><td className="num muted">{s.pe?.volume?.toLocaleString("en-IN") ?? "n/a"}</td>
        <td className="num">{oiBar(s.pe?.oi, true)}</td></tr>)}</tbody></table></div>}
    <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Greeks/IV sirf wahi dikhaye jaate hain jo Dhan deta hai; missing = "n/a". Dhan option-chain rate limit: 1 request / 3 sec. Shaded = in-the-money.</p>
  </section>;
}

/** Compact chain for the Markets side panel: CE | strike | PE around ATM. */
export function MiniChain({ symKey, symbol, eligible }: { symKey: string | null; symbol: string; eligible: boolean }) {
  const [exp, setExp] = useState(""); const [lastKey, setLastKey] = useState(symKey);
  if (lastKey !== symKey) { setLastKey(symKey); setExp(""); }
  const { data, error } = usePoll<{ expiries: string[]; chain: Chain | null }>(symKey && eligible ? `/api/option-chain?key=${encodeURIComponent(symKey)}${exp ? `&expiry=${exp}` : ""}` : null, 15000);
  const ch = data?.chain ?? null;
  const atm = ch?.strikes.length ? ch.strikes.reduce((a, b) => Math.abs(b.strike - ch.spot) < Math.abs(a.strike - ch.spot) ? b : a).strike : null;
  const ai = ch && atm !== null ? ch.strikes.findIndex(s => s.strike === atm) : -1;
  const near = ch && ai >= 0 ? ch.strikes.slice(Math.max(0, ai - 8), ai + 9) : [];
  const maxOi = Math.max(1, ...near.flatMap(s => [s.ce?.oi ?? 0, s.pe?.oi ?? 0]));
  const pcr = near.length ? near.reduce((a, s) => a + (s.pe?.oi ?? 0), 0) / Math.max(1, near.reduce((a, s) => a + (s.ce?.oi ?? 0), 0)) : null;
  const bar = (v: number | null | undefined, side: "ce" | "pe") => <div style={{ height: 3, marginTop: 2, borderRadius: 2, width: `${((v ?? 0) / maxOi) * 100}%`, background: side === "ce" ? "#ff5d7399" : "#2fd08a99", marginLeft: side === "ce" ? "auto" : 0 }} />;
  return <section className="card" style={{ padding: 12, display: "flex", flexDirection: "column", minHeight: 0 }}>
    <div className="card-head" style={{ marginBottom: 8, gap: 6 }}>
      <h2 style={{ fontSize: 14 }}>⛓ {symbol} options</h2>
      {ch && <Chip kind={ch.source === "DHAN" ? "ok" : "warn"}>{ch.source}</Chip>}
    </div>
    {!eligible ? <div className="empty">{symbol} F&O mein listed nahi hai — option chain available nahi.</div> : <>
      <div className="actions" style={{ gap: 6, marginBottom: 8, alignItems: "center" }}>
        <Select options={(data?.expiries ?? []).map(e => ({ value: e, label: e }))} value={exp || ch?.expiry || ""} onChange={setExp} size="sm" placeholder="Expiry" ariaLabel="Expiry" />
        {ch && <span className="muted num" style={{ fontSize: 12 }}>Spot {fmt(ch.spot)} · PCR {pcr ? pcr.toFixed(2) : "n/a"}</span>}
      </div>
      {error && <div className="note bad">{error}</div>}
      {!ch && !error && <div className="empty">Loading…</div>}
      {ch && <div className="table-wrap" style={{ overflowY: "auto", flex: 1 }}><table className="oc">
        <thead><tr><th className="r">CE OI</th><th className="r">CE LTP</th><th style={{ textAlign: "center" }}>Strike</th><th>PE LTP</th><th>PE OI</th></tr></thead>
        <tbody>{near.map(s => <tr key={s.strike} className={s.strike === atm ? "atm" : ""}>
          <td className={`r num muted ${s.strike < ch.spot ? "itm" : ""}`} style={{ fontSize: 11 }}>{s.ce?.oi != null ? (s.ce.oi / 1000).toFixed(0) + "k" : "n/a"}{bar(s.ce?.oi, "ce")}</td>
          <td className={`r num ${s.strike < ch.spot ? "itm" : ""}`}><b>{fmt(s.ce?.ltp)}</b><br /><small className="muted">Δ {fmt(s.ce?.delta, 2)}</small></td>
          <td className="strike num">{s.strike}{s.strike === atm && <><br /><small className="muted">ATM</small></>}</td>
          <td className={`num ${s.strike > ch.spot ? "itm" : ""}`}><b>{fmt(s.pe?.ltp)}</b><br /><small className="muted">Δ {fmt(s.pe?.delta, 2)}</small></td>
          <td className={`num muted ${s.strike > ch.spot ? "itm" : ""}`} style={{ fontSize: 11 }}>{s.pe?.oi != null ? (s.pe.oi / 1000).toFixed(0) + "k" : "n/a"}{bar(s.pe?.oi, "pe")}</td>
        </tr>)}</tbody></table></div>}
      {ch && <p className="muted" style={{ fontSize: 11, margin: "8px 0 0" }}>ATM ±8 strikes · {istTime(ch.fetchedAt)} · refresh 15s · shaded = ITM</p>}
    </>}
  </section>;
}
