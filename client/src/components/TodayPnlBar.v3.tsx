/**
 * TodayPnlBar v3 — Rolling window marker system (Fixed range version)
 *
 * Design: Fixed comprehensive marker range with symmetric rolling window
 *
 * Marker zones with increments:
 * - Extended Loss (below lossCap): 1% increments (lossCap - 50% to lossCap - 1%)
 * - Loss (L→T):  1% increments   (-2% to +5%)
 * - Gift G1 (T→G1): 2% increments (+5% to +10%)
 * - Gift G2 (G1→G2): 3% increments (+10% to +25%)
 * - Gift G3 (G2→G3): 4% increments (+25% to +50%)
 * - King (G3→end): 5% increments (+50% to giftMax + 200%)
 *
 * Rolling window: Always shows N markers (default 15), with 2-marker buffers on both sides.
 * Window scrolls left when indicator approaches left edge, right when approaching right edge.
 */

import { memo, useMemo, useRef } from "react";
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
  zone: "heavyLoss" | "bigLoss" | "loss" | "profit" | "bigProfit" | "superProfit" | "superDuperProfit" | "jockbot";
  label: string;
}

/**
 * Generate all markers for fixed comprehensive range with new zone boundaries.
 * Zones: < -10% (heavyLoss), -10% to -2% (bigLoss), -2% to 0% (loss),
 * 0% to 5% (profit), 5% to 10% (bigProfit), 10% to 25% (superProfit),
 * 25% to 50% (superDuperProfit), > 50% (jockbot)
 */
function generateAllMarkers(cfg: BarConfig): Marker[] {
  const markers: Marker[] = [];

  // Heavy loss zone: < -10% (1% increments)
  for (let pct = -100; pct < -10; pct += 1) {
    markers.push({
      pct,
      zone: "heavyLoss",
      label: `${pct}%`,
    });
  }

  // Big loss zone: -10% to -2% (1% increments)
  for (let pct = -10; pct < -2; pct += 1) {
    markers.push({
      pct,
      zone: "bigLoss",
      label: `${pct}%`,
    });
  }

  // Loss zone: -2% to 0% (1% increments)
  for (let pct = -2; pct <= 0; pct += 1) {
    markers.push({
      pct,
      zone: "loss",
      label: `${pct}%`,
    });
  }

  // Profit zone: 0% to 5% (1% increments)
  for (let pct = 1; pct <= 5; pct += 1) {
    markers.push({
      pct,
      zone: "profit",
      label: `${pct}%`,
    });
  }

  // Big profit zone: 5% to 10% (1% increments)
  for (let pct = 6; pct <= 10; pct += 1) {
    markers.push({
      pct,
      zone: "bigProfit",
      label: `${pct}%`,
    });
  }

  // Super profit zone: 10% to 25% (1% increments)
  for (let pct = 11; pct <= 25; pct += 1) {
    markers.push({
      pct,
      zone: "superProfit",
      label: `${pct}%`,
    });
  }

  // Super duper profit zone: 25% to 50% (1% increments)
  for (let pct = 26; pct <= 50; pct += 1) {
    markers.push({
      pct,
      zone: "superDuperProfit",
      label: `${pct}%`,
    });
  }

  // Jockbot zone: > 50% (2% increments)
  for (let pct = 52; pct <= cfg.giftMax + 200; pct += 2) {
    markers.push({
      pct,
      zone: "jockbot",
      label: `${pct}%`,
    });
  }

  return markers;
}

/**
 * Select visible markers from rolling window.
 * Window stays fixed, scrolls only when indicator within 2 markers of edge.
 * Uses previous window position to avoid scrolling on every P&L change.
 */
function getVisibleMarkerIndices(
  allMarkers: Marker[],
  currentPct: number,
  visibleCount: number,
  prevStartIdx: number | null
): { start: number; end: number } {
  if (allMarkers.length <= visibleCount) {
    return { start: 0, end: allMarkers.length };
  }

  // Find current marker index closest to or >= currentPct
  let currentIndex = allMarkers.findIndex((m) => m.pct >= currentPct);
  if (currentIndex === -1) {
    currentIndex = allMarkers.length - 1;
  }

  const buffer = 2;  // Scroll only when 2 markers left to boundary
  const safeZoneMin = buffer;  // Min position in window (2 from left edge)
  const safeZoneMax = visibleCount - 1 - buffer;  // Max position in window (2 from right edge)

  // Start with previous window position (sticky behavior)
  let startIdx = prevStartIdx ?? 0;

  // Check if indicator is currently visible and in safe zone
  const indicatorPos = currentIndex - startIdx;

  // If indicator is off-screen, initialize window to center it
  if (indicatorPos < 0 || indicatorPos >= visibleCount) {
    const centerPosition = Math.floor(visibleCount / 2);
    startIdx = Math.max(0, currentIndex - centerPosition);
  }
  // If indicator violates left boundary (too close to left edge), scroll left
  else if (indicatorPos < safeZoneMin) {
    startIdx = currentIndex - safeZoneMin;
  }
  // If indicator violates right boundary (too close to right edge), scroll right
  else if (indicatorPos > safeZoneMax) {
    startIdx = currentIndex - safeZoneMax;
  }
  // Otherwise, keep window stable (don't change startIdx)

  // Clamp to valid range
  startIdx = Math.max(0, Math.min(startIdx, allMarkers.length - visibleCount));

  let endIdx = startIdx + visibleCount;

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
  const barRightEdge = cfg.giftMax + 200;  // Fixed right boundary matching generateAllMarkers
  const kingMax = cfg.giftMax + 200;       // For accessibility (aria-valuemax)

  // Track previous window start index for sticky behavior
  const prevStartIdxRef = useRef<number | null>(null);

  // Generate all markers once (stable list, no currentPct dependency)
  const allMarkers = useMemo(
    () => generateAllMarkers(cfg),
    [cfg]
  );

  const visibleRange = useMemo(() => {
    const result = getVisibleMarkerIndices(
      allMarkers,
      currentPct,
      visibleMarkers,
      prevStartIdxRef.current
    );
    // Update ref with current window position for next render
    prevStartIdxRef.current = result.start;
    return result;
  }, [allMarkers, currentPct, visibleMarkers]);

  const isMarkerVisible = (index: number) => {
    return index >= visibleRange.start && index < visibleRange.end;
  };

  // Position markers evenly across the visible window with margins
  const getMarkerBarPosition = (index: number): number => {
    if (index < visibleRange.start || index >= visibleRange.end) {
      return -1; // Not visible
    }

    const positionInWindow = index - visibleRange.start;
    const totalVisible = visibleRange.end - visibleRange.start;

    // Evenly distribute visible markers across the bar with 1.25% margins on each side
    const marginPercent = 1.25;
    if (totalVisible <= 1) return 50;
    return (positionInWindow / (totalVisible - 1)) * (100 - 2 * marginPercent) + marginPercent;
  };

  // Get bar position for any P&L value within the visible window (using even distribution with margins)
  const getBarPositionForPct = (pct: number): number => {
    const totalVisible = visibleRange.end - visibleRange.start;
    if (totalVisible <= 0) return 50;

    const marginPercent = 1.25;  // Match the margin in getMarkerBarPosition

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
      return (positionInWindow / (totalVisible - 1)) * (100 - 2 * marginPercent) + marginPercent;
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

    return Math.max(0, Math.min(100, position * (100 - 2 * marginPercent) + marginPercent));
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
      <div className="relative w-full h-4 mb-0.5">
        {/* All marker labels - visible ones emphasized */}
        {allMarkers.map((marker, idx) => {
          const isVisible = isMarkerVisible(idx);
          const barPos = getMarkerBarPosition(idx);

          // Color by zone - gradient from light to dark, black for zero
          const getLabelColor = () => {
            if (marker.pct === 0) return "#000000";  // black for zero
            switch (marker.zone) {
              case "heavyLoss":
                return "#7f1d1d";  // dark red
              case "bigLoss":
                return "#dc2626";  // medium red
              case "loss":
                return "#fca5a5";  // light red
              case "profit":
                return "#86efac";  // light green
              case "bigProfit":
                return "#4ade80";  // medium green
              case "superProfit":
                return "#22c55e";  // darker green
              case "superDuperProfit":
                return "#16a34a";  // very dark green
              case "jockbot":
                return "#eab308";  // bright yellow
              default:
                return "currentColor";
            }
          };

          return isVisible ? (
            <span
              key={`val-${marker.pct}`}
              className="absolute text-[0.625rem] font-bold tabular-nums -translate-x-1/2 transition-opacity duration-300 opacity-100"
              style={{
                left: `${barPos}%`,
                color: getLabelColor(),
              }}
            >
              {formatINR((tradingPool * marker.pct) / 100)}
            </span>
          ) : null;
        })}
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

        {/* Fill bar: from 0% P&L to indicator (gradient by zone) */}
        {(() => {
          const zeroPos = getBarPositionForPct(0);

          let fillStart: number;
          let fillWidth: number;
          let backgroundColor: string;

          // Determine color based on current P&L zone
          const getGradientColor = () => {
            if (currentPct > 0) {
              if (currentPct <= 5) return "rgba(134, 239, 172, 0.6)";  // light green
              if (currentPct <= 10) return "rgba(74, 222, 128, 0.6)";   // medium green
              if (currentPct <= 25) return "rgba(34, 197, 94, 0.6)";    // darker green
              if (currentPct <= 50) return "rgba(22, 163, 74, 0.7)";    // very dark green
              return "rgba(234, 179, 8, 0.7)";                          // bright yellow (jockbot)
            } else {
              if (currentPct >= -2) return "rgba(252, 165, 165, 0.6)";  // light red
              if (currentPct >= -10) return "rgba(220, 38, 38, 0.7)";   // medium red
              return "rgba(127, 29, 29, 0.8)";                          // dark red
            }
          };

          if (currentPct > 0) {
            // Positive P&L: fill extends RIGHT from 0% to indicator
            fillStart = zeroPos;
            fillWidth = markerLeft - zeroPos;
            backgroundColor = getGradientColor();
          } else if (currentPct < 0) {
            // Negative P&L: fill extends LEFT from indicator to 0%
            fillStart = markerLeft;
            fillWidth = zeroPos - markerLeft;
            backgroundColor = getGradientColor();
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

        {/* All marker ticks - colored by zone */}
        {allMarkers.map((marker, idx) => {
          const isVisible = isMarkerVisible(idx);
          const barPos = getMarkerBarPosition(idx);

          // Color based on zone - gradient from light to dark, black for zero
          const getMarkerColor = () => {
            if (marker.pct === 0) {
              return isVisible ? "#000000" : "#00000040";  // black for zero
            }
            switch (marker.zone) {
              case "heavyLoss":
                return isVisible ? "#7f1d1d" : "#7f1d1d40";
              case "bigLoss":
                return isVisible ? "#dc2626" : "#dc262640";
              case "loss":
                return isVisible ? "#fca5a5" : "#fca5a540";
              case "profit":
                return isVisible ? "#86efac" : "#86efac40";
              case "bigProfit":
                return isVisible ? "#4ade80" : "#4ade8040";
              case "superProfit":
                return isVisible ? "#22c55e" : "#22c55e40";
              case "superDuperProfit":
                return isVisible ? "#16a34a" : "#16a34a40";
              case "jockbot":
                return isVisible ? "#eab308" : "#eab30840";
              default:
                return "#9ca3af";
            }
          };

          return (
            <div
              key={`tick-${marker.pct}`}
              className="absolute top-1/2 -translate-y-1/2 w-px transition-all duration-300"
              style={{
                left: `${barPos}%`,
                height: "10px",
                backgroundColor: getMarkerColor(),
              }}
            />
          );
        })}

        {/* Current marker line */}
        <div
          className={`absolute -top-3 bottom-0 w-0.5 z-3 transition-[left] duration-500 ${
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

          // Color by zone - same gradient as value labels, black for zero
          const getPercentColor = () => {
            if (marker.pct === 0) return "#000000";  // black for zero
            switch (marker.zone) {
              case "heavyLoss":
                return "#7f1d1d";  // dark red
              case "bigLoss":
                return "#dc2626";  // medium red
              case "loss":
                return "#fca5a5";  // light red
              case "profit":
                return "#86efac";  // light green
              case "bigProfit":
                return "#4ade80";  // medium green
              case "superProfit":
                return "#22c55e";  // darker green
              case "superDuperProfit":
                return "#16a34a";  // very dark green
              case "jockbot":
                return "#eab308";  // bright yellow
              default:
                return "currentColor";
            }
          };

          return isVisible ? (
            <span
              key={`pct-${marker.pct}`}
              className="absolute text-[0.4375rem] font-bold tabular-nums -translate-x-1/2 transition-opacity duration-300 opacity-100"
              style={{
                left: `${barPos}%`,
                color: getPercentColor(),
              }}
            >
              {marker.pct >= 0 ? "+" : ""}
              {marker.pct}%
            </span>
          ) : null;
        })}

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
