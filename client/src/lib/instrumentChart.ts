/**
 * instrumentChart — helpers for the pop-out per-instrument underlying chart
 * window (T76). Builds candles from OUR recorded/live ticks (server
 * trading.underlyingTicks) at any interval, resolves per-instrument metadata,
 * and builds the pop-out window URL.
 */
import { type Candle, IST_OFFSET_SECONDS, istDateString } from "./signalChart";

/** Selectable candle intervals (label + bucket size in seconds). */
export const CHART_INTERVALS: { label: string; seconds: number }[] = [
  { label: "1s", seconds: 1 },
  { label: "15s", seconds: 15 },
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "2m", seconds: 120 },
  { label: "3m", seconds: 180 },
  { label: "4m", seconds: 240 },
  { label: "5m", seconds: 300 },
];

export const DEFAULT_INTERVAL_SECONDS = 60;

/**
 * Bucket chronological ticks (epoch SECONDS, UTC) into OHLC candles of
 * `intervalSec`. Times are IST-shifted (+IST_OFFSET_SECONDS) to match the rest
 * of the chart (signal/trade markers, toCandles). Assumes ticks are in time
 * order (recorded append order / re-read of the growing file both are).
 */
export function bucketTicks(t: number[], ltp: number[], intervalSec: number): Candle[] {
  const n = Math.min(t.length, ltp.length);
  if (n === 0 || intervalSec <= 0) return [];
  const out: Candle[] = [];
  let curStart = -1;
  let cur: Candle | null = null;
  for (let i = 0; i < n; i++) {
    const ts = t[i];
    const price = ltp[i];
    if (!(ts > 0) || !(price > 0)) continue;
    const bucketStart = Math.floor(ts / intervalSec) * intervalSec;
    if (bucketStart !== curStart) {
      if (cur) out.push(cur);
      curStart = bucketStart;
      cur = { time: bucketStart + IST_OFFSET_SECONDS, open: price, high: price, low: price, close: price };
    } else if (cur) {
      if (price > cur.high) cur.high = price;
      if (price < cur.low) cur.low = price;
      cur.close = price;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Heikin-Ashi transform of already-bucketed candles (times preserved). */
export function heikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  let prevOpen = 0;
  let prevClose = 0;
  for (let i = 0; i < candles.length; i++) {
    const { open: o, high: h, low: l, close: c, time } = candles[i];
    const haClose = (o + h + l + c) / 4;
    const haOpen = i === 0 ? (o + c) / 2 : (prevOpen + prevClose) / 2;
    out.push({
      time,
      open: haOpen,
      high: Math.max(h, haOpen, haClose),
      low: Math.min(l, haOpen, haClose),
      close: haClose,
    });
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return out;
}

/** Per-instrument metadata for the chart window (Phase 1 = NIFTY + BANK). */
export const INSTRUMENT_CHART_META: Record<string, { key: string; displayName: string }> = {
  NIFTY_50: { key: "NIFTY_50", displayName: "NIFTY 50" },
  BANKNIFTY: { key: "BANKNIFTY", displayName: "BANK NIFTY" },
};

/** Instruments that get a chart window in Phase 1. */
export const PHASE1_CHART_INSTRUMENTS = ["NIFTY_50", "BANKNIFTY"];

/** Read the target instrument key off the pop-out window URL (?inst=…). */
export function chartInstrumentFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search);
  return p.get("inst");
}

/** Build the pop-out window URL for one instrument's chart. */
export function instrumentChartUrl(instrumentKey: string): string {
  return `${window.location.origin}/?view=instchart&inst=${encodeURIComponent(instrumentKey)}`;
}

/**
 * Default date for a freshly-opened window: today if an NSE session is currently
 * live (weekday, 09:15–15:30 IST → live streaming), else the most recent
 * recorded date. Falls back to today when nothing is recorded yet.
 */
export function defaultChartDate(recordedDates: string[], now: Date = new Date()): string {
  const today = istDateString(now);
  // Current IST wall-clock minutes since midnight + weekday.
  const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = istNow.getDay(); // 0 Sun … 6 Sat
  const mins = istNow.getHours() * 60 + istNow.getMinutes();
  const isWeekday = day >= 1 && day <= 5;
  const inSession = isWeekday && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
  if (inSession) return today;
  if (recordedDates.length > 0) return recordedDates[recordedDates.length - 1];
  return today;
}
