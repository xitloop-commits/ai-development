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
import type { OiLevel, OiSide, OiTrend } from "@/hooks/useOptionChainLevels";
import { formatOI, leanLabel } from "@/hooks/useOptionChainLevels";

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
  /** Option-chain OI levels (top CE/PE OI strikes) for the current expiry —
   *  drawn as two-sided OI marks on the strike axis (CE above, PE below). */
  oiLevels?: OiLevel[];
  /** Largest single-side OI across `oiLevels` — normalises stub height/opacity. */
  oiMax?: number;
  /** Max-pain strike to flag with a distinct marker. */
  maxPainStrike?: number | null;
  /** Fired when the user clicks the bar to place the trade-entry marker (price). */
  onPlaceEntry?: (price: number) => void;
  /** Fired once when the live LTP first touches the placed entry marker. */
  onEnterTrade?: (price: number) => void;
  /** Controlled placed entry price; if provided, click-to-place is parent-owned. */
  entryMarker?: number | null;
  /** Persistent entry markers — one per trade taken on this instrument (price =
   *  the strike/underlying where it entered). They stay on the bar across the
   *  trade's life; the bar never flips to a trade view. */
  tradeMarkers?: Array<{ price: number; isBuy: boolean }>;
  /** Strikes shown each side of centre (default 3 → 7 visible). */
  windowEachSide?: number;
  /** Compact mode (no strike-number labels) for tight table cells. */
  compact?: boolean;
  className?: string;
}

// ─── Tunables ───────────────────────────────────────────────────────────
const RANGE_EACH_SIDE = 30; // strikes generated each side of the anchor (rolling reserve)
const EDGE = 4; // % margin so edge ticks / pointer never clip

// ─── Colours (match TradeBar / TodayPnlBar palette) ─────────────────────
const ATM_COLOR = "#eab308"; // amber
const ITM_COLOR = "#22c55e"; // green
const OTM_COLOR = "#94a3b8"; // slate
const POINTER_COLOR = "#3b82f6"; // blue
const SUPPORT_COLOR = "#10b981"; // emerald — demand floor
const RESISTANCE_COLOR = "#ef4444"; // red — supply ceiling
const ENTRY_COLOR = "#2563eb"; // blue — trade-entry marker
const TRAIL_COLOR = "#2563eb"; // single colour for the dwell heatmap footprints

const AMBER = "#f59e0b"; // wall under pressure / weakening (buyer-driven / covering)
const NEUTRAL_GREY = "#9ca3af";
const MAXPAIN_COLOR = "#a855f7"; // violet

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// OI-marker helpers (shared by styles A and B).
// Solid horizontal arrows for the side-by-side OI bars: ▶ = OI increasing, ◀ = decreasing.
const trendArrow = (t: OiTrend) => (t === "up" ? "▶" : t === "down" ? "◀" : "");
const pctStr = (oi: number, change: number) =>
  oi > 0 ? `${change >= 0 ? "+" : ""}${((change / oi) * 100).toFixed(0)}%` : "";
/** Arrow colour encodes the buyer/seller lean: amber = wall under pressure /
 *  weakening; grey = quiet/flat; otherwise the side's own colour (holding). */
const leanArrowColor = (sideColor: string, side: OiSide): string =>
  side.lean === "buyer" || side.lean === "covering"
    ? AMBER
    : side.lean === "quiet" || side.lean === "flat"
      ? NEUTRAL_GREY
      : sideColor;
const sideTip = (label: string, s: OiSide) =>
  `${label} ${formatOI(s.oi)} ${trendArrow(s.trend)}${pctStr(s.oi, s.oiChange)} ${leanLabel(s.lean)}`;

/** Strength state of a side for the flying-balloon alert: 'up' = strengthening
 *  (writer-defended), 'down' = weakening (under pressure / unwinding), null = quiet. */
const strengthOf = (s: OiSide): "up" | "down" | null =>
  s.lean === "writer"
    ? "up"
    : s.lean === "buyer" || s.lean === "covering" || s.lean === "unwind"
      ? "down"
      : null;

interface SrBalloon {
  id: number;
  leftPct: number; // pops from the changed side's arrow
  color: string;
  dir: "up" | "down";
  delayMs: number; // stagger within the burst
  jitterPx: number; // small horizontal scatter so the stream looks organic
  size: number; // px
}

/**
 * Rolling window over the strike list. The window stays PUT while the pointer
 * travels across it; once the pointer comes within SCROLL_BUFFER strikes of an
 * edge it crawls ONE strike in that direction (introducing a single new strike),
 * keeping a strike of headroom so the pointer never clips the last strike.
 * Centres on first render.
 */
const SCROLL_BUFFER = 1; // crawl when the pointer is this many strikes from an edge

function getVisibleWindow(
  strikes: number[],
  ltp: number,
  visibleCount: number,
  prevStart: number | null,
): { start: number; end: number } {
  if (strikes.length <= visibleCount) return { start: 0, end: strikes.length };
  let current = strikes.findIndex((s) => s >= ltp);
  if (current === -1) current = strikes.length - 1;
  let start = prevStart ?? current - Math.floor(visibleCount / 2);
  if (prevStart !== null) {
    const pos = current - start; // pointer's index within the visible window
    const safeMin = SCROLL_BUFFER;
    const safeMax = visibleCount - 1 - SCROLL_BUFFER;
    if (pos < safeMin) start = current - safeMin; // nearing the left edge → crawl one in
    else if (pos > safeMax) start = current - safeMax; // nearing the right edge → crawl one in
  }
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
  oiLevels,
  oiMax = 0,
  maxPainStrike = null,
  onPlaceEntry,
  onEnterTrade,
  entryMarker,
  tradeMarkers = [],
  windowEachSide = 3,
  compact = false,
  className,
}: StrikeBarProps) {
  const step = strikeStep > 0 ? strikeStep : 1;
  // Live underlying LTP — drives the pointer, the rolling window, AND the ATM.
  const pointerVal = ltp ?? spot;
  const liveAtm = Math.round(pointerVal / step) * step;
  const visibleCount = windowEachSide * 2 + 1;

  const prevStartRef = useRef<number | null>(null);

  // The strike LIST must be anchored to a STABLE reference so the window can
  // actually roll as the live pointer moves. Callers often pass spot === ltp
  // (the live tick), so anchoring to spot would re-centre the whole list under
  // the pointer on every tick — the pointer would never reach an edge and the
  // window would never roll. (It only "works" in Storybook because there spot is
  // fixed while ltp is dragged.) So capture the anchor once and re-anchor only
  // when the pointer nears the edge of the generated reserve.
  const anchorRef = useRef<number | null>(null);
  if (anchorRef.current === null) anchorRef.current = atmStrike ?? Math.round(spot / step) * step;
  const reserveSpan = (RANGE_EACH_SIDE - 3) * step; // keep a few strikes of reserve
  if (pointerVal > 0 && Math.abs(pointerVal - anchorRef.current) > reserveSpan) {
    anchorRef.current = Math.round(pointerVal / step) * step;
    prevStartRef.current = null; // re-centre the window on the fresh list
  }
  const listAnchor = anchorRef.current;

  const strikes = useMemo(() => {
    const arr: number[] = [];
    for (let i = -RANGE_EACH_SIDE; i <= RANGE_EACH_SIDE; i++) arr.push(listAnchor + i * step);
    return arr;
  }, [listAnchor, step]);

  // Window rolls to follow the live LTP — stays put until the pointer reaches the
  // last visible strike, then rolls one strike at a time.
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

  // ── Flying-balloon S/R alerts ─────────────────────────────────────────────
  // When a strike's lean flips to strengthening (writer-defended) or weakening
  // (under pressure / unwinding), pop a balloon that floats up (strengthening) or
  // down (weakening) and fades. Fires only on a STATE CHANGE (not every refresh).
  const [srBalloons, setSrBalloons] = useState<SrBalloon[]>([]);
  const srBalloonIdRef = useRef(0);
  const srPrevStrengthRef = useRef<Map<string, "up" | "down" | null>>(new Map());
  const srPosRef = useRef<Map<string, number>>(new Map()); // strike → leftPct (set in render)
  const srInitRef = useRef(false);
  // Signature of every level's per-side strength — the effect only runs when it changes.
  const srSig = (oiLevels ?? [])
    .map((l) => `${l.strike}:${strengthOf(l.call) ?? "-"}:${strengthOf(l.put) ?? "-"}`)
    .join("|");
  useEffect(() => {
    const prev = srPrevStrengthRef.current;
    const levels = oiLevels ?? [];
    // First run: seed the baseline so we don't flood balloons on initial load.
    if (!srInitRef.current) {
      srInitRef.current = true;
      for (const l of levels) {
        prev.set(`${l.strike}:CE`, strengthOf(l.call));
        prev.set(`${l.strike}:PE`, strengthOf(l.put));
      }
      return;
    }
    // Each side that flips emits a BURST of small balloons that keep popping from
    // that arrow for a few seconds (staggered + jittered) so it reads as an active
    // strengthening/weakening condition rather than a single blip.
    const BURST = 12; // balloons per change
    const STAGGER_MS = 400; // gap between balloons in a burst (stream lasts a few seconds)
    const adds: SrBalloon[] = [];
    for (const l of levels) {
      for (const side of ["CE", "PE"] as const) {
        const key = `${l.strike}:${side}`;
        const cur = strengthOf(side === "CE" ? l.call : l.put);
        if (cur === (prev.get(key) ?? null)) continue;
        prev.set(key, cur);
        const leftPct = srPosRef.current.get(key); // the changed side's arrow x
        if (!cur || leftPct == null) continue; // skip quiet/flat + off-window strikes
        // Colour = the wall's side (matches the bars): red = resistance (CE),
        // green = support (PE). Direction (into/out) already shows strengthen/weaken.
        const color = side === "CE" ? RESISTANCE_COLOR : SUPPORT_COLOR;
        for (let k = 0; k < BURST; k++) {
          adds.push({
            id: ++srBalloonIdRef.current,
            leftPct,
            color,
            dir: cur,
            delayMs: k * STAGGER_MS,
            jitterPx: Math.round((Math.random() - 0.5) * 10), // ±5px scatter
            size: 3 + Math.round(Math.random() * 3), // 3–6px
          });
        }
      }
    }
    if (adds.length > 0) {
      setSrBalloons((b) => [...b, ...adds].slice(-90)); // cap total in-flight
      const ids = new Set(adds.map((a) => a.id));
      // Burst lifetime = last stagger + one animation (3s) + buffer.
      const ttl = (BURST - 1) * STAGGER_MS + 3000 + 300;
      setTimeout(() => setSrBalloons((b) => b.filter((x) => !ids.has(x.id))), ttl);
    }
  }, [srSig, oiLevels]);

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

  // Option-chain OI levels for the visible window.
  const oiActive = !!(oiLevels && oiLevels.length > 0);
  const oiNorm = oiMax > 0 ? oiMax : 1;
  const oiVisible = oiActive ? oiLevels!.filter((l) => l.strike >= lo && l.strike <= hi) : [];
  // Horizontal OI bars grow side-by-side from each strike line; cap each side to
  // ~42% of the inter-strike spacing so a bar never reaches the next strike.
  const oiStepPct = total > 1 ? Math.abs(posOfIndex(1) - posOfIndex(0)) : 10;
  const oiMaxLen = 0.42 * oiStepPct;
  // Feed the balloon effect each visible CE/PE arrow's x-position (it reads this
  // ref) so a balloon pops from the exact arrow that changed.
  srPosRef.current = new Map(
    oiVisible.flatMap((l) => {
      const at = clamp(posForValue(l.strike));
      const ceLen = (l.call.oi / oiNorm) * oiMaxLen;
      const peLen = (l.put.oi / oiNorm) * oiMaxLen;
      return [
        [`${l.strike}:CE`, clamp(at + ceLen)] as [string, number],
        [`${l.strike}:PE`, clamp(at - peLen)] as [string, number],
      ];
    }),
  );

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
        style={{ left: `${at}%`, width: "12px", height: "20px" }}
        title={`${strike} · ${m}`}
      >
        <div
          style={{
            width: "1px",
            height: isAtm ? "16px" : "13px",
            backgroundColor: colorOf(m),
            borderRadius: "1px",
            opacity: isAtm ? 1 : 0.7,
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

        {/* Option-chain OI marks, merged onto the strike axis: CE bar up / PE bar
            down from the track centre, sized + opacity by OI; ▲/▼ = OI building/
            unwinding, arrow colour = buyer/seller lean; MP = max-pain. Tooltip
            carries the full CE/PE numbers. */}
        {oiVisible.map((lvl) => {
          const at = clamp(posForValue(lvl.strike));
          const ceLen = (lvl.call.oi / oiNorm) * oiMaxLen; // grows RIGHT from the strike line
          const peLen = (lvl.put.oi / oiNorm) * oiMaxLen; // grows LEFT from the strike line
          const tip = `${lvl.strike} · CE ${sideTip("OI", lvl.call)} · PE ${sideTip("OI", lvl.put)}`;
          return (
            <div key={`oi-${lvl.strike}`} className="absolute inset-0 pointer-events-none z-[1]">
              {/* PE (support, green) — fills the track height, grows LEFT from the strike line.
                  OI magnitude is shown by length; single solid green. */}
              <div className="absolute pointer-events-auto cursor-help" style={{ top: "1px", bottom: "1px", left: `${at - peLen}%`, width: `${peLen}%`, background: SUPPORT_COLOR, opacity: 0.6 }} title={tip} />
              {lvl.put.trend !== "flat" && (
                <span className="absolute inset-y-0 flex items-center leading-none" style={{ left: `${at - peLen}%`, transform: "translateX(calc(-50% - 4px))", fontSize: "7px", color: leanArrowColor(SUPPORT_COLOR, lvl.put) }}>
                  {trendArrow(lvl.put.trend)}
                </span>
              )}
              {/* CE (resistance, red) — fills the track height, grows RIGHT from the strike line. */}
              <div className="absolute pointer-events-auto cursor-help" style={{ top: "1px", bottom: "1px", left: `${at}%`, width: `${ceLen}%`, background: RESISTANCE_COLOR, opacity: 0.6 }} title={tip} />
              {lvl.call.trend !== "flat" && (
                <span className="absolute inset-y-0 flex items-center leading-none" style={{ left: `${at + ceLen}%`, transform: "translateX(calc(-50% + 4px))", fontSize: "7px", color: leanArrowColor(RESISTANCE_COLOR, lvl.call) }}>
                  {trendArrow(lvl.call.trend)}
                </span>
              )}
            </div>
          );
        })}
        {oiActive && maxPainStrike != null && maxPainStrike >= lo && maxPainStrike <= hi && (
          <div
            className="absolute -translate-x-1/2 pointer-events-auto cursor-help z-[1]"
            style={{ left: `${clamp(posForValue(maxPainStrike))}%`, bottom: "calc(100% + 2px)" }}
            title={`Max pain ${maxPainStrike}`}
          >
            <span className="font-bold leading-none" style={{ fontSize: "8px", color: MAXPAIN_COLOR }}>MP</span>
          </div>
        )}

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

        {/* Persistent entry markers — one per trade taken; stays put across its
            life (green up-triangle = BUY, red = SELL), below the track. */}
        {tradeMarkers.map((m, i) => {
          if (m.price < lo || m.price > hi) return null;
          return (
            <div
              key={`tm-${i}-${m.price}`}
              className="absolute -translate-x-1/2 pointer-events-auto cursor-help"
              style={{ left: `${clamp(posForValue(m.price))}%`, bottom: "-7px" }}
              title={`${m.isBuy ? "BUY" : "SELL"} entry @ ${m.price}`}
            >
              <div
                className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[5px] border-l-transparent border-r-transparent"
                style={{ borderBottomColor: m.isBuy ? ITM_COLOR : RESISTANCE_COLOR }}
              />
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

        {/* Live LTP triangle pointer + price label — z above the OI bars. */}
        <div
          className="absolute -translate-x-1/2 pointer-events-auto cursor-help transition-[left] duration-300 ease-out z-[6]"
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

        {/* Flying-balloon S/R alerts — a staggered stream of small balloons bursts
            from the changed CE/PE arrow: up + green = strengthening, down + red =
            weakening. Read meaning from origin (which arrow) + direction + colour. */}
        {srBalloons.map((b) => (
          <div
            key={b.id}
            className={`absolute rounded-full pointer-events-none z-[7] ${b.dir === "up" ? "animate-sr-balloon-up" : "animate-sr-balloon-down"}`}
            style={{
              left: `calc(${b.leftPct}% + ${b.jitterPx}px)`,
              top: "50%", // arrow centre — keyframe centres the balloon on it
              width: `${b.size}px`,
              height: `${b.size}px`,
              background: b.color,
              animationDelay: `${b.delayMs}ms`,
              boxShadow: `0 0 3px ${b.color}`,
            }}
          />
        ))}
      </div>

      {/* Strike-number labels below the bar (hidden in compact mode). z above the
          OI bars so the prices stay readable where PE bars overlap them. */}
      {!compact && (
        <div className="relative w-full h-3 mt-0.5 z-[5]">
          {visible.map((strike, i) => {
            // Dim every strike label except the current spot (ATM) strike so the
            // live strike stands out.
            const isAtm = strike === liveAtm;
            return (
              <span
                key={strike}
                className={`absolute -translate-x-1/2 text-[0.5rem] tabular-nums leading-none transition-[left] duration-300 ease-out ${isAtm ? "font-bold" : "font-normal"}`}
                style={{ left: `${clamp(posOfIndex(i), 4, 96)}%`, color: colorOf(moneyness(strike)), opacity: isAtm ? 1 : 0.4 }}
              >
                {strike}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
