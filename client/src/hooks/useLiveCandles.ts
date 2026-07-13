/**
 * useLiveCandles — build live candles for ONE contract from the WS tick stream.
 *
 * Subscribes the contract (server-side) while mounted, accumulates every incoming
 * tick into an in-memory buffer, and buckets it into candles at `intervalSec`.
 * Data starts from when the hook mounts (live-only). When the contract id changes
 * (e.g. the ATM strike rolls intraday) the buffer resets to the new series.
 *
 * Used by the instrument chart window's underlying + CE + PE panels.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useInstrumentTick } from "@/hooks/useTickStream";
import { useFeedSubscriptions } from "@/hooks/useFeedControl";
import { bucketTicks } from "@/lib/instrumentChart";
import type { Candle } from "@/lib/signalChart";

const MAX_TICKS = 40000; // ~a full fast session; bounds memory

export function useLiveCandles(
  securityId: string | null | undefined,
  exchangeSegment: string,
  intervalSec: number,
  enabled = true,
  /** Optional disk history (epoch-seconds ticks) to back-fill before the live
   *  buffer — prepended for ticks that predate the first live tick. */
  seed?: { t: number[]; ltp: number[] } | null,
  /** When the live contract differs from the seed's contract (e.g. seed = future
   *  disk, live = index), shift live prices so they continue from the seed's last
   *  price — removes the basis jump at the seam. */
  alignToSeed = false,
): { candles: Candle[]; tickCount: number } {
  // Index feeds are ticker-mode (no depth); options/futures use full.
  const mode = exchangeSegment === "IDX_I" ? ("ticker" as const) : ("full" as const);
  // Keep the contract subscribed on the live feed while mounted + enabled.
  const contracts = useMemo(
    () => (enabled && securityId ? [{ securityId, exchange: exchangeSegment, mode }] : []),
    [enabled, securityId, exchangeSegment, mode],
  );
  useFeedSubscriptions(contracts);

  const tick = useInstrumentTick(enabled ? exchangeSegment : null, enabled ? securityId : null);

  const key = enabled && securityId ? `${exchangeSegment}:${securityId}` : "";
  const bufRef = useRef<{ t: number[]; ltp: number[]; key: string }>({ t: [], ltp: [], key: "" });
  const lastTsRef = useRef(0);
  const [count, setCount] = useState(0);

  // Reset the buffer when the contract changes (ATM roll / instrument switch).
  useEffect(() => {
    if (bufRef.current.key !== key) {
      bufRef.current = { t: [], ltp: [], key };
      lastTsRef.current = 0;
      setCount(0);
    }
  }, [key]);

  // Append each genuinely-new tick to the buffer. NOTE: useInstrumentTick returns
  // the SAME tick object mutated in place, so we depend on its VALUE (timestamp +
  // ltp), not the object reference — otherwise the effect never re-fires and we
  // capture only the first tick.
  useEffect(() => {
    if (!enabled || !tick || !(tick.ltp > 0)) return;
    const ts = tick.timestamp; // epoch ms (receive time)
    if (!(ts > lastTsRef.current)) return;
    lastTsRef.current = ts;
    const buf = bufRef.current;
    buf.t.push(ts / 1000);
    buf.ltp.push(tick.ltp);
    if (buf.t.length > MAX_TICKS) {
      buf.t.shift();
      buf.ltp.shift();
    }
    setCount((c) => c + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick is mutated in place; fire on value change
  }, [tick?.timestamp, tick?.ltp, enabled]);

  const candles = useMemo(
    () => {
      const live = bufRef.current;
      if (!seed || seed.t.length === 0) return bucketTicks(live.t, live.ltp, intervalSec);
      // Back-fill: seed ticks that predate the earliest live tick, then live.
      const liveStart = live.t.length ? live.t[0] : Infinity;
      // Basis shift so live continues from the seed's last price (no seam jump).
      const off = alignToSeed && live.ltp.length ? seed.ltp[seed.ltp.length - 1] - live.ltp[0] : 0;
      const t: number[] = [];
      const ltp: number[] = [];
      for (let i = 0; i < seed.t.length; i++) {
        if (seed.t[i] < liveStart) { t.push(seed.t[i]); ltp.push(seed.ltp[i]); }
      }
      for (let i = 0; i < live.t.length; i++) { t.push(live.t[i]); ltp.push(live.ltp[i] + off); }
      return bucketTicks(t, ltp, intervalSec);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bufRef is mutated in place; re-bucket on tick count / interval / contract / seed
    [count, intervalSec, key, seed, alignToSeed],
  );

  return { candles, tickCount: count };
}

/**
 * usePolledSpotCandles — like useLiveCandles but fed by a POLLED value (the live
 * feature-stream spot) instead of the WS tick stream. Used for the underlying,
 * whose index market-data isn't on the WS feed the chart window can reach.
 * Accumulates each distinct spot into a buffer and buckets it, seeded (and
 * optionally basis-aligned) with the disk history.
 */
export function usePolledSpotCandles(
  spot: number | null | undefined,
  intervalSec: number,
  seed?: { t: number[]; ltp: number[] } | null,
  alignToSeed = false,
): { candles: Candle[]; tickCount: number } {
  const bufRef = useRef<{ t: number[]; ltp: number[] }>({ t: [], ltp: [] });
  const lastRef = useRef(0);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (spot == null || !(spot > 0) || spot === lastRef.current) return;
    lastRef.current = spot;
    const buf = bufRef.current;
    buf.t.push(Date.now() / 1000);
    buf.ltp.push(spot);
    if (buf.t.length > MAX_TICKS) {
      buf.t.shift();
      buf.ltp.shift();
    }
    setCount((c) => c + 1);
  }, [spot]);

  const candles = useMemo(
    () => {
      const live = bufRef.current;
      if (!seed || seed.t.length === 0) return bucketTicks(live.t, live.ltp, intervalSec);
      const liveStart = live.t.length ? live.t[0] : Infinity;
      const off = alignToSeed && live.ltp.length ? seed.ltp[seed.ltp.length - 1] - live.ltp[0] : 0;
      const t: number[] = [];
      const ltp: number[] = [];
      for (let i = 0; i < seed.t.length; i++) {
        if (seed.t[i] < liveStart) { t.push(seed.t[i]); ltp.push(seed.ltp[i]); }
      }
      for (let i = 0; i < live.t.length; i++) { t.push(live.t[i]); ltp.push(live.ltp[i] + off); }
      return bucketTicks(t, ltp, intervalSec);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bufRef mutated in place; re-bucket on count/interval/seed
    [count, intervalSec, seed, alignToSeed],
  );

  return { candles, tickCount: count };
}
