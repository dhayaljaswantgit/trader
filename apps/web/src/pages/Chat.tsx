import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, usePoll, Chip, getVenue, withVenue, Select } from "../lib.tsx";

type ChatInfo = { provider: "local" | "api"; configured: boolean; cli: { found: boolean; version: string | null } | null; keyMasked: string | null; model: string; models: string[] };
type Msg = { role: "user" | "assistant"; content: string; at: number };
const MODEL_LABEL: Record<string, string> = { "claude-opus-5-5": "Opus 5.5 — sabse acchi analysis", "claude-sonnet-5-5": "Sonnet 5.5 — balanced", "claude-haiku-5-5": "Haiku 5.5 — sabse sasta/fast" };

/** Claude API key + model (shown on the Chat page and in Settings, both exchanges). */
export function ChatSettings({ compact }: { compact?: boolean }) {
  const { data: c, reload } = usePoll<ChatInfo>("/api/settings/chat", 60000);
  const [key, setKey] = useState(""); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const save = async (body: object, ok: string) => { setErr(""); setMsg(""); try { await api("/api/settings/chat", { method: "PUT", json: body }); setKey(""); setMsg(ok); reload(); } catch (e) { setErr((e as Error).message); } };
  const local = c?.provider !== "api";
  return <section className="card">
    <div className="card-head"><h2>💬 Chat AI</h2>{c && <Chip kind={c.configured ? "ok" : "warn"}>{local ? (c.cli?.found ? `Local Claude Code ✓ ${c.cli.version ?? ""}` : "Claude Code nahi mila") : c.configured ? `API key ${c.keyMasked}` : "API key set nahi"}</Chip>}</div>
    {!compact && <div className="note" style={{ marginBottom: 12 }}>Chat sirf <b>read-only analysis</b> karta hai — app live data (spot, futures, option chain + OI, VIX, candles, aapki positions) khud bhejta hai. Ye <b>koi order place/modify/cancel nahi kar sakta</b>, engine ko bhi touch nahi karta.</div>}
    <div className="actions" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {c && <Select ariaLabel="AI provider" width={300} value={c.provider} onChange={v => save({ provider: v }, "✓ Provider changed")} options={[
        { value: "local", label: "🖥 Local Claude Code (aapka login)", sub: "Is Mac ka 'claude' — koi API key / extra bill nahi, subscription limits lagti hain" },
        { value: "api", label: "🔑 Anthropic API key", sub: "console.anthropic.com — pay per use" }]} />}
      {c && <Select ariaLabel="Model" width={260} value={c.model} onChange={v => save({ model: v }, "✓ Model changed")} options={c.models.map(m => ({ value: m, label: MODEL_LABEL[m]?.split(" — ")[0] ?? m, sub: MODEL_LABEL[m]?.split(" — ")[1] }))} />}
    </div>
    {c && !local && <div className="actions" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
      <input type="password" placeholder={c.configured ? "Nayi key (badalne ke liye)" : "sk-ant-…"} value={key} onChange={e => setKey(e.target.value)} style={{ minWidth: 260 }} autoComplete="off" />
      <button className="btn primary" disabled={!key.trim()} onClick={() => save({ apiKey: key }, "✓ Key saved")}>Save key</button>
      {c.configured && <button className="btn" onClick={() => save({ apiKey: "" }, "Key hata di")}>Remove</button>}
    </div>}
    {c && local && !c.cli?.found && <p className="err">Is Mac par <code>claude</code> command nahi mila. Terminal mein Claude Code install karke ek baar <code>claude</code> chala kar login karein, phir yahan refresh.</p>}
    {msg && <p className="up">{msg}</p>}{err && <p className="err" role="alert">{err}</p>}
  </section>;
}

/** Tiny markdown: **bold**, `code`, bullets, | tables |, headings. */
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).map((p, i) => p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b>
    : p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p.length > 2 && p.startsWith("_") && p.endsWith("_") ? <i key={i}>{p.slice(1, -1)}</i> : p);
}
function Md({ text }: { text: string }) {
  const lines = text.split("\n"), out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*\|/.test(l)) { const rows: string[][] = []; while (i < lines.length && /^\s*\|/.test(lines[i]!)) { const r = lines[i]!.trim().replace(/^\||\|$/g, "").split("|").map(x => x.trim()); if (!r.every(x => /^:?-{2,}:?$/.test(x))) rows.push(r); i++; } i--;
      out.push(<div key={i} className="tbl-wrap"><table className="tbl"><thead><tr>{rows[0]!.map((h, k) => <th key={k}>{inline(h)}</th>)}</tr></thead><tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table></div>); continue; }
    if (/^\s*[-*•] /.test(l)) { const items: string[] = []; while (i < lines.length && /^\s*[-*•] /.test(lines[i]!)) { items.push(lines[i]!.replace(/^\s*[-*•] /, "")); i++; } i--; out.push(<ul key={i}>{items.map((x, k) => <li key={k}>{inline(x)}</li>)}</ul>); continue; }
    if (/^#{1,4} /.test(l)) { out.push(<h4 key={i} style={{ margin: "8px 0 4px" }}>{inline(l.replace(/^#+ /, ""))}</h4>); continue; }
    if (l.trim()) out.push(<p key={i} style={{ margin: "4px 0" }}>{inline(l)}</p>);
  }
  return <>{out}</>;
}

const QUICK_DHAN = ["Abhi CE ya PE? Kaunsa strike?", "OI walls kahan hain, support/resistance batao", "Meri open position ka kya karun — stoploss kahan?", "BANKNIFTY mein abhi kya setup hai?"];
const QUICK_DELTA = ["BTC abhi long ya short?", "BTC ke support/resistance levels batao", "Meri open position ka stop kahan rakhun?", "ETH ka setup kya hai?"];

export function Chat() {
  const venue = getVenue(), store = `chat:${venue}:${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}`;
  const { data: c } = usePoll<ChatInfo>("/api/settings/chat", 60000);
  const [msgs, setMsgs] = useState<Msg[]>(() => { try { return JSON.parse(localStorage.getItem(store) ?? "[]"); } catch { return []; } });
  const [q, setQ] = useState(""); const [busy, setBusy] = useState(false); const [snap, setSnap] = useState<object | null>(null);
  const abort = useRef<AbortController | null>(null), end = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem(store, JSON.stringify(msgs)); } catch { /* ignore */ } end.current?.scrollIntoView({ block: "end" }); }, [msgs, store]);

  const send = async (text: string) => {
    const question = text.trim(); if (!question || busy) return;
    const history = msgs.map(({ role, content }) => ({ role, content }));
    setQ(""); setBusy(true); setMsgs(m => [...m, { role: "user", content: question, at: Date.now() }, { role: "assistant", content: "", at: Date.now() }]);
    const ac = new AbortController(); abort.current = ac;
    const put = (s: string) => setMsgs(m => { const n = [...m]; n[n.length - 1] = { ...n[n.length - 1]!, content: s }; return n; });
    let acc = "";
    try {
      const r = await fetch(withVenue("/api/chat"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, history }), signal: ac.signal });
      if (!r.ok || !r.body) { const j = await r.json().catch(() => null); throw new Error(j?.message ?? j?.error ?? `HTTP ${r.status}`); }
      const rd = r.body.getReader(), dec = new TextDecoder();
      for (;;) { const { done, value } = await rd.read(); if (done) break; acc += dec.decode(value, { stream: true }); put(acc); }
    } catch (e) { if ((e as Error).name !== "AbortError") put(`${acc}\n\n⚠️ ${(e as Error).message}`); }
    finally { setBusy(false); abort.current = null; }
  };

  if (c && !c.configured) return <div style={{ display: "grid", gap: 12 }}><ChatSettings /></div>;
  return <div style={{ display: "grid", gap: 12 }}>
    <section className="card" style={{ display: "flex", flexDirection: "column", minHeight: "70vh" }}>
      <div className="card-head"><h2>💬 Market chat — {venue === "DELTA" ? "₿ Delta" : "Dhan / NSE"}</h2>
        <Chip kind="ok">Read-only · koi order nahi</Chip>{c && <Chip kind="info">{MODEL_LABEL[c.model]?.split(" —")[0] ?? c.model}</Chip>}
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={async () => setSnap(await api(`/api/chat/snapshot?q=${encodeURIComponent(q)}`))}>🔍 Data dekho</button>
        <button className="btn sm" disabled={busy || !msgs.length} onClick={() => setMsgs([])}>🗑 Clear</button></div>
      <div style={{ flex: 1, overflowY: "auto", display: "grid", gap: 10, alignContent: "start", maxHeight: "62vh", paddingRight: 4 }}>
        {!msgs.length && <div className="muted" style={{ padding: 12 }}>Puchiye — app har sawal ke saath <b>abhi ka live data</b> (spot, futures, option chain + OI change, VIX, 5/15-min candles, aapki positions) khud bhejega. Screenshot ki zaroorat nahi.
          <br />Ye sirf salah hai, financial advice nahi — decision aapka. Chat market ko live watch nahi karta; har baar puchne par fresh data leta hai.</div>}
        {msgs.map((m, i) => <div key={i} style={{ justifySelf: m.role === "user" ? "end" : "start", maxWidth: "88%", padding: "8px 12px", borderRadius: 10,
          background: m.role === "user" ? "var(--accent-soft, rgba(80,120,255,.15))" : "var(--panel-2, rgba(127,127,127,.08))" }}>
          {m.role === "user" ? m.content : m.content ? <Md text={m.content} /> : <span className="muted">⏳ live data le raha hoon aur soch raha hoon…</span>}</div>)}
        <div ref={end} />
      </div>
      <div className="actions" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>{(venue === "DELTA" ? QUICK_DELTA : QUICK_DHAN).map(x => <button key={x} className="btn sm" disabled={busy} onClick={() => send(x)}>{x}</button>)}</div>
      <form className="actions" style={{ gap: 8, marginTop: 8 }} onSubmit={e => { e.preventDefault(); void send(q); }}>
        <textarea value={q} onChange={e => setQ(e.target.value)} rows={2} placeholder="e.g. 25500 PE 109 pe liya hai 2340 qty, stop kahan rakhun?" style={{ flex: 1, resize: "vertical" }}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(q); } }} />
        {busy ? <button type="button" className="btn" onClick={() => abort.current?.abort()}>■ Stop</button> : <button className="btn primary" disabled={!q.trim()}>Send ➤</button>}
      </form>
    </section>
    {snap && <section className="card"><div className="card-head"><h2>🔍 Chat ko jaane wala data</h2><button className="btn sm" onClick={() => setSnap(null)}>Close</button></div>
      <pre style={{ maxHeight: 400, overflow: "auto", fontSize: 12 }}>{JSON.stringify(snap, null, 2)}</pre></section>}
    <ChatSettings compact />
  </div>;
}
