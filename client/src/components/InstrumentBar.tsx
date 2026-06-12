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
  className,
}: InstrumentBarProps) {
  const [activeSide, setActiveSide] = useState<OptionSide>(side);
  const [activeDirection, setActiveDirection] = useState<TradeDirection>(direction);
  useEffect(() => setActiveSide(side), [side]);
  useEffect(() => setActiveDirection(direction), [direction]);
  const selectSide = (s: OptionSide) => {
    setActiveSide(s);
    onSideChange?.(s);
  };
  const selectDirection = (d: TradeDirection) => {
    setActiveDirection(d);
    onDirectionChange?.(d);
  };

  const toggleBtn = "px-1 py-0.5 rounded text-[0.5625rem] font-bold transition-colors";

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      {name && (
        <div className="shrink-0 text-xs">
          <InstrumentTag name={name} />
        </div>
      )}

      {expiry && (
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

      <div className="shrink-0 flex items-center gap-0.5 rounded border border-border/50 px-0.5 py-0.5">
        {(["LONG", "SHORT"] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => selectDirection(opt)}
            className={`${toggleBtn} ${
              activeDirection === opt
                ? opt === "LONG"
                  ? "bg-bullish/20 text-bullish"
                  : "bg-destructive/20 text-destructive"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>

      <div className="relative flex-1 min-w-0">
        <StrikeBar {...strike} side={activeSide} />
      </div>
    </div>
  );
}
