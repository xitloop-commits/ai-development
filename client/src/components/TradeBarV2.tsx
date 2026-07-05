/**
 * TradeBarV2 — redesign of TradeBar (proportional risk∶reward + live P&L).
 *
 * Design goals (chosen with Partha):
 *   2a — the bar shows RISK (entry→stop, red) and REWARD (entry→TP, green) at
 *        their true proportional widths, so a bad reward∶risk is obvious at a
 *        glance (a 0.3 RR = a sliver of green against a wall of red).
 *   3a — live ₹ P&L is baked onto the bar, not hidden in a tooltip.
 *   1b — ONE state-aware readout instead of the old three %-chips + arrows.
 *
 * Same prop contract as TradeBar so it can be swapped in later. Favourable
 * space (favourable is always rightward → a SELL is mirrored automatically).
 */

import { useEffect, useRef, useState } from "react";
import { formatPrice, formatINR } from "@/lib/formatINR";
import type { TradeBarProps } from "./TradeBar";

const scalePrice = (v: number) => formatINR(v, { prefix: false, compact: false });
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// ─── Palette (cleaner, dark-row friendly) ───────────────────────────────
const RISK = "#ef4444"; // red — at-risk zone / loss fill
const REWARD = "#22c55e"; // green — reward zone / profit fill
const ENTRY_C = "#3b82f6"; // blue — entry anchor
const TSL_C = "#eab308"; // gold — stop once trailed into profit
const TRACK = "rgba(148,163,184,0.18)";

export function TradeBarV2({
  isBuy,
  entryPrice,
  ltp,
  slPercent = 5,
  tpPercent = 10,
  trailingEnabled = true,
  tslActivatedAt,
  units,
  roundTripCharges = 0,
  compact = false,
  frozen = false,
  className,
  onStopLossHit,
  onTakeProfitHit,
}: TradeBarProps) {
  // The stop IS a trailing stop when trailing is on; a plain fixed SL when off.
  // Drives the label / tooltip — a fixed SL never trails into profit, so it
  // simply stays red.
  const isTsl = trailingEnabled;
  const stopName = isTsl ? "TSL" : "SL";
  // Favourable-% of a price relative to entry (BUY: up +, SELL: down +).
  const toFav = (p: number) => ((isBuy ? p - entryPrice : entryPrice - p) / entryPrice) * 100;

  const ltpFav = entryPrice > 0 ? toFav(ltp) : 0;
  const stopFav = -slPercent; // <0 at risk, >0 once trailed into profit
  const tpFav = tpPercent;
  const stopLocked = stopFav > 0;

  // ₹ P&L at a favourable-% (net of round-trip charges) when size is known.
  const profitAtFav = (fav: number): number | null =>
    units && units > 0 ? (fav / 100) * entryPrice * units - (roundTripCharges ?? 0) : null;
  const pnl = profitAtFav(ltpFav);
  const fmtMoney = (v: number) => `${v >= 0 ? "+" : "-"}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

  // Reward∶risk at the trade's ORIGINAL levels (fixed property of the trade).
  const rr = slPercent > 0 && tpPercent > 0 ? tpPercent / slPercent : null;

  // ── Fire-once hit events (kept for drop-in parity) ────────────────────
  const fired = useRef({ sl: false, tp: false });
  const slRef = useRef(onStopLossHit);
  const tpRef = useRef(onTakeProfitHit);
  slRef.current = onStopLossHit;
  tpRef.current = onTakeProfitHit;
  useEffect(() => {
    fired.current = { sl: false, tp: false };
  }, [entryPrice, isBuy]);
  useEffect(() => {
    if (frozen || entryPrice <= 0) return;
    if (!fired.current.sl && ltpFav <= stopFav) {
      fired.current.sl = true;
      slRef.current?.();
    }
    if (!fired.current.tp && ltpFav >= tpFav) {
      fired.current.tp = true;
      tpRef.current?.();
    }
  }, [ltpFav, stopFav, tpFav, entryPrice, frozen]);

  // "TSL running" mm:ss clock (re-render each second while live).
  const [, tick] = useState(0);
  const tslRunning = !!tslActivatedAt && !frozen;
  useEffect(() => {
    if (!tslRunning) return;
    const id = setInterval(() => tick((n) => (n + 1) % 86_400), 1000);
    return () => clearInterval(id);
  }, [tslRunning]);
  const tslSec = tslActivatedAt ? Math.max(0, Math.floor((Date.now() - tslActivatedAt) / 1000)) : 0;
  const tslClock = `${String(Math.floor(tslSec / 60)).padStart(2, "0")}:${String(tslSec % 60).padStart(2, "0")}`;

  if (!(entryPrice > 0)) return null;

  // ── Scale: tight to the trade's own levels (stop … TP), entry sits
  // proportionally so RISK and REWARD widths read as true rupee ratios.
  // Auto-extends only if the LTP runs past a bound so the pointer stays on. ─
  const lowRaw = Math.min(stopFav, 0, ltpFav);
  const highRaw = Math.max(tpFav, 0, ltpFav);
  const pad = Math.max((highRaw - lowRaw) * 0.05, 0.3);
  const lo = lowRaw - pad;
  const hi = highRaw + pad;
  const pos = (fav: number) => clamp(((fav - lo) / (hi - lo)) * 100);

  const stopPos = pos(stopFav);
  const entryPos = pos(0);
  const tpPos = pos(tpFav);
  const ltpPos = pos(ltpFav);
  const inProfit = ltpFav >= 0;

  // Colour bands (left→right): risk (or locked-profit) then reward base, with
  // a solid P&L fill from entry to the LTP painted on top.
  const bands: Array<{ from: number; to: number; color: string; op?: number }> = [];
  if (stopLocked) {
    bands.push({ from: entryPos, to: stopPos, color: TSL_C, op: 0.28 }); // locked profit
  } else {
    bands.push({ from: stopPos, to: entryPos, color: RISK, op: 0.18 }); // at-risk
  }
  bands.push({ from: entryPos, to: tpPos, color: REWARD, op: 0.14 }); // reward base
  // P&L fill: entry → LTP, solid, coloured by profit/loss.
  bands.push({ from: entryPos, to: ltpPos, color: inProfit ? REWARD : RISK, op: 0.6 });

  const stopColor = stopLocked ? TSL_C : RISK;
  const Tick = ({ at, color, tip, tall }: { at: number; color: string; tip: string; tall?: boolean }) => (
    <div
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 cursor-help transition-[left] duration-300 ease-out"
      style={{ left: `${at}%`, width: "10px", height: "18px" }}
      title={tip}
    >
      <div
        className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 rounded-[1px]"
        style={{ width: "2px", height: tall ? "16px" : "12px", background: color }}
      />
    </div>
  );

  const pnlColor = inProfit ? REWARD : RISK;
  const distToTp = Math.max(0, tpFav - ltpFav);
  const distToStop = Math.max(0, ltpFav - stopFav);

  return (
    <div
      className={`relative w-full ${className ?? ""}`}
      role="progressbar"
      aria-label="Trade risk/reward position"
      aria-valuenow={Math.round(ltp)}
    >
      {/* Readout row (1b + 3a) — one state-aware line. Hidden in compact. */}
      {!compact && (
        <div className="flex items-baseline gap-2 mb-1 leading-none">
          <span className="text-[0.6875rem] font-bold tabular-nums" style={{ color: pnlColor }}>
            {pnl != null ? fmtMoney(pnl) : fmtPct(ltpFav)}
          </span>
          {pnl != null && (
            <span className="text-[0.5625rem] font-semibold tabular-nums" style={{ color: pnlColor }}>
              {fmtPct(ltpFav)}
            </span>
          )}
          <span className="ml-auto text-[0.5625rem] font-medium tabular-nums text-muted-foreground">
            {stopLocked ? (
              <span style={{ color: TSL_C }}>TSL {tslRunning ? `· ${tslClock}` : "locked"}</span>
            ) : rr != null ? (
              <span title="Reward ∶ risk at entry">RR {rr.toFixed(2)}</span>
            ) : null}
            {distToTp > 0.05 && <span> · {distToTp.toFixed(1)}% to TP</span>}
          </span>
        </div>
      )}

      {/* The bar */}
      <div className="relative w-full h-2">
        <div className="absolute inset-0 rounded-full overflow-hidden" style={{ background: TRACK }}>
          {bands.map((b, i) => {
            const left = clamp(Math.min(b.from, b.to));
            const width = clamp(Math.abs(b.to - b.from));
            if (width <= 0.2) return null;
            return (
              <div
                key={i}
                className="absolute top-0 bottom-0 transition-[left,width] duration-300 ease-out"
                style={{ left: `${left}%`, width: `${width}%`, background: b.color, opacity: b.op ?? 1 }}
              />
            );
          })}
        </div>

        {/* Markers */}
        <div className="absolute inset-0 pointer-events-none [&>*]:pointer-events-auto">
          <Tick at={stopPos} color={stopColor} tall tip={`${isTsl ? "Trailing stop" : "Stop loss"} ${formatPrice(entryPrice * (1 + (isBuy ? stopFav : -stopFav) / 100))} (${fmtPct(stopFav)})${stopLocked ? " · locked in profit" : ""}`} />
          <Tick at={entryPos} color={ENTRY_C} tip={`Entry ${formatPrice(entryPrice)}`} />
          <Tick at={tpPos} color={REWARD} tall tip={`Target ${formatPrice(entryPrice * (1 + (isBuy ? tpFav : -tpFav) / 100))} (${fmtPct(tpFav)})`} />
        </div>

        {/* LTP pointer + live price */}
        <div
          className="absolute -translate-x-1/2 pointer-events-auto cursor-help transition-[left] duration-300 ease-out"
          style={{ left: `${ltpPos}%`, top: "-7px" }}
          title={`LTP ${formatPrice(ltp)} (${fmtPct(ltpFav)})`}
        >
          <span
            className="absolute left-1/2 -translate-x-1/2 -top-2.5 text-[0.5rem] font-bold tabular-nums leading-none whitespace-nowrap"
            style={{ color: pnlColor }}
          >
            {scalePrice(ltp)}
          </span>
          <div
            className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent"
            style={{ borderTopColor: pnlColor }}
          />
        </div>
      </div>

      {/* Marker prices below (hidden in compact) */}
      {!compact && (
        <div className="relative w-full mt-1 h-4">
          <span
            className="absolute -translate-x-1/2 flex flex-col items-center gap-px leading-none transition-[left] duration-300 ease-out"
            style={{ left: `${clamp(stopPos, 5, 95)}%`, color: stopColor }}
          >
            <span className="text-[0.5rem] font-bold">{stopName}</span>
            <span className="text-[0.5rem] font-bold tabular-nums">{scalePrice(entryPrice * (1 + (isBuy ? stopFav : -stopFav) / 100))}</span>
          </span>
          <span
            className="absolute -translate-x-1/2 flex flex-col items-center gap-px leading-none"
            style={{ left: `${clamp(entryPos, 5, 95)}%`, color: ENTRY_C }}
          >
            <span className="text-[0.5rem] font-bold">E</span>
            <span className="text-[0.5rem] font-bold tabular-nums">{scalePrice(entryPrice)}</span>
          </span>
          <span
            className="absolute -translate-x-1/2 flex flex-col items-center gap-px leading-none"
            style={{ left: `${clamp(tpPos, 5, 95)}%`, color: REWARD }}
          >
            <span className="text-[0.5rem] font-bold">TP</span>
            <span className="text-[0.5rem] font-bold tabular-nums">{scalePrice(entryPrice * (1 + (isBuy ? tpFav : -tpFav) / 100))}</span>
          </span>
        </div>
      )}
    </div>
  );
}
