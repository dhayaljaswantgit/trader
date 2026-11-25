import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Google sign-in (OAuth 2.0 / OpenID Connect, authorization-code flow) with an email allowlist.
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS (comma separated), PUBLIC_URL (https://your-domain),
 *      SESSION_SECRET (optional; else a random key is kept in DATA_DIR/session.key).
 * The id_token is received directly from Google's token endpoint over TLS, so its claims are trusted (OIDC §3.1.3.7).
 */
const COOKIE = "at_sess", STATE = "at_state", DAYS = 7;

export const googleAuthConfig = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "", clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const allowed = (process.env.ALLOWED_EMAILS ?? "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  return { enabled: !!(clientId && clientSecret), clientId, clientSecret, allowed, publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/$/, "") };
};

function secret(): Buffer {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET);
  const f = resolve(process.env.DATA_DIR ?? resolve(import.meta.dirname, "../../../data"), "session.key");
  if (!existsSync(f)) { mkdirSync(resolve(f, ".."), { recursive: true }); writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 }); }
  return Buffer.from(readFileSync(f, "utf8").trim());
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
export function signSession(email: string, key: Buffer, now = Date.now()) {
  const body = b64(JSON.stringify({ email, exp: now + DAYS * 86400000 }));
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
export function readSession(v: string | undefined, key: Buffer, allowed: string[], now = Date.now()): string | null {
  if (!v) return null; const [body, sig] = v.split("."); if (!body || !sig) return null;
  const want = createHmac("sha256", key).update(body).digest(), got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as { email: string; exp: number };
    return p.exp > now && allowed.includes(p.email.toLowerCase()) ? p.email : null; // removed from ALLOWED_EMAILS → logged out
  } catch { return null; }
}
const cookies = (req: FastifyRequest) => Object.fromEntries((req.headers.cookie ?? "").split(";").map(c => c.trim().split("=")).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));

const page = (msg = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Trader · Sign in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8ecf4;font:15px system-ui,sans-serif;padding:16px;box-sizing:border-box}
.c{background:#161a24;border:1px solid #262c3a;border-radius:16px;padding:32px 28px;width:min(360px,100%);text-align:center}
.l{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#7c8cff,#a78bfa);display:grid;place-items:center;margin:0 auto 14px;font-size:20px}
a.b{display:flex;gap:10px;align-items:center;justify-content:center;background:#fff;color:#1f1f1f;text-decoration:none;border-radius:10px;padding:12px;font-weight:600;margin-top:22px}
.e{background:#ff5d7322;color:#ff8a9a;border-radius:10px;padding:10px;margin-top:16px;font-size:13px}p{color:#8a93a6;margin:6px 0 0}</style></head>
<body><div class="c"><div class="l">◆</div><b style="font-size:18px">AI Trader</b><p>Sirf allowed emails sign in kar sakte hain</p>
${msg ? `<div class="e">${msg.replace(/[<>&"]/g, c => `&#${c.charCodeAt(0)};`)}</div>` : ""}
<a class="b" href="/auth/google"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Sign in with Google</a></div></body></html>`;

export function registerGoogleAuth(app: FastifyInstance) {
  const cfg = googleAuthConfig(); if (!cfg.enabled) return false;
  const key = secret();
  const base = (req: FastifyRequest) => cfg.publicUrl || `${req.protocol}://${req.headers.host}`;
  const secure = (req: FastifyRequest) => base(req).startsWith("https://") ? "; Secure" : "";
  const setCookie = (reply: FastifyReply, req: FastifyRequest, name: string, val: string, maxAge: number) =>
    reply.header("set-cookie", `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req)}`);
  const open = (u: string) => u === "/healthz" || u === "/login" || u.startsWith("/auth/") || u === "/favicon.ico";

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!; if (open(path)) return;
    const email = readSession(cookies(req)[COOKIE], key, cfg.allowed);
    if (email) { (req as FastifyRequest & { user?: string }).user = email; return; }
    if (path.startsWith("/api/")) return reply.code(401).send({ error: "LOGIN_REQUIRED" });
    return reply.redirect("/login");
  });
  app.get("/login", async (req, reply) => reply.type("text/html").send(page((req.query as { e?: string }).e ?? "")));
  app.get("/auth/google", async (req, reply) => {
    const state = randomBytes(16).toString("hex"); setCookie(reply, req, STATE, state, 600);
    const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: `${base(req)}/auth/google/callback`, response_type: "code", scope: "openid email", state, prompt: "select_account" });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
  });
  app.get("/auth/google/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string }, fail = (m: string) => reply.redirect(`/login?e=${encodeURIComponent(m)}`);
    if (q.error || !q.code) return fail("Google sign-in cancel hua");
    const st = cookies(req)[STATE];
    if (!st || !q.state || st.length !== q.state.length || !timingSafeEqual(Buffer.from(st), Buffer.from(q.state))) return fail("Sign-in expire ho gaya, dobara try karein");
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: q.code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: `${base(req)}/auth/google/callback`, grant_type: "authorization_code" }) });
    const j = await r.json().catch(() => ({})) as { id_token?: string };
    if (!r.ok || !j.id_token) return fail("Google se login verify nahi hua");
    const c = JSON.parse(Buffer.from(j.id_token.split(".")[1]!, "base64url").toString()) as { aud: string; iss: string; email?: string; email_verified?: boolean; exp: number };
    if (c.aud !== cfg.clientId || !["accounts.google.com", "https://accounts.google.com"].includes(c.iss) || c.exp * 1000 < Date.now() || !c.email || !c.email_verified) return fail("Google token invalid");
    const email = c.email.toLowerCase();
    if (!cfg.allowed.includes(email)) { app.log.warn({ email }, "google sign-in denied"); return fail(`${email} allowed nahi hai`); }
    reply.header("set-cookie", [`${COOKIE}=${encodeURIComponent(signSession(email, key))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure(req)}`, `${STATE}=; Path=/; Max-Age=0`]);
    return reply.redirect("/");
  });
  app.get("/auth/logout", async (req, reply) => { setCookie(reply, req, COOKIE, "", 0); return reply.redirect("/login"); });
  app.get("/api/me", async req => ({ email: (req as FastifyRequest & { user?: string }).user ?? null }));
  return true;
}
