/**
 * priceMapBus — lets a NON-chart component line itself up with a chart's price
 * scale (T173 chain strip, Partha 2026-09-01: "align the option-chain strikes
 * with the underlying's price scale"). The underlying TickChart publishes a
 * price -> screen-Y mapping under a key whenever its scale, size or position
 * changes; the ChainStrip subscribes and places each strike row at that height.
 * Client (viewport) Y is used so the two components need not share a parent.
 */
export interface PriceMap {
  /** Viewport Y for a price, or null when the chart cannot map it yet. */
  toClientY(price: number): number | null;
  /** Viewport top / bottom of the chart's plotting container. */
  top: number;
  bottom: number;
  /** The chart's latest close — lets subscribers compute the futures-vs-spot
   *  basis and shift spot-referenced levels (strikes) to the right height. */
  lastPrice: number | null;
}

type Listener = (m: PriceMap | null) => void;
const current = new Map<string, PriceMap>();
const listeners = new Map<string, Set<Listener>>();

export function publishPriceMap(key: string, map: PriceMap | null): void {
  if (map) current.set(key, map); else current.delete(key);
  listeners.get(key)?.forEach((fn) => fn(map));
}

/** Subscribe; fires immediately with the current map (if any). Returns unsubscribe. */
export function subscribePriceMap(key: string, fn: Listener): () => void {
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(fn);
  fn(current.get(key) ?? null);
  return () => { set!.delete(fn); if (set!.size === 0) listeners.delete(key); };
}
