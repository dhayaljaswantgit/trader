import { useState } from "react";
import { useEffect } from "react";
import { usePoll, Chip, istTime, getVenue, setVenue, authorizeDhan, loginDhan, type Venue } from "./lib.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Setup } from "./pages/Setup.tsx";
import { Markets } from "./pages/Markets.tsx";
import { OptionChainPage } from "./pages/OptionChain.tsx";
import { Signals } from "./pages/Signals.tsx";
import { Trades } from "./pages/Trades.tsx";
import { Backtest, type BacktestTab } from "./pages/Backtest.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Builder } from "./pages/Builder.tsx";
import { Chat } from "./pages/Chat.tsx";

export type Health = {
  db: boolean; mode: string; marketOpen: boolean; serverTime: string; broker: { source: "MOCK" | "DHAN"; connected: boolean; detail: string };
  engine: { running: boolean; lastTick: string | null; lastError: string | null; ticks: number }; venue?: Venue; liveTrading?: boolean; engines?: { DHAN: boolean; DELTA: boolean };
  instruments: { running: boolean; lastSync: string | null; total: number; error: string | null }; token: { configured: boolean; clientIdMasked: string | null; expiresAt: string | null };
};

const PAGES = [
  ["dashboard", "◉", "Dashboard"], ["setup", "⚙︎", "Trade Setup"], ["markets", "▤", "Markets"], ["chain", "⛓", "Option Chain"],
  ["signals", "⚡", "Signals"], ["trades", "⇅", "Positions & P&L"], ["backtest", "⟲", "Backtest Lab"], ["builder", "🧩", "Strategy Builder"], ["chat", "💬", "Market Chat"], ["settings", "⚿", "Settings & Audit"],
] as const;
type Page = (typeof PAGES)[number][0];

export function App() {
  const [page, setPage] = useState<Page>(() => (localStorage.getItem("page") as Page) || "dashboard");
  const go = (p: Page) => { setPage(p); try { localStorage.setItem("page", p); } catch { /* ignore */ } };
  const [venue, setV] = useState<Venue>(getVenue());
  const switchVenue = (v: Venue) => { if (v === venue) return; setVenue(v); setV(v); };
  const { data: h, error } = usePoll<Health>(`/api/health?venue=${venue}`, 4000);
  const { data: dlt } = usePoll<{ health: { connected: boolean; detail: string } }>("/api/delta/status", 60000);
  const [btTab, setBtTabRaw] = useState<BacktestTab>(() => { try { return localStorage.getItem("btTab") === "all" ? "all" : "lab"; } catch { return "lab"; } });
  const setBtTab = (t: BacktestTab) => { setBtTabRaw(t); try { localStorage.setItem("btTab", t); } catch { /* ignore */ } };
  const title = PAGES.find(p => p[0] === page)![2];
  // back from Dhan's login page: ?dhan=connected | ?dhan=error&msg=…
  const [authMsg, setAuthMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search), d = q.get("dhan"); if (!d) return;
    if (d === "connected") { setVenue("DHAN"); setV("DHAN"); }
    setAuthMsg(d === "connected" ? { ok: true, text: "✓ Dhan connected — naya token save ho gaya, live data shuru." } : { ok: false, text: `Dhan login fail: ${q.get("msg") ?? "unknown error"}` });
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const { data: dapp } = usePoll<{ configured: boolean }>("/api/settings/dhan-app", 60000);
  const { data: inst } = usePoll<{ configured: boolean }>("/api/settings/dhan-instant", 60000);
  const [logging, setLogging] = useState(false);
  // one click: instant PIN+TOTP login if set up, else Dhan's login page (API key flow)
  const authorize = () => {
    if (inst?.configured) { setLogging(true); loginDhan().then(() => setAuthMsg({ ok: true, text: "✓ Dhan connected — naya token save ho gaya, live data shuru." }))
      .catch(e => setAuthMsg({ ok: false, text: (e as Error).message })).finally(() => setLogging(false)); return; }
    authorizeDhan().catch(e => setAuthMsg({ ok: false, text: (e as Error).message }));
  };
  const tokenExp = h?.token.expiresAt ? (Date.parse(h.token.expiresAt) - Date.now()) / 3600000 : null;

  const { data: me } = usePoll<{ email: string | null }>("/api/me", 600000);
  const [menu, setMenu] = useState(false);
  return <div className={`layout ${menu ? "menu-open" : ""}`}>
    {menu && <div className="side-scrim" onClick={() => setMenu(false)} />}
    <aside className="side">
      <div className="venue-switch" role="tablist" aria-label="Exchange">
        {(["DHAN", "DELTA"] as const).map(v => <button key={v} role="tab" aria-selected={venue === v} className={venue === v ? "on" : ""} onClick={() => switchVenue(v)}
          title={v === "DHAN" ? "NSE/BSE — Dhan" : "Crypto — Delta Exchange (24x7)"}>
          {v === "DHAN" ? "🇮🇳 Dhan" : "₿ Delta"}{h?.engines?.[v] && <span className="vdot" title="Auto engine chal raha hai (background mein bhi)" />}</button>)}
      </div>
      {h?.engines && (["DHAN", "DELTA"] as const).filter(v => v !== venue && h.engines![v]).map(v => <div key={v} className="venue-bg">● {v === "DHAN" ? "Dhan" : "Delta"} engine background mein chal raha hai</div>)}
      <div className="brand"><div className="logo">◆</div><div>AI Trader<small className="brand-sub">{venue === "DELTA" ? "₿ Delta Exchange · crypto" : "🇮🇳 Dhan · NSE / BSE"}</small></div></div>
      {PAGES.map(([id, ic, label]) => <button key={id} className={`nav ${page === id ? "active" : ""}`} onClick={() => { go(id); setMenu(false); }}><span className="ic">{ic}</span>{label}</button>)}
      {me?.email && <div className="foot me">{me.email}<br /><a href="/auth/logout">Sign out</a></div>}
      <div className="foot">Dhan: paper ya LIVE (Dashboard) · Delta: paper<br />Display: IST · Storage: UTC</div>
    </aside>
    <div className="main">
      {venue === "DHAN" && h?.liveTrading ? <div className="paper-strip live" role="status">🔴 LIVE TRADING ON (Dhan) · Engine ASLI orders lagayega · asli paisa</div> : <div className="paper-strip" role="status">PAPER TRADING · Koi asli order nahi lagega · {venue === "DELTA" ? "₿ DELTA EXCHANGE · LIVE CRYPTO DATA · 24x7" : h?.broker.source === "MOCK" ? "SIMULATED PRICES (MOCK)" : "LIVE DHAN MARKET DATA"}</div>}
      <header className="topbar">
        <button className="hamburger" aria-label="Menu" onClick={() => setMenu(m => !m)}>☰</button>
        {page === "backtest"
          ? <div className="tabs page-tabs" role="tablist">
              <button role="tab" aria-selected={btTab === "lab"} className={btTab === "lab" ? "on" : ""} onClick={() => setBtTab("lab")}>⟲ Backtest Lab</button>
              <button role="tab" aria-selected={btTab === "all"} className={btTab === "all" ? "on" : ""} onClick={() => setBtTab("all")}>📊 All strategies backtest</button>
            </div>
          : <h1>{title}</h1>}
        {error && <Chip kind="bad">API offline</Chip>}
        {h && <>
          {venue === "DHAN" && <Chip kind={h.broker.source === "DHAN" ? (h.broker.connected ? "ok" : "bad") : "warn"}>{h.broker.source === "DHAN" ? (h.broker.connected ? "Dhan connected" : "Dhan error") : "Mock data"}</Chip>}
          {venue === "DELTA" && dlt && <Chip kind={dlt.health.connected ? "ok" : "bad"}>{dlt.health.connected ? "₿ Delta connected" : "₿ Delta error"}</Chip>}
          <Chip kind={h.marketOpen ? "ok" : ""} pulse={h.marketOpen}>{venue === "DELTA" ? "24x7 open" : h.marketOpen ? "Market open" : "Market closed"}</Chip>
          <Chip kind={h.engine.running ? "info" : ""} pulse={h.engine.running}>{h.engine.running ? "Auto engine ON" : "Engine OFF"}</Chip>
          {venue === "DHAN" && tokenExp !== null && tokenExp < 6 && <button className="chip-btn" onClick={authorize} title="Click: Login with Dhan"><Chip kind={tokenExp < 0 ? "bad" : "warn"}>{tokenExp < 0 ? "Token expired" : `Token expires in ${tokenExp.toFixed(1)}h`} · 🔐</Chip></button>}
          <span className="muted num" style={{ fontSize: 12 }}>{istTime(h.serverTime)} IST</span>
        </>}
      </header>
      {authMsg && <div className={`note ${authMsg.ok ? "" : "bad"} auth-banner`}>{authMsg.text} <button className="btn sm" onClick={() => setAuthMsg(null)}>✕</button></div>}
      {venue === "DHAN" && h?.broker.source === "DHAN" && tokenExp !== null && tokenExp < 1 && <div className={`note ${tokenExp < 0 ? "bad" : "warn"} auth-banner`}>
        {tokenExp < 0 ? "🔴 Dhan token expire ho gaya — live data aur auto-trading ruki hui hai." : `🟡 Dhan token ${Math.max(0, tokenExp * 60).toFixed(0)} min mein expire hoga.`}{" "}
        {inst?.configured ? <button className="btn sm primary" disabled={logging} onClick={authorize}>{logging ? "⏳ Logging in…" : "⚡ Login with Dhan"}</button>
          : dapp?.configured ? <button className="btn sm primary" onClick={authorize}>🔐 Authorize with Dhan</button> : <button className="btn sm" onClick={() => go("settings")}>Settings → ⚡ Instant login setup</button>}</div>}
      <div className="content" key={venue /* remount every page so it loads the active exchange's data */}>
        {page === "dashboard" && <Dashboard health={h} go={go} />}
        {page === "setup" && <Setup />}
        {page === "markets" && <Markets />}
        {page === "chain" && <OptionChainPage />}
        {page === "signals" && <Signals />}
        {page === "trades" && <Trades />}
        {page === "backtest" && <Backtest tab={btTab} />}
        {page === "builder" && <Builder />}
        {page === "chat" && <Chat />}
        {page === "settings" && <Settings health={h} />}
      </div>
    </div>
  </div>;
}
