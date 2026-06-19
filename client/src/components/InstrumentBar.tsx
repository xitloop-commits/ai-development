/**
 * InstrumentBar — the per-instrument bar in the TradingDesk instrument column.
 *
 * It is ALWAYS the strike scale (StrikeBar) — it never flips to a trade view.
 * Layout: `[caption?] | expiry | CE/PE | LONG/SHORT | StrikeBar`. Each trade
 * taken leaves a persistent marker on the StrikeBar (via `strike.tradeMarkers`);
 * the live trade detail (SL/entry/TSL/TP) is shown by a separate `TradeBar`
 * instance in the trade rows (TodayTradeRow), not here.
 */

import { useEffect, useState } from "react";
import { InstrumentTag } from "./InstrumentTag";
import { StrikeBar, type StrikeBarProps } from "./StrikeBar";

export type OptionSide = "CE" | "PE";
export type TradeDirection = "LONG" | "SHORT";

export interface InstrumentBarProps {
  /** Optional caption (TodaySection usually renders the name in its own cell). */
  name?: string;
  /** Expiry chip shown before the CE/PE toggle. */
  expiry?: string;
  side?: OptionSide;
  onSideChange?: (side: OptionSide) => void;
  direction?: TradeDirection;
  onDirectionChange?: (direction: TradeDirection) => void;
  /** Strike-scale props (the bar is always the strike scale). */
  strike: StrikeBarProps;
  /** Enter at the live premium. When set, the LONG/SHORT toggle doubles as the
   *  entry trigger: Ctrl+hover flips the button to "ENTER", Ctrl+click places in
   *  that button's direction. */
  onEnter?: (direction: TradeDirection) => void;
  /** Disable ENTER (e.g. no live premium yet). */
  enterDisabled?: boolean;
  /** Stack the layout: controls on top, StrikeBar full-width on its own row. */
  stacked?: boolean;
  /** Days left to expiry — shown as a small badge just before ENTER (stacked). */
  expiryDaysLeft?: number | null;
  /** Optional element rendered on the RIGHT of the controls row (e.g. the
   *  CE/PE capital-required block), left of the days badge + LONG/SHORT toggle. */
  rightSlot?: React.ReactNode;
  className?: string;
}

export function InstrumentBar({
  name,
  expiry,
  side = "CE",
  onSideChange,
  direction = "LONG",
  onDirectionChange,
  strike,
  onEnter,
  enterDisabled,
  stacked,
  expiryDaysLeft,
  rightSlot,
  className,
}: InstrumentBarProps) {
  const [activeSide, setActiveSide] = useState<OptionSide>(side);
  const [activeDirection, setActiveDirection] = useState<TradeDirection>(direction);
  useEffect(() => setActiveSide(side), [side]);
  useEffect(() => setActiveDirection(direction), [direction]);

  // The LONG/SHORT toggle doubles as the entry trigger (when onEnter is set):
  // plain click selects the direction; with Ctrl held, the hovered button flips
  // to "ENTER" (armed cue) and a Ctrl+click places at the live premium in THAT
  // button's direction. Ctrl-guarded so a stray click can't fire a trade.
  const [hoverDir, setHoverDir] = useState<TradeDirection | null>(null);
  const [ctrlDown, setCtrlDown] = useState(false);
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setCtrlDown(e.ctrlKey || e.metaKey);
    const clear = () => setCtrlDown(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);
  const selectSide = (s: OptionSide) => {
    setActiveSide(s);
    onSideChange?.(s);
  };
  const selectDirection = (d: TradeDirection) => {
    setActiveDirection(d);
    onDirectionChange?.(d);
  };

  const toggleBtn = "px-1 py-0.5 rounded text-[0.5625rem] font-bold transition-colors";

  const caption = (
    <>
      {name && (
        <div className="shrink-0 text-xs">
          <InstrumentTag name={name} />
        </div>
      )}
      {!stacked && expiry && (
        <span className="shrink-0 rounded border border-border/50 px-1 py-0.5 text-[0.5625rem] font-bold tabular-nums text-muted-foreground">
          {expiry}
        </span>
      )}
      <div className="shrink-0 flex items-center gap-0.5 rounded border border-border/50 px-0.5 py-0.5">
        {(["CE", "PE"] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => selectSide(opt)}
            className={`${toggleBtn} ${
              activeSide === opt ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </>
  );

  // LONG/SHORT toggle = direction selector + Ctrl-armed ENTER.
  const dirToggle = (
    <div className="shrink-0 flex items-center gap-0.5 rounded border border-border/50 px-0.5 py-0.5">
      {(["LONG", "SHORT"] as const).map((opt) => {
        const armed = !!onEnter && ctrlDown && hoverDir === opt && !enterDisabled;
        const active = activeDirection === opt;
        let cls: string;
        if (armed) {
          cls = opt === "LONG"
            ? "bg-bullish/30 text-bullish ring-1 ring-bullish"
            : "bg-destructive/30 text-destructive ring-1 ring-destructive";
        } else if (active) {
          cls = opt === "LONG" ? "bg-bullish/20 text-bullish" : "bg-destructive/20 text-destructive";
        } else {
          cls = "text-muted-foreground hover:text-foreground";
        }
        return (
          <button
            key={opt}
            type="button"
            onMouseEnter={() => setHoverDir(opt)}
            onMouseLeave={() => setHoverDir((d) => (d === opt ? null : d))}
            onClick={(e) => {
              if (onEnter && (e.ctrlKey || e.metaKey)) {
                if (!enterDisabled) onEnter(opt);
              } else {
                selectDirection(opt);
              }
            }}
            title={onEnter ? `${opt} — Ctrl+click to ENTER at the live market price` : opt}
            className={`${toggleBtn} ${cls}`}
          >
            {armed ? "ENTER" : opt}
          </button>
        );
      })}
    </div>
  );

  const daysBadge =
    expiryDaysLeft != null ? (
      <span
        className="shrink-0 rounded border border-border/50 px-1 py-0.5 text-[0.5625rem] font-bold tabular-nums text-muted-foreground"
        title="Days to expiry"
      >
        {expiryDaysLeft}d
      </span>
    ) : null;

  const barEl = <StrikeBar {...strike} side={activeSide} />;

  if (stacked) {
    // Controls on top (LONG/SHORT-as-ENTER pushed right, days-to-expiry before
    // it); StrikeBar on its own full-width row (so all strikes show).
    return (
      <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
        <div className="flex items-center gap-2">
          {caption}
          <div className="ml-auto flex items-center gap-2">
            {rightSlot}
            {daysBadge}
            {dirToggle}
          </div>
        </div>
        <div className="relative w-full min-w-0">{barEl}</div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      {caption}
      {rightSlot}
      {dirToggle}
      <div className="relative flex-1 min-w-0">{barEl}</div>
      {daysBadge}
    </div>
  );
}
