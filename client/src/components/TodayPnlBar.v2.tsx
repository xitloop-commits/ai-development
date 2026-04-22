/**
 * TodayPnlBar v2 — Rolling window marker system
 *
 * Design: Zone-based markers with dynamic rolling window
 *
 * Marker zones with increments:
 * - Loss (L→T):  1% increments   (-2% to +5%)
 * - Gift G1 (T→G1): 2% increments (+5% to +10%)
 * - Gift G2 (G1→G2): 3% increments (+10% to +25%)
 * - Gift G3 (G2→G3): 4% increments (+25% to +50%)
 * - King (G3→end): 5% increments (+50% to currentPnL+20%)
 *
 * Rolling window: Always shows N markers (default 15), auto-positioned around current P&L.
 * User cannot scroll; window follows the P&L.
 */

import { memo, useMemo } from "react";
import { formatINR } from "@/lib/formatINR";

// ─── Config ───────────────────────────────────────────────────────────

export interface BarConfig {
  lossCap: number;
  circuitBreaker?: number;
  target: number;
  giftMax: number;
  partialExits?: Array<{ percent: number; closePct: number; label?: string }>;
  sessionHalted?: boolean;
}

export const DEFAULT_BAR_CONFIG: BarConfig = {
  lossCap: -2,
  circuitBreaker: -3,
  target: 5,
  giftMax: 50,
  partialExits: [],
  sessionHalted: false,
};

// ─── Props ────────────────────────────────────────────────────────────

interface TodayPnlBarProps {
  pnl: number;
  tradingPool: number;
  config?: BarConfig;
  exitAllEnabled?: boolean;
  openTradeCount: number;
  onExitAll?: () => void;
  visibleMarkers?: number;
}

// ─── Marker Generation (Pure Functions) ────────────────────────────────

interface Marker {
  pct: number;
  zone: "loss" | "g1" | "g2" | "g3" | "king";
  label: string;
}

/**
 * Generate all markers from loss cap to king zone end.
 * Uses zone-based increments:
 * - Loss (L→T): 1%
 * - G1 (T→G1): 2%
 * - G2 (G1→G2): 3%
 * - G3 (G2→G3): 4%
 * - King (G3+): 5%
 */
function generateAllMarkers(cfg: BarConfig, currentPct: number): Marker[] {
  const markers: Marker[] = [];
  const kingMax = currentPct + 20;

  // Loss zone: 1% increments from lossCap to target
  for (let pct = cfg.lossCap; pct <= cfg.target; pct += 1) {
    markers.push({
      pct,
      zone: "loss",
      label: `${pct}%`,
    });
  }

  // G1 zone: 2% increments from target to 10%
  for (let pct = cfg.target + 2; pct <= 10; pct += 2) {
    markers.push({
      pct,
      zone: "g1",
      label: `${pct}%`,
    });
  }

  // G2 zone: 3% increments from 10% to 25%
  for (let pct = 10 + 3; pct <= 25; pct += 3) {
    markers.push({
      pct,
      zone: "g2",
      label: `${pct}%`,
    });
  }

  // G3 zone: 4% increments from 25% to 50%
  for (let pct = 25 + 4; pct <= 50; pct += 4) {
    markers.push({
      pct,
      zone: "g3",
      label: `${pct}%`,
    });
  }

  // King zone: 5% increments from 50% to kingMax
  for (let pct = 50 + 5; pct <= kingMax; pct += 5) {
    markers.push({
      pct,
      zone: "king",
      label: `${pct}%`,
    });
  }

  return markers;
}

/**
 * Select visible markers from rolling window.
 * Window stays fixed until indicator approaches right edge (2 markers buffer).
 * Scrolls step-by-step keeping indicator with 2 markers visible to the right.
 */
function getVisibleMarkerIndices(
  allMarkers: Marker[],
  currentPct: number,
  visibleCount: number
): { start: number; end: number } {
  if (allMarkers.length <= visibleCount) {
    return { start: 0, end: allMarkers.length };
  }

  // Find current marker index closest to or >= currentPct
  let currentIndex = allMarkers.findIndex((m) => m.pct >= currentPct);
  if (currentIndex === -1) {
    currentIndex = allMarkers.length - 1;
  }

  // Keep indicator with 2 markers buffer on the right
  // When indicator reaches position where only 2 markers remain, start scrolling
  const rightBuffer = 2;  // Keep 2 markers visible to the right of indicator
  let startIdx = Math.max(0, currentIndex - (visibleCount - 1 - rightBuffer));

  let endIdx = startIdx + visibleCount;

  // Clamp to array bounds
  if (endIdx > allMarkers.length) {
    endIdx = allMarkers.length;
    startIdx = Math.max(0, endIdx - visibleCount);
  }

  return { start: startIdx, end: endIdx };
}

/**
 * Map P&L % to bar position (0-100).
 * Linear scaling from leftEdge to rightEdge.
 */
function pctToBar(
  pct: number,
  leftEdge: number,
  target: number,
  rightEdge: number
): number {
  const span = rightEdge - leftEdge;
  if (span <= 0) return 0;
  const clamped = Math.max(leftEdge, Math.min(rightEdge, pct));
  return ((clamped - leftEdge) / span) * 100;
}

// ─── Component ────────────────────────────────────────────────────────

function _TodayPnlBar({
  pnl,
  tradingPool,
  config,
  exitAllEnabled = false,
  openTradeCount,
  onExitAll,
  visibleMarkers = 15,
}: TodayPnlBarProps) {
  const cfg = config ?? DEFAULT_BAR_CONFIG;
  const currentPct = tradingPool > 0 ? (pnl / tradingPool) * 100 : 0;
  const leftEdge = cfg.circuitBreaker ?? cfg.lossCap;
  const barRightEdge = Math.max(cfg.giftMax, currentPct + 20);
  const kingMax = currentPct + 20;

  // Generate all markers and calculate visible range
  const allMarkers = useMemo(
    () => generateAllMarkers(cfg, currentPct),
    [cfg, currentPct]
  );

  const visibleRange = useMemo(
    () => getVisibleMarkerIndices(allMarkers, currentPct, visibleMarkers),
    [allMarkers, currentPct, visibleMarkers]
  );

  const isMarkerVisible = (index: number) => {
    return index >= visibleRange.start && index < visibleRange.end;
  };

  // Position markers evenly across the visible window
  const getMarkerBarPosition = (index: number): number => {
    if (index < visibleRange.start || index >= visibleRange.end) {
      return -1; // Not visible
    }

    const positionInWindow = index - visibleRange.start;
    const totalVisible = visibleRange.end - visibleRange.start;

    // Evenly distribute visible markers across the bar (0% to 100%)
    if (totalVisible <= 1) return 50;
    return (positionInWindow / (totalVisible - 1)) * 100;
  };

  // Get bar position for any P&L value within the visible window (using even distribution)
  const getBarPositionForPct = (pct: number): number => {
    const totalVisible = visibleRange.end - visibleRange.start;
    if (totalVisible <= 0) return 50;

    // Find which visible marker pct aligns with or falls between
    let markerIndex = -1;
    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      if (allMarkers[i].pct === pct) {
        markerIndex = i;
        break;
      }
    }

    // If exact match, position at that marker
    if (markerIndex !== -1) {
      const positionInWindow = markerIndex - visibleRange.start;
      return (positionInWindow / (totalVisible - 1)) * 100;
    }

    // Otherwise interpolate between surrounding markers
    let lowerIndex = visibleRange.start;
    let upperIndex = visibleRange.end - 1;

    for (let i = visibleRange.start; i < visibleRange.end - 1; i++) {
      if (allMarkers[i].pct < pct && allMarkers[i + 1].pct > pct) {
        lowerIndex = i;
        upperIndex = i + 1;
        break;
      }
    }

    if (pct < allMarkers[visibleRange.start].pct) {
      lowerIndex = visibleRange.start;
      upperIndex = visibleRange.start;
    } else if (pct > allMarkers[visibleRange.end - 1].pct) {
      lowerIndex = visibleRange.end - 1;
      upperIndex = visibleRange.end - 1;
    }

    const lowerMarker = allMarkers[lowerIndex];
    const upperMarker = allMarkers[upperIndex];
    const markerRange = upperMarker.pct - lowerMarker.pct;

    let interpolationFactor = 0;
    if (markerRange > 0) {
      interpolationFactor = (pct - lowerMarker.pct) / markerRange;
    }

    const lowerPos = (lowerIndex - visibleRange.start) / (totalVisible - 1);
    const upperPos = (upperIndex - visibleRange.start) / (totalVisible - 1);
    const position = lowerPos + (upperPos - lowerPos) * interpolationFactor;

    return Math.max(0, Math.min(100, position * 100));
  };

  const markerLeft = getBarPositionForPct(currentPct);

  const markerIsPositive = currentPct > 0;
  const showExit = exitAllEnabled && openTradeCount > 0;

  return (
    <div
      className="relative px-3 py-1.5 flex flex-col justify-center w-full"
      style={
        {
          "--m": `${markerLeft}%`,
        } as React.CSSProperties
      }
      role="progressbar"
      aria-label="Today P&L progress"
      aria-valuenow={Math.round(currentPct * 10) / 10}
      aria-valuemin={leftEdge}
      aria-valuemax={kingMax}
    >
      {/* Session halted overlay */}
      {cfg.sessionHalted && (
        <div className="absolute inset-0 z-[5] flex items-center justify-center bg-destructive/10 backdrop-blur-[1px] border border-destructive/40 rounded pointer-events-none">
          <span className="text-[0.625rem] font-bold text-destructive tracking-widest uppercase">
            Session Halted
          </span>
        </div>
      )}

      {/* Top values row */}
      <div className="relative w-full h-3 mb-0.5">
        {/* All marker labels - visible ones emphasized */}
        {allMarkers.map((marker, idx) => {
          const isVisible = isMarkerVisible(idx);
          const barPos = getMarkerBarPosition(idx);
          return isVisible ? (
            <span
              key={`val-${marker.pct}`}
              className={`absolute text-[0.4375rem] font-bold tabular-nums -translate-x-1/2 transition-opacity duration-300 opacity-100 text-foreground`}
              style={{
                left: `${barPos}%`,
              }}
            >
              {formatINR((tradingPool * marker.pct) / 100)}
            </span>
          ) : null;
        })}

        {/* Current value at marker */}
        <span
          className="absolute text-[0.5rem] font-bold tabular-nums text-info-cyan -translate-x-1/2 whitespace-nowrap transition-[left] duration-500 z-10"
          style={{ left: "var(--m)", bottom: 0 }}
        >
          {currentPct >= 0 ? "+" : ""}
          {formatINR(pnl)}
        </span>
      </div>

      {/* The bar */}
      <div className="relative w-full h-1.5 rounded-full bg-muted-foreground/30">
        {/* Visible window background highlight */}
        {visibleRange.end > visibleRange.start && (
          <div
            className="absolute top-0 bottom-0 bg-primary/10 transition-all duration-500 rounded-full"
            style={{
              left: `0%`,
              right: `0%`,
            }}
          />
        )}

        {/* Fill bar: from 0% P&L to indicator (evenly distributed) */}
        {(() => {
          const zeroPos = getBarPositionForPct(0);

          let fillStart: number;
          let fillWidth: number;
          let backgroundColor: string;

          if (currentPct > 0) {
            // Positive P&L: fill extends RIGHT from 0% to indicator
            fillStart = zeroPos;
            fillWidth = markerLeft - zeroPos;
            backgroundColor = "rgb(34 197 94 / 0.6)";  // Green
          } else if (currentPct < 0) {
            // Negative P&L: fill extends LEFT from indicator to 0%
            fillStart = markerLeft;
            fillWidth = zeroPos - markerLeft;
            backgroundColor = "rgb(220 38 38 / 0.8)";  // Red
          } else {
            // Exactly 0: no fill bar
            return null;
          }

          if (fillWidth <= 0) return null;

          return (
            <div
              className={`absolute top-0 bottom-0 transition-[left,width] duration-500 ${
                markerIsPositive ? "rounded-r-full" : "rounded-l-full"
              }`}
              style={{
                left: `${fillStart}%`,
                width: `${Math.abs(fillWidth)}%`,
                background: backgroundColor,
              }}
            />
          );
        })()}

        {/* All marker ticks - colored by P&L zone, not marker zone */}
        {allMarkers.map((marker, idx) => {
          const isVisible = isMarkerVisible(idx);
          const barPos = getMarkerBarPosition(idx);

          // Color based on P&L value, not marker zone
          const getMarkerColor = () => {
            if (marker.pct < 0) {
              // Loss zone: red
              return isVisible ? "w-0.5 bg-destructive/80" : "w-px bg-destructive/20";
            } else if (marker.pct === 0) {
              // Neutral at 0%: gray
              return isVisible ? "w-0.5 bg-muted-foreground/70" : "w-px bg-muted-foreground/20";
            } else {
              // Profit zone: green
              return isVisible ? "w-0.5 bg-bullish/70" : "w-px bg-bullish/15";
            }
          };

          return (
            <div
              key={`tick-${marker.pct}`}
              className={`absolute top-0 bottom-0 transition-all duration-300 ${getMarkerColor()}`}
              style={{
                left: `${barPos}%`,
              }}
            />
          );
        })}

        {/* Current marker line */}
        <div
          className={`absolute top-[-3px] bottom-[-3px] w-0.5 z-[3] transition-[left] duration-500 ${
            markerIsPositive
              ? "bg-bullish shadow-[0_0_4px_oklch(0.7_0.15_120)]"
              : "bg-destructive shadow-[0_0_4px_oklch(0.65_0.18_20)]"
          }`}
          style={{ left: "var(--m)", marginLeft: "-1px" }}
        />

        {/* Marker triangle */}
        <div
          className="absolute z-[3] transition-[left] duration-500 -translate-x-1/2"
          style={{ left: "var(--m)", top: "-7px" }}
        >
          <div
            className={`w-0 h-0 border-l-[4px] border-r-[4px] border-t-[5px] border-l-transparent border-r-transparent ${
              markerIsPositive ? "border-t-bullish" : "border-t-destructive"
            }`}
          />
        </div>

        {/* Exit All button */}
        {showExit && (
          <button
            type="button"
            onClick={onExitAll}
            className="absolute z-[4] -translate-x-1/2 top-[-22px] px-1 py-0 text-[0.5625rem] font-bold leading-none rounded bg-destructive/20 text-destructive border border-destructive/50 hover:bg-destructive/35 transition-colors whitespace-nowrap"
            style={{ left: "var(--m)" }}
            title="Exit all open positions"
            aria-label="Exit all open positions"
          >
            × EXIT
          </button>
        )}
      </div>

      {/* Bottom percent row */}
      <div className="relative w-full h-3 mt-0.5">
        {/* All marker percent labels - visible ones emphasized */}
        {allMarkers.map((marker, idx) => {
          const isVisible = isMarkerVisible(idx);
          const barPos = getMarkerBarPosition(idx);
          return isVisible ? (
            <span
              key={`pct-${marker.pct}`}
              className={`absolute text-[0.4375rem] font-bold tabular-nums -translate-x-1/2 transition-opacity duration-300 opacity-100 text-foreground`}
              style={{
                left: `${barPos}%`,
              }}
            >
              {marker.pct >= 0 ? "+" : ""}
              {marker.pct}%
            </span>
          ) : null;
        })}

        {/* Current percent */}
        <span
          className="absolute text-[0.5rem] font-bold tabular-nums text-info-cyan -translate-x-1/2 whitespace-nowrap transition-[left] duration-500 z-10"
          style={{ left: "var(--m)", top: 0 }}
        >
          {currentPct >= 0 ? "+" : ""}
          {currentPct.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}

export const TodayPnlBar = memo(_TodayPnlBar, (prev, next) => {
  return (
    prev.pnl === next.pnl &&
    prev.tradingPool === next.tradingPool &&
    prev.config === next.config &&
    prev.exitAllEnabled === next.exitAllEnabled &&
    prev.openTradeCount === next.openTradeCount &&
    prev.onExitAll === next.onExitAll &&
    prev.visibleMarkers === next.visibleMarkers
  );
});
