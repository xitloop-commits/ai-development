/**
 * ribbon_geometry — per-candle MA/SMA5 ribbon geometry, for later analysis.
 *
 * A MongoDB TIME-SERIES collection (Partha 2026-08-22): one document per
 * candle × leg (CE/PE) × ribbon (ma/sma5), for the LOCKED/traded ATM contract.
 * Recorded in every mode (paper / live / replay). See ribbonGeometryRecorder.ts.
 *
 * The on-screen "geometric" angle is zoom-dependent, so we store SCALE-FREE
 * values instead: the raw slope (`slopePct`), the normalized readout degree
 * (`deg`), and a fixed-scale geometric angle (`geoDeg`) — all reproducible.
 */
import mongoose, { Schema } from "mongoose";

export type RibbonSource = "ma" | "sma5";
export type RibbonMode = "paper" | "live" | "replay";
export type RibbonSide = "CE" | "PE";

export interface RibbonGeometryDoc {
  /** Candle time (bucket start). */
  t: Date;
  meta: {
    instrument: string;
    securityId: string;
    side: RibbonSide;
    strike: number;
    source: RibbonSource;
    timeframeSec: number;
    mode: RibbonMode;
    /** Replay only — which run these points belong to. */
    runId?: string;
    /** Session (live) or replayed (replay) day, YYYY-MM-DD. */
    date: string;
  };
  /** Ribbon smoothing-line price that candle. */
  line: number;
  /** Candle close (premium). */
  close: number;
  /** Raw % lean of the line over the lookback (reproducible slope). */
  slopePct: number;
  /** Normalized/self-calibrated angle — the chart readout degree. */
  deg: number;
  /** Fixed-scale geometric angle (atan(slopePct / fixedPctPer45)). */
  geoDeg: number;
  trend: -1 | 0 | 1;
}

const schema = new Schema<RibbonGeometryDoc>(
  {
    t: { type: Date, required: true },
    meta: {
      instrument: { type: String, required: true },
      securityId: { type: String, required: true },
      side: { type: String, required: true },
      strike: { type: Number, required: true },
      source: { type: String, required: true },
      timeframeSec: { type: Number, required: true },
      mode: { type: String, required: true },
      runId: { type: String },
      date: { type: String, required: true },
    },
    line: { type: Number, required: true },
    close: { type: Number, required: true },
    slopePct: { type: Number, required: true },
    deg: { type: Number, required: true },
    geoDeg: { type: Number, required: true },
    trend: { type: Number, required: true },
  },
  {
    timeseries: { timeField: "t", metaField: "meta", granularity: "minutes" },
    autoCreate: true,
    // No TTL — this is analysis data we keep.
  },
);

export const RibbonGeometry =
  (mongoose.models.RibbonGeometry as mongoose.Model<RibbonGeometryDoc>) ??
  mongoose.model<RibbonGeometryDoc>("RibbonGeometry", schema, "ribbon_geometry");
