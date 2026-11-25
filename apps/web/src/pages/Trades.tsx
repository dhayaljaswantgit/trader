import { StopCell } from "./StopCell.tsx";
import { useState } from "react";
import { usePoll, fmt, inr, Pnl, LineChart, istDateTime } from "../lib.tsx";
import { livePnl, type Trade } from "./Dashboard.tsx";

export function Trades() {
  const [mode, setMode] = useState<"PAPER" | "LIVE">(() => { try { return localStorage.getItem("tradesMode") === "LIVE" ? "LIVE" : "PAPER"; } catch { return "PAPER"; } });
  const pick = (m: "PAPER" | "LIVE") => { setMode(m); try { localStorage.setItem("tradesMode", m); } catch { /* ignore */ } };
  const { data: pos } = usePoll<{ open: Trade[]; closed: Trade[] }>(`/api/positions?mode=${mode}`, 3000);
  const { data: perf } = usePoll<any>(`/api/performance?mode=${mode}`, 8000);
  const L = mode === "LIVE";
  return <>
    <div className="tabs" role="tablist" style={{ justifySelf: "start" }}>
      <button role="tab" aria-selected={!L} className={!L ? "on" : ""} onClick={() => pick("PAPER")}>📝 Paper</button>
      <button role="tab" aria-selected={L} className={L ? "on" : ""} onClick={() => pick("LIVE")}>🔴 Live (Dhan)</button>
    </div>
    <section className="card">
      <h2>{L ? "🔴 Live performance" : "Paper performance"} <span className="sub">— all sessions{L ? " · asli Dhan orders" : ""}</span></h2>
      <div className="kpis">
        <div className="kpi"><div className="l">Net P&L</div><div className="v"><Pnl v={perf?.net} /></div></div>
        <div className="kpi"><div className="l">Trades</div><div className="v">{perf?.trades ?? 0}</div><div className="s">{perf?.sessionsCount ?? 0} sessions</div></div>
        <div className="kpi"><div className="l">Win rate</div><div className="v">{perf?.winRate == null ? "—" : (perf.winRate * 100).toFixed(1) + "%"}</div></div>
        <div className="kpi"><div className="l">Expectancy / trade</div><div className="v">{inr(perf?.expectancy)}</div><div className="s">net of charges</div></div>
        <div className="kpi"><div className="l">Profit factor</div><div className="v">{fmt(perf?.profitFactor)}</div></div>
        <div className="kpi"><div className="l">Avg win / loss</div><div className="v" style={{ fontSize: 15 }}>{inr(perf?.avgWin, 0)} / {inr(perf?.avgLoss, 0)}</div></div>
      </div>
      <div style={{ marginTop: 14 }}><LineChart points={perf?.curve ?? []} baseline={0} /></div>
      {!L && perf && perf.sessionsCount < 20 && <div className="note warn" style={{ marginTop: 12 }}>Sirf {perf.sessionsCount} session(s). Live par jaane se pehle kam se kam 20+ sessions ka paper record chahiye — aur tab bhi ye guarantee nahi hai.</div>}
    </section>
    <section className="card">
      <h2>{L ? "Live" : "Paper"} open positions</h2>
      {!pos?.open.length ? <div className="empty">None</div> : <TradeTable rows={pos.open} live />}
    </section>
    <section className="card">
      <h2>{L ? "Live" : "Paper"} closed trades <span className="sub">— {L ? "Dhan ka asli fill price" : "fill assumptions transparent"}</span></h2>
      {!pos?.closed.length ? <div className="empty">{L ? "Abhi koi live trade nahi hua" : "Abhi koi closed trade nahi"}</div> : <TradeTable rows={pos.closed} />}
    </section>
  </>;
}

function TradeTable({ rows, live }: { rows: Trade[]; live?: boolean }) {
  return <div className="table-wrap"><table><thead><tr><th>{live ? "Opened" : "Closed"}</th><th>Contract</th><th>Side</th><th className="r">Qty</th><th className="r">Entry</th><th className="r">{live ? "LTP" : "Exit"}</th><th className="r">Charges</th><th className="r">P&L</th><th>{live ? "SL / TGT" : "Reason"}</th><th>Fill note</th></tr></thead>
    <tbody>{rows.map(t => <tr key={t.id}>
      <td className="num" style={{ fontSize: 12 }}>{istDateTime(live ? t.openedAt : t.closedAt)}</td>
      <td className="sym"><b>{t.contract}</b><small>{t.kind} · {t.product} · {t.strategyId} · {t.dataSource}</small></td>
      <td><span className={`pill ${t.side}`}>{t.side}</span></td><td className="r num">{t.quantity}</td><td className="r num">{fmt(t.entryPrice)}</td>
      <td className="r num">{fmt(live ? t.lastPrice : t.exitPrice)}</td><td className="r num muted">{fmt(Number(t.entryCharges) + Number(t.exitCharges))}</td>
      <td className="r"><Pnl v={live ? livePnl(t) : t.pnlInr} /></td>
      <td>{live ? <StopCell t={t} /> : <span className="pill NEUTRAL">{t.exitReason}</span>}</td>
      <td className="muted" style={{ fontSize: 12, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }} title={t.fillNote}>{t.fillNote}</td></tr>)}</tbody></table></div>;
}
