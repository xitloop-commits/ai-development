import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerTradingRoutes } from "../tradingRoutes";
import { connectMongo } from "../mongo";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { registerAdapter, initBrokerService } from "../broker";
import { MockAdapter } from "../broker/adapters/mock";
import { DhanAdapter } from "../broker/adapters/dhan";
import { registerBrokerRoutes } from "../broker/brokerRoutes";
import aiDecisionsRouter from "../aiDecisions";
import { pnlEngine } from "../capital/pnlEngine";
import { orderSyncEngine } from "../capital/orderSyncEngine";
import { setupTickWebSocket } from "../broker/tickWs";

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
      // Register broker adapters and initialize broker service after MongoDB is ready
      registerAdapter("mock", () => new MockAdapter(), { displayName: "Paper Trading", isPaperBroker: true });
      registerAdapter("dhan", () => new DhanAdapter(), { displayName: "Dhan", isPaperBroker: false });
      await initBrokerService();
      pnlEngine.start();
      orderSyncEngine.start();
    })
    .catch((err) =>
      console.error("[MongoDB] Initial connection failed:", err)
    );
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // Trading data push API (receives data from Python modules)
  registerTradingRoutes(app);
  // Broker Service REST API (for Python modules)
  registerBrokerRoutes(app);
  // AI Decisions REST API (serves AI decision JSON files for frontend)
  app.use("/api/ai-decisions", aiDecisionsRouter);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // Tick WebSocket (native WS for zero-latency LTP streaming)
  setupTickWebSocket(server);

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

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
