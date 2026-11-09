import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { BrokerHolder } from "./broker.ts";

const prisma = new PrismaClient();
const broker = new BrokerHolder(() => new Date(), undefined, undefined, true);
const { app, engine } = await buildApp({ prisma, autoSync: true, broker });
app.log.info(`Data source on startup: ${broker.source}`);
if (config.gates.liveTradingEnabled || config.gates.tradingMode !== "PAPER")
  app.log.warn("Live flags in .env are IGNORED: this build is PAPER-only.");
// Restart safety: the auto-entry engine always starts STOPPED. Open paper positions are still monitored.
engine.startMonitor();
await app.listen({ host: config.host, port: config.port });
