import { Fragment, useState } from "react";
import { usePoll, fmt, istDateTime } from "../lib.tsx";

type Sig = { id: string; createdAt: string; barTime: string; underlying: string; strategyId: string; strategyVersion: string; direction: string; action: string; reasons: string[]; checks: Array<{ name: string; pass: boolean; detail: string }>; entry: number | null; stop: number | null; target: number | null; dataFresh: boolean; dataSource: string };

export function Signals() {
  const [filter, setFilter] = useState(""); const [open, setOpen] = useState<string | null>(null);
  const { data } = usePoll<Sig[]>(`/api/signals${filter ? `?action=${filter}` : ""}`, 5000);
  return <section className="card">
    <div className="card-head"><h2>Signal explorer <span className="sub">har decision ka reason · candle close par evaluate</span></h2>
      <div className="tabs">{[["", "All"], ["ENTER", "Enter"], ["WATCH", "Watch"], ["NO_TRADE", "No trade"]].map(([v, l]) => <button key={v} className={filter === v ? "on" : ""} onClick={() => setFilter(v!)}>{l}</button>)}</div></div>
    {!data?.length ? <div className="empty">Abhi signals nahi hain. Setup mein strategy enable karke Dashboard se auto engine start karein.</div> :
      <div className="table-wrap"><table><thead><tr><th>Bar (IST)</th><th>Underlying</th><th>Strategy @ style</th><th>Action</th><th>Direction</th><th className="r">Entry</th><th className="r">Stop</th><th className="r">Target</th><th>Why</th></tr></thead>
        <tbody>{data.map(s => <Fragment key={s.id}>
          <tr className="click" onClick={() => setOpen(open === s.id ? null : s.id)}>
            <td className="num">{istDateTime(s.barTime)}</td><td><b>{s.underlying}</b></td><td>{s.strategyId} <span className="dim">v{s.strategyVersion}</span></td>
            <td><span className={`pill ${s.action}`}>{s.action}</span></td><td><span className={`pill ${s.direction}`}>{s.direction}</span></td>
            <td className="r num">{fmt(s.entry)}</td><td className="r num">{fmt(s.stop)}</td><td className="r num">{fmt(s.target)}</td>
            <td className="muted" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>{s.reasons[0]} {open === s.id ? "▴" : "▾"}</td></tr>
          {open === s.id && <tr><td colSpan={9} style={{ whiteSpace: "normal", background: "var(--bg2)" }}>
            <div className="checks">{s.checks.map(c => <div key={c.name}><span className={c.pass ? "up" : "down"}>{c.pass ? "✓ PASS" : "✗ FAIL"}</span><span className="k">{c.name}</span><span className="num muted">{c.detail}</span></div>)}</div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Data: {s.dataSource} · fresh: {s.dataFresh ? "yes" : "no"} · ENTER tabhi jab har check PASS ho. Uske baad bhi independent risk engine approve kare tabhi paper trade.</p></td></tr>}
        </Fragment>)}</tbody></table></div>}
  </section>;
}
