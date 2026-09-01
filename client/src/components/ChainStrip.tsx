/**
 * ChainStrip — the NARROW option-chain column of the per-instrument window
 * (T173, Partha 2026-09-01). Decision data only, ATM ±5:
 *
 *   CALL side (resistance, red) │ STRIKE │ PUT side (support, green)
 *   OI bar (scaled to the chain's biggest OI on that side) + OI in lakhs,
 *   5-min OI change tinted (building = brighter, unwinding = dim),
 *   LTP · delta as ₹/pt · decay as ₹/hr — decay coloured red when it beats the
 *   move a typical hour pays (ratio > 1), amber when it's half-way there.
 *   Footer: PCR + max pain.
 *
 * Volume / bid-ask / gamma-theta-vega are deliberately absent (execution data,
 * not decision data).
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";

const lakhs = (oi: number) => (oi >= 1e5 ? `${(oi / 1e5).toFixed(1)}L` : oi >= 1e3 ? `${(oi / 1e3).toFixed(0)}K` : String(oi));
const signed = (n: number) => (n > 0 ? `+${lakhs(n)}` : n < 0 ? `−${lakhs(-n)}` : "0");

type Leg = {
  ltp: number; oi: number; oiChg5m: number | null; iv: number;
  perPt: number | null; decayHr: number | null; decayRatio: number | null;
};

function decayTone(ratio: number | null): string {
  if (ratio == null) return "text-muted-foreground";
  if (ratio > 1) return "text-red-400 font-bold";
  if (ratio > 0.5) return "text-amber-400";
  return "text-muted-foreground";
}

function LegCell({ leg, max, side }: { leg: Leg; max: number; side: "CE" | "PE" }) {
  const pct = max > 0 ? Math.min(100, (leg.oi / max) * 100) : 0;
  const bar = side === "CE" ? "bg-red-500/45" : "bg-emerald-500/45";
  const chg = leg.oiChg5m;
  const chgTone = chg == null ? "text-muted-foreground/60" : chg > 0 ? (side === "CE" ? "text-red-300" : "text-emerald-300") : chg < 0 ? "text-muted-foreground/70" : "text-muted-foreground/60";
  return (
    <div className={`relative min-w-0 px-1 py-0.5 ${side === "CE" ? "text-right" : "text-left"}`}>
      {/* OI bar grows toward the strike column: CE from the left edge, PE from the right */}
      <div
        className={`absolute inset-y-0.5 ${bar} rounded-sm`}
        style={side === "CE" ? { right: 0, width: `${pct}%` } : { left: 0, width: `${pct}%` }}
      />
      <div className="relative z-10 leading-tight">
        <div className="text-[0.6875rem] tabular-nums">
          <span className="font-semibold">{lakhs(leg.oi)}</span>
          <span className={`ml-1 text-[0.5625rem] ${chgTone}`} title="OI change over ~5 min">{chg == null ? "…" : signed(chg)}</span>
        </div>
        <div className="text-[0.625rem] tabular-nums text-foreground/90">
          {leg.ltp.toFixed(2)}
          <span className="ml-1 text-muted-foreground" title="₹ the option moves per 1-point underlying move (delta)">
            {leg.perPt != null ? `${leg.perPt.toFixed(2)}/pt` : "—"}
          </span>
        </div>
        <div className={`text-[0.5625rem] tabular-nums ${decayTone(leg.decayRatio)}`}
          title="Decay: ₹ lost per trading hour. Red = decay beats what a typical hour's move pays (decay trap); amber = half-way.">
          {leg.decayHr != null ? `−${leg.decayHr.toFixed(2)}/hr` : "—"}
          <span className="ml-1 opacity-70">IV {leg.iv.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
}

export function ChainStrip({ instrument, around = 5 }: { instrument: string; around?: number }) {
  const q = trpc.trading.chainStrip.useQuery(
    { instrument, around },
    { refetchInterval: 15_000, refetchOnWindowFocus: false },
  );
  const d = q.data;
  const asOf = useMemo(() => (d ? new Date(d.asOf).toLocaleTimeString("en-GB", { hour12: false }) : ""), [d]);

  if (!d) {
    return (
      <div className="flex h-full items-center justify-center px-2 text-center text-[0.625rem] text-muted-foreground">
        {q.isLoading ? "Loading chain…" : "Chain unavailable (broker/token)."}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex items-baseline justify-between px-1 pb-1 text-[0.625rem] text-muted-foreground">
        <span>spot <b className="text-foreground tabular-nums">{d.spot.toFixed(1)}</b></span>
        <span>exp {d.expiry.slice(5)}</span>
        <span>{asOf}</span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center px-1 pb-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="text-right text-red-400/80">Call · OI · ₹/pt · decay</span>
        <span className="px-1">Strike</span>
        <span className="text-emerald-400/80">Put · OI · ₹/pt · decay</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {d.rows.map((r) => (
          <div
            key={r.strike}
            className={`grid grid-cols-[1fr_auto_1fr] items-stretch border-t border-border/40 ${r.isAtm ? "bg-info-cyan/10" : ""}`}
          >
            <LegCell leg={r.ce} max={d.maxCallOi} side="CE" />
            <div className={`flex items-center px-1.5 font-bold tabular-nums ${r.isAtm ? "text-info-cyan" : ""}`} title={r.isAtm ? "ATM" : ""}>
              {r.strike}
            </div>
            <LegCell leg={r.pe} max={d.maxPutOi} side="PE" />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border/60 px-1 pt-1 text-[0.625rem] tabular-nums text-muted-foreground">
        <span title="Put-call ratio (total put OI ÷ total call OI)">PCR <b className="text-foreground">{d.pcr != null ? d.pcr.toFixed(2) : "—"}</b></span>
        <span title="Strike where option writers' total payout is lowest">max pain <b className="text-foreground">{d.maxPain ?? "—"}</b></span>
      </div>
    </div>
  );
}
