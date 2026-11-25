import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily } from "node:net";
// Dhan order APIs check the caller's whitelisted static IP — always connect over IPv4 so the IP is the predictable one.
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false); // no happy-eyeballs → the first (IPv4) address is used
import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { BrokerHolder } from "./broker.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, extname, normalize } from "node:path";

const prisma = new PrismaClient();
const broker = new BrokerHolder(() => new Date(), undefined, undefined, true);
const { app, engines } = await buildApp({ prisma, autoSync: true, broker });
app.log.info(`Data source on startup: ${broker.source}`);
if (config.gates.liveTradingEnabled || config.gates.tradingMode !== "PAPER")
  app.log.warn("Live flags in .env are IGNORED: this build is PAPER-only.");
// Restart safety: the auto-entry engine always starts STOPPED. Open paper positions are still monitored.
engines.DHAN.startMonitor(); engines.DELTA.startMonitor(); // both exchanges monitor their open paper positions independently
// Production: serve the built web UI (apps/web/dist) from the same port — set WEB_DIST or build into the default path.
const WEB = resolve(process.env.WEB_DIST ?? resolve(import.meta.dirname, "../../web/dist"));
if (existsSync(resolve(WEB, "index.html"))) {
  const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".map": "application/json" };
  app.setNotFoundHandler((req, reply) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    if (req.method !== "GET" || path.startsWith("/api/")) return reply.code(404).send({ error: "NOT_FOUND" });
    let f = resolve(WEB, "." + normalize(path));
    if (!f.startsWith(WEB) || !existsSync(f) || statSync(f).isDirectory()) f = resolve(WEB, "index.html"); // SPA fallback
    reply.header("cache-control", f.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.type(TYPES[extname(f)] ?? "application/octet-stream").send(readFileSync(f));
  });
  app.log.info(`Serving web UI from ${WEB}`);
}
await app.listen({ host: config.host, port: config.port });
