/**
 * trendRibbon — slope-based trend analysis (T162 test-chart experiments).
 *
 * Classifies every 1-MINUTE bucket as UP / DOWN / SIDEWAYS from the lean of a
 * smoothing line (MA = 20-EMA per Partha 2026-08-12, or SMA5), and returns:
 *   - the tri-colour ribbon line (green/red/gray) drawn just under the line
 *   - a per-minute state map for the bottom readout: state, angle in degrees,
 *     and HOW LONG the current trend has been running (minutes).
 *
 * Self-calibrating per instrument/day: noise floor = P40 of |5-min moves|
 * (sideways), display scale P80 = 45°. History-polish passes pull colour
 * boundaries to the visible turns (live edge can't know its future — the raw
 * lag returns at the right edge).
 */

import { IST_OFFSET_SECONDS } from "./signalChart";

export interface RibbonPoint { time: number; value?: number; color?: string }

export interface MinuteState {
  trend: -1 | 0 | 1;
  deg: number;
  /** consecutive minutes (incl. this one) the current trend has run */
  runMin: number;
  line: number; // the smoothing line's value that minute
}

export interface TrendAnalysis {
  lines: { data: RibbonPoint[]; color: string }[];
  /** key = epoch-minute (floor(timeSec / 60)) */
  minuteState: Map<number, MinuteState>;
}

export type SlopeSource = "ma" | "sma5";

/** Tunables — mirrored in CommonConfig.trendAngle (Settings ▸ Trend angle). */
export interface TrendAngleOptions {
  source: SlopeSource;          // which line's lean we trust
  lookbackMin: number;          // slope lookback in CANDLES (1–10)
  scaleMode: "auto" | "fixed";  // what counts as steep
  fixedPctPer45: number;        // fixed mode: % per lookback that reads 45°
  grayPctile: number;           // noise floor percentile (20–60)
  smooth: boolean;              // history-polish passes on/off
  /** Candle SECONDS the line + slope compute on — pass the SEA detector's
   *  candle_sec so the chart's colours flip exactly when signals fire
   *  (2026-08-13). Not a Settings knob; callers supply it. Default 60. */
  bucketSec?: number;
}

export const DEFAULT_TREND_ANGLE: TrendAngleOptions = {
  source: "ma",
  lookbackMin: 5,
  scaleMode: "auto",
  fixedPctPer45: 0.2,
  grayPctile: 40,
  smooth: true,
};

const GREEN = "#1a9850";
const RED = "#d7301f";
// The "sideways/no-trend" zone — bright amber-yellow so it's clearly visible on
// the dark theme (was a muted grey; Partha 2026-08-18). Distinct from up/down.
const GRAY = "#facc15";

export function trendAnalysis(
  candles: { time: number; close: number }[],
  opts: Partial<TrendAngleOptions> = {},
): TrendAnalysis | undefined {
  const o = { ...DEFAULT_TREND_ANGLE, ...opts };
  const source = o.source;
  const LOOK = Math.max(1, Math.round(o.lookbackMin));
  // Detector-timeframe buckets (60s default). Every state applies to all the
  // minutes its bucket covers, so the per-minute readout/lookup stays intact.
  const BUCKET = Math.max(60, Math.round(o.bucketSec ?? 60));
  const perBucket = Math.max(1, Math.round(BUCKET / 60));
  if (candles.length < 2) return undefined; // draw from the first candles (min-periods=1)
  const minuteClose = new Map<number, number>();
  for (const c of candles) minuteClose.set(Math.floor(c.time / BUCKET), c.close);
  const mins = Array.from(minuteClose.keys()).sort((a, b) => a - b);
  const mClose = mins.map((m) => minuteClose.get(m)!);

  // The smoothing line on minute closes.
  const lineV: (number | null)[] = [];
  if (source === "ma") {
    const k = 2 / 21; // 20-EMA — the MA-Signal cohort's own line
    let e = mClose[0];
    for (let i = 0; i < mClose.length; i++) {
      e = i === 0 ? mClose[0] : mClose[i] * k + e * (1 - k);
      lineV.push(e); // draw from candle 1 (the EMA seeds from the first close)
    }
  } else {
    for (let i = 0; i < mClose.length; i++) {
      // min-periods=1: average whatever's available (up to 5), from candle 1.
      const start = Math.max(0, i - 4);
      let s = 0;
      for (let j = start; j <= i; j++) s += mClose[j];
      lineV.push(s / (i - start + 1));
    }
  }

  // % lean of the line over the LOOKBACK, per minute.
  const pctOfMin = new Map<number, { pct: number; line: number }>();
  const allAbs: number[] = [];
  mins.forEach((m, i) => {
    const now = lineV[i];
    const then = i >= LOOK ? lineV[i - LOOK] : i > 0 ? lineV[0] : null; // shorter lookback early
    if (now == null || then == null || !(then > 0)) return;
    const pct = ((now - then) / then) * 100;
    pctOfMin.set(m, { pct, line: now });
    allAbs.push(Math.abs(pct));
  });
  if (!allAbs.length) return undefined;
  const sortedAbs = [...allAbs].sort((a, b) => a - b);
  const grayIdx = Math.min(sortedAbs.length - 1, Math.floor(sortedAbs.length * Math.min(0.9, Math.max(0.1, o.grayPctile / 100))));
  const noise = Math.max(sortedAbs[grayIdx] ?? 0.01, 0.002);
  const p80 = o.scaleMode === "fixed"
    ? Math.max(o.fixedPctPer45, 0.005)
    : Math.max(sortedAbs[Math.floor(sortedAbs.length * 0.8)] ?? noise * 2, noise);

  // SMA5 ribbon is BINARY (Partha 2026-08-14: no gray — green and red only):
  // the state is the sign of the slope, no noise floor. MA keeps its gray zone.
  const noGray = source === "sma5";
  const st = new Map<number, MinuteState>();
  let prevTrend: -1 | 0 | 1 = 0;
  pctOfMin.forEach((v, m) => {
    const trend: -1 | 0 | 1 = noGray
      ? (v.pct > 0 ? 1 : v.pct < 0 ? -1 : prevTrend)
      : v.pct > noise ? 1 : v.pct < -noise ? -1 : 0;
    prevTrend = trend;
    // `m` is a BUCKET id — expand its state to every minute it covers (each
    // minute gets its OWN object; the polish passes + run-age stamping mutate
    // entries individually).
    const m0 = Math.floor((m * BUCKET) / 60);
    for (let j = 0; j < perBucket; j++) {
      st.set(m0 + j, {
        deg: (Math.atan(v.pct / p80) * 180) / Math.PI,
        line: v.line,
        trend,
        runMin: 1,
      });
    }
  });

  // History-polish passes (Partha rules): gray→red prefill any length, short
  // gray→green prefill, boundaries pulled to the line's actual turn.
  const seq = mins.filter((m) => st.has(m));
  if (!o.smooth) return finalize(candles, st);
  let i2 = 0;
  while (i2 < seq.length) {
    let j2 = i2;
    while (j2 < seq.length && st.get(seq[j2])!.trend === st.get(seq[i2])!.trend) j2++;
    const runTrend = st.get(seq[i2])!.trend;
    const runLen = j2 - i2;
    if (runTrend === 0 && j2 < seq.length && st.get(seq[j2])!.trend === -1) {
      for (let k = i2; k < j2; k++) st.get(seq[k])!.trend = -1;
    }
    if (runTrend === 0 && runLen <= 3 && j2 < seq.length && st.get(seq[j2])!.trend === 1) {
      for (let k = i2; k < j2; k++) st.get(seq[k])!.trend = 1;
    }
    i2 = j2;
  }
  i2 = 0;
  while (i2 < seq.length) {
    let j2 = i2;
    while (j2 < seq.length && st.get(seq[j2])!.trend === st.get(seq[i2])!.trend) j2++;
    if (st.get(seq[i2])!.trend !== -1 && j2 < seq.length && st.get(seq[j2])!.trend === -1) {
      let t = j2 - 1;
      while (t > i2 && st.get(seq[t])!.line < st.get(seq[t - 1])!.line) { st.get(seq[t])!.trend = -1; t--; }
    }
    if (st.get(seq[i2])!.trend !== 1 && j2 < seq.length && st.get(seq[j2])!.trend === 1) {
      let t = j2 - 1;
      while (t > i2 && st.get(seq[t])!.line > st.get(seq[t - 1])!.line) { st.get(seq[t])!.trend = 1; t--; }
    }
    i2 = j2;
  }

  return finalize(candles, st);
}

/** T169-B — one server ribbon sample per SIGNAL candle (from shared/chartLines
 *  maRibbonSignal). `t` is the RAW bucket-start epoch seconds. */
export interface ServerRibbonBucket { t: number; line: number; trend: -1 | 0 | 1; deg: number }

/**
 * T169-B — build the client TrendAnalysis (ribbon line + readout state) from the
 * SERVER's per-signal-candle ribbon, so the drawn ribbon is authoritative (no
 * client recompute). Expands each server bucket to the display minutes it covers
 * exactly like trendAnalysis's own perBucket step, then runs the SAME finalize.
 */
export function ribbonFromServerBuckets(
  buckets: ServerRibbonBucket[],
  candles: { time: number; close: number }[],
  bucketSec: number,
): TrendAnalysis {
  const perBucket = Math.max(1, Math.round(Math.max(60, bucketSec) / 60));
  const st = new Map<number, MinuteState>();
  for (const b of buckets) {
    // Raw bucket start -> IST bucket start (IST_OFFSET is a multiple of bucketSec).
    const m0 = Math.floor((b.t + IST_OFFSET_SECONDS) / 60);
    for (let j = 0; j < perBucket; j++) {
      st.set(m0 + j, { trend: b.trend, deg: b.deg, line: b.line, runMin: 1 });
    }
  }
  // Same display polish trendAnalysis applies: pull a steady rise/fall out of the
  // gray zone so a clearly-trending line reads green/red, not sideways-yellow.
  polishStates(st);
  return finalize(candles, st);
}

/** History-polish passes over a per-minute state map (mutates trend): a gray run
 *  before a DOWN turns down (any length); a short gray run before an UP turns up;
 *  then boundaries are pulled to where the line actually turned. Extracted so the
 *  SEA ribbon (ribbonFromServerBuckets) gets the same treatment trendAnalysis
 *  applies inline. Operates on the map's own keys, so it works at any timeframe. */
function polishStates(st: Map<number, MinuteState>): void {
  const seq = Array.from(st.keys()).sort((a, b) => a - b);
  let i = 0;
  while (i < seq.length) {
    let j = i;
    while (j < seq.length && st.get(seq[j])!.trend === st.get(seq[i])!.trend) j++;
    const runTrend = st.get(seq[i])!.trend;
    const runLen = j - i;
    if (runTrend === 0 && j < seq.length && st.get(seq[j])!.trend === -1) {
      for (let k = i; k < j; k++) st.get(seq[k])!.trend = -1;
    }
    if (runTrend === 0 && runLen <= 3 && j < seq.length && st.get(seq[j])!.trend === 1) {
      for (let k = i; k < j; k++) st.get(seq[k])!.trend = 1;
    }
    i = j;
  }
  i = 0;
  while (i < seq.length) {
    let j = i;
    while (j < seq.length && st.get(seq[j])!.trend === st.get(seq[i])!.trend) j++;
    if (st.get(seq[i])!.trend !== -1 && j < seq.length && st.get(seq[j])!.trend === -1) {
      let t = j - 1;
      while (t > i && st.get(seq[t])!.line < st.get(seq[t - 1])!.line) { st.get(seq[t])!.trend = -1; t--; }
    }
    if (st.get(seq[i])!.trend !== 1 && j < seq.length && st.get(seq[j])!.trend === 1) {
      let t = j - 1;
      while (t > i && st.get(seq[t])!.line > st.get(seq[t - 1])!.line) { st.get(seq[t])!.trend = 1; t--; }
    }
    i = j;
  }
}

/**
 * T169-B (option B) — one SEA-pushed closed-candle ribbon sample (from
 * seaLineStore). Mapped into a ServerRibbonBucket + fed through
 * ribbonFromServerBuckets so the LINE *and* the trend/angle/run readout both come
 * from SEA's own numbers (server-authoritative, no client re-calc).
 */
export interface SeaRibbonSample { t: number; line: number; state: -1 | 0 | 1; close: number; deg: number }

/** Build the full ribbon (line + readout state) from SEA's samples. */
export function ribbonFromSea(
  samples: SeaRibbonSample[],
  candles: { time: number; close: number }[],
  candleSec: number,
): TrendAnalysis {
  return ribbonFromServerBuckets(
    samples.map((s) => ({ t: s.t, line: s.line, trend: s.state, deg: s.deg })),
    candles,
    candleSec,
  );
}

/** Run-age stamping + ribbon line construction (shared by smooth/raw paths). */
function finalize(
  candles: { time: number; close: number }[],
  st: Map<number, MinuteState>,
): TrendAnalysis {
  const seq = Array.from(st.keys()).sort((a, b) => a - b);
  let run = 0;
  let prev: -1 | 0 | 1 | null = null;
  for (const m of seq) {
    const s = st.get(m)!;
    run = prev === s.trend ? run + 1 : 1;
    s.runMin = run;
    prev = s.trend;
  }
  const line: RibbonPoint[] = [];
  candles.forEach((c) => {
    const a = st.get(Math.floor(c.time / 60));
    if (!a) { line.push({ time: c.time }); return; }
    const color = a.trend > 0 ? GREEN : a.trend < 0 ? RED : GRAY;
    line.push({ time: c.time, value: a.line * 0.9995, color });
  });
  return { lines: [{ data: line, color: GRAY }], minuteState: st };
}

/** Bottom-readout text for one minute's state (or the latest). */
export function trendReadoutText(s: MinuteState | undefined, source: SlopeSource): { text: string; color: string } {
  const label = source === "ma" ? "MA" : "SMA5";
  if (!s) return { text: `${label}: —`, color: "" };
  const word = s.trend > 0 ? "UP" : s.trend < 0 ? "DOWN" : "SIDEWAYS";
  const color = s.trend > 0 ? GREEN : s.trend < 0 ? RED : GRAY;
  return {
    text: `${label}: ${word}  ${s.deg >= 0 ? "+" : ""}${s.deg.toFixed(1)}°  ·  ${s.runMin}m ${s.trend === 0 ? "flat" : "trending"}`,
    color,
  };
}

/** Back-compat wrapper: just the ribbon lines with default options. */
export function trendRibbon(
  candles: { time: number; close: number }[],
  _sma5Period = 5,
): { data: RibbonPoint[]; color: string }[] | undefined {
  return trendAnalysis(candles)?.lines;
}
