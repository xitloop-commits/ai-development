/**
 * chartLines.ts (shared) — the authoritative SMA5 line + MA/SMA5 slope-ribbon
 * maths for T169-B, run ONCE on the server and consumed by the chart.
 *
 * These operate directly on SIGNAL-timeframe candles (one candle = one detector
 * bucket), returning ONE value per signal candle. The client then maps each
 * result onto its display candles (the trivial finalize step) so the drawn line
 * is unchanged — only the source of the numbers moves to the server, killing the
 * client-vs-server drift.
 *
 * The ribbon logic is a faithful port of client/src/lib/trendRibbon.ts
 * `trendAnalysis` (minus its display-candle expansion); the SMA5 line mirrors
 * TickChart.higherTfSma. Keep the two in sync.
 */
import { heikinAshi, type OhlcCandle } from "./candles";

/** One SMA5 line sample on a signal candle. `close` is the (HA or raw) close the
 *  colour compares against (green when close > sma, red when below). */
export interface Sma5Bucket {
  t: number;
  sma: number | null;
  close: number | null;
}

/**
 * SMA5 line per signal candle. min-periods=1 (averages whatever is available up
 * to `period` from the first candle), matching higherTfSma so the line draws
 * immediately and converges to the strict SMA once `period` candles exist.
 */
export function sma5SignalLine(
  signal: OhlcCandle[],
  period: number,
  useHa: boolean,
): Sma5Bucket[] {
  const srcClose = (useHa ? heikinAshi(signal) : signal).map((k) => k.close);
  return signal.map((c, i) => {
    const start = Math.max(0, i - period + 1);
    let s = 0;
    let cnt = 0;
    for (let j = start; j <= i; j++) {
      const v = srcClose[j];
      if (v != null) { s += v; cnt++; }
    }
    return { t: c.t, sma: cnt ? s / cnt : null, close: srcClose[i] ?? null };
  });
}

export type SlopeSource = "ma" | "sma5";

export interface RibbonAngleOptions {
  source: SlopeSource;
  lookbackMin: number;
  scaleMode: "auto" | "fixed";
  fixedPctPer45: number;
  grayPctile: number;
  smooth: boolean;
}

export const DEFAULT_RIBBON_ANGLE: RibbonAngleOptions = {
  source: "ma",
  lookbackMin: 5,
  scaleMode: "auto",
  fixedPctPer45: 0.2,
  grayPctile: 40,
  smooth: true,
};

/** One ribbon sample on a signal candle: the smoothing-line value, the trend
 *  (-1/0/1) after the polish passes, and the slope angle in degrees. The client
 *  maps trend → colour and expands to display candles + run-age. */
export interface RibbonBucket {
  t: number;
  line: number;
  trend: -1 | 0 | 1;
  deg: number;
  /** Raw % lean of the line over the lookback (before scaling to degrees).
   *  Reproducible slope, used by the ribbon-geometry recorder. */
  pct: number;
}

/**
 * MA / SMA5 slope ribbon per signal candle. Faithful port of trendAnalysis's
 * core (line + % slope + noise floor + trend classify + history polish), indexed
 * one-per-signal-candle instead of expanded to display minutes.
 */
export function maRibbonSignal(
  signal: OhlcCandle[],
  opts: Partial<RibbonAngleOptions> = {},
): RibbonBucket[] {
  const o = { ...DEFAULT_RIBBON_ANGLE, ...opts };
  const LOOK = Math.max(1, Math.round(o.lookbackMin));
  const n = signal.length;
  if (n < 2) return [];
  const mClose = signal.map((c) => c.close);

  // Smoothing line on the signal closes.
  const lineV: (number | null)[] = [];
  if (o.source === "ma") {
    const k = 2 / 21; // 20-EMA
    let e = mClose[0];
    for (let i = 0; i < n; i++) {
      e = i === 0 ? mClose[0] : mClose[i] * k + e * (1 - k);
      lineV.push(e);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - 4); // 5-SMA, min-periods=1
      let s = 0;
      for (let j = start; j <= i; j++) s += mClose[j];
      lineV.push(s / (i - start + 1));
    }
  }

  // % lean of the line over the lookback, per candle.
  const pctAt: (number | null)[] = new Array(n).fill(null);
  const allAbs: number[] = [];
  for (let i = 0; i < n; i++) {
    const now = lineV[i];
    const then = i >= LOOK ? lineV[i - LOOK] : i > 0 ? lineV[0] : null;
    if (now == null || then == null || !(then > 0)) continue;
    const pct = ((now - then) / then) * 100;
    pctAt[i] = pct;
    allAbs.push(Math.abs(pct));
  }
  if (!allAbs.length) return [];
  const sortedAbs = [...allAbs].sort((a, b) => a - b);
  const pctile = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0;
  // Whole-series p80 (deg scale) — used as-is for SMA5 (which has no warm-up).
  const p80Whole = o.scaleMode === "fixed"
    ? Math.max(o.fixedPctPer45, 0.005)
    : Math.max(pctile(sortedAbs, 0.8), 0.002);

  // SMA5 ribbon is BINARY (sign, no gray, no warm-up). MA mirrors SEA's detector
  // (premium_ribbon.py): a CAUSAL expanding noise floor + a 15-sample warm-up
  // (min_samples) — NO bucket is emitted until then, so the chart's MA line
  // appears exactly when SEA's ribbon goes live (Partha 2026-08-23).
  const noGray = o.source === "sma5";
  const MIN_SAMPLES = 15;
  const MIN_NOISE = 0.002;
  const gp = Math.min(0.9, Math.max(0.1, o.grayPctile / 100));
  const idx: number[] = [];
  const trend = new Array<-1 | 0 | 1>(n).fill(0);
  const deg = new Array<number>(n).fill(0);
  const line = new Array<number>(n).fill(0);
  let prevTrend: -1 | 0 | 1 = 0;
  const seen: number[] = []; // causal |pct| history (MA noise floor)
  for (let i = 0; i < n; i++) {
    const pct = pctAt[i];
    if (pct == null) continue;
    if (noGray) {
      const t: -1 | 0 | 1 = pct > 0 ? 1 : pct < 0 ? -1 : prevTrend;
      prevTrend = t;
      trend[i] = t;
      deg[i] = (Math.atan(pct / p80Whole) * 180) / Math.PI;
      line[i] = lineV[i]!;
      idx.push(i);
      continue;
    }
    // MA — causal expanding noise floor + 15-sample warm-up gate.
    seen.push(Math.abs(pct));
    if (seen.length < MIN_SAMPLES) continue; // still warming → emit nothing (no line yet)
    const srt = [...seen].sort((a, b) => a - b);
    const noise = Math.max(pctile(srt, gp), MIN_NOISE);
    const p80 = o.scaleMode === "fixed" ? Math.max(o.fixedPctPer45, 0.005) : Math.max(pctile(srt, 0.8), noise);
    const t: -1 | 0 | 1 = pct > noise ? 1 : pct < -noise ? -1 : 0;
    prevTrend = t;
    trend[i] = t;
    deg[i] = (Math.atan(pct / p80) * 180) / Math.PI;
    line[i] = lineV[i]!;
    idx.push(i);
  }

  // History-polish passes (mirrors trendAnalysis): gray→red prefill any length,
  // short gray→green prefill, then boundaries pulled to the line's actual turn.
  if (o.smooth) {
    let a = 0;
    while (a < idx.length) {
      let b = a;
      while (b < idx.length && trend[idx[b]] === trend[idx[a]]) b++;
      const runTrend = trend[idx[a]];
      const runLen = b - a;
      if (runTrend === 0 && b < idx.length && trend[idx[b]] === -1) {
        for (let k = a; k < b; k++) trend[idx[k]] = -1;
      }
      if (runTrend === 0 && runLen <= 3 && b < idx.length && trend[idx[b]] === 1) {
        for (let k = a; k < b; k++) trend[idx[k]] = 1;
      }
      a = b;
    }
    a = 0;
    while (a < idx.length) {
      let b = a;
      while (b < idx.length && trend[idx[b]] === trend[idx[a]]) b++;
      if (trend[idx[a]] !== -1 && b < idx.length && trend[idx[b]] === -1) {
        let t = b - 1;
        while (t > a && line[idx[t]] < line[idx[t - 1]]) { trend[idx[t]] = -1; t--; }
      }
      if (trend[idx[a]] !== 1 && b < idx.length && trend[idx[b]] === 1) {
        let t = b - 1;
        while (t > a && line[idx[t]] > line[idx[t - 1]]) { trend[idx[t]] = 1; t--; }
      }
      a = b;
    }
  }

  return idx.map((i) => ({ t: signal[i].t, line: line[i], trend: trend[i], deg: deg[i], pct: pctAt[i] ?? 0 }));
}
