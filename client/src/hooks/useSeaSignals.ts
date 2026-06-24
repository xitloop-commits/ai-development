/**
 * useSeaSignals — feeds the signal tray from the Mongo-backed store.
 *
 * Delivery model (replaces the old log-tail polling):
 *   - initial paint: one tRPC query (no refetchInterval) seeds the store
 *   - live updates:  pushed over /ws/ticks → signalsStore.addLive (see
 *     useTickStream) — no polling
 *   - lazy-load:     loadOlder() fetches the next older page on scroll
 *
 * Returns the recent-first list plus the lazy-load controls.
 */
import { useEffect, useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import * as signalsStore from "@/stores/signalsStore";

const PAGE = 50;

export function useSeaSignals() {
  const signals = signalsStore.useSignals();
  const utils = trpc.useUtils();
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // First page only — live signals arrive over the WS, so no polling. The
  // query still refetches on window-focus/reconnect, re-seeding the store.
  const initialQuery = trpc.trading.signals.useQuery({ limit: PAGE });
  useEffect(() => {
    if (!initialQuery.data) return;
    const page = initialQuery.data as any[];
    signalsStore.setInitial(page as any);
    setHasMore(page.length >= PAGE);
  }, [initialQuery.data]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore) return;
    const before = signalsStore.getOldestTs();
    if (!before) return;
    setLoadingOlder(true);
    try {
      const older = (await utils.trading.signals.fetch({ limit: PAGE, before })) as any[];
      signalsStore.appendOlder(older as any);
      if (older.length < PAGE) setHasMore(false);
    } catch {
      // transient — leave hasMore set so a later scroll retries
    } finally {
      setLoadingOlder(false);
    }
  }, [utils, loadingOlder, hasMore]);

  return { signals, loadOlder, loadingOlder, hasMore };
}
