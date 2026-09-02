/**
 * ChainStrip — the NARROW option-chain column of the per-instrument window
 * (T173, Partha 2026-09-01). Decision data only:
 *
 *   CALL side (resistance, red) │ STRIKE │ PUT side (support, green)
 *   OI bar (scaled to the chain's biggest OI on that side) + OI in lakhs,
 *   5-min OI change tinted (building = brighter, unwinding = dim),
 *   LTP · delta as ₹/pt · decay as ₹/hr — decay coloured red when it beats the
 *   move a typical hour pays (ratio > 1), amber when it's half-way there.
 *   Footer: PCR + max pain.
 *
 * Two layouts:
 *   • list (default) — ATM ±N rows stacked top-down.
 *   • ALIGNED (`alignTo`) — each strike row sits at that price's height on the
 *     underlying chart's price scale (Partha: "align the strikes with the
 *     underlying's price scale"), so the OI walls on the chart and the OI bars
 *     here read straight across. The chart publishes its price→Y mapping on
 *     the priceMapBus; rows follow zoom / scroll / autoscale live. When strikes
 *     get too close for a full row the cells shrink to 2 lines, then 1, then
 *     alternate strikes are dropped (nearest-to-spot kept). A dashed cyan
 *     line marks the spot. Falls back to the list until the chart is ready.
 *
 * Volume / bid-ask / gamma-theta-vega are deliberately absent (execution data,
 * not decision data).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { subscribePriceMap, type PriceMap } from "@/lib/priceMapBus";

const lakhs = (oi: number) => (oi >= 1e5 ? `${(oi / 1e5).toFixed(1)}L` : oi >= 1e3 ? `${(oi / 1e3).toFixed(0)}K` : String(oi));
const signed = (n: number) => (n > 0 ? `+${lakhs(n)}` : n < 0 ? `−${lakhs(-n)}` : "0");

type Leg = {
  ltp: number; oi: number; oiChg5m: number | null; iv: number;
  perPt: number | null; decayHr: number | null; decayRatio: number | null;
};
type Row = { strike: number; isAtm: boolean; ce: Leg; pe: Leg };

/** How much of a row fits between neighbouring strikes: 3 = full, 2 = no decay
 *  line, 1 = a single "OI · LTP" line. */
type Density = 1 | 2 | 3;
const ROW_PX: Record<Density, number> = { 3: 48, 2: 30, 1: 13 };

function decayTone(ratio: number | null): string {
  if (ratio == null) return "text-muted-foreground";
  if (ratio > 1) return "text-red-400 font-bold";
  if (ratio > 0.5) return "text-amber-400";
  return "text-muted-foreground";
}

function LegCell({ leg, max, side, density = 3 }: { leg: Leg; max: number; side: "CE" | "PE"; density?: Density }) {
  const pct = max > 0 ? Math.min(100, (leg.oi / max) * 100) : 0;
  const bar = side === "CE" ? "bg-red-500/45" : "bg-emerald-500/45";
  const chg = leg.oiChg5m;
  const chgTone = chg == null ? "text-muted-foreground/60" : chg > 0 ? (side === "CE" ? "text-red-300" : "text-emerald-300") : chg < 0 ? "text-muted-foreground/70" : "text-muted-foreground/60";
  const pad = density === 1 ? "px-1" : "px-1 py-0.5";
  return (
    <div className={`relative min-w-0 ${pad} ${side === "CE" ? "text-right" : "text-left"}`}>
      {/* OI bar grows toward the strike column: CE from the left edge, PE from the right */}
      <div
        className={`absolute ${density === 1 ? "inset-y-0" : "inset-y-0.5"} ${bar} rounded-sm`}
        style={side === "CE" ? { right: 0, width: `${pct}%` } : { left: 0, width: `${pct}%` }}
      />
      <div className="relative z-10 leading-tight">
        {density === 1 ? (
          <div className="whitespace-nowrap text-[0.5625rem] tabular-nums leading-[13px]">
            <span className="font-semibold">{lakhs(leg.oi)}</span>
            <span className="ml-1 text-foreground/80">{leg.ltp.toFixed(1)}</span>
          </div>
        ) : (
          <>
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
            {density === 3 && (
              <div className={`text-[0.5625rem] tabular-nums ${decayTone(leg.decayRatio)}`}
                title="Decay: ₹ lost per trading hour. Red = decay beats what a typical hour's move pays (decay trap); amber = half-way.">
                {leg.decayHr != null ? `−${leg.decayHr.toFixed(2)}/hr` : "—"}
                <span className="ml-1 opacity-70">IV {leg.iv.toFixed(1)}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StrikeRow({ r, maxCallOi, maxPutOi, density = 3, className = "", style }: {
  r: Row; maxCallOi: number; maxPutOi: number; density?: Density; className?: string; style?: React.CSSProperties;
}) {
  return (
    <div
      className={`grid grid-cols-[1fr_auto_1fr] items-stretch ${r.isAtm ? "bg-info-cyan/10" : ""} ${className}`}
      style={style}
    >
      <LegCell leg={r.ce} max={maxCallOi} side="CE" density={density} />
      <div
        className={`flex items-center px-1.5 font-bold tabular-nums ${density === 1 ? "text-[0.625rem]" : ""} ${r.isAtm ? "text-info-cyan" : ""}`}
        title={r.isAtm ? "ATM" : ""}
      >
        {r.strike}
      </div>
      <LegCell leg={r.pe} max={maxPutOi} side="PE" density={density} />
    </div>
  );
}

export function ChainStrip({ instrument, around = 5, alignTo, date }: {
  instrument: string; around?: number; alignTo?: string;
  /** Review a past day: serve that date's recorded chain instead of the live one. */
  date?: string;
}) {
  const q = trpc.trading.chainStrip.useQuery(
    { instrument, around, date },
    { refetchInterval: 15_000, refetchOnWindowFocus: false },
  );
  const d = q.data;
  const asOf = useMemo(() => (d ? new Date(d.asOf).toLocaleTimeString("en-GB", { hour12: false }) : ""), [d]);

  // ── Aligned mode: follow the underlying chart's price scale ──────────────
  const [pm, setPm] = useState<PriceMap | null>(null);
  useEffect(() => {
    if (!alignTo) { setPm(null); return; }
    return subscribePriceMap(alignTo, setPm);
  }, [alignTo]);
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) { setArea(null); return; }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setArea((prev) => (prev && prev.top === r.top && prev.height === r.height ? prev : { top: r.top, height: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pm, d]);

  const placed = useMemo(() => {
    if (!alignTo || !pm || !area || !d || d.rows.length < 2) return null;
    const rows = d.rows as Row[];
    const step = Math.abs(rows[0].strike - rows[1].strike) || 1;
    const y0 = pm.toClientY(d.spot);
    const y1 = pm.toClientY(d.spot + step);
    if (y0 == null || y1 == null) return null;
    const spacing = Math.abs(y1 - y0);
    const density: Density = spacing >= ROW_PX[3] ? 3 : spacing >= ROW_PX[2] ? 2 : 1;
    const minGap = ROW_PX[density];
    // Nearest-to-spot first so thinning drops the far strikes, never the ATM.
    const cands = rows
      .map((r) => ({ r, y: pm.toClientY(r.strike) }))
      .filter((c): c is { r: Row; y: number } => c.y != null)
      .map((c) => ({ r: c.r, y: c.y - area.top }))
      .filter((c) => c.y >= 0 && c.y <= area.height)
      .sort((a, b) => Math.abs(a.r.strike - d.spot) - Math.abs(b.r.strike - d.spot));
    const kept: { r: Row; y: number }[] = [];
    for (const c of cands) {
      if (kept.every((k) => Math.abs(k.y - c.y) >= minGap)) kept.push(c);
    }
    const spotY = y0 - area.top;
    return { kept, density, spotY: spotY >= 0 && spotY <= area.height ? spotY : null };
  }, [alignTo, pm, area, d]);

  if (!d) {
    return (
      <div className="flex h-full items-center justify-center px-2 text-center text-[0.625rem] text-muted-foreground">
        {q.isLoading ? "Loading chain…" : "Chain unavailable (broker/token)."}
      </div>
    );
  }

  const header = (
    <>
      <div className="flex items-baseline justify-between px-1 pb-1 text-[0.625rem] text-muted-foreground">
        <span>spot <b className="text-foreground tabular-nums">{d.spot.toFixed(1)}</b></span>
        <span>exp {d.expiry.slice(5)}</span>
        {d.snapshotDate ? (
          <span className="text-amber-400" title={`Recorded chain snapshot from ${d.snapshotDate} (live chain unavailable)`}>
            snap {d.snapshotDate.slice(5)} {asOf.slice(0, 5)}
          </span>
        ) : (
          <span>{asOf}</span>
        )}
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center px-1 pb-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="text-right text-red-400/80">Call · OI · ₹/pt · decay</span>
        <span className="px-1">Strike</span>
        <span className="text-emerald-400/80">Put · OI · ₹/pt · decay</span>
      </div>
    </>
  );
  const footer = (
    <div className="flex items-center justify-between border-t border-border/60 px-1 pt-1 text-[0.625rem] tabular-nums text-muted-foreground">
      <span title="Put-call ratio (total put OI ÷ total call OI)">PCR <b className="text-foreground">{d.pcr != null ? d.pcr.toFixed(2) : "—"}</b></span>
      <span title="Strike where option writers' total payout is lowest">max pain <b className="text-foreground">{d.maxPain ?? "—"}</b></span>
    </div>
  );

  // Aligned layout only when at least one strike actually fits the chart's
  // visible price range — pre-open the range is a single tick wide, so every
  // strike is off-scale; the plain list is more useful than an empty column.
  if (alignTo && placed && placed.kept.length > 0) {
    return (
      <div className="relative h-full min-h-0 text-xs">
        {/* Rows are placed at the chart's price heights; header/footer float over the ends. */}
        <div ref={areaRef} className="absolute inset-0 overflow-hidden">
          {placed?.kept.map(({ r, y }) => (
            <div key={r.strike} className="absolute inset-x-0" style={{ top: y }}>
              {/* hairline at the exact strike price, ties the row to the chart's wall line */}
              <div className="absolute inset-x-0 top-0 border-t border-border/40" />
              <StrikeRow
                r={r}
                maxCallOi={d.maxCallOi}
                maxPutOi={d.maxPutOi}
                density={placed.density}
                className="absolute inset-x-0 -translate-y-1/2"
              />
            </div>
          ))}
          {placed?.spotY != null && (
            <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top: placed.spotY }} title="Spot">
              <div className="absolute inset-x-0 top-0 border-t border-dashed border-info-cyan/80" />
              <span className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-info-cyan px-1 text-[0.5625rem] font-bold tabular-nums text-black">
                {d.spot.toFixed(1)}
              </span>
            </div>
          )}
        </div>
        <div className="absolute inset-x-0 top-0 z-30 bg-background/85 backdrop-blur-[1px]">{header}</div>
        <div className="absolute inset-x-0 bottom-0 z-30 bg-background/85 pb-0.5 backdrop-blur-[1px]">{footer}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(d.rows as Row[]).map((r) => (
          <StrikeRow key={r.strike} r={r} maxCallOi={d.maxCallOi} maxPutOi={d.maxPutOi} className="border-t border-border/40" />
        ))}
      </div>
      {footer}
    </div>
  );
}
