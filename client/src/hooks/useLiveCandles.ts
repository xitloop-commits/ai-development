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
): { candles: Candle[]; tickCount: number } {
  // Keep the contract subscribed on the live feed while mounted + enabled.
  const contracts = useMemo(
    () => (enabled && securityId ? [{ securityId, exchange: exchangeSegment, mode: "full" as const }] : []),
    [enabled, securityId, exchangeSegment],
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
    () => bucketTicks(bufRef.current.t, bufRef.current.ltp, intervalSec),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bufRef is mutated in place; re-bucket on tick count / interval / contract
    [count, intervalSec, key],
  );

  return { candles, tickCount: count };
}
