import { useState } from "react";
import { usePoll, Chip, istTime } from "./lib.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Setup } from "./pages/Setup.tsx";
import { Markets } from "./pages/Markets.tsx";
import { OptionChainPage } from "./pages/OptionChain.tsx";
import { Signals } from "./pages/Signals.tsx";
import { Trades } from "./pages/Trades.tsx";
import { Backtest, type BacktestTab } from "./pages/Backtest.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Builder } from "./pages/Builder.tsx";

export type Health = {
  db: boolean; mode: string; marketOpen: boolean; serverTime: string; broker: { source: "MOCK" | "DHAN"; connected: boolean; detail: string };
  engine: { running: boolean; lastTick: string | null; lastError: string | null; ticks: number };
  instruments: { running: boolean; lastSync: string | null; total: number; error: string | null }; token: { configured: boolean; clientIdMasked: string | null; expiresAt: string | null };
};

const PAGES = [
  ["dashboard", "◉", "Dashboard"], ["setup", "⚙︎", "Trade Setup"], ["markets", "▤", "Markets"], ["chain", "⛓", "Option Chain"],
  ["signals", "⚡", "Signals"], ["trades", "⇅", "Positions & P&L"], ["backtest", "⟲", "Backtest Lab"], ["builder", "🧩", "Strategy Builder"], ["settings", "⚿", "Settings & Audit"],
] as const;
type Page = (typeof PAGES)[number][0];

export function App() {
  const [page, setPage] = useState<Page>(() => (localStorage.getItem("page") as Page) || "dashboard");
  const go = (p: Page) => { setPage(p); try { localStorage.setItem("page", p); } catch { /* ignore */ } };
  const { data: h, error } = usePoll<Health>("/api/health", 4000);
  const [btTab, setBtTabRaw] = useState<BacktestTab>(() => { try { return localStorage.getItem("btTab") === "all" ? "all" : "lab"; } catch { return "lab"; } });
  const setBtTab = (t: BacktestTab) => { setBtTabRaw(t); try { localStorage.setItem("btTab", t); } catch { /* ignore */ } };
  const title = PAGES.find(p => p[0] === page)![2];
  const tokenExp = h?.token.expiresAt ? (Date.parse(h.token.expiresAt) - Date.now()) / 3600000 : null;

  return <div className="layout">
    <aside className="side">
      <div className="brand"><div className="logo">◆</div>Dhan AI Trader</div>
      {PAGES.map(([id, ic, label]) => <button key={id} className={`nav ${page === id ? "active" : ""}`} onClick={() => go(id)}><span className="ic">{ic}</span>{label}</button>)}
      <div className="foot">Paper-only build · no real orders<br />Display: IST · Storage: UTC</div>
    </aside>
    <div className="main">
      <div className="paper-strip" role="status">PAPER TRADING · Koi asli order nahi lagega · {h?.broker.source === "MOCK" ? "SIMULATED PRICES (MOCK)" : "LIVE DHAN MARKET DATA"}</div>
      <header className="topbar">
        {page === "backtest"
          ? <div className="tabs page-tabs" role="tablist">
              <button role="tab" aria-selected={btTab === "lab"} className={btTab === "lab" ? "on" : ""} onClick={() => setBtTab("lab")}>⟲ Backtest Lab</button>
              <button role="tab" aria-selected={btTab === "all"} className={btTab === "all" ? "on" : ""} onClick={() => setBtTab("all")}>📊 All strategies backtest</button>
            </div>
          : <h1>{title}</h1>}
        {error && <Chip kind="bad">API offline</Chip>}
        {h && <>
          <Chip kind={h.broker.source === "DHAN" ? (h.broker.connected ? "ok" : "bad") : "warn"}>{h.broker.source === "DHAN" ? (h.broker.connected ? "Dhan connected" : "Dhan error") : "Mock data"}</Chip>
          <Chip kind={h.marketOpen ? "ok" : ""} pulse={h.marketOpen}>{h.marketOpen ? "Market open" : "Market closed"}</Chip>
          <Chip kind={h.engine.running ? "info" : ""} pulse={h.engine.running}>{h.engine.running ? "Auto engine ON" : "Engine OFF"}</Chip>
          {tokenExp !== null && tokenExp < 6 && <Chip kind={tokenExp < 0 ? "bad" : "warn"}>{tokenExp < 0 ? "Token expired" : `Token expires in ${tokenExp.toFixed(1)}h`}</Chip>}
          <span className="muted num" style={{ fontSize: 12 }}>{istTime(h.serverTime)} IST</span>
        </>}
      </header>
      <div className="content">
        {page === "dashboard" && <Dashboard health={h} go={go} />}
        {page === "setup" && <Setup />}
        {page === "markets" && <Markets />}
        {page === "chain" && <OptionChainPage />}
        {page === "signals" && <Signals />}
        {page === "trades" && <Trades />}
        {page === "backtest" && <Backtest tab={btTab} />}
        {page === "builder" && <Builder />}
        {page === "settings" && <Settings health={h} />}
      </div>
    </div>
  </div>;
}
