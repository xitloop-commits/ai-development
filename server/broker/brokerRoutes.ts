/**
 * Broker REST Routes
 *
 * Plain Express routes for Python modules to interact with the Broker Service.
 * All endpoints are under /api/broker/*
 */

import type { Express, Request, Response } from "express";
import {
  getActiveBroker,
  getAdapter,
  getBrokerServiceStatus,
  toggleKillSwitch,
  toggleWorkspaceKillSwitch,
  isChannelKillSwitchActive,
  type Channel,
  type Workspace,
} from "./brokerService";
import {
  getActiveBrokerConfig,
  getAllBrokerConfigs,
  getBrokerConfig,
  upsertBrokerConfig,
  updateBrokerCredentials,
} from "./brokerConfig";
import { DHAN_TOKEN_EXPIRY_MS } from "./adapters/dhan/constants";
import type { OrderParams, ModifyParams } from "./types";
import { transformCandleData } from "./types";
import { createLogger } from "./logger";

const log = createLogger("REST");

// ─── Helpers ────────────────────────────────────────────────────

const VALID_CHANNELS = new Set<Channel>([
  "ai-live", "ai-paper", "my-live", "my-paper", "testing-live", "testing-sandbox",
]);

const VALID_WORKSPACES = new Set<Workspace>(["ai", "my", "testing"]);

function sendError(res: Response, status: number, message: string) {
  res.status(status).json({ success: false, error: message });
}

function requireBrokerREST(res: Response) {
  const broker = getActiveBroker();
  if (!broker) {
    sendError(res, 503, "No active broker adapter. Configure a broker first.");
    return null;
  }
  return broker;
}

function requireChannelAdapter(channel: string, res: Response) {
  if (!VALID_CHANNELS.has(channel as Channel)) {
    sendError(res, 400, `Invalid channel "${channel}". Valid: ${Array.from(VALID_CHANNELS).join(", ")}`);
    return null;
  }
  try {
    return getAdapter(channel as Channel);
  } catch (err: any) {
    sendError(res, 503, err.message ?? `Adapter for channel "${channel}" not available.`);
    return null;
  }
}

// ─── Route Registration ─────────────────────────────────────────

export function registerBrokerRoutes(app: Express): void {
  // ── Status ──────────────────────────────────────────────────

  /** GET /api/broker/status — Connection + token status */
  app.get("/api/broker/status", async (_req: Request, res: Response) => {
    try {
      const status = await getBrokerServiceStatus();
      res.json({ success: true, data: status });
    } catch (err: any) {
      log.error("Error getting status:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Config ──────────────────────────────────────────────────

  /** GET /api/broker/config — Active broker config (token masked) */
  app.get("/api/broker/config", async (_req: Request, res: Response) => {
    try {
      const config = await getActiveBrokerConfig();
      if (!config) {
        res.json({ success: true, data: null });
        return;
      }
      // Mask token
      res.json({
        success: true,
        data: {
          ...config,
          credentials: {
            ...config.credentials,
            accessToken: config.credentials.accessToken
              ? `***${config.credentials.accessToken.slice(-4)}`
              : "",
          },
        },
      });
    } catch (err: any) {
      log.error("Error getting config:", err);
      sendError(res, 500, err.message);
    }
  });

  /** GET /api/broker/configs — All broker configs (tokens masked) */
  app.get("/api/broker/configs", async (_req: Request, res: Response) => {
    try {
      const configs = await getAllBrokerConfigs();
      res.json({
        success: true,
        data: configs.map((c) => ({
          ...c,
          credentials: {
            ...c.credentials,
            accessToken: c.credentials.accessToken
              ? `***${c.credentials.accessToken.slice(-4)}`
              : "",
          },
        })),
      });
    } catch (err: any) {
      log.error("Error getting configs:", err);
      sendError(res, 500, err.message);
    }
  });

  /** POST /api/broker/config — Create/update broker config */
  app.post("/api/broker/config", async (req: Request, res: Response) => {
    try {
      const config = req.body;
      if (!config.brokerId || !config.displayName) {
        sendError(res, 400, "Missing brokerId or displayName");
        return;
      }
      const result = await upsertBrokerConfig(config);
      res.json({ success: true, data: result });
    } catch (err: any) {
      log.error("Error upserting config:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Token ───────────────────────────────────────────────────

  /** GET /api/broker/token/status — Token validity check */
  app.get("/api/broker/token/status", async (_req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const result = await broker.validateToken();
      res.json({
        success: true,
        data: {
          valid: result.valid,
          expiresAt: result.expiresAt,
          message: result.valid
            ? "Token is valid"
            : "Token expired or invalid",
        },
      });
    } catch (err: any) {
      log.error("Error checking token:", err);
      sendError(res, 500, err.message);
    }
  });

  /** POST /api/broker/token/update — Update access token */
  app.post("/api/broker/token/update", async (req: Request, res: Response) => {
    try {
      const { token, clientId } = req.body;
      if (!token) {
        sendError(res, 400, "Missing token");
        return;
      }

      const broker = requireBrokerREST(res);
      if (!broker) return;

      await broker.updateToken(token, clientId);

      // Also update in MongoDB
      const config = await getActiveBrokerConfig();
      if (config) {
        await updateBrokerCredentials(config.brokerId, {
          accessToken: token,
          clientId: clientId ?? config.credentials.clientId,
          updatedAt: Date.now(),
          status: "valid",
        });
      }

      res.json({ success: true, message: "Token updated" });
    } catch (err: any) {
      log.error("Error updating token:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Channel-scoped Orders / Positions / Margin / Exit-all ───

  /** POST /api/broker/:channel/orders — Place order (kill switch checked) */
  app.post("/api/broker/:channel/orders", async (req: Request, res: Response) => {
    try {
      const channel = req.params.channel as Channel;
      const broker = requireChannelAdapter(channel, res);
      if (!broker) return;

      if (isChannelKillSwitchActive(channel)) {
        sendError(res, 403, `KILL_SWITCH_ACTIVE: Trading halted for channel "${channel}".`);
        return;
      }

      const params = req.body as OrderParams;
      if (!params.instrument || !params.transactionType || !params.quantity) {
        sendError(res, 400, "Missing required fields: instrument, transactionType, quantity");
        return;
      }

      const result = await broker.placeOrder(params);
      res.json({ success: true, data: result });
    } catch (err: any) {
      log.error("Error placing order:", err);
      sendError(res, 500, err.message);
    }
  });

  /** PUT /api/broker/:channel/orders/:id — Modify order (kill switch checked) */
  app.put("/api/broker/:channel/orders/:id", async (req: Request, res: Response) => {
    try {
      const channel = req.params.channel as Channel;
      const broker = requireChannelAdapter(channel, res);
      if (!broker) return;

      if (isChannelKillSwitchActive(channel)) {
        sendError(res, 403, `KILL_SWITCH_ACTIVE: Trading halted for channel "${channel}".`);
        return;
      }

      const result = await broker.modifyOrder(req.params.id, req.body as ModifyParams);
      res.json({ success: true, data: result });
    } catch (err: any) {
      log.error("Error modifying order:", err);
      sendError(res, 500, err.message);
    }
  });

  /** DELETE /api/broker/:channel/orders/:id — Cancel order (bypasses kill switch) */
  app.delete("/api/broker/:channel/orders/:id", async (req: Request, res: Response) => {
    try {
      const broker = requireChannelAdapter(req.params.channel, res);
      if (!broker) return;
      const result = await broker.cancelOrder(req.params.id);
      res.json({ success: true, data: result });
    } catch (err: any) {
      log.error("Error cancelling order:", err);
      sendError(res, 500, err.message);
    }
  });

  /** GET /api/broker/:channel/orders — Order book for channel */
  app.get("/api/broker/:channel/orders", async (req: Request, res: Response) => {
    try {
      const broker = requireChannelAdapter(req.params.channel, res);
      if (!broker) return;
      const orders = await broker.getOrderBook();
      res.json({ success: true, data: orders });
    } catch (err: any) {
      log.error("Error getting orders:", err);
      sendError(res, 500, err.message);
    }
  });

  /** GET /api/broker/:channel/positions — Positions for channel */
  app.get("/api/broker/:channel/positions", async (req: Request, res: Response) => {
    try {
      const broker = requireChannelAdapter(req.params.channel, res);
      if (!broker) return;
      const positions = await broker.getPositions();
      res.json({ success: true, data: positions });
    } catch (err: any) {
      log.error("Error getting positions:", err);
      sendError(res, 500, err.message);
    }
  });

  /** GET /api/broker/:channel/margin — Margin/fund info for channel */
  app.get("/api/broker/:channel/margin", async (req: Request, res: Response) => {
    try {
      const broker = requireChannelAdapter(req.params.channel, res);
      if (!broker) return;
      const margin = await broker.getMargin();
      res.json({ success: true, data: margin });
    } catch (err: any) {
      log.error("Error getting margin:", err);
      sendError(res, 500, err.message);
    }
  });

  /** POST /api/broker/:channel/exit-all — Exit all positions (bypasses kill switch) */
  app.post("/api/broker/:channel/exit-all", async (req: Request, res: Response) => {
    try {
      const broker = requireChannelAdapter(req.params.channel, res);
      if (!broker) return;
      const result = await broker.exitAll();
      res.json({ success: true, data: result });
    } catch (err: any) {
      log.error("Error exiting all:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Kill Switch ─────────────────────────────────────────────

  /**
   * POST /api/broker/kill-switch
   * Body: { workspace: "ai" | "my" | "testing", action: "ACTIVATE" | "DEACTIVATE" }
   */
  app.post("/api/broker/kill-switch", async (req: Request, res: Response) => {
    try {
      const { workspace, action } = req.body;

      if (!workspace || !VALID_WORKSPACES.has(workspace as Workspace)) {
        sendError(res, 400, `Missing or invalid workspace. Must be: ${Array.from(VALID_WORKSPACES).join(", ")}`);
        return;
      }
      if (!action || !["ACTIVATE", "DEACTIVATE"].includes(action)) {
        sendError(res, 400, 'Missing or invalid action. Must be "ACTIVATE" or "DEACTIVATE".');
        return;
      }

      const result = await toggleWorkspaceKillSwitch(workspace as Workspace, action);
      res.json({ success: true, data: result });
    } catch (err: any) {
      log.error("Error toggling kill switch:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Scrip Master ────────────────────────────────────────────

  /** GET /api/broker/scrip-master/status — Scrip master cache status */
  app.get("/api/broker/scrip-master/status", async (_req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      if (broker.getScripMasterStatus) {
        const status = broker.getScripMasterStatus();
        res.json({ success: true, data: status });
      } else {
        res.json({
          success: true,
          data: {
            isLoaded: false,
            recordCount: 0,
            message: "Scrip master not supported by this adapter",
          },
        });
      }
    } catch (err: any) {
      log.error("Error getting scrip master status:", err);
      sendError(res, 500, err.message);
    }
  });

  /** POST /api/broker/scrip-master/refresh — Force re-download scrip master */
  app.post("/api/broker/scrip-master/refresh", async (_req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      if (broker.refreshScripMaster) {
        const status = await broker.refreshScripMaster();
        res.json({ success: true, data: status });
      } else {
        sendError(res, 501, "Scrip master refresh not supported by this adapter");
      }
    } catch (err: any) {
      log.error("Error refreshing scrip master:", err);
      sendError(res, 500, err.message);
    }
  });

  /** GET /api/broker/scrip-master/lookup — Lookup security ID */
  app.get("/api/broker/scrip-master/lookup", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { symbol, expiry, strike, optionType, exchange, instrumentName } = req.query;

      if (!symbol) {
        sendError(res, 400, "Missing required query param: symbol");
        return;
      }

      if (broker.lookupSecurity) {
        const result = broker.lookupSecurity({
          symbol: symbol as string,
          expiry: expiry as string | undefined,
          strike: strike ? parseFloat(strike as string) : undefined,
          optionType: optionType as string | undefined,
          exchange: exchange as string | undefined,
          instrumentName: instrumentName as string | undefined,
        });

        if (result) {
          res.json({ success: true, data: result });
        } else {
          sendError(res, 404, `No match found for symbol=${symbol}`);
        }
      } else {
        sendError(res, 501, "Security lookup not supported by this adapter");
      }
    } catch (err: any) {
      log.error("Error looking up security:", err);
      sendError(res, 500, err.message);
    }
  });

  /** GET /api/broker/scrip-master/expiry-list — Get expiry dates from cache */
  app.get("/api/broker/scrip-master/expiry-list", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { symbol, exchange, instrumentName } = req.query;

      if (!symbol) {
        sendError(res, 400, "Missing required query param: symbol");
        return;
      }

      if (broker.getScripExpiryDates) {
        const dates = broker.getScripExpiryDates(
          symbol as string,
          exchange as string | undefined,
          instrumentName as string | undefined
        );
        res.json({ success: true, data: dates });
      } else {
        sendError(res, 501, "Expiry list from cache not supported by this adapter");
      }
    } catch (err: any) {
      log.error("Error getting expiry list:", err);
      sendError(res, 500, err.message);
    }
  });

  /** GET /api/broker/scrip-master/mcx-futcom — Resolve nearest-month MCX FUTCOM */
  app.get("/api/broker/scrip-master/mcx-futcom", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { symbol } = req.query;

      if (!symbol) {
        sendError(res, 400, "Missing required query param: symbol");
        return;
      }

      if (broker.resolveMCXFutcom) {
        const result = await broker.resolveMCXFutcom(symbol as string);
        if (result) {
          res.json({ success: true, data: result });
        } else {
          sendError(res, 404, `No FUTCOM found for ${symbol}`);
        }
      } else {
        sendError(res, 501, "MCX FUTCOM resolution not supported by this adapter");
      }
    } catch (err: any) {
      log.error("Error resolving MCX FUTCOM:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Option Chain (via Dhan API) ────────────────────────────

  /** GET /api/broker/option-chain/expiry-list — Get expiry list from Dhan API */
  app.get("/api/broker/option-chain/expiry-list", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { underlying, exchangeSegment } = req.query;
      if (!underlying) {
        sendError(res, 400, "Missing required query param: underlying");
        return;
      }

      const dates = await broker.getExpiryList(
        underlying as string,
        (exchangeSegment as string) || undefined
      );
      res.json({ success: true, data: dates });
    } catch (err: any) {
      log.error("Error getting expiry list:", err);
      sendError(res, 500, err.message);
    }
  });

  /** GET /api/broker/option-chain — Get option chain from Dhan API */
  app.get("/api/broker/option-chain", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { underlying, expiry, exchangeSegment } = req.query;
      if (!underlying || !expiry) {
        sendError(res, 400, "Missing required query params: underlying, expiry");
        return;
      }

      const chain = await broker.getOptionChain(
        underlying as string,
        expiry as string,
        (exchangeSegment as string) || undefined
      );
      res.json({ success: true, data: chain });
    } catch (err: any) {
      log.error("Error getting option chain:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Charts / Historical Data ─────────────────────────────────

  /** POST /api/broker/charts/intraday — Get intraday OHLCV candle data */
  app.post("/api/broker/charts/intraday", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { securityId, exchangeSegment, instrument, interval, fromDate, toDate, oi, transform } = req.body;

      if (!securityId || !exchangeSegment || !instrument || !interval || !fromDate || !toDate) {
        sendError(
          res,
          400,
          "Missing required fields: securityId, exchangeSegment, instrument, interval, fromDate, toDate"
        );
        return;
      }

      const validIntervals = ["1", "5", "15", "25", "60"];
      if (!validIntervals.includes(interval)) {
        sendError(res, 400, `Invalid interval. Must be one of: ${validIntervals.join(", ")}`);
        return;
      }

      const data = await broker.getIntradayData({
        securityId,
        exchangeSegment,
        instrument,
        interval,
        fromDate,
        toDate,
        oi: oi ?? false,
      });

      if (transform === true || transform === "true" || transform === "t") {
        res.setHeader("Content-Type", "text/csv");
        res.send(transformCandleData(data, "intraday"));
      } else {
        res.json({ success: true, data });
      }
    } catch (err: any) {
      log.error("Error fetching intraday data:", err);
      sendError(res, 500, err.message);
    }
  });

  /** POST /api/broker/charts/historical — Get daily historical OHLCV candle data */
  app.post("/api/broker/charts/historical", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { securityId, exchangeSegment, instrument, fromDate, toDate, expiryCode, oi, transform } = req.body;

      if (!securityId || !exchangeSegment || !instrument || !fromDate || !toDate) {
        sendError(
          res,
          400,
          "Missing required fields: securityId, exchangeSegment, instrument, fromDate, toDate"
        );
        return;
      }

      const data = await broker.getHistoricalData({
        securityId,
        exchangeSegment,
        instrument,
        fromDate,
        toDate,
        expiryCode: expiryCode ?? 0,
        oi: oi ?? false,
      });

      if (transform === true || transform === "true" || transform === "t") {
        res.setHeader("Content-Type", "text/csv");
        res.send(transformCandleData(data, "historical"));
      } else {
        res.json({ success: true, data });
      }
    } catch (err: any) {
      log.error("Error fetching historical data:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Trade Book ──────────────────────────────────────────────

  /** GET /api/broker/trades — Trade book */
  app.get("/api/broker/trades", async (_req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const trades = await broker.getTradeBook();
      res.json({ success: true, data: trades });
    } catch (err: any) {
      log.error("Error getting trades:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Token (unmasked, for TFA internal use only) ─────────────

  /**
   * GET /api/broker/token
   * Returns unmasked Dhan credentials so TFA can open its own direct
   * Dhan WebSocket connection at startup. Localhost-only — rejects all
   * external requests with 403.
   */
  app.get("/api/broker/token", async (req: Request, res: Response) => {
    // Localhost-only guard — never expose raw token externally
    const ip = req.ip ?? "";
    const isLocal =
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip === "::ffff:127.0.0.1";
    if (!isLocal) {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }

    try {
      // brokerId selectable via query (?brokerId=dhan-ai-data for TFA on the
      // spouse's account). Defaults to "dhan" for backward compatibility.
      const brokerIdParam = String(req.query.brokerId ?? "dhan");
      let config = await getBrokerConfig(brokerIdParam);
      if (!config) {
        sendError(res, 404, `Broker config not found for brokerId=${brokerIdParam}`);
        return;
      }

      let { accessToken, clientId, status, updatedAt, expiresIn } =
        config.credentials;

      // ── Self-healing: refresh token if expired / near-expiry / invalid ──
      // TFA's only window into token state is this endpoint. If BSA hasn't
      // noticed an expired token (no trading endpoint call has hit 401 yet),
      // returning it would break TFA's WebSocket reconnect. So we proactively
      // check + refresh here.  Coalesced via auth.ts _inflightRefresh — will
      // NOT double-generate if BSA is also refreshing at the same moment.
      const ageMs       = updatedAt ? Date.now() - updatedAt : Infinity;
      const expiresInMs = expiresIn || DHAN_TOKEN_EXPIRY_MS;
      const EXPIRY_BUFFER_MS = 5 * 60 * 1000;   // refresh if < 5 min remaining
      const isExpired     = ageMs >= expiresInMs;
      const isExpiringSoon = ageMs >= expiresInMs - EXPIRY_BUFFER_MS;
      const isMissing     = !accessToken || status === "expired";

      if (isMissing || isExpired || isExpiringSoon) {
        log.info(
          `GET /api/broker/token: token stale (age=${Math.round(ageMs / 1000)}s, ` +
          `status=${status}) — refreshing before return.`
        );
        try {
          // Use handleDhan401 path — it has coalescing built in and sets
          // status + updatedAt + updates adapter via the inflight lock.
          const { handleDhan401 } = await import(
            "./adapters/dhan/auth"
          );
          await handleDhan401(brokerIdParam);
          // Re-read fresh config after refresh
          config = await getBrokerConfig(brokerIdParam);
          if (config) {
            accessToken = config.credentials.accessToken;
            clientId    = config.credentials.clientId;
            status      = config.credentials.status;
            updatedAt   = config.credentials.updatedAt;
            expiresIn   = config.credentials.expiresIn;
          }
        } catch (refreshErr: any) {
          log.error(
            `GET /api/broker/token: refresh failed — ${refreshErr.message}`
          );
          // Fall through and return whatever we have; caller can decide
        }
      }

      const tokenExpiresIn =
        updatedAt && expiresIn
          ? Math.max(0, updatedAt + expiresIn - Date.now())
          : null;

      res.json({
        success: true,
        data: {
          accessToken,
          clientId,
          status,
          expiresIn: tokenExpiresIn,
        },
      });
    } catch (err: any) {
      log.error("Error getting token:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Feed Subscribe / Unsubscribe / State ────────────────────

  /**
   * POST /api/broker/feed/subscribe
   * Allows Python consumers to subscribe security IDs to BSA's Dhan WS feed.
   * Body: { instruments: [{ securityId, exchange }], mode?: "ltp"|"quote"|"full" }
   */
  app.post("/api/broker/feed/subscribe", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { instruments, mode } = req.body;
      if (!Array.isArray(instruments) || instruments.length === 0) {
        sendError(res, 400, "Missing or empty instruments array");
        return;
      }

      const feedMode = mode ?? "full";
      broker.subscribeLTP(
        instruments.map((i: any) => ({ ...i, mode: feedMode })),
        () => {} // tick forwarding handled by tickBus inside the adapter
      );

      const state = broker.getSubscriptionState?.();
      res.json({
        success: true,
        subscribed: instruments.length,
        total: state?.totalSubscriptions ?? instruments.length,
      });
    } catch (err: any) {
      log.error("Error subscribing feed:", err);
      sendError(res, 500, err.message);
    }
  });

  /**
   * POST /api/broker/feed/unsubscribe
   * Body: { instruments: [{ securityId, exchange }] }
   */
  app.post("/api/broker/feed/unsubscribe", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { instruments } = req.body;
      if (!Array.isArray(instruments) || instruments.length === 0) {
        sendError(res, 400, "Missing or empty instruments array");
        return;
      }

      broker.unsubscribeLTP(instruments);

      const state = broker.getSubscriptionState?.();
      res.json({
        success: true,
        unsubscribed: instruments.length,
        total: state?.totalSubscriptions ?? 0,
      });
    } catch (err: any) {
      log.error("Error unsubscribing feed:", err);
      sendError(res, 500, err.message);
    }
  });

  /**
   * GET /api/broker/feed/state
   * Returns current subscription registry and WebSocket connection status.
   */
  app.get("/api/broker/feed/state", async (_req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const state = broker.getSubscriptionState?.();
      res.json({
        success: true,
        data: {
          wsConnected: state?.wsConnected ?? false,
          totalSubscriptions: state?.totalSubscriptions ?? 0,
          maxSubscriptions: state?.maxSubscriptions ?? 5000,
          instruments: state ? Array.from(state.instruments.keys()) : [],
        },
      });
    } catch (err: any) {
      log.error("Error getting feed state:", err);
      sendError(res, 500, err.message);
    }
  });
}
