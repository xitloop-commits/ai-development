/**
 * TodayPnlBar — Today's P&L progress bar with adaptive zoom.
 *
 * Design: Approach A "Focus follows you" (locked 2026-04-22)
 *
 *   - Anchors (always pinned):   loss-cap, zero, target. Dim when far from current.
 *   - Detail ticks (dynamic):    1% spacing inside a window around the current marker.
 *                                Window half-width grows with magnitude: 3/5/10%.
 *   - Milestones (round nums):   10, 25, 50, 75, 100, 150, 200 ... shown beyond
 *                                detail window and below right-edge.
 *   - Right edge auto-extends:   25% steps (50 → 75 → 100 → 150 ...).
 *   - Marker + Exit-All:         travel together along the bar.
 *   - Partial-exit markers:      rendered from `config.partialExits` (future DA wiring).
 *
 * Authoritative config: Discipline Agent. Shape declared as `BarConfig` below.
 * For MVP a static default is used; replace with a trpc.discipline.getBarConfig
 * query when Phase 1.4 (Module 8) lands.
 *
 * Performance contract:
 *   - `React.memo` with custom prop compare — only re-renders when layout inputs change.
 *   - Layout (ticks, anchors, milestones) is memoised on a COARSE bucket of current %
 *     so it rebuilds every ~3% of price movement, not every tick.
 *   - Marker position is applied via a CSS custom property `--m` so the browser can
 *     transform the marker + exit button without React re-creating DOM.
 *   - No inline style objects in the hot path; all hoisted or memoised.
 */
import { memo, useMemo } from "react";
import { formatINR } from "@/lib/formatINR";

// ─── Public config shape (will come from Discipline Agent) ────────────

export interface BarConfig {
  /** Negative number; daily loss cap enforced by Module 8. Default -2. */
  lossCap: number;
  /** Optional; legacy Module 1 circuit breaker. Default -3. */
  circuitBreaker?: number;
  /** Positive number; daily profit cap / target. Default +5. */
  target: number;
  /** Baseline right edge when in normal zone. Default +50. */
  giftMax: number;
  /** Future: per-DA partial-exit zones, e.g. {percent: 3, closePct: 50}. */
  partialExits?: Array<{ percent: number; closePct: number; label?: string }>;
  /** When true, overlay a "SESSION HALTED" state. */
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

// ─── Public props ─────────────────────────────────────────────────────

interface TodayPnlBarProps {
  /** Today's realized P&L in rupees. */
  pnl: number;
  /** Capital used as divisor for % calc. */
  tradingPool: number;
  /** Authoritative bar config (from DA). Falls back to defaults. */
  config?: BarConfig;
  /** True when user is allowed to exit trades in the current workspace. */
  exitAllEnabled?: boolean;
  /** Number of currently-open trades. Exit button hidden when 0. */
  openTradeCount: number;
  /** Callback when user clicks the Exit All button. */
  onExitAll?: () => void;
}

// ─── Internal: layout computation (pure, memoisable) ──────────────────

type BarColor = "destructive" | "foreground" | "warning" | "bullish" | "primary" | "info";

interface LayoutTick {
  pct: number;
  kind: "anchor" | "detail" | "milestone";
  label?: string;
  color: BarColor;
}

// Static Tailwind class lookup — dynamic interpolation is unreliable under JIT.
const TEXT_FULL: Record<BarColor, string> = {
  destructive: "text-destructive",
  foreground: "text-foreground",
  warning: "text-warning-amber",
  bullish: "text-bullish",
  primary: "text-primary",
  info: "text-info-cyan",
};
const TEXT_DIM: Record<BarColor, string> = {
  destructive: "text-destructive/60",
  foreground: "text-foreground/60",
  warning: "text-warning-amber/70",
  bullish: "text-bullish/70",
  primary: "text-primary/70",
  info: "text-info-cyan/60",
};
const BG_LINE: Record<BarColor, string> = {
  destructive: "bg-destructive/70",
  foreground: "bg-foreground/50",
  warning: "bg-warning-amber/70",
  bullish: "bg-bullish/70",
  primary: "bg-primary/40",
  info: "bg-info-cyan",
};
const BG_TICK: Record<BarColor, string> = {
  destructive: "bg-destructive/30",
  foreground: "bg-foreground/30",
  warning: "bg-warning-amber/30",
  bullish: "bg-bullish/30",
  primary: "bg-primary/30",
  info: "bg-info-cyan/30",
};

interface Layout {
  leftEdge: number;
  rightEdge: number;
  target: number;
  anchors: LayoutTick[];
  detailTicks: LayoutTick[];
  milestones: LayoutTick[];
  partialExits: Array<{ percent: number; closePct: number; label?: string }>;
}

/** Rounds up to next 25% step; baseline giftMax. */
function computeRightEdge(currentPct: number, giftMax: number): number {
  if (currentPct + 15 <= giftMax) return giftMax;
  return Math.ceil((currentPct + 15) / 25) * 25;
}

function detailHalfWidth(absPct: number): number {
  if (absPct < 10) return 3;
  if (absPct < 25) return 5;
  return 10;
}

function computeLayout(bucketedPct: number, cfg: BarConfig): Layout {
  const leftEdge = cfg.circuitBreaker ?? cfg.lossCap;
  const rightEdge = computeRightEdge(bucketedPct, cfg.giftMax);
  const half = detailHalfWidth(Math.abs(bucketedPct));
  const detailLo = Math.max(leftEdge, bucketedPct - half);
  const detailHi = Math.min(rightEdge, bucketedPct + half);

  // Anchors — always rendered, dimming handled at render time
  const anchors: LayoutTick[] = [
    { pct: cfg.lossCap, kind: "anchor", label: "LOSS", color: "destructive" },
    { pct: 0, kind: "anchor", label: "0", color: "foreground" },
    { pct: cfg.target, kind: "anchor", label: "CAP", color: "warning" },
  ];
  // Optional legacy circuit breaker (separate from Module 8 loss cap)
  if (cfg.circuitBreaker != null && cfg.circuitBreaker !== cfg.lossCap) {
    anchors.unshift({
      pct: cfg.circuitBreaker,
      kind: "anchor",
      label: "CB",
      color: "destructive",
    });
  }

  // Detail ticks — 1% spacing inside detail window, skip positions occupied by anchors
  const anchorPcts = new Set(anchors.map((a) => a.pct));
  const detailTicks: LayoutTick[] = [];
  const loRounded = Math.ceil(detailLo);
  const hiRounded = Math.floor(detailHi);
  for (let v = loRounded; v <= hiRounded; v++) {
    if (anchorPcts.has(v)) continue;
    detailTicks.push({
      pct: v,
      kind: "detail",
      color: v > 0 ? "bullish" : v < 0 ? "destructive" : "foreground",
    });
  }

  // Milestones — round numbers outside detail window, below right edge, > target.
  // Kept deliberately sparse to avoid visual crowding; +15 dropped because +10 / +25 bracket it.
  const candidateMilestones = [10, 25, 50, 75, 100, 150, 200];
  const milestones: LayoutTick[] = [];
  for (const m of candidateMilestones) {
    if (m <= cfg.target) continue;
    if (m > rightEdge) continue;
    if (m >= detailLo && m <= detailHi) continue; // already covered by detail window
    milestones.push({
      pct: m,
      kind: "milestone",
      color: "primary",
    });
  }

  return {
    leftEdge,
    rightEdge,
    target: cfg.target,
    anchors,
    detailTicks,
    milestones,
    partialExits: cfg.partialExits ?? [],
  };
}

/**
 * Piecewise map from raw % to 0..100 bar position.
 * Each zone gets a fixed proportion of the bar so the left/target/gift
 * regions stay readable regardless of how wide the overall range is:
 *   risk zone   (leftEdge  →  0     ): 0%   → 25% of bar
 *   target zone (0         →  target): 25%  → 60% of bar
 *   gift zone   (target    → right  ): 60%  → 100% of bar
 */
const RISK_END = 25;
const TARGET_END = 60;

function pctToBar(pct: number, leftEdge: number, target: number, rightEdge: number): number {
  if (pct <= 0) {
    const span = 0 - leftEdge;
    if (span <= 0) return 0;
    const clamped = Math.max(leftEdge, pct);
    return ((clamped - leftEdge) / span) * RISK_END;
  }
  if (pct <= target) {
    if (target <= 0) return RISK_END;
    return RISK_END + (pct / target) * (TARGET_END - RISK_END);
  }
  const giftSpan = rightEdge - target;
  if (giftSpan <= 0) return TARGET_END;
  const clamped = Math.min(rightEdge, pct);
  return TARGET_END + ((clamped - target) / giftSpan) * (100 - TARGET_END);
}

// ─── Component ────────────────────────────────────────────────────────

function _TodayPnlBar({
  pnl,
  tradingPool,
  config,
  exitAllEnabled = false,
  openTradeCount,
  onExitAll,
}: TodayPnlBarProps) {
  const cfg = config ?? DEFAULT_BAR_CONFIG;
  const currentPct = tradingPool > 0 ? (pnl / tradingPool) * 100 : 0;

  // Coarse bucket (~3% resolution) so layout rebuilds are rare.
  // Rebuilds only when currentPct crosses a 3% boundary.
  const bucketedPct = Math.round(currentPct / 3) * 3;

  const layout = useMemo(
    () => computeLayout(bucketedPct, cfg),
    [bucketedPct, cfg]
  );

  const markerLeft = pctToBar(currentPct, layout.leftEdge, layout.target, layout.rightEdge);
  const zeroLeft = pctToBar(0, layout.leftEdge, layout.target, layout.rightEdge);
  const signedAbs = currentPct >= 0;
  const fillLeft = signedAbs ? zeroLeft : markerLeft;
  const fillWidth = signedAbs ? markerLeft - zeroLeft : zeroLeft - markerLeft;

  const showExit = exitAllEnabled && openTradeCount > 0;
  const markerInDanger = currentPct <= cfg.lossCap + 0.3;
  const markerNearTarget = currentPct >= cfg.target - 0.3;
  // Collision handling: if the marker is on top of an anchor, suppress the
  // marker's value/percent overlay labels so they don't stack with the
  // anchor's own labels. Anchor labels win because they're stable.
  const markerOverlapsAnchor = layout.anchors.some(
    (a) => Math.abs(currentPct - a.pct) < 0.5
  );

  return (
    <div
      className="relative px-3 py-1.5 flex flex-col justify-center flex-1 min-w-[280px]"
      style={
        {
          "--m": `${markerLeft}%`,
          "--z": `${zeroLeft}%`,
        } as React.CSSProperties
      }
      role="progressbar"
      aria-label="Today P&L progress"
      aria-valuenow={Math.round(currentPct * 10) / 10}
      aria-valuemin={layout.leftEdge}
      aria-valuemax={layout.rightEdge}
    >
      {/* Session halted overlay */}
      {cfg.sessionHalted && (
        <div className="absolute inset-0 z-[5] flex items-center justify-center bg-destructive/10 backdrop-blur-[1px] border border-destructive/40 rounded pointer-events-none">
          <span className="text-[0.625rem] font-bold text-destructive tracking-widest uppercase">
            Session Halted
          </span>
        </div>
      )}

      {/* Top row: value labels above bar */}
      <div className="relative w-full h-3 mb-0.5">
        {/* Anchor value labels (pinned) */}
        {layout.anchors.map((a) => {
          const inDetail = a.pct >= bucketedPct - detailHalfWidth(Math.abs(bucketedPct))
            && a.pct <= bucketedPct + detailHalfWidth(Math.abs(bucketedPct));
          return (
            <span
              key={`av${a.pct}`}
              className={`absolute text-[0.4375rem] font-bold tabular-nums -translate-x-1/2 ${TEXT_FULL[a.color]} ${inDetail ? "" : "opacity-40"}`}
              style={{ left: `${pctToBar(a.pct, layout.leftEdge, layout.target, layout.rightEdge)}%` }}
            >
              {formatINR((tradingPool * a.pct) / 100)}
            </span>
          );
        })}

        {/* Detail ticks intentionally omit value labels (top row). Their
            percent label remains in the bottom row below. This is the single
            biggest visual-density win for the bar. */}

        {/* Milestone value labels */}
        {layout.milestones.map((m) => (
          <span
            key={`mv${m.pct}`}
            className="absolute text-[0.4375rem] font-bold tabular-nums text-primary/70 -translate-x-1/2"
            style={{ left: `${pctToBar(m.pct, layout.leftEdge, layout.target, layout.rightEdge)}%` }}
          >
            {formatINR((tradingPool * m.pct) / 100)}
          </span>
        ))}

        {/* Current value at marker (suppressed when sitting on top of an anchor) */}
        {!markerOverlapsAnchor && (
          <span
            className="absolute text-[0.5rem] font-bold tabular-nums text-info-cyan -translate-x-1/2 whitespace-nowrap transition-[left] duration-500"
            style={{ left: "var(--m)", bottom: 0 }}
          >
            {currentPct >= 0 ? "+" : ""}
            {formatINR(pnl)}
          </span>
        )}
      </div>

      {/* The bar — track slightly more visible (/30 instead of /20) so the
          bar reads as "present" even when P&L is zero and there's no fill. */}
      <div className="relative w-full h-1.5 rounded-full bg-muted-foreground/30">
        {/* Fill from zero to marker */}
        <div
          className={`absolute top-0 bottom-0 transition-[left,width] duration-500 ${
            signedAbs
              ? "rounded-r-full bg-bullish/60"
              : "rounded-l-full bg-destructive/80"
          }`}
          style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
        />

        {/* Anchor vertical lines */}
        {layout.anchors.map((a) => (
          <div
            key={`al${a.pct}`}
            className={`absolute top-[-2px] bottom-[-2px] w-0.5 z-[1] ${BG_LINE[a.color]}`}
            style={{
              left: `${pctToBar(a.pct, layout.leftEdge, layout.target, layout.rightEdge)}%`,
              marginLeft: "-1px",
            }}
          />
        ))}

        {/* Detail tick ticks */}
        {layout.detailTicks.map((t) => (
          <div
            key={`dl${t.pct}`}
            className={`absolute top-0 bottom-0 w-px ${BG_TICK[t.color]}`}
            style={{ left: `${pctToBar(t.pct, layout.leftEdge, layout.target, layout.rightEdge)}%` }}
          />
        ))}

        {/* Milestone ticks */}
        {layout.milestones.map((m) => (
          <div
            key={`ml${m.pct}`}
            className="absolute top-0 bottom-0 w-px bg-primary/40"
            style={{ left: `${pctToBar(m.pct, layout.leftEdge, layout.target, layout.rightEdge)}%` }}
          />
        ))}

        {/* Partial-exit zone markers (future DA wiring) */}
        {layout.partialExits.map((p, i) => (
          <div
            key={`pe${i}`}
            className="absolute top-[-4px] bottom-[-4px] z-[2] flex items-center"
            style={{
              left: `${pctToBar(p.percent, layout.leftEdge, layout.target, layout.rightEdge)}%`,
              marginLeft: "-4px",
            }}
            title={p.label ?? `Exit ${p.closePct}% @ ${p.percent}%`}
          >
            <div className="w-2 h-2 rotate-45 bg-warning-amber/80 border border-warning-amber" />
          </div>
        ))}

        {/* Current marker — CSS-var driven for buttery updates */}
        <div
          className={`absolute top-[-3px] bottom-[-3px] w-0.5 z-[3] transition-[left] duration-500 ${
            markerInDanger
              ? "bg-destructive shadow-[0_0_4px_oklch(0.65_0.18_20)]"
              : markerNearTarget
              ? "bg-warning-amber shadow-[0_0_4px_oklch(0.8_0.18_80)]"
              : "bg-info-cyan shadow-[0_0_4px_oklch(0.8_0.15_210)]"
          }`}
          style={{ left: "var(--m)", marginLeft: "-1px" }}
        />

        {/* Marker triangle pointer */}
        <div
          className="absolute z-[3] transition-[left] duration-500 -translate-x-1/2"
          style={{ left: "var(--m)", top: "-7px" }}
        >
          <div
            className={`w-0 h-0 border-l-[4px] border-r-[4px] border-t-[5px] border-l-transparent border-r-transparent ${
              markerInDanger
                ? "border-t-destructive"
                : markerNearTarget
                ? "border-t-warning-amber"
                : "border-t-info-cyan"
            }`}
          />
        </div>

        {/* Exit All button — follows marker */}
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

      {/* Bottom row: percentage labels below bar */}
      <div className="relative w-full h-3 mt-0.5">
        {layout.anchors.map((a) => {
          const inDetail =
            a.pct >= bucketedPct - detailHalfWidth(Math.abs(bucketedPct)) &&
            a.pct <= bucketedPct + detailHalfWidth(Math.abs(bucketedPct));
          return (
            <span
              key={`ap${a.pct}`}
              className={`absolute text-[0.4375rem] font-bold tabular-nums -translate-x-1/2 ${TEXT_FULL[a.color]} ${inDetail ? "" : "opacity-40"}`}
              style={{ left: `${pctToBar(a.pct, layout.leftEdge, layout.target, layout.rightEdge)}%` }}
            >
              {a.label ?? (a.pct >= 0 ? `+${a.pct}%` : `${a.pct}%`)}
            </span>
          );
        })}

        {layout.detailTicks.map((t) => (
          <span
            key={`dp${t.pct}`}
            className={`absolute text-[0.4375rem] tabular-nums -translate-x-1/2 ${TEXT_DIM[t.color]}`}
            style={{ left: `${pctToBar(t.pct, layout.leftEdge, layout.target, layout.rightEdge)}%` }}
          >
            {t.pct >= 0 ? `+${t.pct}%` : `${t.pct}%`}
          </span>
        ))}

        {layout.milestones.map((m) => (
          <span
            key={`mp${m.pct}`}
            className="absolute text-[0.4375rem] font-bold tabular-nums text-primary/70 -translate-x-1/2"
            style={{ left: `${pctToBar(m.pct, layout.leftEdge, layout.target, layout.rightEdge)}%` }}
          >
            +{m.pct}%
          </span>
        ))}

        {!markerOverlapsAnchor && (
          <span
            className="absolute text-[0.5rem] font-bold tabular-nums text-info-cyan -translate-x-1/2 whitespace-nowrap transition-[left] duration-500"
            style={{ left: "var(--m)", top: 0 }}
          >
            {currentPct >= 0 ? "+" : ""}
            {currentPct.toFixed(2)}%
          </span>
        )}
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
    prev.onExitAll === next.onExitAll
  );
});
