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

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { formatPrice, formatINR } from "@/lib/formatINR";

/** Compact price for the scale (no ₹, no K/L shorthand): 135.4, 1,234.5. */
const scalePrice = (v: number) => formatINR(v, { prefix: false, compact: false });

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
  /** Trailing enabled (global). When on but the stop hasn't trailed into profit
   *  yet, a thin "pending" TSL marker is drawn at the activation gate. */
  trailingEnabled?: boolean;
  /** Price at which the trailing stop will arm (breakeven + gate%). Positions the
   *  pending TSL marker before activation. */
  tslGatePrice?: number;
  /** Seconds price must hold past the gate before the server actually arms the
   *  TSL — shown in the pending marker's tooltip so it doesn't look armed early. */
  tslHoldSeconds?: number;
  /** Epoch ms the trailing stop ACTIVATED — when set, a running mm:ss stopwatch
   *  shows next to the TP marker (how long the TSL has been live). */
  tslActivatedAt?: number | null;
  /** Position size in units (lots × lot size) — used to show ₹ P&L at markers. */
  units?: number;
  /** Round-trip charges (₹) — subtracted from the ₹ P&L shown at markers. */
  roundTripCharges?: number;
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
  /** Click-to-set: called with the price under a click on the favourable (right)
   *  side of the scale, so the operator can move the TP by clicking the bar. When
   *  absent the bar isn't click-interactive. */
  onSetTp?: (price: number) => void;
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
const BUFFER_GREEN = "rgba(34, 197, 94, 0.55)"; // clear green for the TSL → LTP buffer
const GREY = "rgba(148, 163, 184, 0.35)";

const SL_COLOR = "#dc2626";
const ENTRY_COLOR = "#2563eb"; // blue — visible on dark rows
const TSL_COLOR = "#eab308"; // stop colour once it has trailed into profit
const TP_COLOR = "#22c55e"; // green

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function TradeBar({
  isBuy,
  entryPrice,
  ltp,
  slPercent = 5,
  tpPercent = 10,
  trailingEnabled = false,
  tslGatePrice,
  tslHoldSeconds,
  tslActivatedAt,
  units,
  roundTripCharges = 0,
  compact = false,
  frozen = false,
  className,
  onStopLossHit,
  onTakeProfitHit,
  onSetTp,
}: TradeBarProps) {
  // Favourable-% of a price relative to entry (BUY: up is +, SELL: down is +).
  const toFav = (p: number) => ((isBuy ? p - entryPrice : entryPrice - p) / entryPrice) * 100;
  const favToPrice = (f: number) => entryPrice * (1 + (isBuy ? f : -f) / 100);

  const ltpFav = entryPrice > 0 ? toFav(ltp) : 0;
  // Favourable-% of the stop. Negative when the stop is below entry (at risk);
  // positive once it has trailed into profit ("locked").
  const stopFav = -slPercent;
  const stopLocked = stopFav > 0;
  // ₹ P&L realised if the trade exits at a given favourable-% (net of charges).
  const profitAtFav = (fav: number): number | null =>
    units && units > 0 ? (fav / 100) * entryPrice * units - (roundTripCharges ?? 0) : null;
  const fmtMoney = (v: number) => `${v >= 0 ? "+" : "-"}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
  // Scale anchored to the trade's own levels: stop on the left (+ a little pad,
  // but never above entry) and TP on the right (+ headroom). The upper bound
  // auto-extends if price runs past TP.
  const baseMaxFav = tpPercent + RIGHT_HEADROOM;

  // ── State ───────────────────────────────────────────────────────────
  const [maxFav, setMaxFav] = useState(baseMaxFav);
  const firedRef = useRef({ sl: false, tp: false });

  // "TSL running" stopwatch — re-render once a second only while the TSL is
  // active (and the bar is live), so the mm:ss next to the TP keeps ticking.
  const [, tickClock] = useState(0);
  const tslRunning = !!tslActivatedAt && !frozen;
  useEffect(() => {
    if (!tslRunning) return;
    const id = setInterval(() => tickClock((n) => (n + 1) % 86_400), 1000);
    return () => clearInterval(id);
  }, [tslRunning]);
  const tslElapsedSec = tslActivatedAt ? Math.max(0, Math.floor((Date.now() - tslActivatedAt) / 1000)) : 0;
  const tslClock = `${String(Math.floor(tslElapsedSec / 60)).padStart(2, "0")}:${String(tslElapsedSec % 60).padStart(2, "0")}`;

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

  // Click-to-set take-profit: map the clicked x back through the scale to a price
  // and hand it up. Only the favourable (right-of-entry) side sets a TP — a click
  // on the loss side is ignored. Inverse of pos().
  const trackRef = useRef<HTMLDivElement>(null);
  const handleBarClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!onSetTp || frozen) return;
    e.stopPropagation(); // don't let a TP-set click also select/expand the row
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const clickPct = ((e.clientX - rect.left) / rect.width) * 100;
    const fav = lowFav + ((clickPct - EDGE) / (100 - 2 * EDGE)) * span;
    if (!(fav > 0)) return; // TP lives on the favourable side only
    const price = favToPrice(fav);
    if (price > 0) onSetTp(Math.round(price * 100) / 100);
  };

  const isFavourable = ltpFav >= 0;
  const profitStart = stopLocked ? stopPos : entryPos;

  // The TSL point in profit space: the locked trailing stop once it has trailed
  // into profit (null while the stop is still at/below entry). Used by the
  // colour bands and the reward-gap breakdown below.
  const tslFav = stopLocked ? stopFav : null;
  const tslPos = tslFav != null && tslFav > 0 && tslFav < tpPercent ? pos(tslFav) : null;
  // The green buffer is specifically the TSL → LTP gap (profit beyond the
  // protected stop). Anchor it at the TSL marker whenever price is above it;
  // otherwise fall back to entry so a plain in-profit trade still shows green.
  const bufferStart = tslPos != null && tslPos < ltpPos ? tslPos : profitStart;

  // ── Colour bands ──────────────────────────────────────────────────────
  const bands: Array<{ from: number; to: number; color: string }> = [];
  if (!stopLocked) bands.push({ from: stopPos, to: entryPos, color: `${RED}55` }); // at-risk loss
  if (stopLocked) bands.push({ from: entryPos, to: stopPos, color: DARK_GREEN }); // locked profit (E→TSL)
  // Pre-lock with price already past the gate: entry→gate is profit not yet
  // protected (pale); gate→LTP is the clear-green buffer pushed below.
  if (!stopLocked && tslPos != null && tslPos < ltpPos)
    bands.push({ from: entryPos, to: tslPos, color: LIGHT_GREEN });
  if (ltpPos > bufferStart) bands.push({ from: bufferStart, to: ltpPos, color: BUFFER_GREEN }); // TSL→LTP buffer
  bands.push({ from: Math.max(bufferStart, ltpPos), to: tpPos, color: GREY }); // room to TP

  // ── Tooltips ──────────────────────────────────────────────────────────
  const fmtSign = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const stopPrice = favToPrice(stopFav);
  const tpPrice = favToPrice(tpPercent);
  // Trailing on → the stop IS a trailing stop (label TSL) even before it trails
  // into profit; trailing off → a plain fixed SL. Colour still shows the phase:
  // red while at-risk (below entry), gold once it has locked profit.
  const stopColor = stopLocked ? TSL_COLOR : SL_COLOR;
  const stopText = trailingEnabled ? "TSL" : "SL";
  const stopProfit = profitAtFav(stopFav);
  const stopTip = `${trailingEnabled ? "Trailing stop" : "Stop loss"} ${formatPrice(stopPrice)} (${fmtSign(stopFav)})${stopProfit != null ? ` · ${fmtMoney(stopProfit)}` : ""}`;
  const entryTip = `Entry ${formatPrice(entryPrice)}`;
  const tpTip = `TP ${formatPrice(tpPrice)} (${fmtSign(tpPercent)})`;
  const ltpTip = `LTP ${formatPrice(ltp)} (${fmtSign(ltpFav)})`;

  const Tick = ({ at, color, tip, z }: { at: number; color: string; tip: string; z?: number }) => (
    <div
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center justify-center pointer-events-auto cursor-help transition-[left] duration-300 ease-out"
      style={{ left: `${at}%`, width: "12px", height: "16px", zIndex: z }}
      title={tip}
    >
      <div
        style={{
          width: "2px",
          height: "11px",
          backgroundColor: color,
          borderRadius: "1px",
        }}
      />
    </div>
  );

  // align: "center" under the marker (default), "left" = label sits to the LEFT
  // of the marker, "right" = to the RIGHT — used to separate markers that crowd.
  const Label = ({ at, color, text, price, hideText, align = "center" }: { at: number; color: string; text: string; price?: number; hideText?: boolean; align?: "center" | "left" | "right" }) => {
    const transform = align === "left" ? "translateX(-100%)" : align === "right" ? "translateX(0)" : "translateX(-50%)";
    const items = align === "left" ? "items-end pr-1" : align === "right" ? "items-start pl-1" : "items-center";
    return (
      <span
        className={`absolute flex flex-col gap-px leading-none transition-[left] duration-300 ease-out ${items}`}
        style={{ left: `${clamp(at, 4, 96)}%`, color, transform }}
      >
        {!hideText && <span className="text-[0.5rem] font-bold tabular-nums">{text}</span>}
        {price != null && price > 0 && (
          <span className="text-[0.5rem] font-bold tabular-nums opacity-90">{scalePrice(price)}</span>
        )}
      </span>
    );
  };

  // ── Zone % arrows (<—— x% ——>) ────────────────────────────────────────
  // Risk = stop→entry (the red loss zone, only when the stop is below entry).
  const showRisk = !stopLocked && entryPos - stopPos > 4;
  const riskMid = (stopPos + entryPos) / 2;

  // Reward = entry→TP, broken into consecutive measured gaps at the TSL and the
  // live LTP. The TSL point is the locked trailing stop, or — before it arms —
  // the pending activation gate, so the gap up to it reads as "how far price
  // must still travel to activate the TSL". Sorting by position keeps every gap
  // correct in all states: pre-arm you get …→TSL (distance to arm); once locked
  // you get E→TSL, TSL→LTP, LTP→TP.
  type RewardPoint = { fav: number; kind: 'E' | 'TSL' | 'LTP' | 'TP' };
  const rewardPts: RewardPoint[] = [
    { fav: 0, kind: 'E' },
    { fav: tpPercent, kind: 'TP' },
  ];
  if (tslFav != null && tslFav > 0 && tslFav < tpPercent) rewardPts.push({ fav: tslFav, kind: 'TSL' });
  if (ltpFav > 0 && ltpFav < tpPercent) rewardPts.push({ fav: ltpFav, kind: 'LTP' });
  rewardPts.sort((a, b) => a.fav - b.fav);
  const rewardSegs = rewardPts.slice(0, -1).map((a, i) => {
    const b = rewardPts[i + 1];
    return { fromPos: pos(a.fav), toPos: pos(b.fav), gapPct: b.fav - a.fav, from: a.kind, to: b.kind };
  });
  // The TSL↔LTP gap is the key number (cushion above the locked stop, or — before
  // arming — the distance left to activate it), so its % always shows even when
  // the gap is too thin for the generic width guard.
  const isTslLtpGap = (s: { from: RewardPoint['kind']; to: RewardPoint['kind'] }) =>
    (s.from === 'TSL' && s.to === 'LTP') || (s.from === 'LTP' && s.to === 'TSL');
  // The Entry→TSL gap carries the secured ₹ (profit the trailing stop locks in).
  const isEntryTslGap = (s: { from: RewardPoint['kind']; to: RewardPoint['kind'] }) =>
    s.from === 'E' && s.to === 'TSL';
  // Each gap is tinted by the marker it runs UP TO: yellow toward the TSL
  // (the activation/locked stop), green toward the LTP, grey toward TP.
  const SEG_COLOR: Record<RewardPoint['kind'], string> = {
    E: '#dcfce7',
    TSL: '#fde68a',
    LTP: '#dcfce7',
    TP: '#e5e7eb',
  };

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

  // % chip centred over a zone; optional suffix (e.g. the secured ₹) appended.
  const GapLabel = ({ at, pct, color, suffix }: { at: number; pct: number; color: string; suffix?: string }) => (
    <span
      className="absolute -translate-x-1/2 text-[0.5rem] font-bold leading-none px-0.5 rounded whitespace-nowrap transition-[left] duration-300 ease-out"
      style={{ left: `${clamp(at, 6, 94)}%`, top: "2px", color, background: "rgba(0,0,0,0.45)" }}
    >
      {pct.toFixed(1).replace(/^(-?)0\./, "$1.")}%{suffix ? ` · ${suffix}` : ""}
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
      {/* Top tier: zone % chips — risk over stop→entry, then one chip per
          reward gap (E→TSL→LTP→TP). Skip a chip when its gap is too thin to read. */}
      <div className="relative w-full" style={{ height: "11px" }}>
        {showRisk && <GapLabel at={riskMid} pct={Math.abs(stopFav)} color="#fecaca" />}
        {rewardSegs.map((s, i) => {
          const showSecured = stopLocked && isEntryTslGap(s) && stopProfit != null;
          if (!(s.toPos - s.fromPos > 6 || isTslLtpGap(s) || showSecured)) return null;
          // Secured ₹ — the profit the trailing stop locks in — only once the TSL
          // has actually activated (trailed into profit), shown on its Entry→TSL gap.
          const suffix = showSecured ? fmtMoney(stopProfit as number) : undefined;
          return (
            <GapLabel key={i} at={(s.fromPos + s.toPos) / 2} pct={s.gapPct} color={SEG_COLOR[s.to]} suffix={suffix} />
          );
        })}
      </div>

      <div
        ref={trackRef}
        className={`relative w-full h-1.5 ${onSetTp && !frozen ? "cursor-pointer" : ""}`}
        onClick={onSetTp && !frozen ? handleBarClick : undefined}
        title={onSetTp && !frozen ? "Click the favourable side of the bar to move the take-profit here" : undefined}
      >
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

        {/* Zone arrows: stop→entry (risk), then one arrow per reward gap
            (E→TSL→LTP→TP). Tiny gaps self-skip inside GapLine. */}
        {showRisk && <GapLine from={stopPos} to={entryPos} color="rgba(255,255,255,0.95)" />}
        {rewardSegs.map((s, i) => (
          <GapLine key={i} from={s.fromPos} to={s.toPos} color="rgba(220,252,231,0.9)" />
        ))}

        {/* Marker ticks — each its own hover tooltip. The stop/TSL marker is
            lifted above the gap arrows + bands so it's never obscured. */}
        <div className="absolute inset-0 pointer-events-none">
          <Tick at={stopPos} color={stopColor} tip={stopTip} z={10} />
          <Tick at={entryPos} color={ENTRY_COLOR} tip={entryTip} />
          <Tick at={tpPos} color={TP_COLOR} tip={tpTip} />
        </div>

        {/* TSL "running" stopwatch (mm:ss) — sits just right of the TP marker,
            inside the bar, while the trailing stop is active. */}
        {tslRunning && (
          <span
            className="absolute z-[11] text-[0.5rem] font-bold tabular-nums leading-none px-0.5 rounded pointer-events-none whitespace-nowrap"
            style={{ left: `${clamp(tpPos, 6, 96)}%`, top: "50%", transform: "translate(3px, -50%)", color: TSL_COLOR, background: "rgba(0,0,0,0.55)" }}
            title={`Trailing stop running · ${tslClock}`}
          >
            {tslClock}
          </span>
        )}

        {/* LTP triangle pointer + live price above it */}
        <div
          className="absolute -translate-x-1/2 pointer-events-auto cursor-help transition-[left] duration-300 ease-out"
          style={{ left: `${ltpPos}%`, top: "-6px" }}
          title={ltpTip}
        >
          <span
            className="absolute left-1/2 -translate-x-1/2 -top-2.5 text-[0.5rem] font-bold tabular-nums leading-none whitespace-nowrap"
            style={{ color: isFavourable ? GREEN : RED }}
          >
            {scalePrice(ltp)}
          </span>
          <div
            className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[5px] border-l-transparent border-r-transparent"
            style={{ borderTopColor: isFavourable ? GREEN : RED }}
          />
        </div>
      </div>

      {/* Marker labels below the bar: option price under each marker. In full
          mode the SL/E/TP/TSL letter sits above the price; compact mode shows the
          prices only (markers are still colour-coded). */}
      <div className={`relative w-full mt-1.5 ${compact ? "h-2.5" : "h-5"}`}>
        {/* Stop: SL centred; once trailed into profit (TSL) it crowds Entry, so
            its price sits to the RIGHT of the marker. Entry's price sits to the
            LEFT of its marker so the two never overlap. */}
        <Label at={stopPos} color={stopColor} text={stopText} price={stopPrice} hideText={compact} align={stopLocked ? "right" : "center"} />
        <Label at={entryPos} color={ENTRY_COLOR} text="E" price={entryPrice} hideText={compact} align="left" />
        <Label at={tpPos} color={TP_COLOR} text="TP" price={tpPrice} hideText={compact} />
      </div>
    </div>
  );
}
