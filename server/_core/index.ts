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
import { orderSyncEngine } from "../portfolio/orderSync";
import { setupTickWebSocket } from "../broker/tickWs";
import { seedDefaultInstruments, getAllInstruments } from "../instruments";
import { setConfiguredInstruments } from "../tradingStore";

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
        console.warn("[MongoDB] Capital legacy wipe failed (non-fatal):", err);
      }

      // Register broker adapters and initialize broker service after MongoDB is ready
      registerAdapter("mock", () => new MockAdapter(), { displayName: "Paper Trading", isPaperBroker: true });
      registerAdapter("dhan", () => new DhanAdapter("dhan", false), { displayName: "Dhan (Trading)", isPaperBroker: false });
      registerAdapter("dhan-ai-data", () => new DhanAdapter("dhan-ai-data", false), { displayName: "Dhan (AI + Data)", isPaperBroker: false });
      await initBrokerService();
      portfolioAgent.start();
      orderSyncEngine.start();
    })
    .catch((err) =>
      console.error("[MongoDB] Initial connection failed:", err)
    );
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Simple health check — used by start-all.bat to wait until server is ready
  app.get("/health", (_req, res) => res.json({ ok: true }));
  // Trading data push API (receives data from Python modules)
  registerTradingRoutes(app);
  // Broker Service REST API (for Python modules)
  registerBrokerRoutes(app);
  // Portfolio Agent REST API (PA spec §10.1)
  registerPortfolioRoutes(app);
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
  setupTickWebSocket(server);

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
