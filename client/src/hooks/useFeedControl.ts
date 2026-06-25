/**
 * useFeedControl — Feed subscription management hook
 *
 * Provides mutations for subscribing/unsubscribing instruments
 * and a query for current subscription state.
 *
 * Usage:
 *   const { subscribe, unsubscribe, state } = useFeedControl();
 *   subscribe([{ securityId: "12345", exchange: "NSE_FNO" }]);
 */

import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";

export interface SubscribeInstrument {
  securityId: string;
  exchange: string; // IDX_I, NSE_FNO, BSE_FNO, MCX_COMM, etc.
  mode?: "ticker" | "quote" | "full";
}

export function useFeedControl() {
  // NOTE: deliberately NOT invalidating broker.feed.state on each sub/unsub —
  // that fired a re-render cascade across every feed consumer on every change
  // (a storm source). The state query refreshes on its own 10s poll.
  const subscribeMutation = trpc.broker.feed.subscribe.useMutation();
  const unsubscribeMutation = trpc.broker.feed.unsubscribe.useMutation();

  const stateQuery = trpc.broker.feed.state.useQuery(undefined, {
    // Refetched via the broker_changed WS signal (no timer).
  });

  const snapshotQuery = trpc.broker.feed.snapshot.useQuery(undefined, {
    refetchInterval: 5_000, // refresh snapshot every 5s as fallback
    enabled: false, // disabled by default — enable when SSE is not available
  });

  return {
    subscribe: (instruments: SubscribeInstrument[]) =>
      subscribeMutation.mutateAsync({ instruments }),
    unsubscribe: (instruments: SubscribeInstrument[]) =>
      unsubscribeMutation.mutateAsync({ instruments }),
    state: stateQuery.data ?? null,
    snapshot: snapshotQuery.data ?? [],
    isSubscribing: subscribeMutation.isPending,
    isUnsubscribing: unsubscribeMutation.isPending,
    refetchState: () => stateQuery.refetch(),
    refetchSnapshot: () => snapshotQuery.refetch(),
  };
}

/**
 * useFeedSubscriptions — keep a STABLE set of contracts subscribed to the live
 * feed, diffing on change so only the contracts that entered/left are
 * sub/unsubscribed. Unlike a per-ATM subscribe, this never flaps: a transient
 * empty `contracts` (e.g. spot momentarily 0 / chain not loaded) is ignored, so
 * the current subscriptions are kept until a real new set is computed.
 * Releases everything on unmount.
 */
export function useFeedSubscriptions(contracts: SubscribeInstrument[]) {
  const subscribeMutation = trpc.broker.feed.subscribe.useMutation();
  const unsubscribeMutation = trpc.broker.feed.unsubscribe.useMutation();
  const subbedRef = useRef<Map<string, SubscribeInstrument>>(new Map());

  // Stable signature — the effect only runs when the desired SET changes.
  const sig = contracts.map((c) => `${c.exchange}:${c.securityId}`).sort().join(",");

  useEffect(() => {
    const desired = new Map<string, SubscribeInstrument>();
    for (const c of contracts) desired.set(`${c.exchange}:${c.securityId}`, c);
    if (desired.size === 0) return; // transient empty → keep current subs (no flap)

    const cur = subbedRef.current;
    const toAdd: SubscribeInstrument[] = [];
    const toRemove: SubscribeInstrument[] = [];
    desired.forEach((c, k) => { if (!cur.has(k)) toAdd.push(c); });
    cur.forEach((c, k) => { if (!desired.has(k)) toRemove.push(c); });

    if (toRemove.length) void unsubscribeMutation.mutateAsync({ instruments: toRemove });
    if (toAdd.length) void subscribeMutation.mutateAsync({ instruments: toAdd.map((c) => ({ ...c, mode: "full" as const })) });
    subbedRef.current = desired;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Release everything on unmount.
  useEffect(
    () => () => {
      const cur = subbedRef.current;
      if (cur.size) void unsubscribeMutation.mutateAsync({ instruments: Array.from(cur.values()) });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}
