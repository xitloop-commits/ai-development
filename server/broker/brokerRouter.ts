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
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import {
  getActiveBroker,
  getBrokerServiceStatus,
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
      exchange: z.enum(["NSE_FNO", "BSE_FNO", "MCX_COMM"]),
      mode: z.enum(["ticker", "quote", "full"]).optional(),
    })
  ),
});

// ─── Router ─────────────────────────────────────────────────────

export const brokerRouter = router({
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
    updateSettings: protectedProcedure
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
    switchBroker: protectedProcedure
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
    update: protectedProcedure
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
    place: protectedProcedure
      .input(orderParamsSchema)
      .mutation(async ({ input }) => {
        checkKillSwitch();
        const broker = requireBroker();
        return broker.placeOrder(input as OrderParams);
      }),

    /** Modify a pending order. */
    modify: protectedProcedure
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
    cancel: protectedProcedure
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
    exitAll: protectedProcedure.mutation(async () => {
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
  killSwitch: protectedProcedure
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
    .input(z.object({ underlying: z.string() }))
    .query(async ({ input }) => {
      const broker = requireBroker();
      return broker.getExpiryList(input.underlying);
    }),

  /** Get option chain data. */
  optionChain: publicProcedure
    .input(
      z.object({
        underlying: z.string(),
        expiry: z.string(),
      })
    )
    .query(async ({ input }) => {
      const broker = requireBroker();
      return broker.getOptionChain(input.underlying, input.expiry);
    }),

  // ── Feed (Live Market Data) ─────────────────────────────────

  feed: router({
    /** Subscribe instruments to the broker's WebSocket feed. */
    subscribe: publicProcedure
      .input(subscribeParamsSchema)
      .mutation(({ input }) => {
        const broker = requireBroker();
        broker.subscribeLTP(input.instruments, (tick) => {
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
        broker.unsubscribeLTP(input.instruments);
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

    /** Get all latest cached ticks (snapshot). */
    snapshot: publicProcedure.query(() => {
      return tickBus.getAllTicks();
    }),

    /** SSE subscription: streams live ticks to the frontend. */
    onTick: publicProcedure.subscription(async function* () {
      let tickResolve: ((tick: TickData) => void) | null = null;
      const tickQueue: TickData[] = [];

      const handler = (tick: TickData) => {
        if (tickResolve) {
          const resolve = tickResolve;
          tickResolve = null;
          resolve(tick);
        } else {
          // Buffer up to 500 ticks to prevent memory issues
          if (tickQueue.length < 500) {
            tickQueue.push(tick);
          }
        }
      };

      tickBus.on("tick", handler);

      try {
        while (true) {
          let tick: TickData;
          if (tickQueue.length > 0) {
            tick = tickQueue.shift()!;
          } else {
            tick = await new Promise<TickData>((resolve) => {
              tickResolve = resolve;
            });
          }
          const id = `${tick.exchange}:${tick.securityId}:${tick.timestamp}`;
          yield tracked(id, tick);
        }
      } finally {
        tickBus.off("tick", handler);
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
