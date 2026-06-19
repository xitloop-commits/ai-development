/**
 * useFeedHealth — detect when the live tick feed has gone quiet.
 *
 * Reports the feed as "down" when the market is open but no tick has arrived in
 * STALE_MS (covers both a dropped WebSocket and a silently-stalled upstream feed
 * — e.g. an expired broker token). Auto-clears within CHECK_MS of ticks
 * resuming. Gated to trading hours so it stays quiet after close (and the mock
 * feed keeps it green since mock ticks update lastTickAt too).
 */

import { useEffect, useState } from 'react';
import { getLastTickAt, isFeedConnected } from './useTickStream';
import { useMarketOpen } from './useMarketOpen';

const STALE_MS = 15_000; // no tick for this long (market open) → feed is down
const CHECK_MS = 2_000; // re-evaluate cadence (also the recovery latency)

export interface FeedHealth {
  down: boolean;
  reason: 'disconnected' | 'stalled' | null;
  agoSec: number;
}

export function useFeedHealth(): FeedHealth {
  const { anyOpen } = useMarketOpen();
  const [, force] = useState(0);

  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1_000_000), CHECK_MS);
    return () => clearInterval(id);
  }, []);

  const ago = Date.now() - getLastTickAt();
  const stale = ago > STALE_MS;
  const down = anyOpen && stale;
  return {
    down,
    reason: down ? (isFeedConnected() ? 'stalled' : 'disconnected') : null,
    agoSec: Math.round(ago / 1000),
  };
}
