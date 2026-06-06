/**
 * StrikeBar — ready-state strike scale for InstrumentBar.
 *
 * A strike-axis sibling of TradeBar: instead of SL / Entry / TSL / TP it plots a
 * rolling window of option strikes (ITM · ATM · OTM) with the underlying LTP as
 * the moving pointer. As the LTP moves, the visible window re-centres on the ATM
 * strike — same rolling-window behaviour as TodayPnlBar.
 *
 * Presentational + self-contained: give it spot + strikeStep (+ optional ltp /
 * ATM) and it owns the scale, the window, and the pointer. The instrument name
 * caption is rendered by InstrumentBar, not here. Iterate via StrikeBar.stories.
 *
 * SCALE: a rolling window of `windowEachSide*2 + 1` strikes (default 7 = 3 ITM ·
 * ATM · 3 OTM). The window follows the live LTP and rolls when the pointer nears
 * an edge, bringing new strikes in.
 *
 * MONEYNESS (CE): strikes below the LTP are ITM, above are OTM. PE is mirrored.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface StrikeBarProps {
  /** Underlying price that anchors the strike list. */
  spot: number;
  /** Live underlying LTP — the moving pointer + window/ATM driver. Defaults to spot. */
  ltp?: number;
  /** Gap between adjacent strikes (e.g. 50 NIFTY, 100 BANKNIFTY). */
  strikeStep: number;
  /** ATM strike list anchor; defaults to round(spot / step) * step. */
  atmStrike?: number;
  /** Moneyness labelling. CE: strikes below LTP are ITM; PE: mirrored. */
  side?: "CE" | "PE";
  /** Show the ITM / ATM / OTM zone labels (default false). */
  showZoneLabels?: boolean;
  /** Leave a fading "footprint" trail of recent LTP positions (default false). */
  showTrail?: boolean;
  /** Max number of footprints kept in the trail. */
  trailLength?: number;
  /** Support price levels on the underlying — rendered as dashed markers. */
  supports?: number[];
  /** Resistance price levels on the underlying — rendered as dashed markers. */
  resistances?: number[];
  /** Fired when the user clicks the bar to place the trade-entry marker (price). */
  onPlaceEntry?: (price: number) => void;
  /** Fired once when the live LTP first touches the placed entry marker. */
  onEnterTrade?: (price: number) => void;
  /** Controlled placed entry price; if provided, click-to-place is parent-owned. */
  entryMarker?: number | null;
  /** Strikes shown each side of centre (default 3 → 7 visible). */
  windowEachSide?: number;
  /** Compact mode (no strike-number labels) for tight table cells. */
  compact?: boolean;
  className?: string;
}

// ─── Tunables ───────────────────────────────────────────────────────────
const RANGE_EACH_SIDE = 30; // strikes generated each side of the anchor (rolling reserve)
const EDGE = 4; // % margin so edge ticks / pointer never clip
const SCROLL_BUFFER = 1; // roll just before the last strike — keep 1 strike of edge headroom

// ─── Colours (match TradeBar / TodayPnlBar palette) ─────────────────────
const ATM_COLOR = "#eab308"; // amber
const ITM_COLOR = "#22c55e"; // green
const OTM_COLOR = "#94a3b8"; // slate
const POINTER_COLOR = "#3b82f6"; // blue
const SUPPORT_COLOR = "#10b981"; // emerald — demand floor
const RESISTANCE_COLOR = "#ef4444"; // red — supply ceiling
const ENTRY_COLOR = "#2563eb"; // blue — trade-entry marker
const TRAIL_COLOR = "#2563eb"; // single colour for the dwell heatmap footprints

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/**
 * Sticky rolling window over a strike list, centred near the live LTP. The
 * window stays put until the pointer comes within SCROLL_BUFFER strikes of an
 * edge, then it scrolls — mirrors TodayPnlBar.getVisibleMarkerIndices.
 */
function getVisibleWindow(
  strikes: number[],
  ltp: number,
  visibleCount: number,
  prevStart: number | null,
): { start: number; end: number } {
  if (strikes.length <= visibleCount) return { start: 0, end: strikes.length };
  let current = strikes.findIndex((s) => s >= ltp);
  if (current === -1) current = strikes.length - 1;
  const safeMin = SCROLL_BUFFER;
  const safeMax = visibleCount - 1 - SCROLL_BUFFER;
  let start = prevStart ?? 0;
  const pos = current - start;
  if (pos < 0 || pos >= visibleCount) start = Math.max(0, current - Math.floor(visibleCount / 2));
  else if (pos < safeMin) start = current - safeMin;
  else if (pos > safeMax) start = current - safeMax;
  start = Math.max(0, Math.min(start, strikes.length - visibleCount));
  return { start, end: start + visibleCount };
}

export function StrikeBar({
  spot,
  ltp,
  strikeStep,
  atmStrike,
  side = "CE",
  showZoneLabels = false,
  showTrail = false,
  trailLength = 30,
  supports = [],
  resistances = [],
  onPlaceEntry,
  onEnterTrade,
  entryMarker,
  windowEachSide = 3,
  compact = false,
  className,
}: StrikeBarProps) {
  const step = strikeStep > 0 ? strikeStep : 1;
  // Live underlying LTP — drives the pointer, the rolling window, AND the ATM.
  const pointerVal = ltp ?? spot;
  // The strike list is anchored to a stable reference (atmStrike or spot) and
  // made wide so the window has room to roll; the ATM marker tracks the live LTP.
  const listAnchor = atmStrike ?? Math.round(spot / step) * step;
  const liveAtm = Math.round(pointerVal / step) * step;
  const visibleCount = windowEachSide * 2 + 1;

  const strikes = useMemo(() => {
    const arr: number[] = [];
    for (let i = -RANGE_EACH_SIDE; i <= RANGE_EACH_SIDE; i++) arr.push(listAnchor + i * step);
    return arr;
  }, [listAnchor, step]);

  // Window rolls to follow the live LTP — re-centres as the pointer nears an
  // edge, bringing new strikes in (TodayPnlBar-style).
  const prevStartRef = useRef<number | null>(null);
  const { start, end } = useMemo(() => {
    const r = getVisibleWindow(strikes, pointerVal, visibleCount, prevStartRef.current);
    prevStartRef.current = r.start;
    return r;
  }, [strikes, pointerVal, visibleCount]);

  // ── Trade-entry marker (hover to aim, click to place) ───────────────────
  const barRef = useRef<HTMLDivElement>(null);
  const [hoverPrice, setHoverPrice] = useState<number | null>(null);
  const [internalEntry, setInternalEntry] = useState<number | null>(null);
  const entryPrice = entryMarker !== undefined ? entryMarker : internalEntry;

  // Fire onEnterTrade once when the live LTP first crosses the placed marker.
  const onEnterTradeRef = useRef(onEnterTrade);
  onEnterTradeRef.current = onEnterTrade;
  const prevEntryRef = useRef<number | null | undefined>(undefined);
  const armAboveRef = useRef(true); // true = wait for LTP to rise to the marker
  const enteredRef = useRef(false);
  useEffect(() => {
    if (entryPrice == null) {
      prevEntryRef.current = entryPrice;
      enteredRef.current = false;
      return;
    }
    // New marker → arm it: remember which side the LTP must reach the marker from.
    if (prevEntryRef.current !== entryPrice) {
      prevEntryRef.current = entryPrice;
      enteredRef.current = false;
      armAboveRef.current = entryPrice >= pointerVal;
    }
    if (enteredRef.current) return;
    // Touched = the LTP has reached the marker from the armed side (fires once;
    // fires immediately if the marker is placed at/through the current LTP).
    const reached = armAboveRef.current ? pointerVal >= entryPrice : pointerVal <= entryPrice;
    if (reached) {
      enteredRef.current = true;
      onEnterTradeRef.current?.(entryPrice);
    }
  }, [pointerVal, entryPrice]);

  // Footprint heatmap — dwell count per price bucket. The longer price lingers
  // around a level, the more its bucket accumulates → the darker the dot.
  const bucketSize = Math.max(1, Math.round(strikeStep / 10));
  const dwellRef = useRef<Map<number, number>>(new Map());
  useEffect(() => {
    if (!showTrail || !(pointerVal > 0)) return;
    const bucket = Math.round(pointerVal / bucketSize) * bucketSize;
    const m = dwellRef.current;
    m.set(bucket, (m.get(bucket) ?? 0) + 1);
    // Bound memory: evict the lowest-dwell bucket once the map grows large.
    if (m.size > trailLength * 8) {
      let minKey = bucket;
      let minVal = Infinity;
      m.forEach((v, k) => {
        if (v < minVal) {
          minVal = v;
          minKey = k;
        }
      });
      m.delete(minKey);
    }
  }, [pointerVal, showTrail, bucketSize, trailLength]);

  if (!(pointerVal > 0) || !(strikeStep > 0)) return null;

  const visible = strikes.slice(start, end);
  const total = visible.length;

  // Evenly distribute visible strikes across [EDGE, 100 − EDGE].
  const posOfIndex = (i: number) => (total <= 1 ? 50 : EDGE + (i / (total - 1)) * (100 - 2 * EDGE));

  // Interpolate any price between the two visible strikes that bracket it.
  const posForValue = (v: number): number => {
    if (v <= visible[0]) return posOfIndex(0);
    if (v >= visible[total - 1]) return posOfIndex(total - 1);
    for (let i = 0; i < total - 1; i++) {
      if (v >= visible[i] && v <= visible[i + 1]) {
        const span = visible[i + 1] - visible[i] || 1;
        const f = (v - visible[i]) / span;
        return posOfIndex(i) + (posOfIndex(i + 1) - posOfIndex(i)) * f;
      }
    }
    return 50;
  };
  const pointerPos = posForValue(pointerVal);

  // Support / resistance markers within the visible price range.
  const lo = visible[0];
  const hi = visible[total - 1];
  const srMarkers = [
    ...supports.filter((p) => p >= lo && p <= hi).map((price) => ({ price, kind: "S" as const })),
    ...resistances.filter((p) => p >= lo && p <= hi).map((price) => ({ price, kind: "R" as const })),
  ];

  // Inverse of the strike scale: bar-% → continuous price (for the entry aim).
  const valueForPos = (pct: number): number => {
    if (total <= 1) return visible[0];
    const spanPct = 100 - 2 * EDGE;
    const fi = clamp((pct - EDGE) / spanPct, 0, 1) * (total - 1);
    const i = Math.min(total - 2, Math.floor(fi));
    return visible[i] + (visible[i + 1] - visible[i]) * (fi - i);
  };
  const priceFromClientX = (clientX: number): number | null => {
    const el = barRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return valueForPos(((clientX - rect.left) / rect.width) * 100);
  };
  const handleAimMove = (e: { clientX: number }) => setHoverPrice(priceFromClientX(e.clientX));
  const handleAimLeave = () => setHoverPrice(null);
  const handlePlace = (e: { clientX: number }) => {
    const p = priceFromClientX(e.clientX);
    if (p == null) return;
    if (entryMarker === undefined) setInternalEntry(p);
    onPlaceEntry?.(p);
  };

  // Footprint heatmap dots — one per dwelt price bucket within the window,
  // darkness ∝ dwell count (single colour, opacity-scaled).
  const trailDots = showTrail
    ? (() => {
        const m = dwellRef.current;
        const out: ReactNode[] = [];
        if (m.size === 0) return out;
        let maxCount = 1;
        m.forEach((v, k) => {
          if (k >= lo && k <= hi && v > maxCount) maxCount = v;
        });
        m.forEach((count, price) => {
          if (price < lo || price > hi) return;
          const intensity = Math.min(1, count / maxCount);
          out.push(
            <div
              key={`fp-${price}`}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full pointer-events-none"
              style={{
                left: `${clamp(posForValue(price))}%`,
                width: "4px",
                height: "4px",
                background: TRAIL_COLOR,
                opacity: 0.15 + intensity * 0.8,
              }}
            />,
          );
        });
        return out;
      })()
    : null;

  // ATM label sits over the actual ATM strike tick — it tracks the live LTP, so
  // it isn't always dead-centre once the window rolls.
  const atmIndex = visible.indexOf(liveAtm);
  const atmPos = atmIndex >= 0 ? posOfIndex(atmIndex) : clamp(pointerPos);

  const moneyness = (strike: number): "ITM" | "ATM" | "OTM" => {
    if (strike === liveAtm) return "ATM";
    const below = strike < pointerVal;
    if (side === "CE") return below ? "ITM" : "OTM";
    return below ? "OTM" : "ITM";
  };
  const colorOf = (m: "ITM" | "ATM" | "OTM") =>
    m === "ATM" ? ATM_COLOR : m === "ITM" ? ITM_COLOR : OTM_COLOR;

  const Tick = ({ at, strike }: { at: number; strike: number }) => {
    const m = moneyness(strike);
    const isAtm = m === "ATM";
    return (
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center justify-center pointer-events-auto cursor-help transition-[left] duration-300 ease-out"
        style={{ left: `${at}%`, width: "12px", height: "16px" }}
        title={`${strike} · ${m}`}
      >
        <div
          style={{
            width: isAtm ? "3px" : "2px",
            height: isAtm ? "12px" : "9px",
            backgroundColor: colorOf(m),
            borderRadius: "1px",
            boxShadow: "0 0 0 0.5px rgba(255,255,255,0.65)",
          }}
        />
      </div>
    );
  };

  return (
    <div
      ref={barRef}
      className={`relative w-full cursor-pointer ${className ?? ""}`}
      role="progressbar"
      aria-label="Strike position"
      aria-valuemin={visible[0]}
      aria-valuemax={visible[total - 1]}
      aria-valuenow={Math.round(pointerVal)}
      onMouseMove={handleAimMove}
      onMouseLeave={handleAimLeave}
      onClick={handlePlace}
    >
      {/* Top tier: also a spacer that balances the bottom strike labels so the
          track stays vertically centred whether or not the zone labels show.
          ITM on the ITM-edge strike, ATM on the live ATM tick, OTM on the
          OTM-edge strike. */}
      {(showZoneLabels || !compact) && (
        <div className="relative w-full" style={{ height: "11px" }}>
          {showZoneLabels && (
            <>
              <span
                className="absolute -translate-x-1/2 text-[0.5rem] font-bold leading-none"
                style={{ left: `${posOfIndex(side === "CE" ? 0 : total - 1)}%`, color: ITM_COLOR }}
              >
                ITM
              </span>
              <span
                className="absolute -translate-x-1/2 text-[0.5rem] font-bold leading-none"
                style={{ left: `${clamp(atmPos, 4, 96)}%`, color: ATM_COLOR }}
              >
                ATM
              </span>
              <span
                className="absolute -translate-x-1/2 text-[0.5rem] font-bold leading-none"
                style={{ left: `${posOfIndex(side === "CE" ? total - 1 : 0)}%`, color: OTM_COLOR }}
              >
                OTM
              </span>
            </>
          )}
        </div>
      )}

      <div className="relative w-full h-1.5">
        {/* Track */}
        <div className="absolute inset-0 rounded-full bg-muted-foreground/20 overflow-hidden" />

        {/* Strike ticks */}
        <div className="absolute inset-0 pointer-events-none">
          {visible.map((strike, i) => (
            <Tick key={strike} at={posOfIndex(i)} strike={strike} />
          ))}
        </div>

        {/* Support / resistance dashed markers (taller than strike ticks) */}
        {srMarkers.map(({ price, kind }) => {
          const at = posForValue(price);
          const color = kind === "S" ? SUPPORT_COLOR : RESISTANCE_COLOR;
          return (
            <div
              key={`${kind}-${price}`}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 pointer-events-auto cursor-help"
              style={{ left: `${clamp(at)}%`, width: "8px", height: "18px" }}
              title={`${kind === "S" ? "Support" : "Resistance"} ${price}`}
            >
              <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0" style={{ borderLeft: `1.5px dashed ${color}` }} />
              <span className="absolute left-1/2 -translate-x-1/2 -top-1.5 text-[0.5rem] font-bold leading-none" style={{ color }}>
                {kind}
              </span>
            </div>
          );
        })}

        {/* Trade-entry: hover aim preview + placed marker */}
        {hoverPrice != null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 pointer-events-none"
            style={{ left: `${clamp(posForValue(hoverPrice))}%`, width: "2px", height: "20px" }}
          >
            <div className="h-full w-full" style={{ background: ENTRY_COLOR, opacity: 0.45 }} />
            <span
              className="absolute left-1/2 -translate-x-1/2 -top-3 text-[0.5rem] font-bold tabular-nums leading-none whitespace-nowrap"
              style={{ color: ENTRY_COLOR, opacity: 0.85 }}
            >
              {Math.round(hoverPrice)}
            </span>
          </div>
        )}
        {entryPrice != null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 pointer-events-none"
            style={{ left: `${clamp(posForValue(entryPrice))}%`, width: "10px", height: "20px" }}
            title={`Entry ${entryPrice.toFixed(2)}`}
          >
            <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0" style={{ borderLeft: `2px solid ${ENTRY_COLOR}` }} />
            <span className="absolute left-1/2 -translate-x-1/2 -bottom-2.5 text-[0.5rem] font-bold tabular-nums leading-none whitespace-nowrap" style={{ color: ENTRY_COLOR }}>
              {Math.round(entryPrice)}
            </span>
          </div>
        )}

        {/* Footprint heatmap — dots darken where price lingered (single colour) */}
        {trailDots}

        {/* Live LTP triangle pointer + price label */}
        <div
          className="absolute -translate-x-1/2 pointer-events-auto cursor-help transition-[left] duration-300 ease-out"
          style={{ left: `${clamp(pointerPos)}%`, top: "-6px" }}
          title={`LTP ${pointerVal}`}
        >
          <span
            className="absolute left-1/2 -translate-x-1/2 -top-2.5 text-[0.5rem] font-bold tabular-nums leading-none whitespace-nowrap"
            style={{ color: POINTER_COLOR }}
          >
            {Math.round(pointerVal)}
          </span>
          <div
            className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[5px] border-l-transparent border-r-transparent"
            style={{ borderTopColor: POINTER_COLOR }}
          />
        </div>
      </div>

      {/* Strike-number labels below the bar (hidden in compact mode) */}
      {!compact && (
        <div className="relative w-full h-3 mt-0.5">
          {visible.map((strike, i) => (
            <span
              key={strike}
              className="absolute -translate-x-1/2 text-[0.5rem] font-bold tabular-nums leading-none transition-[left] duration-300 ease-out"
              style={{ left: `${clamp(posOfIndex(i), 4, 96)}%`, color: colorOf(moneyness(strike)) }}
            >
              {strike}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
