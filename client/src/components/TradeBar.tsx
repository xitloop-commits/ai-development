/**
 * TradeBar — self-contained per-trade price scale (Version 1).
 *
 * Fully client-side and independent: it owns the scale, the markers, the TSL
 * activation timer, and the hit/activation events. It never talks to the
 * server — the parent may listen to the emitted callbacks and decide what to
 * do (toast, animation, or later wire to a real exit). Iterate on it via
 * TradeBar.stories.tsx.
 *
 * SCALE (favourable space — favourable direction is always to the RIGHT, so a
 * SELL is mirrored automatically):
 *   - Lower bound: Entry − 15%  (fixed, never moves)
 *   - Upper bound: Entry + 50%  (auto-extends by +10% of entry as the LTP
 *     approaches it; smooth, marker positions recompute on every change)
 *
 * MARKERS (left → right): SL · Entry · TSL · TP, plus the live LTP triangle.
 *   SL  = entry − slPercent%      (fixed after creation)
 *   TP  = entry + tpPercent%
 *   TSL = inactive until ltp > entry + charges + entry×1% held for 5s, then it
 *         activates once and trails the peak by tslPercent — forward-only.
 *
 * EVENTS (emitted once each): onStopLossHit · onTakeProfitHit · onTslActivated.
 */

import { useEffect, useRef, useState } from "react";
import { formatPrice } from "@/lib/formatINR";

export interface TradeBarProps {
  /** BUY → price up is favourable; SELL → price down is favourable (mirrored). */
  isBuy: boolean;
  entryPrice: number;
  /** Live last-traded price (the moving pointer). */
  ltp: number;
  /** Hard-stop %, fixed at trade creation. SL = entry − slPercent% (BUY). */
  slPercent?: number;
  /** Take-profit %. TP = entry + tpPercent% (BUY). */
  tpPercent?: number;
  /** Trailing-stop distance %, applied once TSL activates. */
  tslPercent?: number;
  /** Per-unit charges added to breakeven for the TSL activation gate. */
  charges?: number;
  /** Compact mode (tight table cells): bar + ticks only, no text labels. */
  compact?: boolean;
  /** Frozen snapshot (closed trade): render markers statically — skip the TSL
   *  activation timer and the hit callbacks so a static LTP can't fire them. */
  frozen?: boolean;
  className?: string;
  /** Fired once when ltp first reaches the stop loss. */
  onStopLossHit?: () => void;
  /** Fired once when ltp first reaches the take profit. */
  onTakeProfitHit?: () => void;
  /** Fired once when the trailing stop activates (after the 5s gate). */
  onTslActivated?: () => void;
}

// ─── Tunables ───────────────────────────────────────────────────────────
const LEFT_PAD = 5; // breathing room (favourable %) left of the SL marker
const RIGHT_HEADROOM = 6; // room (favourable %) right of TP before the edge
const EXTEND_STEP = 10; // grow the upper bound by +10% of entry on approach
const APPROACH = 5; // "approaching the max" = within 5% of it
const TSL_GATE_PCT = 1; // activation gate: ltp must clear entry + charges + 1%
const TSL_HOLD_MS = 5000; // gate must hold continuously for 5s

// ─── Colours (match TodayPnlBar palette) ────────────────────────────────
const RED = "#dc2626";
const GREEN = "#22c55e";
const DARK_GREEN = "rgba(21, 128, 61, 0.85)";
const LIGHT_GREEN = "rgba(187, 247, 208, 0.85)";
const GREY = "rgba(148, 163, 184, 0.35)";

const SL_COLOR = "#dc2626";
const ENTRY_COLOR = "#000000";
const TSL_COLOR = "#eab308";
const TP_COLOR = "#3b82f6";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function TradeBar({
  isBuy,
  entryPrice,
  ltp,
  slPercent = 5,
  tpPercent = 10,
  tslPercent = 1,
  charges = 0,
  compact = false,
  frozen = false,
  className,
  onStopLossHit,
  onTakeProfitHit,
  onTslActivated,
}: TradeBarProps) {
  // Favourable-% of a price relative to entry (BUY: up is +, SELL: down is +).
  const toFav = (p: number) => ((isBuy ? p - entryPrice : entryPrice - p) / entryPrice) * 100;
  const favToPrice = (f: number) => entryPrice * (1 + (isBuy ? f : -f) / 100);

  const ltpFav = entryPrice > 0 ? toFav(ltp) : 0;
  // Activation gate as a favourable %: clear (charges + 1%) of entry above entry.
  const gateFav = entryPrice > 0 ? (charges / entryPrice) * 100 + TSL_GATE_PCT : Infinity;

  // Scale is anchored to the trade's own levels: SL on the left (+ a little
  // pad) and TP on the right (+ headroom). Keeps the loss zone compact and TP
  // near the right edge; the upper bound still auto-extends if price runs past.
  const baseMaxFav = tpPercent + RIGHT_HEADROOM;

  // ── State ───────────────────────────────────────────────────────────
  const [maxFav, setMaxFav] = useState(baseMaxFav);
  const [tslFav, setTslFav] = useState<number | null>(null); // null = not activated yet

  const peakFavRef = useRef(-Infinity); // highest favourable-% seen since activation
  const gateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ltpFavRef = useRef(ltpFav); // latest favourable-% for the timer to read at fire
  ltpFavRef.current = ltpFav;
  const firedRef = useRef({ sl: false, tp: false });

  const onStopLossHitRef = useRef(onStopLossHit);
  const onTakeProfitHitRef = useRef(onTakeProfitHit);
  const onTslActivatedRef = useRef(onTslActivated);
  onStopLossHitRef.current = onStopLossHit;
  onTakeProfitHitRef.current = onTakeProfitHit;
  onTslActivatedRef.current = onTslActivated;

  // Reset everything when the trade (entry/direction) changes.
  useEffect(() => {
    setMaxFav(baseMaxFav);
    setTslFav(null);
    peakFavRef.current = -Infinity;
    firedRef.current = { sl: false, tp: false };
    if (gateTimerRef.current) {
      clearTimeout(gateTimerRef.current);
      gateTimerRef.current = null;
    }
  }, [entryPrice, isBuy, baseMaxFav]);

  // Clear any pending timer on unmount.
  useEffect(() => () => {
    if (gateTimerRef.current) clearTimeout(gateTimerRef.current);
  }, []);

  // Auto-extend the upper bound when the LTP approaches it (lower never moves).
  useEffect(() => {
    if (ltpFav >= maxFav - APPROACH) {
      setMaxFav((prev) => {
        let next = prev;
        while (ltpFav >= next - APPROACH) next += EXTEND_STEP;
        return next;
      });
    }
  }, [ltpFav, maxFav]);

  // TSL activation: gate must hold continuously for 5s. One-shot — once tslFav
  // is set it never re-arms (the effect bails while active).
  useEffect(() => {
    if (frozen) return; // closed snapshot — never auto-activate
    if (tslFav !== null) return; // already activated
    const armed = ltpFav > gateFav;
    if (armed && !gateTimerRef.current) {
      gateTimerRef.current = setTimeout(() => {
        gateTimerRef.current = null;
        const fav = ltpFavRef.current;
        peakFavRef.current = fav;
        setTslFav(fav - tslPercent);
        onTslActivatedRef.current?.();
      }, TSL_HOLD_MS);
    } else if (!armed && gateTimerRef.current) {
      clearTimeout(gateTimerRef.current); // gate broke before 5s — reset
      gateTimerRef.current = null;
    }
  }, [ltpFav, gateFav, tslFav, tslPercent]);

  // Trail the peak once active — forward-only (never retreats).
  useEffect(() => {
    if (frozen) return; // closed snapshot — no trailing
    if (tslFav === null) return;
    if (ltpFav > peakFavRef.current) {
      peakFavRef.current = ltpFav;
      const candidate = ltpFav - tslPercent;
      setTslFav((prev) => (prev === null ? candidate : Math.max(prev, candidate)));
    }
  }, [ltpFav, tslFav, tslPercent]);

  // Hit events — fire once each.
  useEffect(() => {
    if (frozen) return; // closed snapshot — don't fire hit events on static LTP
    if (entryPrice <= 0) return;
    if (!firedRef.current.sl && ltpFav <= -slPercent) {
      firedRef.current.sl = true;
      onStopLossHitRef.current?.();
    }
    if (!firedRef.current.tp && ltpFav >= tpPercent) {
      firedRef.current.tp = true;
      onTakeProfitHitRef.current?.();
    }
  }, [ltpFav, slPercent, tpPercent, entryPrice]);

  if (!(entryPrice > 0)) return null;

  // ── Map favourable-% → bar position [EDGE, 100-EDGE] ──────────────────
  // Lower plotted bound sits LEFT_PAD below the lower bound (or below a deep
  // SL), so the SL marker always keeps breathing room from the left edge.
  const EDGE = 4;
  const lowFav = -slPercent - LEFT_PAD;
  const span = maxFav - lowFav;
  const pos = (fav: number) => clamp(EDGE + ((fav - lowFav) / span) * (100 - 2 * EDGE));

  const slPos = pos(-slPercent);
  const entryPos = pos(0);
  const tpPos = pos(tpPercent);
  const ltpPos = pos(ltpFav);
  const tslShown = tslFav !== null && tslFav > -slPercent;
  const tslPos = tslShown ? pos(tslFav as number) : null;

  const isFavourable = ltpFav >= 0;
  const tslLocked = tslPos != null && (tslFav as number) > 0;
  const profitStart = tslLocked ? (tslPos as number) : entryPos;

  // ── Colour bands ──────────────────────────────────────────────────────
  const bands: Array<{ from: number; to: number; color: string }> = [
    { from: slPos, to: entryPos, color: `${RED}55` }, // at-risk loss
  ];
  if (tslLocked) bands.push({ from: entryPos, to: tslPos as number, color: DARK_GREEN }); // locked
  if (ltpPos > profitStart) bands.push({ from: profitStart, to: ltpPos, color: LIGHT_GREEN }); // buffer
  bands.push({ from: Math.max(profitStart, ltpPos), to: tpPos, color: GREY }); // room to TP

  // ── Tooltips ──────────────────────────────────────────────────────────
  const fmtSign = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const slPrice = favToPrice(-slPercent);
  const tpPrice = favToPrice(tpPercent);
  const tslPrice = tslFav != null ? favToPrice(tslFav) : null;
  const slTip = `SL ${formatPrice(slPrice)} (${fmtSign(-slPercent)})`;
  const entryTip = `Entry ${formatPrice(entryPrice)}`;
  const tpTip = `TP ${formatPrice(tpPrice)} (${fmtSign(tpPercent)})`;
  const tslTip = tslPrice != null ? `TSL ${formatPrice(tslPrice)} (${fmtSign(tslFav as number)})` : "";
  const ltpTip = `LTP ${formatPrice(ltp)} (${fmtSign(ltpFav)})`;

  const Tick = ({ at, color, tip }: { at: number; color: string; tip: string }) => (
    <div
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center justify-center pointer-events-auto cursor-help transition-[left] duration-300 ease-out"
      style={{ left: `${at}%`, width: "12px", height: "16px" }}
      title={tip}
    >
      <div
        style={{
          width: "3px",
          height: "11px",
          backgroundColor: color,
          borderRadius: "1px",
          boxShadow: "0 0 0 0.5px rgba(255,255,255,0.65)",
        }}
      />
    </div>
  );

  const Label = ({ at, color, text }: { at: number; color: string; text: string }) => (
    <span
      className="absolute -translate-x-1/2 text-[0.5rem] font-bold tabular-nums leading-none transition-[left] duration-300 ease-out"
      style={{ left: `${clamp(at, 4, 96)}%`, color }}
    >
      {text}
    </span>
  );

  // ── Zone % arrows (<—— x% ——>) for the two main zones ─────────────────
  // Risk = SL→entry (the red loss zone). Reward = entry→TP (the room zone).
  const showRisk = entryPos - slPos > 4;
  const showReward = tpPos - entryPos > 4;
  const riskMid = (slPos + entryPos) / 2;
  const rewardMid = (entryPos + tpPos) / 2;

  // Double-headed measurement line spanning from%→to%, centred on the bar.
  const GapLine = ({ from, to, color }: { from: number; to: number; color: string }) => {
    const inset = 0.5;
    const lo = Math.min(from, to) + inset;
    const hi = Math.max(from, to) - inset;
    const width = hi - lo;
    if (width <= 1) return null;
    const head = (dir: "l" | "r") => (
      <span
        className="w-0 h-0 shrink-0"
        style={
          dir === "l"
            ? { borderTop: "3px solid transparent", borderBottom: "3px solid transparent", borderRight: `4px solid ${color}` }
            : { borderTop: "3px solid transparent", borderBottom: "3px solid transparent", borderLeft: `4px solid ${color}` }
        }
      />
    );
    return (
      <div
        className="absolute z-[2] pointer-events-none flex items-center transition-[left,width] duration-300 ease-out"
        style={{ left: `${lo}%`, width: `${width}%`, top: "50%", transform: "translateY(-50%)", height: "6px" }}
      >
        {head("l")}
        <div className="flex-1" style={{ height: "1px", background: color }} />
        {head("r")}
      </div>
    );
  };

  // % chip centred over a zone.
  const GapLabel = ({ at, pct, color }: { at: number; pct: number; color: string }) => (
    <span
      className="absolute -translate-x-1/2 text-[0.5rem] font-bold leading-none px-0.5 rounded whitespace-nowrap transition-[left] duration-300 ease-out"
      style={{ left: `${clamp(at, 6, 94)}%`, top: "2px", color, background: "rgba(0,0,0,0.45)" }}
    >
      {pct.toFixed(1)}%
    </span>
  );

  return (
    <div
      className={`relative w-full ${className ?? ""}`}
      role="progressbar"
      aria-label="Trade price position"
      aria-valuemin={Math.round(favToPrice(lowFav))}
      aria-valuemax={Math.round(favToPrice(maxFav))}
      aria-valuenow={Math.round(ltp)}
    >
      {/* Top tier: zone % chips (risk over SL→entry, reward over entry→TP) */}
      <div className="relative w-full" style={{ height: "11px" }}>
        {showRisk && <GapLabel at={riskMid} pct={slPercent} color="#fecaca" />}
        {showReward && <GapLabel at={rewardMid} pct={tpPercent} color="#dcfce7" />}
      </div>

      <div className="relative w-full h-1.5">
        {/* Track + colour bands (clipped to the rounded track) */}
        <div className="absolute inset-0 rounded-full bg-muted-foreground/20 overflow-hidden">
          {bands.map((b, i) => {
            const left = clamp(Math.min(b.from, b.to));
            const width = clamp(Math.abs(b.to - b.from));
            if (width <= 0.3) return null;
            return (
              <div
                key={i}
                className="absolute top-0 bottom-0 transition-[left,width] duration-300 ease-out"
                style={{ left: `${left}%`, width: `${width}%`, background: b.color }}
              />
            );
          })}
        </div>

        {/* Zone arrows: SL→entry (risk) and entry→TP (reward) */}
        {showRisk && <GapLine from={slPos} to={entryPos} color="rgba(255,255,255,0.95)" />}
        {showReward && <GapLine from={entryPos} to={tpPos} color="rgba(220,252,231,0.9)" />}

        {/* Marker ticks — each its own hover tooltip */}
        <div className="absolute inset-0 pointer-events-none">
          <Tick at={slPos} color={SL_COLOR} tip={slTip} />
          <Tick at={entryPos} color={ENTRY_COLOR} tip={entryTip} />
          {tslPos != null && <Tick at={tslPos} color={TSL_COLOR} tip={tslTip} />}
          <Tick at={tpPos} color={TP_COLOR} tip={tpTip} />
        </div>

        {/* LTP triangle pointer */}
        <div
          className="absolute -translate-x-1/2 pointer-events-auto cursor-help transition-[left] duration-300 ease-out"
          style={{ left: `${ltpPos}%`, top: "-6px" }}
          title={ltpTip}
        >
          <div
            className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[5px] border-l-transparent border-r-transparent"
            style={{ borderTopColor: isFavourable ? GREEN : RED }}
          />
        </div>
      </div>

      {/* Labels below the bar (hidden in compact mode) */}
      {!compact && (
        <div className="relative w-full h-3 mt-0.5">
          <Label at={slPos} color={SL_COLOR} text="SL" />
          <Label at={entryPos} color={ENTRY_COLOR} text="E" />
          {tslPos != null && <Label at={tslPos} color={TSL_COLOR} text="TSL" />}
          <Label at={tpPos} color={TP_COLOR} text="TP" />
        </div>
      )}
    </div>
  );
}