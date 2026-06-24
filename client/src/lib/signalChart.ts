/**
 * signalChart — helpers for the SEA signal chart popup.
 *
 *  - toHeikinAshi: convert raw OHLC candles (parallel arrays from the broker
 *    intradayData endpoint) into Heikin Ashi candles for lightweight-charts.
 *  - optionContractMeta: map an instrument key to the exchange segment +
 *    instrument type its OPTION contracts trade under (needed by intradayData).
 */

/** Raw OHLC candle payload as returned by tRPC broker.intradayData. */
export interface RawCandles {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume?: number[];
  timestamp: number[]; // epoch SECONDS
}

/** A single candle in lightweight-charts shape (time = epoch seconds). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** IST is UTC+5:30. lightweight-charts renders UTCTimestamps as UTC, so we add
 *  this offset to every time value to make the axis read in IST clock time. */
export const IST_OFFSET_SECONDS = 5.5 * 3600;

/** Plain (non-HA) candles from the raw arrays, oldest-first, IST-shifted. */
export function toCandles(raw: RawCandles): Candle[] {
  const out: Candle[] = [];
  const n = Math.min(raw.timestamp.length, raw.close.length);
  for (let i = 0; i < n; i++) {
    out.push({
      time: raw.timestamp[i] + IST_OFFSET_SECONDS,
      open: raw.open[i],
      high: raw.high[i],
      low: raw.low[i],
      close: raw.close[i],
    });
  }
  return out;
}

/**
 * Heikin Ashi transform of the raw candles.
 *   HA_close = (O+H+L+C)/4
 *   HA_open  = (prevHA_open + prevHA_close)/2   (first = (O+C)/2)
 *   HA_high  = max(H, HA_open, HA_close)
 *   HA_low   = min(L, HA_open, HA_close)
 * Times are IST-shifted to match toCandles.
 */
export function toHeikinAshi(raw: RawCandles): Candle[] {
  const out: Candle[] = [];
  const n = Math.min(raw.timestamp.length, raw.close.length);
  let prevOpen = 0;
  let prevClose = 0;
  for (let i = 0; i < n; i++) {
    const o = raw.open[i];
    const h = raw.high[i];
    const l = raw.low[i];
    const c = raw.close[i];
    const haClose = (o + h + l + c) / 4;
    const haOpen = i === 0 ? (o + c) / 2 : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(h, haOpen, haClose);
    const haLow = Math.min(l, haOpen, haClose);
    out.push({
      time: raw.timestamp[i] + IST_OFFSET_SECONDS,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
    });
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return out;
}

/** A signal occurrence to plot as a marker on the underlying chart. */
export interface ChartSignal {
  timestamp: number; // epoch SECONDS (real UTC)
  timestamp_ist: string;
  direction: "GO_CALL" | "GO_PUT";
  action?: string;
  atm_strike: number;
  spot_price: number | null;
  entry?: number;
  tp?: number;
  sl?: number;
  cohort?: string;
}

/** Dhan instrument type for the UNDERLYING, derived from its feed segment.
 *  Index (IDX_I) → INDEX; commodity (MCX_COMM) → FUTCOM. */
export function underlyingInstrumentType(segment: string): "INDEX" | "FUTCOM" {
  return segment === "MCX_COMM" ? "FUTCOM" : "INDEX";
}

/** Fallback underlying security IDs for the index instruments (from the
 *  instrument config). Commodities resolve their future id via the live feed. */
export const UNDERLYING_SECURITY_ID: Record<string, string> = {
  NIFTY_50: "13",
  BANKNIFTY: "25",
};

/** Today's date in IST as "YYYY-MM-DD" (used to bound the intraday window). */
export function istDateString(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
