/**
 * TradeBar — self-contained per-trade price scale.
 *
 * Shows ONE real stop marker driven by the trade's actual stop price (the value
 * the server exits on). Before trailing kicks in it sits at the hard SL; once the
 * server trails the stop into profit the same marker climbs and is labelled TSL.
 * The bar never runs its own trailing simulation — the server owns trailing, so
 * what's drawn here can't disagree with where the trade actually exits.
 *
 * SCALE (favourable space — favourable direction is always to the RIGHT, so a
 * SELL is mirrored automatically):
 *   - Lower bound: min(stop, entry) − 15%  (keeps entry + the stop visible)
 *   - Upper bound: TP + headroom (auto-extends by +10% of entry as LTP nears it)
 *
 * MARKERS (left → right): Stop · Entry · TP, plus the live LTP triangle.
 *   Stop = entry − slPercent%   (slPercent is the live distance to the real stop;
 *                                negative once the stop trails into profit)
 *   TP   = entry + tpPercent%
 *
 * EVENTS (emitted once each): onStopLossHit · onTakeProfitHit.
 */

import { useEffect, useRef, useState } from "react";
import { formatPrice } from "@/lib/formatINR";

export interface TradeBarProps {
  /** BUY → price up is favourable; SELL → price down is favourable (mirrored). */
  isBuy: boolean;
  entryPrice: number;
  /** Live last-traded price (the moving pointer). */
  ltp: number;
  /** Distance to the REAL stop as a % of entry (BUY: stop = entry − slPercent%).
   *  Derived by the parent from the trade's actual stop price, so it follows
   *  edits and server-side trailing. Goes negative once the stop is in profit. */
  slPercent?: number;
  /** Take-profit %. TP = entry + tpPercent% (BUY). */
  tpPercent?: number;
  /** Compact mode (tight table cells): bar + ticks only, no text labels. */
  compact?: boolean;
  /** Frozen snapshot (closed trade): render markers statically + skip the hit
   *  callbacks so a static LTP can't fire them. */
  frozen?: boolean;
  className?: string;
  /** Fired once when ltp first reaches the stop. */
  onStopLossHit?: () => void;
  /** Fired once when ltp first reaches the take profit. */
  onTakeProfitHit?: () => void;
}

// ─── Tunables ───────────────────────────────────────────────────────────
const LEFT_PAD = 5; // breathing room (favourable %) left of the stop marker
const RIGHT_HEADROOM = 6; // room (favourable %) right of TP before the edge
const EXTEND_STEP = 10; // grow the upper bound by +10% of entry on approach
const APPROACH = 5; // "approaching the max" = within 5% of it

// ─── Colours (match TodayPnlBar palette) ────────────────────────────────
const RED = "#dc2626";
const GREEN = "#22c55e";
const DARK_GREEN = "rgba(21, 128, 61, 0.85)";
const LIGHT_GREEN = "rgba(187, 247, 208, 0.85)";
const GREY = "rgba(148, 163, 184, 0.35)";

const SL_COLOR = "#dc2626";
const ENTRY_COLOR = "#000000";
const TSL_COLOR = "#eab308"; // stop colour once it has trailed into profit
const TP_COLOR = "#3b82f6";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function TradeBar({
  isBuy,
  entryPrice,
  ltp,
  slPercent = 5,
  tpPercent = 10,
  compact = false,
  frozen = false,
  className,
  onStopLossHit,
  onTakeProfitHit,
}: TradeBarProps) {
  // Favourable-% of a price relative to entry (BUY: up is +, SELL: down is +).
  const toFav = (p: number) => ((isBuy ? p - entryPrice : entryPrice - p) / entryPrice) * 100;
  const favToPrice = (f: number) => entryPrice * (1 + (isBuy ? f : -f) / 100);

  const ltpFav = entryPrice > 0 ? toFav(ltp) : 0;
  // Favourable-% of the stop. Negative when the stop is below entry (at risk);
  // positive once it has trailed into profit ("locked").
  const stopFav = -slPercent;
  const stopLocked = stopFav > 0;

  // Scale anchored to the trade's own levels: stop on the left (+ a little pad,
  // but never above entry) and TP on the right (+ headroom). The upper bound
  // auto-extends if price runs past TP.
  const baseMaxFav = tpPercent + RIGHT_HEADROOM;

  // ── State ───────────────────────────────────────────────────────────
  const [maxFav, setMaxFav] = useState(baseMaxFav);
  const firedRef = useRef({ sl: false, tp: false });

  const onStopLossHitRef = useRef(onStopLossHit);
  const onTakeProfitHitRef = useRef(onTakeProfitHit);
  onStopLossHitRef.current = onStopLossHit;
  onTakeProfitHitRef.current = onTakeProfitHit;

  // Reset hit guards when the trade (entry/direction) changes.
  useEffect(() => {
    setMaxFav(baseMaxFav);
    firedRef.current = { sl: false, tp: false };
  }, [entryPrice, isBuy, baseMaxFav]);

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

  // Hit events — fire once each.
  useEffect(() => {
    if (frozen) return; // closed snapshot — don't fire hit events on static LTP
    if (entryPrice <= 0) return;
    if (!firedRef.current.sl && ltpFav <= stopFav) {
      firedRef.current.sl = true;
      onStopLossHitRef.current?.();
    }
    if (!firedRef.current.tp && ltpFav >= tpPercent) {
      firedRef.current.tp = true;
      onTakeProfitHitRef.current?.();
    }
  }, [ltpFav, stopFav, tpPercent, entryPrice, frozen]);

  if (!(entryPrice > 0)) return null;

  // ── Map favourable-% → bar position [EDGE, 100-EDGE] ──────────────────
  // Lower plotted bound sits LEFT_PAD below the stop (or below entry, whichever
  // is lower), so entry stays visible even when the stop has trailed into profit.
  const EDGE = 4;
  const lowFav = Math.min(stopFav, 0) - LEFT_PAD;
  const span = maxFav - lowFav;
  const pos = (fav: number) => clamp(EDGE + ((fav - lowFav) / span) * (100 - 2 * EDGE));

  const stopPos = pos(stopFav);
  const entryPos = pos(0);
  const tpPos = pos(tpPercent);
  const ltpPos = pos(ltpFav);

  const isFavourable = ltpFav >= 0;
  const profitStart = stopLocked ? stopPos : entryPos;

  // ── Colour bands ──────────────────────────────────────────────────────
  const bands: Array<{ from: number; to: number; color: string }> = [];
  if (!stopLocked) bands.push({ from: stopPos, to: entryPos, color: `${RED}55` }); // at-risk loss
  if (stopLocked) bands.push({ from: entryPos, to: stopPos, color: DARK_GREEN }); // locked profit
  if (ltpPos > profitStart) bands.push({ from: profitStart, to: ltpPos, color: LIGHT_GREEN }); // buffer
  bands.push({ from: Math.max(profitStart, ltpPos), to: tpPos, color: GREY }); // room to TP

  // ── Tooltips ──────────────────────────────────────────────────────────
  const fmtSign = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const stopPrice = favToPrice(stopFav);
  const tpPrice = favToPrice(tpPercent);
  const stopColor = stopLocked ? TSL_COLOR : SL_COLOR;
  const stopText = stopLocked ? "TSL" : "SL";
  const stopTip = `${stopLocked ? "Trailing stop" : "Stop loss"} ${formatPrice(stopPrice)} (${fmtSign(stopFav)})`;
  const entryTip = `Entry ${formatPrice(entryPrice)}`;
  const tpTip = `TP ${formatPrice(tpPrice)} (${fmtSign(tpPercent)})`;
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
  // Risk = stop→entry (the red loss zone, only when the stop is below entry).
  // Reward = entry→TP (the room zone).
  const showRisk = !stopLocked && entryPos - stopPos > 4;
  const showReward = tpPos - entryPos > 4;
  const riskMid = (stopPos + entryPos) / 2;
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
      {/* Top tier: zone % chips (risk over stop→entry, reward over entry→TP) */}
      <div className="relative w-full" style={{ height: "11px" }}>
        {showRisk && <GapLabel at={riskMid} pct={Math.abs(stopFav)} color="#fecaca" />}
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

        {/* Zone arrows: stop→entry (risk) and entry→TP (reward) */}
        {showRisk && <GapLine from={stopPos} to={entryPos} color="rgba(255,255,255,0.95)" />}
        {showReward && <GapLine from={entryPos} to={tpPos} color="rgba(220,252,231,0.9)" />}

        {/* Marker ticks — each its own hover tooltip */}
        <div className="absolute inset-0 pointer-events-none">
          <Tick at={stopPos} color={stopColor} tip={stopTip} />
          <Tick at={entryPos} color={ENTRY_COLOR} tip={entryTip} />
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
          <Label at={stopPos} color={stopColor} text={stopText} />
          <Label at={entryPos} color={ENTRY_COLOR} text="E" />
          <Label at={tpPos} color={TP_COLOR} text="TP" />
        </div>
      )}
    </div>
  );
}
