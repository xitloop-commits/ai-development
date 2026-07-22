/**
 * usePushInvalidations — refetch status queries on server WS signals instead of
 * polling them. Mount ONCE (MainScreen). Invalidating a query key refetches
 * every mounted instance, so the formerly-polled status queries (broker.status
 * ×3, broker.feed.state ×2, discipline.getDashboard ×3) all refresh from one
 * place — only when the server says something actually changed.
 */
import { useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { useSignalEpoch } from '@/stores/liveSignals';

export function usePushInvalidations() {
  const utils = trpc.useUtils();
  const brokerEpoch = useSignalEpoch('broker');
  const disciplineEpoch = useSignalEpoch('discipline');
  const seaEpoch = useSignalEpoch('sea');

  useEffect(() => {
    if (brokerEpoch === 0) return; // skip the initial mount value
    void utils.broker.status.invalidate();
    void utils.broker.feed.state.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerEpoch]);

  useEffect(() => {
    if (disciplineEpoch === 0) return;
    void utils.discipline.getDashboard.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disciplineEpoch]);

  useEffect(() => {
    if (seaEpoch === 0) return;
    // SEA cohort/model changed → the model + cohort badges read seaCohortState.
    void utils.trading.seaCohortState.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seaEpoch]);
}
