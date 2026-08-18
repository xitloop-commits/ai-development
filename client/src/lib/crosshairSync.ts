/**
 * crosshairSync — a tiny shared bus so several TickChart panes show ONE crosshair
 * together: hovering any pane draws the vertical (time) crosshair on every pane at
 * the same moment. Each parent that has a multi-pane layout creates one instance
 * (useMemo) and passes it to every TickChart; TickChart publishes its own hover
 * and mirrors everyone else's. (Partha, 2026-08-18)
 *
 * We sync the TIME (vertical line). The price travels along so same-scale panes
 * also line up horizontally; cross-scale panes (underlying vs premium) just show
 * the vertical line, which is exactly what's wanted.
 */
import type { Time } from "lightweight-charts";

export interface CrosshairEvent {
  time: Time | null;   // null = pointer left the chart → clear everywhere
  price: number | null;
}

export interface CrosshairSync {
  /** The live crosshair (last non-clear emit), or null when nothing is hovered.
   *  A pane re-applies this after a rebuild so the crosshair survives live ticks
   *  instead of blinking out until the next mouse move. */
  current: CrosshairEvent | null;
  /** Publish this pane's hover. `source` identifies the emitter so it ignores itself. */
  emit(source: symbol, ev: CrosshairEvent): void;
  /** Listen for other panes' hovers. Returns an unsubscribe. */
  subscribe(fn: (source: symbol, ev: CrosshairEvent) => void): () => void;
}

export function createCrosshairSync(): CrosshairSync {
  const listeners = new Set<(source: symbol, ev: CrosshairEvent) => void>();
  const sync: CrosshairSync = {
    current: null,
    emit(source, ev) {
      sync.current = ev.time == null ? null : ev;
      listeners.forEach((fn) => fn(source, ev));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
  return sync;
}
