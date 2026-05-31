/**
 * AlertModel — server-side persistence for the in-app AlertHistory drawer.
 *
 * T52 locked-design 2026-05-31: 30-day retention in MongoDB so alerts
 * survive page reloads and (eventually) sync across machines. The client
 * AlertContext is still in-memory-only today; the next slice wires it to
 * query / push through the alerts.* tRPC router.
 *
 * Field set mirrors `client/src/lib/alertTypes.ts AlertEvent` so server
 * + client speak the same shape.
 */
import mongoose, { Schema } from "mongoose";

export const ALERT_EVENT_TYPES = [
  "go_signal",
  "stop_loss_hit",
  "target_profit_hit",
  "module_down",
  "new_signal",
  "position_opened",
  "position_closed",
] as const;

export type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];

export const ALERT_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type AlertPriority = (typeof ALERT_PRIORITIES)[number];

export interface AlertDoc {
  type: AlertEventType;
  priority: AlertPriority;
  title: string;
  message: string;
  instrument?: string | null;
  channel?: string | null;
  tradeId?: string | null;
  /** Unix ms timestamp of the event. Distinct from Mongoose's createdAt
   *  to preserve event-time vs storage-time on replays / backfills. */
  timestamp: number;
  readAt?: number | null;
}

const alertSchema = new Schema<AlertDoc>(
  {
    type: { type: String, required: true, enum: ALERT_EVENT_TYPES },
    priority: { type: String, required: true, enum: ALERT_PRIORITIES },
    title: { type: String, required: true },
    message: { type: String, required: true },
    instrument: { type: String, default: null },
    channel: { type: String, default: null },
    tradeId: { type: String, default: null },
    timestamp: { type: Number, required: true, index: true },
    readAt: { type: Number, default: null },
  },
  {
    timestamps: true, // adds createdAt / updatedAt for storage-side debugging
    collection: "alerts",
  },
);

// Compound index drives the most common query: "latest N alerts since X".
alertSchema.index({ timestamp: -1 });

export const AlertModel = mongoose.model<AlertDoc>("Alert", alertSchema);
