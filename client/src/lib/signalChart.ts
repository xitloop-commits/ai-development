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
  /** Server signal id, e.g. "sea-banknifty-42". The trailing number is the
   *  per-instrument signal sequence shown on the chart marker. */
  id?: string;
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
  /** Model direction probability (0–1) — shown on the chart marker as a 0–100 score. */
  confidence?: number | null;
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

/** What the standalone Signal Chart page needs to render one instrument. */
export interface SignalChartTarget {
  instrumentKey: string;   // NIFTY_50 / BANKNIFTY / CRUDEOIL / NATURALGAS
  displayName: string;
  securityId: string;      // underlying feed security id
  exchangeSegment: string; // underlying feed segment (IDX_I / MCX_COMM)
  initialDate: string;     // YYYY-MM-DD (IST)
}

/** Build the standalone chart-page URL (?view=chart&…) — opened in a new tab.
 *  This is the UNDERLYING (index/future) chart with all SEA signal arrows. */
export function signalChartUrl(t: SignalChartTarget): string {
  const p = new URLSearchParams({
    view: "chart",
    kind: "underlying",
    instrument: t.instrumentKey,
    name: t.displayName,
    securityId: t.securityId,
    segment: t.exchangeSegment,
    date: t.initialDate,
  });
  return `${window.location.origin}/?${p.toString()}`;
}

/** What the option-strike chart needs: one specific option contract + the
 *  channel/date whose trades to overlay. */
export interface OptionChartTarget {
  instrumentKey: string;   // NIFTY_50 / BANKNIFTY / …
  displayName: string;     // e.g. "BANKNIFTY 58500 CE"
  securityId: string;      // the OPTION contract's security id (contractSecurityId)
  exchangeSegment: string; // NSE_FNO / MCX_COMM
  strike: number;
  optionType: "CE" | "PE";
  channel: string;         // which channel's trades to plot
  date: string;            // YYYY-MM-DD (IST)
  expiry?: string | null;  // YYYY-MM-DD — enables the "Open in TradingView" link
}

/** Build the option-strike chart-page URL — opened in a new tab. Shows the
 *  option contract's own candles with that day's trades marked (entry ↑ / exit
 *  ↓) and labelled by signal id. */
export function optionChartUrl(t: OptionChartTarget): string {
  const p = new URLSearchParams({
    view: "chart",
    kind: "option",
    instrument: t.instrumentKey,
    name: t.displayName,
    securityId: t.securityId,
    segment: t.exchangeSegment,
    strike: String(t.strike),
    side: t.optionType,
    channel: t.channel,
    date: t.date,
  });
  if (t.expiry) p.set("expiry", t.expiry);
  return `${window.location.origin}/?${p.toString()}`;
}

/** Dhan instrument type for an OPTION contract, from its exchange segment.
 *  Index options (NSE_FNO) → OPTIDX; commodity options (MCX_COMM) → OPTFUT. */
export function optionInstrumentType(segment: string): "OPTIDX" | "OPTFUT" {
  return segment === "MCX_COMM" ? "OPTFUT" : "OPTIDX";
}

/** Map a UI instrument key to its TradingView underlying symbol + exchange. */
function tvUnderlying(instrument: string): { exchange: string; symbol: string } | null {
  const u = instrument.toUpperCase().replace(/[^A-Z]/g, "");
  if (u.includes("BANK")) return { exchange: "NSE", symbol: "BANKNIFTY" };
  if (u.startsWith("NIFTY")) return { exchange: "NSE", symbol: "NIFTY" };
  if (u.includes("CRUDE")) return { exchange: "MCX", symbol: "CRUDEOIL" };
  if (u.includes("NATURAL") || u.includes("GAS")) return { exchange: "MCX", symbol: "NATURALGAS" };
  return null;
}

/** TradingView deep-link to an option contract's LIVE chart, or null when it
 *  can't be built (missing/invalid expiry, unknown instrument). Symbol format:
 *  {EXCH}:{UNDERLYING}{YYMMDD}{C|P}{STRIKE}, e.g. NSE:NIFTY260728P24200. */
export function tradingViewOptionUrl(opts: {
  instrument: string;
  strike: number;
  optionType: "CE" | "PE";
  expiry?: string | null; // YYYY-MM-DD
}): string | null {
  const under = tvUnderlying(opts.instrument);
  const m = opts.expiry ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(opts.expiry) : null;
  if (!under || !m) return null;
  const yymmdd = `${m[1].slice(2)}${m[2]}${m[3]}`;
  const cp = opts.optionType === "CE" ? "C" : "P";
  const sym = `${under.exchange}:${under.symbol}${yymmdd}${cp}${Math.round(opts.strike)}`;
  // interval=30S → 30-second candles. NOTE: TradingView's sub-minute intervals
  // need a paid plan; free accounts fall back to 1-minute (switchable in-chart).
  return `https://www.tradingview.com/chart/?symbol=${sym}&interval=30S`;
}

/** A trade to plot on the option-strike chart (entry + exit markers, and
 *  entry/SL/TP price lines for open trades). */
export interface ChartTrade {
  signalSeq: number | null;
  side: "CE" | "PE";
  entryTime: number;        // epoch SECONDS (real UTC)
  entryPrice: number;
  exitTime: number | null;  // epoch SECONDS (real UTC), null while OPEN
  exitPrice: number | null;
  status: string;           // OPEN / CLOSED / …
  exitReason?: string;
  pnl: number;
  stopLossPrice?: number | null; // current stop (trails) — drawn as a price line
  targetPrice?: number | null;   // current target — drawn as a price line
}
