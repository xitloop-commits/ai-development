/**
 * FeedStatusBanner — a thin warning strip shown under the AppBar whenever the
 * live tick feed has gone quiet during market hours. Disappears automatically
 * when ticks resume. See useFeedHealth for the detection logic.
 */

import { AlertTriangle } from 'lucide-react';
import { useFeedHealth } from '@/hooks/useFeedHealth';

export function FeedStatusBanner() {
  const { down, reason, agoSec } = useFeedHealth();
  if (!down) return null;

  const disconnected = reason === 'disconnected';
  const tone = disconnected ? 'bg-destructive text-white' : 'bg-warning-amber text-black';
  const text = disconnected
    ? 'Live feed disconnected — reconnecting…'
    : `Live feed stalled — no ticks for ${agoSec}s. Prices may be frozen; check the broker token / feed.`;

  return (
    <div
      className={`w-full ${tone} flex items-center justify-center gap-2 px-3 py-1 text-[0.6875rem] font-bold tracking-wide`}
      role="alert"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}
