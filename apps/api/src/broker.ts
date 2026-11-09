import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DhanAdapter, MockBrokerAdapter, type IBrokerAdapter } from "@dat/broker-dhan";

/** Credentials live in data/dhan.json (chmod 600, gitignored) or .env. Never sent to the browser. */
const FILE = resolve(process.env.DATA_DIR ?? resolve(import.meta.dirname, "../../../data"), "dhan.json");

type Creds = { clientId: string; accessToken: string; savedAt?: string };
let creds: Creds = { clientId: process.env.DHAN_CLIENT_ID ?? "", accessToken: process.env.DHAN_ACCESS_TOKEN ?? "" };
if (creds.clientId.startsWith("replace")) creds = { clientId: "", accessToken: "" };
try { if (existsSync(FILE)) creds = { ...creds, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch { /* ignore */ }

export function saveCreds(c: { clientId: string; accessToken: string }) {
  creds = { ...c, savedAt: new Date().toISOString() };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(creds), { mode: 0o600 }); chmodSync(FILE, 0o600);
}
/** Decode JWT expiry without verifying (display only). */
export function tokenInfo() {
  let expiresAt: string | null = null;
  try { const p = JSON.parse(Buffer.from(creds.accessToken.split(".")[1]!, "base64url").toString()); if (p.exp) expiresAt = new Date(p.exp * 1000).toISOString(); } catch { /* not a JWT */ }
  return { configured: !!(creds.clientId && creds.accessToken), clientIdMasked: creds.clientId ? creds.clientId.slice(0, 2) + "****" + creds.clientId.slice(-2) : null, expiresAt, savedAt: creds.savedAt ?? null };
}

const SOURCE_FILE = resolve(dirname(FILE), "source.json");
/** Persisted data-source choice so a restart never silently falls back to MOCK. */
function savedSource(): "MOCK" | "DHAN" | null {
  try { const s = JSON.parse(readFileSync(SOURCE_FILE, "utf8")).source; return s === "DHAN" || s === "MOCK" ? s : null; } catch { return null; }
}

export class BrokerHolder {
  current: IBrokerAdapter;
  readonly mock: MockBrokerAdapter;
  readonly dhan: DhanAdapter;
  constructor(clock: () => Date, initial: "MOCK" | "DHAN" = savedSource() ?? (process.env.BROKER as "MOCK" | "DHAN") ?? "MOCK", fetchFn?: typeof fetch, private persist = false) {
    this.mock = new MockBrokerAdapter(clock);
    this.dhan = new DhanAdapter(() => creds, fetchFn);
    this.current = initial === "DHAN" ? this.dhan : this.mock;
  }
  use(s: "MOCK" | "DHAN") {
    this.current = s === "DHAN" ? this.dhan : this.mock;
    if (this.persist) { mkdirSync(dirname(SOURCE_FILE), { recursive: true }); writeFileSync(SOURCE_FILE, JSON.stringify({ source: s, at: new Date().toISOString() }), { mode: 0o600 }); }
  }
  get source() { return this.current.source; }
}
