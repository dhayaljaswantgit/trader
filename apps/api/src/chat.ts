/**
 * 💬 Market chat — READ-ONLY analysis assistant (Claude API).
 * The server builds a live JSON snapshot (spot, futures, option chain + OI, VIX, candles, positions)
 * and sends it with each question. No tool here can place / modify / cancel anything.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient, Instrument } from "@prisma/client";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { ema, bollinger, type Bar } from "@dat/quant";
import { toIstDate } from "@dat/shared";
import type { OptionChain } from "@dat/broker-dhan";
import type { BrokerHolder } from "./broker.ts";
import { refOf, nearestFuture } from "./instruments.ts";
import { config } from "./config.ts";

export const CHAT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
/** local = your logged-in Claude Code CLI on this Mac (subscription, no API key); api = Anthropic API key (pay per use). */
export type ChatProvider = "local" | "api";
const LOCAL_ALIAS: Record<string, string> = { "claude-opus-5-5": "opus", "claude-sonnet-5-5": "sonnet", "claude-haiku-5-5": "haiku" };
const FILE = resolve(process.env.DATA_DIR ?? resolve(import.meta.dirname, "../../../data"), "claude.json");
const testing = () => !!process.env.VITEST || process.env.NODE_ENV === "test";
let saved: { apiKey?: string; model?: string; provider?: ChatProvider } = {};
if (!testing()) try { saved = JSON.parse(readFileSync(FILE, "utf8")); } catch { /* none yet */ }

const key = () => saved.apiKey || process.env.ANTHROPIC_API_KEY || "";
let cliCache: { at: number; path: string | null; version: string | null } | null = null;
export function claudeCli() {
  if (cliCache && Date.now() - cliCache.at < 60000) return cliCache;
  const bin = process.env.CLAUDE_CLI || "claude";
  const r = testing() ? null : spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin:${process.env.HOME}/.local/bin:${process.env.HOME}/.claude/local` } });
  cliCache = { at: Date.now(), path: r && r.status === 0 ? bin : null, version: r && r.status === 0 ? r.stdout.trim() : null };
  return cliCache;
}
export function chatInfo() {
  const k = key(), provider: ChatProvider = saved.provider ?? "local", cli = provider === "local" ? claudeCli() : null;
  return { provider, configured: provider === "local" ? !!cli?.path : !!k, cli: cli ? { found: !!cli.path, version: cli.version } : null,
    keyMasked: k ? `${k.slice(0, 7)}…${k.slice(-4)}` : null, model: saved.model && (CHAT_MODELS as readonly string[]).includes(saved.model) ? saved.model : CHAT_MODELS[1], models: CHAT_MODELS };
}
export function saveChatSettings(s: { apiKey?: string; model?: string; provider?: string }) {
  if (s.apiKey !== undefined) saved.apiKey = s.apiKey.trim() || undefined;
  if (s.model && (CHAT_MODELS as readonly string[]).includes(s.model)) saved.model = s.model;
  if (s.provider === "local" || s.provider === "api") saved.provider = s.provider;
  if (!testing()) { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(saved), { mode: 0o600 }); }
  return chatInfo();
}

// ---- OI history: one compact snapshot per underlying+expiry every ≥3 min (exchange updates OI every 1–3 min) ----
type OiSnap = { at: string; oi: Record<number, { ce: number | null; pe: number | null }> };
const oiHist = new Map<string, OiSnap[]>();
function recordOi(ch: OptionChain) {
  const k = `${ch.underlying.securityId}|${ch.expiry}`, list = oiHist.get(k) ?? [];
  const last = list[list.length - 1];
  if (last && Date.now() - Date.parse(last.at) < 3 * 60000) return list;
  const oi: OiSnap["oi"] = {}; for (const s of ch.strikes) oi[s.strike] = { ce: s.ce?.oi ?? null, pe: s.pe?.oi ?? null };
  list.push({ at: new Date().toISOString(), oi }); if (list.length > 40) list.shift(); oiHist.set(k, list);
  return list;
}

const r2 = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const lastN = <T,>(a: T[], n: number) => a.slice(Math.max(0, a.length - n));
const ist = (t: number) => new Date(t * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit" });

function candlePack(bars: Bar[], n: number) {
  const c = bars.map(b => b.c), e20 = ema(c, 20), bb = bollinger(c, 20, 2);
  return lastN(bars.map((b, i) => ({ t: ist(b.t), o: r2(b.o), h: r2(b.h), l: r2(b.l), c: r2(b.c), ema20: r2(e20[i]), bbUp: r2(bb.up[i]), bbLo: r2(bb.lo[i]) })), n);
}

/** Pick the underlying the question is about (default NIFTY on Dhan, BTC on Delta). */
export async function pickUnderlying(prisma: PrismaClient, venue: "DHAN" | "DELTA", q: string): Promise<Instrument | null> {
  const t = q.toUpperCase();
  if (venue === "DELTA") {
    const sym = /\bETH/.test(t) ? "ETHUSD" : /\bSOL/.test(t) ? "SOLUSD" : "BTCUSD";
    return prisma.instrument.findFirst({ where: { segment: "DELTA", symbol: sym } });
  }
  const sym = /BANK\s?NIFTY/.test(t) ? "BANKNIFTY" : /FIN\s?NIFTY/.test(t) ? "FINNIFTY" : /SENSEX/.test(t) ? "SENSEX" : /MIDCP|MIDCAP/.test(t) ? "MIDCPNIFTY" : "NIFTY";
  return prisma.instrument.findFirst({ where: { instrumentType: "INDEX", symbol: sym } });
}

/** Live JSON snapshot for the question. Every block is best-effort: failures are reported, not thrown. */
export async function buildSnapshot(prisma: PrismaClient, broker: BrokerHolder, venue: "DHAN" | "DELTA", u: Instrument | null, now: Date) {
  const errors: string[] = [], snap: Record<string, unknown> = { venue, asOfIst: now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }), dataSource: venue === "DELTA" ? "DELTA" : broker.source };
  if (!u) return { ...snap, errors: ["underlying not found in instruments"] };
  snap.underlying = { symbol: u.symbol, key: u.key, lotSize: u.fnoLotSize ?? u.lotSize };
  const ref = refOf(u), to = now;
  try {
    const [q] = await broker.current.getQuotes([ref]);
    if (q) snap.spot = { ltp: q.ltp, open: q.open, dayHigh: q.high, dayLow: q.low, prevClose: q.prevClose, changePct: q.prevClose ? r2((q.ltp - q.prevClose) / q.prevClose * 100) : null, ...(venue === "DELTA" ? { currency: "USD" } : {}) };
  } catch (e) { errors.push(`spot: ${(e as Error).message}`); }
  try {
    const nowS = now.getTime() / 1000;
    const b5 = (await broker.current.getCandles({ ref, interval: 5, from: new Date(to.getTime() - 4 * 86400000), to })).filter(b => b.t + 300 <= nowS);
    const b15 = (await broker.current.getCandles({ ref, interval: 15, from: new Date(to.getTime() - 6 * 86400000), to })).filter(b => b.t + 900 <= nowS);
    const daily = await broker.current.getCandles({ ref, interval: "D", from: new Date(to.getTime() - 60 * 86400000), to });
    snap.candles5m = candlePack(b5, 24); snap.candles15m = candlePack(b15, 16);
    const dc = daily.map(b => b.c), d20 = ema(dc, 20);
    snap.daily = { last5: lastN(daily, 5).map(b => ({ date: toIstDate(new Date(b.t * 1000)), o: r2(b.o), h: r2(b.h), l: r2(b.l), c: r2(b.c) })), ema20: r2(d20[d20.length - 1]), trend: dc.length && d20[d20.length - 1] != null ? (dc[dc.length - 1]! > d20[d20.length - 1]! ? "above daily 20-EMA" : "below daily 20-EMA") : null };
  } catch (e) { errors.push(`candles: ${(e as Error).message}`); }

  if (venue === "DHAN") {
    try {
      const f = await nearestFuture(prisma, u, toIstDate(now));
      if (f) { const [fq] = await broker.current.getQuotes([refOf(f)]); if (fq) snap.futures = { symbol: f.symbol, expiry: f.expiry, ltp: fq.ltp, bid: fq.bid, ask: fq.ask, dayHigh: fq.high, dayLow: fq.low, oi: fq.oi } as object; }
    } catch (e) { errors.push(`futures: ${(e as Error).message}`); }
    try {
      const vix = await prisma.instrument.findFirst({ where: { symbol: "INDIA VIX", instrumentType: "INDEX" } });
      if (vix) { const [vq] = await broker.current.getQuotes([refOf(vix)]); if (vq) snap.indiaVix = { ltp: vq.ltp, prevClose: vq.prevClose, changePct: vq.prevClose ? r2((vq.ltp - vq.prevClose) / vq.prevClose * 100) : null }; }
    } catch (e) { errors.push(`vix: ${(e as Error).message}`); }
    try {
      const exps = await broker.current.getExpiries(ref), exp = exps[0];
      if (exp) {
        const ch = await broker.current.getOptionChain(ref, exp), hist = recordOi(ch), first = hist[0]!, prev = hist.length > 1 ? hist[hist.length - 2]! : null;
        const spot = ch.spot || ((snap.spot as { ltp?: number })?.ltp ?? 0);
        const atm = ch.strikes.reduce((a, s) => Math.abs(s.strike - spot) < Math.abs(a.strike - spot) ? s : a, ch.strikes[0]!);
        const i0 = ch.strikes.indexOf(atm), near = ch.strikes.slice(Math.max(0, i0 - 10), i0 + 11);
        const sum = (f: (s: (typeof ch.strikes)[number]) => number | null | undefined) => ch.strikes.reduce((a, s) => a + (f(s) ?? 0), 0);
        const ceOi = sum(s => s.ce?.oi), peOi = sum(s => s.pe?.oi);
        const days = Math.max(0, Math.round((Date.parse(`${exp}T15:30:00+05:30`) - now.getTime()) / 86400000 * 10) / 10);
        const wknd = (() => { for (let d = new Date(now); d <= new Date(`${exp}T15:30:00+05:30`); d = new Date(d.getTime() + 86400000)) { const w = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).getDay(); if (w === 0 || w === 6) return true; } return false; })();
        snap.optionChain = {
          expiry: exp, nextExpiries: exps.slice(1, 3), daysToExpiry: days, weekendBeforeExpiry: wknd, spotFromChain: spot, atmStrike: atm.strike,
          atmStraddle: atm.ce?.ltp != null && atm.pe?.ltp != null ? r2(atm.ce.ltp + atm.pe.ltp) : null,
          totals: { callOi: ceOi, putOi: peOi, pcr: ceOi ? r2(peOi / ceOi) : null },
          oiChangeWindow: { sinceIst: new Date(first.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }), lastSnapIst: prev ? new Date(prev.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : null, note: "oiChg = change since app started watching (first snapshot); oiChgLast = since previous ~3-min snapshot" },
          strikes: near.map(s => ({ strike: s.strike,
            ce: s.ce ? { ltp: s.ce.ltp, oi: s.ce.oi, oiChg: s.ce.oi != null && first.oi[s.strike]?.ce != null ? s.ce.oi - first.oi[s.strike]!.ce! : null, oiChgLast: s.ce.oi != null && prev?.oi[s.strike]?.ce != null ? s.ce.oi - prev.oi[s.strike]!.ce! : null, iv: r2(s.ce.iv), delta: r2(s.ce.delta) } : null,
            pe: s.pe ? { ltp: s.pe.ltp, oi: s.pe.oi, oiChg: s.pe.oi != null && first.oi[s.strike]?.pe != null ? s.pe.oi - first.oi[s.strike]!.pe! : null, oiChgLast: s.pe.oi != null && prev?.oi[s.strike]?.pe != null ? s.pe.oi - prev.oi[s.strike]!.pe! : null, iv: r2(s.pe.iv), delta: r2(s.pe.delta) } : null })),
        };
      }
    } catch (e) { errors.push(`optionChain: ${(e as Error).message}`); }
  } else snap.note = `Delta perpetual futures (no option chain). Prices in USD; app converts at ₹${config.cryptoUsdInr}/USD, leverage ${config.cryptoLeverage}x. 24x7 market.`;

  try {
    const open = await prisma.paperTrade.findMany({ where: { closedAt: null, venue }, orderBy: { openedAt: "desc" }, take: 10 });
    const s = await prisma.tradingSession.findUnique({ where: { tradingDate_venue: { tradingDate: toIstDate(now), venue } } });
    snap.position = { mode: "PAPER (simulated)", open: open.map(t => ({ contract: t.contract, kind: t.kind, side: t.side, qty: t.quantity, lotSize: t.lotSize, avgPrice: Number(t.entryPrice), stop: Number(t.stopPrice), target: Number(t.targetPrice), strategy: t.strategyId, openedIst: t.openedAt.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) })),
      session: s ? { capitalInr: Number(s.capitalInr), realizedPnlInr: Number(s.realizedPnlInr), maxLossInr: Number(s.maxLossInr), status: s.status } : null };
  } catch (e) { errors.push(`position: ${(e as Error).message}`); }
  if (errors.length) snap.errors = errors;
  return snap;
}

export const SYSTEM_PROMPT = `You are the analysis assistant inside a personal Nifty options (and crypto) PAPER-trading app.
The trader is an intraday option buyer. With each message the app attaches a live JSON snapshot it fetched
from the broker a moment ago: spot, futures, the option chain with OI and OI change, VIX, the ATM straddle,
days to expiry, 5- and 15-minute candles with 20-EMA and Bollinger bands, daily context, and the app's open
paper positions. You see only these snapshots. You cannot watch the market between messages, and you cannot
place or change orders — the app gives you no such ability. Say so if asked. Never claim to see anything that
is not in the snapshot; if a field is missing or listed under "errors", say so.

Your job is to help the trader decide, not to predict. Option buyers lose money mainly by entering in the
middle of a range, sizing too large, and widening stops, so your default answer is "not now" until the data
gives a trigger.

For each question, work through these checks before answering:
1. Where is price between the nearest support and resistance (day high/low, candle swings, EMA, bands)?
2. Where are the largest call and put OI walls, and is one strike pinned?
3. From oiChg / oiChgLast, are call or put writers adding or covering?
4. How far is futures from spot, and did futures confirm spot's last move?
5. Is VIX rising or cooling, and what does that do to premiums?
6. How big is the ATM straddle compared with the move the trade needs?
7. How much time is left to expiry, and is a weekend in between?
8. Is the trade with or against the daily trend?

Then answer in this shape:
- First line: the decision in bold (yes, no, or not now).
- The two or three facts from the snapshot that drive it, with numbers.
- A small if-then table: the candle-close level that would trigger a CE, the level that would trigger a PE,
  and the level that cancels each idea.
- For any trade: strike, stoploss on premium or futures (not spot), a limit a few points beyond the trigger,
  the exit zone, and the rupee loss at the stop for the trader's quantity (use delta ≈ 0.4–0.5 near ATM).

Rules you apply:
- Entries need a candle close through the level: 5-minute for a range trade, 15-minute for a breakout.
- Size comes from the loss the trader accepts: quantity = maximum loss / stop points. After a winning trade,
  suggest risking no more than about a third of the day's profit.
- If the risk is too large, suggest a smaller quantity. Never suggest moving a stop further away.
- Once a trade is in profit, suggest booking part and trailing the stop upward under the previous 5-minute low.
- If the reward is smaller than the risk, say the trade is not worth taking.
- If the trader names a target such as 2x, show the index level it needs and compare it with the straddle.
- Do not suggest chasing a move that has already happened, or carrying full size over a weekend before expiry.
- Never promise an outcome or call a top or bottom. Never encourage a larger size after a win.

Be honest about uncertainty. State any assumption you make about the position. When an earlier suggestion of
yours turned out wrong, say so plainly and move on. Reply in the language the trader writes in (Hinglish if
they write Hinglish), keep replies short (a few bullets and one table), and mention once per conversation —
only in your first reply — that this is not financial advice and the decision is theirs.`;

export type ChatTurn = { role: "user" | "assistant"; content: string };

const userBlock = (snapshot: object, q: string) => `<snapshot fetched_now="true">\n${JSON.stringify(snapshot)}\n</snapshot>\n\n${q}`;

/** Streams the answer as plain text chunks via onText. Returns the full text. */
export async function askClaude(opts: { history: ChatTurn[]; question: string; snapshot: object; onText: (t: string) => void; signal?: AbortSignal }) {
  const info = chatInfo();
  const history = opts.history.filter(t => t.content?.trim()).slice(-12);
  while (history.length && history[0]!.role !== "user") history.shift();
  if (info.provider === "local") return askLocal(info.model, history, opts);
  if (!info.configured) throw new Error("Claude API key set nahi hai — Market Chat → settings mein key daalein, ya provider 'Local Claude Code' chunein.");
  const client = new Anthropic({ apiKey: key() });
  const messages: Anthropic.MessageParam[] = [...history.map(t => ({ role: t.role, content: t.content })), { role: "user", content: userBlock(opts.snapshot, opts.question) }];
  const stream = client.messages.stream({
    model: info.model, max_tokens: 8000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { effort: info.model === "claude-haiku-5-5" ? "low" : "medium" },
    messages,
  }, { signal: opts.signal });
  stream.on("text", t => opts.onText(t));
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") opts.onText("\n\n_(Model ne is sawal ka jawab dene se mana kiya.)_");
  return final.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
}

/** Runs the locally logged-in Claude Code CLI in print mode with ALL tools disabled (pure text answer, cannot touch files/orders). */
function askLocal(model: string, history: ChatTurn[], opts: { question: string; snapshot: object; onText: (t: string) => void; signal?: AbortSignal }) {
  const cli = claudeCli(); if (!cli.path) return Promise.reject(new Error("Claude Code CLI ('claude') is Mac par nahi mila — install/login karein, ya provider 'API key' chunein."));
  const convo = history.map(t => `<${t.role === "user" ? "trader" : "you_earlier"}>\n${t.content}\n</${t.role === "user" ? "trader" : "you_earlier"}>`).join("\n");
  const prompt = `${convo ? `Conversation so far:\n${convo}\n\nNew message from the trader:\n` : ""}${userBlock(opts.snapshot, opts.question)}`;
  const args = ["-p", "--model", LOCAL_ALIAS[model] ?? "sonnet", "--system-prompt", SYSTEM_PROMPT, "--tools", "", "--strict-mcp-config", "--setting-sources", "",
    "--no-session-persistence", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
  return new Promise<string>((res, rej) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin:${process.env.HOME}/.local/bin` };
    delete env.ANTHROPIC_API_KEY; // use the subscription login, not a stray key
    const p = spawn(cli.path!, args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", text = "", err = "", result: string | null = null;
    opts.signal?.addEventListener("abort", () => p.kill("SIGTERM"));
    p.stdout.on("data", (d: Buffer) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
        try { const j = JSON.parse(line);
          if (j.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.type === "text_delta") { text += j.event.delta.text; opts.onText(j.event.delta.text); }
          else if (j.type === "result") { result = typeof j.result === "string" ? j.result : null; if (j.is_error) err ||= String(j.result ?? "Claude Code error"); }
        } catch { /* partial / non-JSON line */ }
      }
    });
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("error", e => rej(e));
    p.on("close", code => {
      if (!text && result) { text = result; opts.onText(result); }
      if (text) res(text); else rej(new Error((err.trim() || `claude exited ${code}`).slice(0, 500) + (/login|auth/i.test(err) ? " — Terminal mein `claude` chala kar login karein." : "")));
    });
    p.stdin.end(prompt);
  });
}
