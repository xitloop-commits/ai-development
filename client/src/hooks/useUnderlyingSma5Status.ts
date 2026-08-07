/**
 * useUnderlyingSma5Status — the SMA5 detector's CURRENT condition, in plain
 * English, computed from the UNDERLYING (the detector's basis) so it can be shown
 * on an OPTION chart (whose own SMA5 line is option prices and never matches the
 * signal).
 *
 * It rebuilds 1-minute candles from the underlying (disk history + live index
 * for today) and replays the SAME state machine the Python detector runs —
 * Heikin-Ashi close vs the SMA line, the `buffer` deadband, and the `confirm`
 * reversal wait — so the message matches what actually fires. It's a faithful
 * reconstruction (same inputs + logic), not a value pushed from SEA, and it lags
 * only as far as the underlying feed does.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useLiveCandles } from "@/hooks/useLiveCandles";
import { heikinAshi } from "@/lib/instrumentChart";
import { sma } from "@/lib/indicators";
import { UNDERLYING_SECURITY_ID, istDateString, type Candle } from "@/lib/signalChart";

export type Sma5Tone = "up" | "down" | "pending" | "flat";
export interface Sma5Status {
  tone: Sma5Tone;
  /** Plain-English sentence for the chart strip. */
  text: string;
  /** Compact settings suffix, e.g. "confirm 2 · buffer 0.1%". */
  settings: string;
}

/** Pure state machine — mirrors sma5_signal.Sma5SignalDetector. Exported for tests. */
export function computeSma5Status(
  candles: Candle[],
  opts: { useHa: boolean; period: number; confirm: number; buffer: number },
): Sma5Status | null {
  const { useHa, period, confirm, buffer } = opts;
  const settings = `confirm ${confirm}${buffer > 0 ? ` · buffer ${buffer}%` : ""}`;
  if (!candles || candles.length < period) {
    return { tone: "flat", text: "Warming up — need a few candles before the line is ready.", settings };
  }
  const src = useHa ? heikinAshi(candles) : candles;
  const closes = src.map((k) => k.close);
  const smaArr = sma(closes, period);
  const buf = buffer / 100;

  let state: "FLAT" | "ABOVE" | "BELOW" = "FLAT";
  let pending: "ABOVE" | "BELOW" | null = null;
  let streak = 0;
  for (let i = 0; i < closes.length; i++) {
    const v = smaArr[i];
    if (v == null || v <= 0) continue;
    const c = closes[i];
    let target: "FLAT" | "ABOVE" | "BELOW" = state;
    if (c > v * (1 + buf)) target = "ABOVE";
    else if (c < v * (1 - buf)) target = "BELOW";
    if (target === state) { pending = null; streak = 0; continue; }
    const need = state === "FLAT" ? 1 : confirm; // first entry is immediate
    if (need > 1) {
      if (pending === target) streak += 1;
      else { pending = target as "ABOVE" | "BELOW"; streak = 1; }
      if (streak < need) continue; // hold — reversal not yet confirmed
    }
    pending = null; streak = 0; state = target;
  }

  // NOTE: every message says "underlying" / "spot" explicitly — this strip is on
  // an OPTION chart, where "the line" could be mistaken for the option's own SMA5.
  // The condition is always about the UNDERLYING (spot) vs its SMA5.
  if (state === "FLAT") {
    return { tone: "flat", text: "Underlying is sitting on its SMA5 line — no clear side yet.", settings };
  }
  // A reversal is forming but not yet confirmed.
  if (pending) {
    const more = confirm - streak;
    const moreTxt = more <= 1 ? "one more close" : `${more} more closes`;
    if (state === "ABOVE") {
      return { tone: "pending", text: `Underlying slipping below its SMA5 line — waiting to confirm exit (${streak} of ${confirm}). ${moreTxt} below and it exits the CALL.`, settings };
    }
    return { tone: "pending", text: `Underlying poking above its SMA5 line — waiting to confirm exit (${streak} of ${confirm}). ${moreTxt} above and it exits the PUT.`, settings };
  }
  // Steady in a side.
  const holdN = confirm > 1 ? ` for ${confirm} candles` : "";
  if (state === "ABOVE") {
    return { tone: "up", text: `Trend up — in the CALL. Exits when the underlying (spot) closes below its SMA5 line${holdN} — not this option's line.`, settings };
  }
  return { tone: "down", text: `Trend down — in the PUT. Exits when the underlying (spot) closes above its SMA5 line${holdN} — not this option's line.`, settings };
}

export function useUnderlyingSma5Status(instrument: string, date: string): Sma5Status | null {
  const isToday = date === istDateString();
  const ticksQ = trpc.trading.underlyingTicks.useQuery(
    { instrument, date },
    { enabled: !!instrument && !!date, staleTime: Infinity, refetchOnWindowFocus: false },
  );
  const cfgQ = trpc.trading.sma5LineConfig.useQuery(
    { instrument },
    { enabled: !!instrument, staleTime: 60_000, refetchOnWindowFocus: false },
  );
  const seaQ = trpc.trading.seaCohortState.useQuery(undefined, {
    refetchInterval: isToday ? 5000 : false,
    refetchOnWindowFocus: false,
  });

  const disk = ticksQ.data as { t: number[]; ltp: number[] } | undefined;
  const seed = useMemo(
    () => (disk && disk.t?.length ? { t: disk.t, ltp: disk.ltp } : undefined),
    [disk],
  );
  // 1-min candles: live index for today (seeded with the day's disk history so the
  // SMA is ready immediately), or the disk history alone for a past date. The
  // above/below state is invariant to a constant price offset, so the disk seed's
  // future-vs-index basis does not change the classification.
  const und = useLiveCandles(
    isToday ? UNDERLYING_SECURITY_ID[instrument] ?? null : null,
    "IDX_I",
    60,
    isToday,
    seed,
  );

  const useHa = cfgQ.data?.useHa ?? true;
  const period = cfgQ.data?.period ?? 5;
  const sea = seaQ.data as { sma5Confirm?: number; sma5Buffer?: number } | undefined;
  const confirm = Math.max(1, Math.round(sea?.sma5Confirm ?? 1));
  const buffer = Math.max(0, sea?.sma5Buffer ?? 0);

  return useMemo(
    () => computeSma5Status(und.candles, { useHa, period, confirm, buffer }),
    [und.candles, useHa, period, confirm, buffer],
  );
}
