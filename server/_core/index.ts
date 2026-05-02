import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerTradingRoutes } from "../tradingRoutes";
import { registerPortfolioRoutes } from "../portfolio/portfolioRoutes";
import { connectMongo } from "../mongo";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { registerAdapter, initBrokerService } from "../broker";
import { MockAdapter } from "../broker/adapters/mock";
import { DhanAdapter } from "../broker/adapters/dhan";
import { registerBrokerRoutes } from "../broker/brokerRoutes";
import { portfolioAgent } from "../portfolio";
import { tradeExecutor } from "../executor";
import { setupTickWebSocket } from "../broker/tickWs";
import { seedDefaultInstruments, getAllInstruments } from "../instruments";
import { setConfiguredInstruments } from "../tradingStore";
import { printAgentLegend, createLogger } from "../broker/logger";
import { registerReadyEndpoint, markReady } from "./ready";
import { registerFatalHandlers } from "./fatalHandlers";
import { registerShutdownHook, installSignalHandlers } from "./shutdown";
import { authMiddleware, registerAuthBootstrapEndpoint } from "./auth";
import { validateEnv } from "./validateEnv";
import { requestIdMiddleware } from "./correlationContext";
import { metricsHandler } from "./metrics";

const bootLog = createLogger("BOOT", "Server");

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // Register fatal-error handlers FIRST so any boot-time crash is logged
  // and alerted (not silently swallowed).
  registerFatalHandlers();

  // Wire SIGINT / SIGTERM into the centralised shutdown coordinator.
  // Hooks register themselves later in boot (mongo, broker, agents,
  // tickWs); the signal handler just dispatches.
  installSignalHandlers();

  // Print the agent color legend up-front so log-tail watchers know
  // how to read the color-coded prefixes that follow.
  printAgentLegend();

  // Boot-time env summary — loud, not silent. Every known env var is
  // classified (ok / warn / fatal) and logged with the consequence of
  // missing config. Server still tolerates anything; this is purely
  // operator visibility.
  validateEnv();

  const app = express();
  const server = createServer(app);

  // Connect to MongoDB (non-blocking — server starts even if MongoDB is down)
  connectMongo()
    .then(async () => {
      // Seed default instruments and load configured instruments into memory
      await seedDefaultInstruments();
      const instruments = await getAllInstruments();
      setConfiguredInstruments(instruments);

      // Wipe legacy capital docs that still use the pre-channel `workspace` field.
      // Idempotent — once migrated, this is a no-op on every subsequent boot.
      const { wipeLegacyCapitalDocs } = await import("../portfolio/state");
      try { await wipeLegacyCapitalDocs(); } catch (err) {
        bootLog.warn(`MongoDB Capital legacy wipe failed (non-fatal): ${(err as Error)?.message ?? err}`);
      }

      // Drop the legacy `discipline_state` unique index `(userId, date)`,
      // replaced by `(userId, channel, date)`. Idempotent.
      const { migrateDisciplineStateIndexes } = await import("../discipline/disciplineModel");
      try { await migrateDisciplineStateIndexes(); } catch (err) {
        bootLog.warn(`MongoDB Discipline index migration failed (non-fatal): ${(err as Error)?.message ?? err}`);
      }

      // B11-followup — rename trades[].brokerId (which was the broker
      // order ID) to brokerOrderId on legacy docs; the new brokerId
      // field stores the broker IDENTITY going forward. Idempotent.
      const { migrateBrokerIdToBrokerOrderId, migrateExitReasonsToHit } = await import("../portfolio/state");
      try { await migrateBrokerIdToBrokerOrderId(); } catch (err) {
        bootLog.warn(`MongoDB brokerId rename migration failed (non-fatal): ${(err as Error)?.message ?? err}`);
      }

      // C2/C3-followup — rename legacy exit reasons "SL"/"TP" →
      // "SL_HIT"/"TP_HIT" so PA storage matches the shared contract
      // vocabulary. Idempotent.
      try { await migrateExitReasonsToHit(); } catch (err) {
        bootLog.warn(`MongoDB exitReason rename migration failed (non-fatal): ${(err as Error)?.message ?? err}`);
      }

      // Phase D — collapse legacy CLOSED_TP/SL/MANUAL/PARTIAL/EOD
      // statuses into canonical "CLOSED" + backfill exitReason where
      // missing. Idempotent.
      const { migrateClosedStatusToCanonical } = await import("../portfolio/state");
      try { await migrateClosedStatusToCanonical(); } catch (err) {
        bootLog.warn(`MongoDB CLOSED_* status collapse migration failed (non-fatal): ${(err as Error)?.message ?? err}`);
      }

      // Register broker adapters and initialize broker service after MongoDB is ready
      registerAdapter("mock", () => new MockAdapter(), { displayName: "Paper Trading", isPaperBroker: true });
      registerAdapter("dhan", () => new DhanAdapter("dhan", false), { displayName: "Dhan (Trading)", isPaperBroker: false });
      registerAdapter("dhan-ai-data", () => new DhanAdapter("dhan-ai-data", false), { displayName: "Dhan (AI + Data)", isPaperBroker: false });
      await initBrokerService();
      markReady("broker");
      // Broker WS connections close via brokerService disconnect at prio 500
      // (after agents flush at 100, before mongo at 1000).
      registerShutdownHook("brokerService", async () => {
        const { disconnectAllAdapters } = await import("../broker/brokerService");
        await disconnectAllAdapters();
      }, 500);

      portfolioAgent.start();
      registerShutdownHook("portfolioAgent", () => portfolioAgent.stop(), 100);
      tradeExecutor.start();
      registerShutdownHook("tradeExecutor", () => tradeExecutor.stop(), 100);

      // Discipline Agent — Module 8 (Capital Protection) carry-forward
      // scheduler. Two timers (NSE 15:15, MCX 23:15 — operator-tunable)
      // fire at the configured IST times. The cap evaluator itself runs
      // synchronously inside onTradeClosed; this scheduler is only the
      // end-of-session carry-forward path.
      const { disciplineAgent } = await import("../discipline");
      await disciplineAgent.start();
      registerShutdownHook("disciplineAgent", () => disciplineAgent.stop(), 100);

      // Risk Control Agent — top-level agent (C2). Owns the real-time
      // monitor loop (age, stale-price, momentum-flip, volatility). The
      // 3 inbound REST endpoints (evaluate, discipline-request, ai-signal)
      // are registered separately below.
      const { rcaMonitor } = await import("../risk-control");
      rcaMonitor.start({ channels: ["ai-paper"] });
      registerShutdownHook("riskControl", () => rcaMonitor.stop(), 100);
    })
    .catch((err) =>
      bootLog.error(`MongoDB initial connection failed: ${(err as Error)?.message ?? err}`)
    );
  // Correlation ID — assign one requestId per HTTP request and propagate
  // it through the async tree so every log line emitted while serving the
  // request carries the same id. Mounted before any other middleware so
  // even error-path logs (auth rejection, body-parser failure, etc.) are
  // tagged.
  app.use(requestIdMiddleware);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  // Simple liveness probe — process is up. Public (probe-friendly).
  app.get("/health", (_req, res) => res.json({ ok: true }));
  // Readiness probe — Mongo + broker + tickWs all initialised. Public.
  registerReadyEndpoint(app);

  // B1 — internal-API auth: shared-secret X-Internal-Token check on
  // every /api/* request (REST + tRPC). /health and /ready are
  // exempt internally. During rollout the middleware runs in warn-only
  // mode (logs but proceeds); flip REQUIRE_INTERNAL_AUTH=true to enforce.
  app.use("/api", authMiddleware);

  // B1-followup — dashboard reads INTERNAL_API_SECRET from this
  // loopback-only endpoint on first paint, then attaches the header
  // to every subsequent /api/* call. Lives at /api/_auth/bootstrap
  // and is exempted from authMiddleware via EXEMPT_PATHS.
  registerAuthBootstrapEndpoint(app);

  // F7 — Prometheus metrics. Mounted under /api/_metrics so the global
  // /api authMiddleware gates it (no public scrape). A scraper that
  // wants to pull this endpoint must present X-Internal-Token like any
  // other internal caller.
  app.get("/api/_metrics", metricsHandler);

  // Trading data push API (receives data from Python modules)
  registerTradingRoutes(app);
  // Broker Service REST API (for Python modules)
  registerBrokerRoutes(app);
  // Portfolio Agent REST API (PA spec §10.1)
  registerPortfolioRoutes(app);
  // Risk Control Agent REST API — inbound from DA + SEA (C2)
  const { registerRiskControlRoutes } = await import("../risk-control/routes");
  registerRiskControlRoutes(app);
  // Discipline Agent REST API — single chain endpoint for SEA Python
  // (DA → RCA → TEA in one round-trip). The TS-only callers continue
  // to use the tRPC `discipline.validate` procedure.
  const { registerDisciplineRoutes } = await import("../discipline/routes");
  registerDisciplineRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Tick WebSocket AFTER Vite so we can intercept /ws/ticks upgrades
  // while letting Vite HMR handle its own WS upgrades
  const tickWsHandle = setupTickWebSocket(server);
  markReady("tickWs");
  // tickWs closes BEFORE broker WS so browser clients don't dangle.
  registerShutdownHook("tickWs", () => tickWsHandle.close(), 400);

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    bootLog.info(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  const host = process.env.HTTP_HOST ?? "127.0.0.1";
  server.listen(port, host, () => {
    bootLog.important(`Server running on http://${host}:${port}/`);
  });
}

startServer().catch((err) => bootLog.error("startServer failed", err));
