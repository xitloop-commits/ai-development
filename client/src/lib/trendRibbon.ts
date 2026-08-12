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
  lookbackMin: number;          // minutes back the slope compares (3–10)
  scaleMode: "auto" | "fixed";  // what counts as steep
  fixedPctPer45: number;        // fixed mode: % per lookback that reads 45°
  grayPctile: number;           // noise floor percentile (20–60)
  smooth: boolean;              // history-polish passes on/off
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
const GRAY = "#9CA3AF";

export function trendAnalysis(
  candles: { time: number; close: number }[],
  opts: Partial<TrendAngleOptions> = {},
): TrendAnalysis | undefined {
  const o = { ...DEFAULT_TREND_ANGLE, ...opts };
  const source = o.source;
  const LOOK = Math.max(1, Math.round(o.lookbackMin));
  if (candles.length < 10) return undefined;
  const minuteClose = new Map<number, number>();
  for (const c of candles) minuteClose.set(Math.floor(c.time / 60), c.close);
  const mins = Array.from(minuteClose.keys()).sort((a, b) => a - b);
  const mClose = mins.map((m) => minuteClose.get(m)!);

  // The smoothing line on minute closes.
  const lineV: (number | null)[] = [];
  if (source === "ma") {
    const k = 2 / 21; // 20-EMA — the MA-Signal cohort's own line
    let e = mClose[0];
    for (let i = 0; i < mClose.length; i++) {
      e = i === 0 ? mClose[0] : mClose[i] * k + e * (1 - k);
      lineV.push(i < 5 ? null : e); // small warmup
    }
  } else {
    for (let i = 0; i < mClose.length; i++) {
      if (i < 4) { lineV.push(null); continue; }
      let s = 0;
      for (let j = 0; j < 5; j++) s += mClose[i - j];
      lineV.push(s / 5);
    }
  }

  // % lean of the line over the LOOKBACK, per minute.
  const pctOfMin = new Map<number, { pct: number; line: number }>();
  const allAbs: number[] = [];
  mins.forEach((m, i) => {
    const now = lineV[i];
    const then = i >= LOOK ? lineV[i - LOOK] : null;
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

  const st = new Map<number, MinuteState>();
  pctOfMin.forEach((v, m) => {
    st.set(m, {
      deg: (Math.atan(v.pct / p80) * 180) / Math.PI,
      line: v.line,
      trend: v.pct > noise ? 1 : v.pct < -noise ? -1 : 0,
      runMin: 1,
    });
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
