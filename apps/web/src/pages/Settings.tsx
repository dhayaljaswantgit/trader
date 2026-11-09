import { useState } from "react";
import { api, usePoll, Chip, istDateTime } from "../lib.tsx";
import type { Health } from "../App.tsx";

export function Settings({ health }: { health: Health | null }) {
  const [cid, setCid] = useState(""); const [tok, setTok] = useState(""); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const { data: audit } = usePoll<any[]>("/api/audit", 6000);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setErr(""); setMsg(""); try { await fn(); setMsg(ok); } catch (e) { setErr((e as Error).message); } };
  const t = health?.token;
  return <>
    <section className="card">
      <div className="card-head"><h2>🔌 Dhan connection</h2>
        {t?.configured ? <Chip kind="ok">Credentials saved · {t.clientIdMasked}</Chip> : <Chip kind="warn">Not configured</Chip>}
        {t?.expiresAt && <Chip kind={Date.parse(t.expiresAt) < Date.now() ? "bad" : "info"}>Token expiry {istDateTime(t.expiresAt)}</Chip>}</div>
      <ol className="muted" style={{ marginTop: 0, paddingLeft: 18, lineHeight: 1.8 }}>
        <li>Dhan web → <b>DhanHQ Trading APIs</b> → <b>Data APIs</b> plan subscribe karein (₹499/month is enough — neeche dekhein).</li>
        <li><b>Generate Access Token</b> → token copy karein (ye ~24 ghante valid rehta hai; roz naya banana padega).</li>
        <li>Neeche Client ID + token paste karke Save → phir <b>Use Dhan live data</b>.</li>
      </ol>
      <div className="form-grid">
        <label className="field"><span>Dhan Client ID</span><input className="input num" autoComplete="off" value={cid} onChange={e => setCid(e.target.value)} placeholder="e.g. 1100xxxxxx" /></label>
        <label className="field" style={{ gridColumn: "span 2" }}><span>Access token (sirf aapke Mac par data/dhan.json mein save hoga, browser ko wapas kabhi nahi bheja jata)</span><input className="input num" type="password" autoComplete="off" value={tok} onChange={e => setTok(e.target.value)} placeholder="eyJ…" /></label>
      </div>
      <div className="actions" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={!cid || !tok} onClick={() => act(async () => { await api("/api/settings/dhan", { json: { clientId: cid, accessToken: tok } }); setTok(""); }, "✓ Credentials saved")}>💾 Save credentials</button>
        <button className="btn go" onClick={() => act(() => api("/api/settings/source", { json: { source: "DHAN" } }), "✓ Switched to Dhan live data")}>Use Dhan live data</button>
        <button className="btn" onClick={() => act(() => api("/api/settings/source", { json: { source: "MOCK" } }), "✓ Switched to mock data")}>Use mock data</button>
        <button className="btn" onClick={() => act(() => api("/api/instruments/sync", { method: "POST" }), "Instrument sync started")}>⟳ Sync instrument master</button>
      </div>
      {msg && <p className="up">{msg}</p>}{err && <p className="err" role="alert">{err}</p>}
      {health && <p className="muted" style={{ fontSize: 13 }}>Source: <b>{health.broker.source}</b> — {health.broker.detail}<br />
        Instruments: <b>{health.instruments.total.toLocaleString("en-IN")}</b> {health.instruments.running ? "(syncing…)" : health.instruments.lastSync ? `· synced ${istDateTime(health.instruments.lastSync)}` : "(seed only — sync pending)"} {health.instruments.error && <span className="err">· {health.instruments.error}</span>}</p>}
    </section>

    <section className="card">
      <h2>💡 Kaunsa Dhan plan?</h2>
      <div className="grid g2">
        <div className="note"><b>✓ Data APIs — ₹499/month (recommended)</b><br />Live quotes, intraday + daily history (backtest), option chain with Greeks, expired options data. Is system ki har zaroorat isse puri hoti hai.</div>
        <div className="note warn"><b>Pro — ₹999/month (abhi zaroorat nahi)</b><br />200-level depth, Technical/Market-movers/News APIs. Indicators hum khud calculate karte hain; 200-depth sirf high-frequency scalping mein marginal help karta hai; news ko safely trading rule banane ke liye alag research chahiye. Zyada data ≠ zyada profit. Paper results 20+ sessions positive aayein, tab sochenge.</div>
      </div>
    </section>

    <section className="card">
      <h2>🛡 Safety status</h2>
      <div className="seg"><Chip kind="ok">Mode: PAPER (hard-coded)</Chip><Chip kind="ok">Live order route: does not exist</Chip><Chip kind="ok">Engine starts OFF after restart</Chip><Chip kind="ok">Option selling: blocked</Chip><Chip kind="ok">Max 1 open position · 3-loss pause</Chip></div>
    </section>

    <section className="card">
      <h2>📜 Audit log <span className="sub">— append-only</span></h2>
      {!audit?.length ? <div className="empty">No events</div> : <div className="table-wrap" style={{ maxHeight: 460, overflowY: "auto" }}><table><thead><tr><th>Time (IST)</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>{audit.map(a => <tr key={a.id}><td className="num" style={{ fontSize: 12 }}>{istDateTime(a.at)}</td><td><b>{a.action}</b></td><td className="muted num" style={{ fontSize: 12, whiteSpace: "normal" }}>{JSON.stringify(a.details)}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}
