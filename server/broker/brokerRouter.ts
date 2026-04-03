/**
 * Broker tRPC Router
 *
 * Exposes the Broker Service to the frontend via tRPC procedures.
 * All order/position/margin calls route through the active adapter.
 * Feed sub-router provides live tick data via SSE subscriptions.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { tracked } from "@trpc/server";
import { publicProcedure, router } from "../_core/trpc";
import {
  getActiveBroker,
  getBrokerServiceStatus,
  getRegisteredAdaptersMeta,
  switchBroker,
  toggleKillSwitch,
  isKillSwitchActive,
} from "./brokerService";
import {
  getActiveBrokerConfig,
  getAllBrokerConfigs,
  upsertBrokerConfig,
  updateBrokerSettings,
  updateBrokerCredentials,
  setActiveBroker as setActiveBrokerInDB,
} from "./brokerConfig";
import { tickBus } from "./tickBus";
import type { OrderParams, ModifyParams, TickData } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

function requireBroker() {
  const broker = getActiveBroker();
  if (!broker) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No active broker adapter. Configure a broker first.",
    });
  }
  return broker;
}

function checkKillSwitch() {
  if (isKillSwitchActive()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Kill switch is active. All trading is halted.",
    });
  }
}

// ─── Zod Schemas ────────────────────────────────────────────────

const orderParamsSchema = z.object({
  instrument: z.string(),
  exchange: z.enum(["NSE_FNO", "BSE_FNO", "MCX_COMM"]),
  transactionType: z.enum(["BUY", "SELL"]),
  optionType: z.enum(["CE", "PE", "FUT"]),
  strike: z.number(),
  expiry: z.string(),
  quantity: z.number().min(1),
  price: z.number().min(0),
  orderType: z.enum(["LIMIT", "MARKET", "SL", "SL-M"]),
  productType: z.enum(["INTRADAY", "CNC", "MARGIN"]),
  triggerPrice: z.number().optional(),
  stopLoss: z.number().optional(),
  target: z.number().optional(),
  tag: z.string().optional(),
});

const modifyParamsSchema = z.object({
  price: z.number().optional(),
  quantity: z.number().min(1).optional(),
  triggerPrice: z.number().optional(),
  orderType: z.enum(["LIMIT", "MARKET", "SL", "SL-M"]).optional(),
});

const brokerSettingsSchema = z.object({
  orderEntryOffset: z.number().min(0).max(10).optional(),
  defaultSL: z.number().min(0).max(50).optional(),
  defaultTP: z.number().min(0).max(100).optional(),
  orderType: z.enum(["LIMIT", "MARKET", "SL", "SL-M"]).optional(),
  productType: z.enum(["INTRADAY", "CNC", "MARGIN"]).optional(),
});

const subscribeParamsSchema = z.object({
  instruments: z.array(
    z.object({
      securityId: z.string(),
      exchange: z.string(), // IDX_I, NSE_EQ, NSE_FNO, BSE_FNO, MCX_COMM
      mode: z.enum(["ticker", "quote", "full"]).optional(),
    })
  ),
});

// ─── Router ─────────────────────────────────────────────────────

export const brokerRouter = router({
  // ── Adapters (always available, even before config exists) ──
  adapters: router({
    /** List all registered adapters with metadata. */
    list: publicProcedure.query(() => {
      return getRegisteredAdaptersMeta();
    }),
  }),

  // ── Setup (create initial broker config) ───────────────────
  setup: publicProcedure
    .input(
      z.object({
        brokerId: z.string(),
        accessToken: z.string().optional(),
        clientId: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Upsert the broker config
      await upsertBrokerConfig({
        brokerId: input.brokerId,
        displayName:
          getRegisteredAdaptersMeta().find((m) => m.brokerId === input.brokerId)
            ?.displayName ?? input.brokerId,
        isActive: true,
        isPaperBroker:
          getRegisteredAdaptersMeta().find((m) => m.brokerId === input.brokerId)
            ?.isPaperBroker ?? false,
        credentials: {
          accessToken: input.accessToken ?? "",
          clientId: input.clientId ?? "",
          status: input.accessToken ? "valid" : "unknown",
          updatedAt: Date.now(),
          expiresIn: 0,
        },
      });
      // Deactivate all others and set this one active
      await setActiveBrokerInDB(input.brokerId);
      // Try to switch to it (connects the adapter)
      try {
        await switchBroker(input.brokerId);
      } catch {
        // Non-fatal — config is saved, adapter may fail to connect
      }
      return { success: true };
    }),

  // ── Config ──────────────────────────────────────────────────

  config: router({
    /** Get the active broker config (token is masked). */
    get: publicProcedure.query(async () => {
      const config = await getActiveBrokerConfig();
      if (!config) return null;

      // Mask the access token for security
      return {
        ...config,
        credentials: {
          ...config.credentials,
          accessToken: config.credentials.accessToken
            ? `***${config.credentials.accessToken.slice(-4)}`
            : "",
        },
      };
    }),

    /** Get all broker configs (tokens masked). */
    list: publicProcedure.query(async () => {
      const configs = await getAllBrokerConfigs();
      return configs.map((c) => ({
        ...c,
        credentials: {
          ...c.credentials,
          accessToken: c.credentials.accessToken
            ? `***${c.credentials.accessToken.slice(-4)}`
            : "",
        },
      }));
    }),

    /** Update broker settings (SL, TP, order type, etc.). */
    updateSettings: publicProcedure
      .input(
        z.object({
          brokerId: z.string(),
          settings: brokerSettingsSchema,
        })
      )
      .mutation(async ({ input }) => {
        const updated = await updateBrokerSettings(
          input.brokerId,
          input.settings
        );
        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Broker config "${input.brokerId}" not found.`,
          });
        }
        return { success: true };
      }),

    /** Switch the active broker. */
    switchBroker: publicProcedure
      .input(z.object({ brokerId: z.string() }))
      .mutation(async ({ input }) => {
        await switchBroker(input.brokerId);
        return { success: true, activeBrokerId: input.brokerId };
      }),
  }),

  // ── Status ──────────────────────────────────────────────────

  /** Get overall broker service status. */
  status: publicProcedure.query(async () => {
    return getBrokerServiceStatus();
  }),

  // ── Token ───────────────────────────────────────────────────

  token: router({
    /** Check token validity. */
    status: publicProcedure.query(async () => {
      const broker = getActiveBroker();
      if (!broker) {
        return { valid: false, message: "No active broker" };
      }
      const result = await broker.validateToken();
      return {
        valid: result.valid,
        expiresAt: result.expiresAt,
        message: result.valid ? "Token is valid" : "Token expired or invalid",
      };
    }),

    /** Update the access token. */
    update: publicProcedure
      .input(
        z.object({
          token: z.string().min(1),
          clientId: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const broker = requireBroker();
        await broker.updateToken(input.token, input.clientId);

        // Also update in MongoDB
        const config = await getActiveBrokerConfig();
        if (config) {
          await updateBrokerCredentials(config.brokerId, {
            accessToken: input.token,
            clientId: input.clientId ?? config.credentials.clientId,
            updatedAt: Date.now(),
            status: "valid",
          });
        }

        return { success: true, message: "Token updated" };
      }),

  }),

  // ── Orders ──────────────────────────────────────────────────

  orders: router({
    /** Place a new order. */
    place: publicProcedure
      .input(orderParamsSchema)
      .mutation(async ({ input }) => {
        checkKillSwitch();
        const broker = requireBroker();
        return broker.placeOrder(input as OrderParams);
      }),

    /** Modify a pending order. */
    modify: publicProcedure
      .input(
        z.object({
          orderId: z.string(),
          params: modifyParamsSchema,
        })
      )
      .mutation(async ({ input }) => {
        checkKillSwitch();
        const broker = requireBroker();
        return broker.modifyOrder(input.orderId, input.params as ModifyParams);
      }),

    /** Cancel an order. */
    cancel: publicProcedure
      .input(z.object({ orderId: z.string() }))
      .mutation(async ({ input }) => {
        const broker = requireBroker();
        return broker.cancelOrder(input.orderId);
      }),

    /** Get the order book. */
    list: publicProcedure.query(async () => {
      const broker = requireBroker();
      return broker.getOrderBook();
    }),

    /** Get a specific order status. */
    get: publicProcedure
      .input(z.object({ orderId: z.string() }))
      .query(async ({ input }) => {
        const broker = requireBroker();
        return broker.getOrderStatus(input.orderId);
      }),

    /** Exit all open positions. */
    exitAll: publicProcedure.mutation(async () => {
      const broker = requireBroker();
      return broker.exitAll();
    }),
  }),

  // ── Positions ───────────────────────────────────────────────

  /** Get current positions. */
  positions: publicProcedure.query(async () => {
    const broker = requireBroker();
    return broker.getPositions();
  }),

  // ── Margin ──────────────────────────────────────────────────

  /** Get margin/fund information. */
  margin: publicProcedure.query(async () => {
    const broker = requireBroker();
    return broker.getMargin();
  }),

  // ── Kill Switch ─────────────────────────────────────────────

  /** Activate or deactivate the kill switch. */
  killSwitch: publicProcedure
    .input(z.object({ action: z.enum(["ACTIVATE", "DEACTIVATE"]) }))
    .mutation(async ({ input }) => {
      return toggleKillSwitch(input.action);
    }),

  // ── Market Data ─────────────────────────────────────────────

  /** Get scrip master for an exchange. */
  scripMaster: publicProcedure
    .input(z.object({ exchange: z.string() }))
    .query(async ({ input }) => {
      const broker = requireBroker();
      return broker.getScripMaster(input.exchange);
    }),

  /** Get expiry list for an underlying. */
  expiryList: publicProcedure
    .input(z.object({ underlying: z.string(), exchangeSegment: z.string().optional() }))
    .query(async ({ input }) => {
      const broker = requireBroker();
      return broker.getExpiryList(input.underlying, input.exchangeSegment);
    }),

  /** Get option chain data. */
  optionChain: publicProcedure
    .input(
      z.object({
        underlying: z.string(),
        expiry: z.string(),
        exchangeSegment: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const broker = requireBroker();
      return broker.getOptionChain(input.underlying, input.expiry, input.exchangeSegment);
    }),

  // ── Feed (Live Market Data) ─────────────────────────────────

  feed: router({
    /** Subscribe instruments to the broker's WebSocket feed. */
    subscribe: publicProcedure
      .input(subscribeParamsSchema)
      .mutation(({ input }) => {
        const broker = requireBroker();
        broker.subscribeLTP(input.instruments as any, (tick) => {
          tickBus.emitTick(tick);
        });
        return {
          success: true,
          count: input.instruments.length,
          message: `Subscribed ${input.instruments.length} instruments`,
        };
      }),

    /** Unsubscribe instruments from the broker's WebSocket feed. */
    unsubscribe: publicProcedure
      .input(subscribeParamsSchema)
      .mutation(({ input }) => {
        const broker = requireBroker();
        broker.unsubscribeLTP(input.instruments as any);
        return {
          success: true,
          count: input.instruments.length,
          message: `Unsubscribed ${input.instruments.length} instruments`,
        };
      }),

    /** Get current subscription state (count, ws status). */
    state: publicProcedure.query(() => {
      const broker = requireBroker();
      const state = broker.getSubscriptionState?.();
      if (!state) {
        return {
          totalSubscriptions: 0,
          maxSubscriptions: 200,
          wsConnected: false,
          instruments: [] as string[],
        };
      }
      return {
        totalSubscriptions: state.totalSubscriptions,
        maxSubscriptions: state.maxSubscriptions,
        wsConnected: state.wsConnected,
        instruments: Array.from(state.instruments.keys()),
      };
    }),

    /**
     * Resolve the correct feed securityIds for the 4 tracked underlyings.
     * NSE indices use hardcoded IDs (IDX_I:13, IDX_I:25).
     * MCX commodities resolve nearest-month future from scrip master.
     */
    resolveInstruments: publicProcedure.query(async () => {
      const broker = requireBroker();
      const instruments: Array<{
        name: string;
        securityId: string;
        exchange: string;
        mode: string;
      }> = [
        { name: "NIFTY_50", securityId: "13", exchange: "IDX_I", mode: "ticker" },
        { name: "BANKNIFTY", securityId: "25", exchange: "IDX_I", mode: "ticker" },
      ];
      // Ensure scrip master is loaded before resolving MCX
      if (broker.getScripMaster) {
        try {
          await broker.getScripMaster("MCX");
        } catch (e) {
          console.warn("[resolveInstruments] Failed to load scrip master:", e);
        }
      }
      // Resolve MCX commodities from scrip master
      for (const mcx of ["CRUDEOIL", "NATURALGAS"] as const) {
        if (broker.resolveMCXFutcom) {
          const result = broker.resolveMCXFutcom(mcx);
          if (result) {
            instruments.push({
              name: mcx,
              securityId: String(result.securityId),
              exchange: "MCX_COMM",
              mode: "ticker",
            });
            console.log(`[resolveInstruments] ${mcx} -> MCX_COMM:${result.securityId} (${result.tradingSymbol})`);
          } else {
            console.warn(`[resolveInstruments] ${mcx} -> not found in scrip master`);
          }
        }
      }
      return instruments;
    }),

    /** Get all latest cached ticks (snapshot). */
    snapshot: publicProcedure.query(() => {
      return tickBus.getAllTicks();
    }),

    /** SSE subscription: streams live ticks to the frontend. */
    onTick: publicProcedure.subscription(async function* (opts) {
      console.log("[SSE] onTick subscription connected");
      let tickResolve: ((tick: TickData) => void) | null = null;
      const tickQueue: TickData[] = [];

      const handler = (tick: TickData) => {
        if (tickResolve) {
          const resolve = tickResolve;
          tickResolve = null;
          resolve(tick);
        } else {
          if (tickQueue.length < 500) {
            tickQueue.push(tick);
          }
        }
      };

      tickBus.on("tick", handler);

      try {
        while (!opts.signal?.aborted) {
          let tick: TickData;
          if (tickQueue.length > 0) {
            tick = tickQueue.shift()!;
          } else {
            tick = await new Promise<TickData>((resolve, reject) => {
              tickResolve = resolve;
              opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          }
          const id = `${tick.exchange}:${tick.securityId}:${tick.timestamp}`;
          yield tracked(id, tick);
        }
      } finally {
        tickBus.off("tick", handler);
        console.log("[SSE] onTick subscription disconnected");
      }
    }),

    /** SSE subscription: streams order updates to the frontend. */
    onOrderUpdate: publicProcedure.subscription(async function* () {
      type OrderUpdateData = {
        orderId: string;
        status: string;
        filledQuantity: number;
        averagePrice: number;
        timestamp: number;
      };

      let resolve: ((update: OrderUpdateData) => void) | null = null;
      const queue: OrderUpdateData[] = [];

      const handler = (update: OrderUpdateData) => {
        if (resolve) {
          const r = resolve;
          resolve = null;
          r(update);
        } else if (queue.length < 100) {
          queue.push(update);
        }
      };

      tickBus.on("orderUpdate", handler);

      try {
        while (true) {
          let update: OrderUpdateData;
          if (queue.length > 0) {
            update = queue.shift()!;
          } else {
            update = await new Promise<OrderUpdateData>((r) => {
              resolve = r;
            });
          }
          const id = `${update.orderId}:${update.timestamp}`;
          yield tracked(id, update);
        }
      } finally {
        tickBus.off("orderUpdate", handler);
      }
    }),
  }),
});
