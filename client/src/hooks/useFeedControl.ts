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

import { trpc } from "@/lib/trpc";

export interface SubscribeInstrument {
  securityId: string;
  exchange: string; // IDX_I, NSE_FNO, BSE_FNO, MCX_COMM, etc.
  mode?: "ticker" | "quote" | "full";
}

export function useFeedControl() {
  const utils = trpc.useUtils();

  const subscribeMutation = trpc.broker.feed.subscribe.useMutation({
    onSuccess: () => {
      void utils.broker.feed.state.invalidate();
    },
  });

  const unsubscribeMutation = trpc.broker.feed.unsubscribe.useMutation({
    onSuccess: () => {
      void utils.broker.feed.state.invalidate();
    },
  });

  const stateQuery = trpc.broker.feed.state.useQuery(undefined, {
    refetchInterval: 10_000, // refresh every 10s
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
    refetchState: () => utils.broker.feed.state.invalidate(),
    refetchSnapshot: () => snapshotQuery.refetch(),
  };
}
