/**
 * trendRibbon — the SMA5-angle trend painter (T162 test-chart experiments).
 *
 * ONE continuous tri-coloured line just under the SMA5 of 1-MINUTE closes
 * (whatever interval the chart displays): GREEN while the 5-min slope leans
 * up past the day's own noise floor, RED leaning down, GRAY only when
 * genuinely flat. Self-calibrating per instrument (P40 noise / P80 = 45°).
 * History-polish rules (Partha 2026-08-12): gray runs flowing into red
 * prefill red (any length); short gray blips before green prefill green;
 * run boundaries pulled to the actual SMA5 rollover/upturn.
 */

export interface RibbonPoint { time: number; value?: number; color?: string }

export function trendRibbon(
  candles: { time: number; close: number }[],
  sma5Period = 5,
): { data: RibbonPoint[]; color: string }[] | undefined {
  if (candles.length < 10) return undefined;
  const p = sma5Period || 5;
  const minuteClose = new Map<number, number>();
  for (const c of candles) minuteClose.set(Math.floor(c.time / 60), c.close);
  const mins = Array.from(minuteClose.keys()).sort((a, b) => a - b);
  const mClose = mins.map((m) => minuteClose.get(m)!);
  const mSma: (number | null)[] = mClose.map((_, i) => {
    if (i < p - 1) return null;
    let s = 0;
    for (let k = 0; k < p; k++) s += mClose[i - k];
    return s / p;
  });
  const pctOfMin = new Map<number, { pct: number; sma: number }>();
  const allAbs: number[] = [];
  mins.forEach((m, i) => {
    const now = mSma[i];
    const then = i >= 5 ? mSma[i - 5] : null;
    if (now == null || then == null || !(then > 0)) return;
    const pct = ((now - then) / then) * 100;
    pctOfMin.set(m, { pct, sma: now });
    allAbs.push(Math.abs(pct));
  });
  if (!allAbs.length) return undefined;
  const sortedAbs = [...allAbs].sort((a, b) => a - b);
  const noise = Math.max(sortedAbs[Math.floor(sortedAbs.length * 0.4)] ?? 0.01, 0.002);
  const p80 = Math.max(sortedAbs[Math.floor(sortedAbs.length * 0.8)] ?? noise * 2, noise);
  const angleOfMin = new Map<number, { deg: number; sma: number; trend: -1 | 0 | 1 }>();
  pctOfMin.forEach((v, m) => {
    angleOfMin.set(m, {
      deg: (Math.atan(v.pct / p80) * 180) / Math.PI,
      sma: v.sma,
      trend: v.pct > noise ? 1 : v.pct < -noise ? -1 : 0,
    });
  });

  // History-polish passes.
  const seq = mins.filter((m) => angleOfMin.has(m));
  let i2 = 0;
  while (i2 < seq.length) {
    let j2 = i2;
    while (j2 < seq.length && angleOfMin.get(seq[j2])!.trend === angleOfMin.get(seq[i2])!.trend) j2++;
    const runTrend = angleOfMin.get(seq[i2])!.trend;
    const runLen = j2 - i2;
    if (runTrend === 0 && j2 < seq.length && angleOfMin.get(seq[j2])!.trend === -1) {
      for (let k = i2; k < j2; k++) angleOfMin.get(seq[k])!.trend = -1;
    }
    if (runTrend === 0 && runLen <= 3 && j2 < seq.length && angleOfMin.get(seq[j2])!.trend === 1) {
      for (let k = i2; k < j2; k++) angleOfMin.get(seq[k])!.trend = 1;
    }
    i2 = j2;
  }
  i2 = 0;
  while (i2 < seq.length) {
    let j2 = i2;
    while (j2 < seq.length && angleOfMin.get(seq[j2])!.trend === angleOfMin.get(seq[i2])!.trend) j2++;
    if (angleOfMin.get(seq[i2])!.trend !== -1 && j2 < seq.length && angleOfMin.get(seq[j2])!.trend === -1) {
      let t = j2 - 1;
      while (t > i2 && angleOfMin.get(seq[t])!.sma < angleOfMin.get(seq[t - 1])!.sma) {
        angleOfMin.get(seq[t])!.trend = -1;
        t--;
      }
    }
    if (angleOfMin.get(seq[i2])!.trend !== 1 && j2 < seq.length && angleOfMin.get(seq[j2])!.trend === 1) {
      let t = j2 - 1;
      while (t > i2 && angleOfMin.get(seq[t])!.sma > angleOfMin.get(seq[t - 1])!.sma) {
        angleOfMin.get(seq[t])!.trend = 1;
        t--;
      }
    }
    i2 = j2;
  }

  const line: RibbonPoint[] = [];
  candles.forEach((c) => {
    const a = angleOfMin.get(Math.floor(c.time / 60));
    if (!a) { line.push({ time: c.time }); return; }
    const color = a.trend > 0 ? "#1a9850" : a.trend < 0 ? "#d7301f" : "#9CA3AF";
    line.push({ time: c.time, value: a.sma * 0.9995, color });
  });
  return [{ data: line, color: "#9CA3AF" }];
}
