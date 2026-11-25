/**
 * One-click Dhan login (official "API key" consent flow) + token auto-renew.
 *   1. POST auth.dhan.co/app/generate-consent?client_id=…  (headers app_id / app_secret) → consentAppId
 *   2. Browser → auth.dhan.co/login/consentApp-login?consentAppId=…  (user logs in + 2FA on Dhan)
 *      Dhan redirects to our Redirect URL with ?tokenId=…
 *   3. GET auth.dhan.co/app/consumeApp-consent?tokenId=…  (app_id / app_secret) → accessToken, expiryTime
 * Daily login is a SEBI/exchange requirement — this removes the copy-paste, not the login.
 * RenewToken (api.dhan.co/v2/RenewToken) extends a still-valid token by 24h (Dhan: Dhan-Web tokens only).
 * API key/secret live in data/dhan_app.json (chmod 600, gitignored) and are never returned to the browser.
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { currentCreds, saveCreds, tokenInfo } from "./broker.ts";

const APP_FILE = resolve(process.env.DATA_DIR ?? resolve(import.meta.dirname, "../../../data"), "dhan_app.json");
type AppCreds = { clientId: string; apiKey: string; apiSecret: string; savedAt?: string };
let app: AppCreds = { clientId: "", apiKey: "", apiSecret: "" };
if (!process.env.VITEST) try { if (existsSync(APP_FILE)) app = { ...app, ...JSON.parse(readFileSync(APP_FILE, "utf8")) }; } catch { /* ignore */ }

export const DHAN_REDIRECT_URL = process.env.DHAN_REDIRECT_URL ?? "http://127.0.0.1:5173/api/dhan/oauth/callback";
const mask = (s: string) => s ? `${s.slice(0, 3)}••••${s.slice(-2)}` : null;

export function saveAppCreds(c: { clientId: string; apiKey: string; apiSecret: string }) {
  app = { ...c, savedAt: new Date().toISOString() };
  if (process.env.VITEST) return;
  mkdirSync(dirname(APP_FILE), { recursive: true }); writeFileSync(APP_FILE, JSON.stringify(app), { mode: 0o600 }); chmodSync(APP_FILE, 0o600);
}
export const appInfo = () => ({ configured: !!(app.clientId && app.apiKey && app.apiSecret), clientIdMasked: mask(app.clientId), apiKeyMasked: mask(app.apiKey), savedAt: app.savedAt ?? null, redirectUrl: DHAN_REDIRECT_URL });

export class DhanAuth {
  /** consentAppId → created (ms); a callback is accepted only for a consent we started */
  private pending = new Map<string, number>();
  renewState = { lastAttempt: null as string | null, lastOk: null as string | null, lastError: null as string | null };
  constructor(private fetchFn: typeof fetch = fetch, private authBase = "https://auth.dhan.co", private apiBase = "https://api.dhan.co", private now = () => Date.now()) {}

  private async json(r: Response) { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } }

  /** Step 1 → URL of Dhan's login page for the user's browser. */
  async start(): Promise<{ url: string }> {
    if (!appInfo().configured) throw new Error("Pehle Dhan API key, secret aur Client ID save karein (Settings).");
    const r = await this.fetchFn(`${this.authBase}/app/generate-consent?client_id=${encodeURIComponent(app.clientId)}`, { method: "POST", headers: { app_id: app.apiKey, app_secret: app.apiSecret } });
    const j = await this.json(r);
    if (!r.ok || !j.consentAppId) throw new Error(`Dhan consent failed [${r.status}]: ${JSON.stringify(j).slice(0, 200)}`);
    for (const [k, t] of this.pending) if (this.now() - t > 30 * 60000) this.pending.delete(k);
    this.pending.set(String(j.consentAppId), this.now());
    return { url: `${this.authBase}/login/consentApp-login?consentAppId=${encodeURIComponent(j.consentAppId)}` };
  }

  /** Step 3 — called from the redirect with ?tokenId=… */
  async complete(tokenId: string) {
    if (!this.pending.size) throw new Error("Koi login request pending nahi — app se 'Authorize with Dhan' dobara dabayein.");
    const r = await this.fetchFn(`${this.authBase}/app/consumeApp-consent?tokenId=${encodeURIComponent(tokenId)}`, { method: "GET", headers: { app_id: app.apiKey, app_secret: app.apiSecret } });
    const j = await this.json(r);
    if (!r.ok || !j.accessToken) throw new Error(`Dhan token exchange failed [${r.status}]: ${JSON.stringify(j).slice(0, 200)}`);
    this.pending.clear();
    saveCreds({ clientId: String(j.dhanClientId ?? app.clientId), accessToken: String(j.accessToken) });
    return { clientName: j.dhanClientName ?? null, expiryTime: j.expiryTime ?? null };
  }

  /** Renew a still-valid token for another 24h. Returns true when a new token was saved. */
  async renew(): Promise<boolean> {
    const c = currentCreds(); if (!c.clientId || !c.accessToken) return false;
    this.renewState.lastAttempt = new Date(this.now()).toISOString();
    try {
      const r = await this.fetchFn(`${this.apiBase}/v2/RenewToken`, { method: "GET", headers: { "access-token": c.accessToken, dhanClientId: c.clientId } });
      const j = await this.json(r);
      const tok = j.accessToken ?? j.token ?? j.access_token ?? j.data?.accessToken;
      if (!r.ok || !tok) throw new Error(`[${r.status}] ${JSON.stringify(j).slice(0, 160)}`);
      saveCreds({ clientId: c.clientId, accessToken: String(tok) });
      this.renewState.lastOk = this.renewState.lastAttempt; this.renewState.lastError = null; return true;
    } catch (e) { this.renewState.lastError = (e as Error).message; return false; }
  }

  /** Renew when the token expires within `withinMs` (default 3h) and is still valid. */
  async maybeRenew(withinMs = 3 * 3600000) {
    const exp = tokenInfo().expiresAt; if (!exp) return false;
    const left = Date.parse(exp) - this.now();
    if (left <= 0 || left > withinMs) return false;
    return this.renew();
  }
}


// ---------------------------------------------------------------------------------------------------------------
// Instant login (official generateAccessToken: Client ID + PIN + TOTP — no browser).
// The TOTP is computed locally from the secret shown during Dhan's "Setup TOTP" (same code an authenticator app shows).
// PIN + TOTP secret together grant full API access to the account: stored only in data/dhan_totp.json (chmod 600),
// never returned to the browser.
// ---------------------------------------------------------------------------------------------------------------
const TOTP_FILE = resolve(dirname(APP_FILE), "dhan_totp.json");
type TotpCreds = { clientId: string; pin: string; secret: string; autoLogin: boolean; savedAt?: string };
let totp: TotpCreds = { clientId: "", pin: "", secret: "", autoLogin: false };
if (!process.env.VITEST) try { if (existsSync(TOTP_FILE)) totp = { ...totp, ...JSON.parse(readFileSync(TOTP_FILE, "utf8")) }; } catch { /* ignore */ }

/** RFC 4648 base32 → bytes (spaces/padding ignored, case-insensitive). */
export function base32Decode(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of clean) { const i = A.indexOf(ch); if (i < 0) throw new Error("TOTP secret mein galat character hai (sirf A–Z aur 2–7)"); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
/** RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) — what Google/Microsoft Authenticator generate. */
export function totpCode(secretB32: string, atMs: number, step = 30, digits = 6): string {
  const counter = Math.floor(atMs / 1000 / step), buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0); buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac("sha1", base32Decode(secretB32)).update(buf).digest(), o = h[h.length - 1]! & 15;
  const bin = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}
export function saveTotpCreds(c: { clientId: string; pin: string; secret: string; autoLogin: boolean }) {
  base32Decode(c.secret); // validate
  totp = { ...c, savedAt: new Date().toISOString() };
  if (process.env.VITEST) return;
  mkdirSync(dirname(TOTP_FILE), { recursive: true }); writeFileSync(TOTP_FILE, JSON.stringify(totp), { mode: 0o600 }); chmodSync(TOTP_FILE, 0o600);
}
export const setAutoLogin = (on: boolean) => saveTotpCreds({ clientId: totp.clientId, pin: totp.pin, secret: totp.secret, autoLogin: on });
export const totpInfo = () => ({ configured: !!(totp.clientId && totp.pin && totp.secret), clientIdMasked: mask(totp.clientId), autoLogin: totp.autoLogin, savedAt: totp.savedAt ?? null });

export class DhanInstantLogin {
  state = { lastAttempt: null as string | null, lastOk: null as string | null, lastError: null as string | null };
  private inFlight: Promise<{ clientName: string | null; expiryTime: string | null }> | null = null;
  constructor(private fetchFn: typeof fetch = fetch, private authBase = "https://auth.dhan.co", private now = () => Date.now()) {}

  /** One click: compute TOTP → Dhan generateAccessToken → save token. */
  login() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      if (!totpInfo().configured) throw new Error("Pehle Client ID, PIN aur TOTP secret save karein (Settings → Instant login).");
      this.state.lastAttempt = new Date(this.now()).toISOString();
      try {
        // avoid a code that rolls over mid-request: if < 3 s left in the 30 s window, wait for the next one
        const msLeft = 30000 - (this.now() % 30000); if (msLeft < 3000 && !process.env.VITEST) await new Promise(r => setTimeout(r, msLeft + 200));
        const code = totpCode(totp.secret, this.now());
        const q = new URLSearchParams({ dhanClientId: totp.clientId, pin: totp.pin, totp: code });
        const r = await this.fetchFn(`${this.authBase}/app/generateAccessToken?${q}`, { method: "POST" });
        const t = await r.text(); let j: any = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; }
        if (!r.ok || !j.accessToken) throw new Error(`Dhan login failed [${r.status}]: ${String(j.message ?? j.errorMessage ?? j.remarks ?? JSON.stringify(j)).slice(0, 180)}`);
        saveCreds({ clientId: String(j.dhanClientId ?? totp.clientId), accessToken: String(j.accessToken) });
        this.state.lastOk = this.state.lastAttempt; this.state.lastError = null;
        return { clientName: j.dhanClientName ?? null, expiryTime: j.expiryTime ?? null };
      } catch (e) { this.state.lastError = (e as Error).message; throw e; }
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** Auto-login (if enabled): token missing/expired, or expiring within 15 min. At most once per 10 min after a failure. */
  async maybeAutoLogin(): Promise<boolean> {
    if (!totpInfo().configured || !totp.autoLogin) return false;
    const exp = tokenInfo().expiresAt, left = exp ? Date.parse(exp) - this.now() : -1;
    if (left > 15 * 60000) return false;
    if (this.state.lastError && this.state.lastAttempt && this.now() - Date.parse(this.state.lastAttempt) < 10 * 60000) return false;
    try { await this.login(); return true; } catch { return false; }
  }
}
