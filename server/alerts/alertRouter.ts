/**
 * Alerts tRPC router — server-side persistence for the AlertHistory drawer.
 *
 * Today's client `AlertContext` is in-memory only. Once the client slice
 * of T52 ships, AlertContext will:
 *   - hydrate on mount via alerts.list({ since })
 *   - push every new alert via alerts.push(event)
 *   - call alerts.markAllRead() when the drawer is opened
 *
 * The daily purge job (server/_core/alertPurgeScheduler.ts) calls
 * purgeOlderThan({ days: 30 }) at 03:00 IST so the collection bounds
 * to a rolling 30-day window.
 */
import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import {
  AlertModel,
  ALERT_EVENT_TYPES,
  ALERT_PRIORITIES,
  type AlertEventType,
  type AlertPriority,
} from "./alertModel";

const alertEventInput = z.object({
  type: z.enum(ALERT_EVENT_TYPES as unknown as [AlertEventType, ...AlertEventType[]]),
  priority: z.enum(ALERT_PRIORITIES as unknown as [AlertPriority, ...AlertPriority[]]),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  instrument: z.string().optional(),
  channel: z.string().optional(),
  tradeId: z.string().optional(),
  timestamp: z.number().int().positive().optional(), // defaults to now
});

export const alertsRouter = router({
  /** Latest N alerts, optionally filtered to those after `since` (Unix ms). */
  list: publicProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(500).default(50),
          since: z.number().int().nonnegative().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const limit = input?.limit ?? 50;
      const filter = input?.since ? { timestamp: { $gt: input.since } } : {};
      const docs = await AlertModel.find(filter)
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();
      return docs.map((d) => ({
        id: String(d._id),
        type: d.type,
        priority: d.priority,
        title: d.title,
        message: d.message,
        instrument: d.instrument ?? null,
        channel: d.channel ?? null,
        tradeId: d.tradeId ?? null,
        timestamp: d.timestamp,
        readAt: d.readAt ?? null,
      }));
    }),

  /** Insert a new alert. Returns the generated id + storage timestamp. */
  push: protectedProcedure
    .input(alertEventInput)
    .mutation(async ({ input }) => {
      const doc = await AlertModel.create({
        ...input,
        timestamp: input.timestamp ?? Date.now(),
      });
      return { id: String(doc._id), timestamp: doc.timestamp };
    }),

  /** Mark all unread alerts as read (single timestamp stamp). */
  markAllRead: protectedProcedure.mutation(async () => {
    const now = Date.now();
    const result = await AlertModel.updateMany(
      { readAt: null },
      { $set: { readAt: now } },
    );
    return { markedRead: result.modifiedCount, at: now };
  }),

  /** Hard-delete alerts older than `days` (Unix ms cutoff). Returns the
   *  deleted count. Called by the daily purge scheduler; also exposed as
   *  an admin endpoint for one-shot operator pruning. */
  purgeOlderThan: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(3650).default(30) }))
    .mutation(async ({ input }) => {
      const cutoff = Date.now() - input.days * 86_400_000;
      const result = await AlertModel.deleteMany({ timestamp: { $lt: cutoff } });
      return { deleted: result.deletedCount, cutoff };
    }),
});
