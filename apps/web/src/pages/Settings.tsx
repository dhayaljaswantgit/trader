import { ChatSettings } from "./Chat.tsx";
import { useState } from "react";
import { api, usePoll, Chip, istDateTime, getVenue, authorizeDhan, loginDhan, Switch } from "../lib.tsx";
import type { Health } from "../App.tsx";

function AuditLog() {
  const { data: audit } = usePoll<any[]>("/api/audit", 6000);
  return <section className="card">
    <h2>📜 Audit log <span className="sub">— append-only · {getVenue() === "DELTA" ? "₿ Delta events" : "🇮🇳 Dhan events"}</span></h2>
    {!audit?.length ? <div className="empty">No events</div> : <div className="table-wrap" style={{ maxHeight: 460, overflowY: "auto" }}><table><thead><tr><th>Time (IST)</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>{audit.map(a => <tr key={a.id}><td className="num" style={{ fontSize: 12 }}>{istDateTime(a.at)}</td><td><b>{a.action}</b></td><td className="muted num" style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{JSON.stringify(a.details)}</td></tr>)}</tbody></table></div>}
  </section>;
}

type DeltaStatus = { running: boolean; lastSync: string | null; count: number; error: string | null; instruments: number; health: { connected: boolean; detail: string; checkedAt: string }; usdInr: number; leverage: number };
function DeltaSettings() {
  const { data: st, reload } = usePoll<DeltaStatus>("/api/delta/status", 30000);
  const [f, setF] = useState<{ usdInr: string; leverage: string } | null>(null);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState("");
  const vals = f ?? (st ? { usdInr: String(st.usdInr), leverage: String(st.leverage) } : null);
  const act = async (k: string, fn: () => Promise<unknown>, ok: string) => { setBusy(k); setErr(""); setMsg(""); try { await fn(); setMsg(ok); reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); } };
  return <>
    <section className="card">
      <div className="card-head"><h2>₿ Delta Exchange connection</h2>
        {st ? <Chip kind={st.health.connected ? "ok" : "bad"}>{st.health.connected ? "Connected" : "Not reachable"}</Chip> : <Chip>checking…</Chip>}
        {st && <Chip kind="info">{st.instruments} perpetuals synced</Chip>}</div>
      <div className="note" style={{ marginBottom: 12 }}><b>Kuch connect karne ki zaroorat nahi — ye already connected hai.</b> App Delta Exchange <b>India</b> ki <b>public market-data API</b> (api.india.delta.exchange) use karta hai:
        prices, candles aur instruments ke liye <b>koi account, API key ya fee nahi</b> lagti. Paper trading bhi Delta ke live bid/ask par simulate hoti hai — koi asli order nahi jata.</div>
      <ol className="muted" style={{ marginTop: 0, paddingLeft: 18, lineHeight: 1.8 }}>
        <li>Upar-left switch se <b>₿ Delta</b> chunein (ye page, Dashboard, Trade Setup, Markets — sab Delta ke ho jaate hain).</li>
        <li><b>Trade Setup</b> → "+ BTC · ETH · SOL · XRP" → strategies chunein → Save.</li>
        <li><b>Dashboard</b> → Start Day (capital ₹) → ▶ Start auto engine. Dhan ka engine alag chalta rehta hai.</li>
      </ol>
      <div className="actions" style={{ gap: 8 }}>
        <button className="btn" disabled={busy === "test"} onClick={() => act("test", async () => reload(), "✓ Connection checked")}>{busy === "test" ? "⏳" : "🔌"} Test connection</button>
        <button className="btn" disabled={busy === "sync"} onClick={() => act("sync", () => api("/api/delta/sync", { method: "POST" }), "✓ Delta instruments synced")}>{busy === "sync" ? "⏳ Syncing…" : "⟳ Sync Delta instruments"}</button>
      </div>
      {msg && <p className="up">{msg}</p>}{err && <p className="err" role="alert">{err}</p>}
      {st && <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>Live check: <b>{st.health.detail}</b> (USD) · checked {istDateTime(st.health.checkedAt)}
        {st.lastSync && <> · instruments synced {istDateTime(st.lastSync)}</>}{st.error && <span className="err"> · sync error: {st.error}</span>}</p>}
    </section>

    <section className="card">
      <h2>⚙ Crypto settings <span className="sub">— backtests + paper trading dono mein use</span></h2>
      {vals && <div className="form-grid">
        <label className="field"><span>₹ per USD (Delta prices USD mein hain → ₹ mein P&L)</span><input className="input num" type="number" step={0.01} value={vals.usdInr} onChange={e => setF({ ...vals, usdInr: e.target.value })} /></label>
        <label className="field"><span>Default leverage (×) — margin per contract = contract value ÷ leverage</span><input className="input num" type="number" min={1} max={100} value={vals.leverage} onChange={e => setF({ ...vals, leverage: e.target.value })} /></label>
      </div>}
      <div className="actions" style={{ marginTop: 12 }}><button className="btn primary" disabled={!f || busy === "save"} onClick={() => act("save", async () => { await api("/api/settings/delta", { method: "PUT", json: { usdInr: Number(vals!.usdInr), leverage: Number(vals!.leverage) } }); setF(null); }, "✓ Crypto settings saved")}>💾 Save</button></div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Rate fixed hai (live USD/INR nahi) — Delta India par deposit/withdraw jis rate par hota hai wahi daalein. Leverage zyada = kam margin, par loss bhi utni hi tezi se.</p>
    </section>

    <section className="card">
      <h2>🔑 Delta API key <span className="sub">— abhi zaroorat nahi</span></h2>
      <p className="muted" style={{ margin: 0 }}>Ye build <b>paper-only</b> hai — orders kabhi exchange par nahi jaate, isliye API key ki zaroorat nahi aur hum key store nahi karte.
        Key sirf tab chahiye jab Delta <b>testnet</b> ya live par asli orders bhejne hon (future phase). Tab bhi key sirf <b>Read + Trade</b> permission ke saath banayein — <b>Withdraw kabhi nahi</b> — aur IP whitelist lagayein.</p>
    </section>

    <section className="card">
      <h2>🛡 Safety status</h2>
      <div className="seg"><Chip kind="ok">Mode: PAPER (hard-coded)</Chip><Chip kind="ok">Live order route: does not exist</Chip><Chip kind="ok">Engine starts OFF after restart</Chip>
        <Chip kind="ok">Separate capital & limits from Dhan</Chip><Chip kind="warn">Funding payments not modelled</Chip><Chip kind="warn">24x7 — no auto square-off</Chip></div>
    </section>
    <ChatSettings />
    <AuditLog />
  </>;
}

export function Settings({ health }: { health: Health | null }) {
  if (getVenue() === "DELTA") return <DeltaSettings />;
  return <DhanSettings health={health} />;
}
type DhanApp = { configured: boolean; clientIdMasked: string | null; apiKeyMasked: string | null; savedAt: string | null; redirectUrl: string;
  renew: { lastAttempt: string | null; lastOk: string | null; lastError: string | null }; token: { configured: boolean; expiresAt: string | null } };
function DhanOneClick() {
  const { data: a, reload } = usePoll<DhanApp>("/api/settings/dhan-app", 30000);
  const [f, setF] = useState({ clientId: "", apiKey: "", apiSecret: "" }); const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState("");
  const act = async (k: string, fn: () => Promise<unknown>, ok: string) => { setBusy(k); setErr(""); setMsg(""); try { await fn(); setMsg(ok); reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); } };
  if (!a) return null;
  const exp = a.token.expiresAt ? Date.parse(a.token.expiresAt) : null, left = exp ? (exp - Date.now()) / 3600000 : null;
  const showSetup = !a.configured || edit;
  return <section className="card">
    <div className="card-head"><h2>🔐 Login via Dhan page <span className="sub">— alternative: API key + Dhan login page</span></h2>
      {a.configured ? <Chip kind="ok">API key saved · {a.apiKeyMasked}</Chip> : <Chip kind="warn">One-time setup baaki</Chip>}
      {left != null && <Chip kind={left <= 0 ? "bad" : left < 3 ? "warn" : "ok"}>{left <= 0 ? "Token expired" : `Token valid · ${left.toFixed(1)}h left`}</Chip>}</div>
    {a.configured && !edit && <>
      <p className="muted" style={{ marginTop: 0 }}>Har din ek click: button dabayein → Dhan ka login page khulega (mobile/PIN + OTP/TOTP — ye SEBI ka daily login hai, skip nahi ho sakta) → login ke baad app mein wapas aa jayenge, token apne aap save. Copy-paste nahi.</p>
      <div className="actions" style={{ gap: 8 }}>
        <button className="btn primary big" disabled={busy === "auth"} onClick={() => act("auth", authorizeDhan, "Dhan login khul raha hai…")}>{busy === "auth" ? "⏳ Opening Dhan…" : "🔐 Authorize with Dhan"}</button>
        <button className="btn" disabled={busy === "renew" || !left || left <= 0} onClick={() => act("renew", () => api("/api/dhan/renew", { method: "POST" }), "✓ Token 24 ghante ke liye renew ho gaya")} title="Valid token ko 24h aur badhao (Dhan: sirf Dhan-Web tokens)">⟳ Renew now</button>
        <button className="btn sm" onClick={() => setEdit(true)}>Edit API key</button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Auto-renew: har 10 min check — token expire hone se 3 ghante pehle tak valid ho to app khud renew karta hai (jab tak app chal raha hai).
        {a.renew.lastOk && <> Last renew ✓ {istDateTime(a.renew.lastOk)}.</>}{a.renew.lastError && <span className="warn"> Last renew failed: {a.renew.lastError} — iss case mein roz 'Authorize with Dhan' dabayein.</span>}</p>
    </>}
    {showSetup && <>
      <ol className="muted" style={{ marginTop: 0, paddingLeft: 18, lineHeight: 1.9 }}>
        <li><b>web.dhan.co</b> par login → <b>My Profile</b> → <b>"Get Trading &amp; Data APIs"</b>.</li>
        <li>Upar toggle ko <b>"Access Token"</b> se <b>"API Key"</b> par switch karein.</li>
        <li><b>App Name</b> kuch bhi (e.g. AI Trader); <b>Redirect URL</b> mein ye paste karein (Postback URL khali chhod dein): <code className="num">{a.redirectUrl}</code> <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(a.redirectUrl); setMsg("✓ Redirect URL copied"); }}>Copy</button></li>
        <li><b>"Generate API Key"</b> → <b>API Key</b> aur <b>API Secret</b> copy karein (12 mahine valid). Neeche apne Client ID ke saath Save.</li>
        <li className="dim">Option nahi dikh raha? Dhan app/web update karein, ya Dhan support se "API Key (consent login)" enable karwayein. Tab tak neeche <b>Manual token</b> use karein.</li>
      </ol>
      <div className="form-grid">
        <label className="field"><span>Dhan Client ID</span><input className="input num" autoComplete="off" value={f.clientId} onChange={e => setF({ ...f, clientId: e.target.value })} placeholder="e.g. 1100xxxxxx" /></label>
        <label className="field"><span>API key</span><input className="input num" autoComplete="off" value={f.apiKey} onChange={e => setF({ ...f, apiKey: e.target.value })} /></label>
        <label className="field"><span>API secret (sirf aapke Mac par data/dhan_app.json mein, browser ko wapas nahi)</span><input className="input num" type="password" autoComplete="off" value={f.apiSecret} onChange={e => setF({ ...f, apiSecret: e.target.value })} /></label>
      </div>
      <div className="actions" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={!f.clientId || !f.apiKey || !f.apiSecret || busy === "save"} onClick={() => act("save", async () => { await api("/api/settings/dhan-app", { method: "PUT", json: f }); setF({ clientId: "", apiKey: "", apiSecret: "" }); setEdit(false); }, "✓ Saved — ab 'Authorize with Dhan' dabayein")}>💾 Save API key</button>
        {edit && <button className="btn" onClick={() => setEdit(false)}>Cancel</button>}
      </div>
    </>}
    {msg && <p className="up">{msg}</p>}{err && <p className="err" role="alert">{err}</p>}
  </section>;
}

type Instant = { configured: boolean; clientIdMasked: string | null; autoLogin: boolean; savedAt: string | null;
  state: { lastAttempt: string | null; lastOk: string | null; lastError: string | null }; token: { expiresAt: string | null } };
function DhanInstant() {
  const { data: a, reload } = usePoll<Instant>("/api/settings/dhan-instant", 15000);
  const [f, setF] = useState({ clientId: "", pin: "", secret: "", autoLogin: true }); const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState("");
  const act = async (k: string, fn: () => Promise<unknown>, ok: string) => { setBusy(k); setErr(""); setMsg(""); try { await fn(); setMsg(ok); reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); } };
  if (!a) return null;
  const exp = a.token.expiresAt ? Date.parse(a.token.expiresAt) : null, left = exp ? (exp - Date.now()) / 3600000 : null;
  return <section className="card">
    <div className="card-head"><h2>⚡ Instant login <span className="sub">— Dhan ka official PIN + TOTP login, browser nahi</span></h2>
      {a.configured ? <Chip kind="ok">Setup done · {a.clientIdMasked}</Chip> : <Chip kind="warn">One-time setup baaki</Chip>}
      {left != null && <Chip kind={left <= 0 ? "bad" : left < 3 ? "warn" : "ok"}>{left <= 0 ? "Token expired" : `Token valid · ${left.toFixed(1)}h left`}</Chip>}</div>
    {a.configured && !edit && <>
      <div className="actions" style={{ gap: 10, alignItems: "center" }}>
        <button className="btn primary big" disabled={busy === "login"} onClick={() => act("login", loginDhan, "✓ Dhan connected — naya token save ho gaya (24 ghante valid)")}>{busy === "login" ? "⏳ Logging in…" : "⚡ Login with Dhan"}</button>
        <Switch on={a.autoLogin} onChange={v => act("auto", () => api("/api/settings/dhan-instant", { method: "PUT", json: { autoLogin: v } }), v ? "✓ Auto-login ON" : "Auto-login OFF")}
          label="Auto-login" sub="Token expire hote hi (app chalu ho to) apne aap login — ek click bhi nahi" />
        <span style={{ flex: 1 }} /><button className="btn sm" onClick={() => setEdit(true)}>Edit setup</button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{a.state.lastOk && <>Last login ✓ {istDateTime(a.state.lastOk)}. </>}{a.state.lastError && <span className="err">Last attempt failed: {a.state.lastError}</span>}</p>
    </>}
    {(!a.configured || edit) && <>
      <ol className="muted" style={{ marginTop: 0, paddingLeft: 18, lineHeight: 1.9 }}>
        <li><b>web.dhan.co</b> → My Profile → <b>"Get Trading &amp; Data APIs"</b> (DhanHQ Trading APIs) → <b>"Setup TOTP"</b>.</li>
        <li>Mobile/email OTP se confirm karein → QR code dikhega. QR ke saath dikhne wala <b>text code (secret)</b> copy karein — wahi neeche paste karna hai.
          QR ko apne authenticator app (Google/Microsoft Authenticator) mein bhi scan kar lein — Dhan setup confirm karne ke liye pehla 6-digit code maangta hai.</li>
        <li>Neeche <b>Client ID</b>, apna <b>Dhan PIN</b> aur <b>TOTP secret</b> daal kar Save.</li>
      </ol>
      <div className="note warn" style={{ marginBottom: 12 }}>⚠ PIN + TOTP secret milke aapke Dhan account ka <b>poora API access</b> dete hain (asli orders bhi). Ye sirf aapke Mac par <code>data/dhan_totp.json</code> mein (sirf aapka user padh sakta hai, git-ignored) save hote hain — browser ko kabhi wapas nahi bheje jaate.
        Mac par FileVault + password rakhein, aur <code>data</code> folder kisi ko share na karein. Ye app khud kabhi asli order nahi lagata.</div>
      <div className="form-grid">
        <label className="field"><span>Dhan Client ID</span><input className="input num" autoComplete="off" value={f.clientId} onChange={e => setF({ ...f, clientId: e.target.value })} placeholder="e.g. 1100xxxxxx" /></label>
        <label className="field"><span>Dhan PIN</span><input className="input num" type="password" inputMode="numeric" autoComplete="off" value={f.pin} onChange={e => setF({ ...f, pin: e.target.value.replace(/\D/g, "").slice(0, 6) })} /></label>
        <label className="field" style={{ gridColumn: "span 2" }}><span>TOTP secret (QR ke saath wala text code, e.g. JBSW Y3DP …)</span><input className="input num" type="password" autoComplete="off" value={f.secret} onChange={e => setF({ ...f, secret: e.target.value })} /></label>
      </div>
      <label className="actions" style={{ gap: 8, marginTop: 10, cursor: "pointer" }}><input type="checkbox" checked={f.autoLogin} onChange={e => setF({ ...f, autoLogin: e.target.checked })} /> Auto-login bhi on karein (token expire hote hi apne aap)</label>
      <div className="actions" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={!f.clientId || f.pin.length < 4 || !f.secret || busy === "save"} onClick={() => act("save", async () => { await api("/api/settings/dhan-instant", { method: "PUT", json: f }); setF({ clientId: "", pin: "", secret: "", autoLogin: true }); setEdit(false); await loginDhan(); }, "✓ Setup saved aur Dhan login ho gaya")}>💾 Save &amp; login</button>
        {edit && <button className="btn" onClick={() => setEdit(false)}>Cancel</button>}
      </div>
    </>}
    {msg && <p className="up">{msg}</p>}{err && <p className="err" role="alert">{err}</p>}
  </section>;
}

function DhanSettings({ health }: { health: Health | null }) {
  const [cid, setCid] = useState(""); const [tok, setTok] = useState(""); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const act = async (fn: () => Promise<unknown>, ok: string) => { setErr(""); setMsg(""); try { await fn(); setMsg(ok); } catch (e) { setErr((e as Error).message); } };
  const t = health?.token;
  return <>
    <DhanInstant />
    <DhanOneClick />
    <section className="card">
      <div className="card-head"><h2>🔌 Manual token <span className="sub">— alternative: Dhan web se token copy-paste</span></h2>
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

    <ChatSettings />
    <AuditLog />
  </>;
}
