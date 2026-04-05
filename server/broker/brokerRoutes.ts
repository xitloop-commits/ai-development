/**
 * Broker REST Routes
 *
 * Plain Express routes for Python modules to interact with the Broker Service.
 * All endpoints are under /api/broker/*
 */

import type { Express, Request, Response } from "express";
import {
  getActiveBroker,
  getBrokerServiceStatus,
  toggleKillSwitch,
  isKillSwitchActive,
} from "./brokerService";
import {
  getActiveBrokerConfig,
  getAllBrokerConfigs,
  upsertBrokerConfig,
  updateBrokerCredentials,
} from "./brokerConfig";
import type { OrderParams, ModifyParams } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

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

// ─── Route Registration ─────────────────────────────────────────

export function registerBrokerRoutes(app: Express): void {
  // ── Status ──────────────────────────────────────────────────

  /** GET /api/broker/status — Connection + token status */
  app.get("/api/broker/status", async (_req: Request, res: Response) => {
    try {
      const status = await getBrokerServiceStatus();
      res.json({ success: true, data: status });
    } catch (err: any) {
      console.error("[Broker REST] Error getting status:", err);
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
      console.error("[Broker REST] Error getting config:", err);
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
      console.error("[Broker REST] Error getting configs:", err);
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
      console.error("[Broker REST] Error upserting config:", err);
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
      console.error("[Broker REST] Error checking token:", err);
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
      console.error("[Broker REST] Error updating token:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Orders ──────────────────────────────────────────────────

  /** POST /api/broker/orders — Place order */
  app.post("/api/broker/orders", async (req: Request, res: Response) => {
    try {
      if (isKillSwitchActive()) {
        sendError(res, 403, "Kill switch is active. All trading is halted.");
        return;
      }

      const broker = requireBrokerREST(res);
      if (!broker) return;

      const params = req.body as OrderParams;
      if (!params.instrument || !params.transactionType || !params.quantity) {
        sendError(
          res,
          400,
          "Missing required fields: instrument, transactionType, quantity"
        );
        return;
      }

      const result = await broker.placeOrder(params);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error("[Broker REST] Error placing order:", err);
      sendError(res, 500, err.message);
    }
  });

  /** PUT /api/broker/orders/:id — Modify order */
  app.put("/api/broker/orders/:id", async (req: Request, res: Response) => {
    try {
      if (isKillSwitchActive()) {
        sendError(res, 403, "Kill switch is active. All trading is halted.");
        return;
      }

      const broker = requireBrokerREST(res);
      if (!broker) return;

      const orderId = req.params.id;
      const params = req.body as ModifyParams;
      const result = await broker.modifyOrder(orderId, params);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error("[Broker REST] Error modifying order:", err);
      sendError(res, 500, err.message);
    }
  });

  /** DELETE /api/broker/orders/:id — Cancel order */
  app.delete("/api/broker/orders/:id", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const orderId = req.params.id;
      const result = await broker.cancelOrder(orderId);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error("[Broker REST] Error cancelling order:", err);
      sendError(res, 500, err.message);
    }
  });

  /** GET /api/broker/orders — Order book */
  app.get("/api/broker/orders", async (_req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const orders = await broker.getOrderBook();
      res.json({ success: true, data: orders });
    } catch (err: any) {
      console.error("[Broker REST] Error getting orders:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Positions ───────────────────────────────────────────────

  /** GET /api/broker/positions — Current positions */
  app.get("/api/broker/positions", async (_req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const positions = await broker.getPositions();
      res.json({ success: true, data: positions });
    } catch (err: any) {
      console.error("[Broker REST] Error getting positions:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Margin ──────────────────────────────────────────────────

  /** GET /api/broker/margin — Margin/fund info */
  app.get("/api/broker/margin", async (_req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const margin = await broker.getMargin();
      res.json({ success: true, data: margin });
    } catch (err: any) {
      console.error("[Broker REST] Error getting margin:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Exit All ────────────────────────────────────────────────

  /** POST /api/broker/exit-all — Exit all positions */
  app.post("/api/broker/exit-all", async (_req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const result = await broker.exitAll();
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error("[Broker REST] Error exiting all:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Kill Switch ─────────────────────────────────────────────

  /** POST /api/broker/kill-switch — Activate/deactivate kill switch */
  app.post("/api/broker/kill-switch", async (req: Request, res: Response) => {
    try {
      const { action } = req.body;
      if (!action || !["ACTIVATE", "DEACTIVATE"].includes(action)) {
        sendError(
          res,
          400,
          'Missing or invalid action. Must be "ACTIVATE" or "DEACTIVATE".'
        );
        return;
      }

      const result = await toggleKillSwitch(action);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error("[Broker REST] Error toggling kill switch:", err);
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
      console.error("[Broker REST] Error getting scrip master status:", err);
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
      console.error("[Broker REST] Error refreshing scrip master:", err);
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
      console.error("[Broker REST] Error looking up security:", err);
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
      console.error("[Broker REST] Error getting expiry list:", err);
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
      console.error("[Broker REST] Error resolving MCX FUTCOM:", err);
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
      console.error("[Broker REST] Error getting expiry list:", err);
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
      console.error("[Broker REST] Error getting option chain:", err);
      sendError(res, 500, err.message);
    }
  });

  // ── Charts / Historical Data ─────────────────────────────────

  /** POST /api/broker/charts/intraday — Get intraday OHLCV candle data */
  app.post("/api/broker/charts/intraday", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { securityId, exchangeSegment, instrument, interval, fromDate, toDate, oi } = req.body;

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
      res.json({ success: true, data });
    } catch (err: any) {
      console.error("[Broker REST] Error fetching intraday data:", err);
      sendError(res, 500, err.message);
    }
  });

  /** POST /api/broker/charts/historical — Get daily historical OHLCV candle data */
  app.post("/api/broker/charts/historical", async (req: Request, res: Response) => {
    try {
      const broker = requireBrokerREST(res);
      if (!broker) return;

      const { securityId, exchangeSegment, instrument, fromDate, toDate, expiryCode, oi } = req.body;

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
      res.json({ success: true, data });
    } catch (err: any) {
      console.error("[Broker REST] Error fetching historical data:", err);
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
      console.error("[Broker REST] Error getting trades:", err);
      sendError(res, 500, err.message);
    }
  });
}
