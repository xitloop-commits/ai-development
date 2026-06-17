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
  /** Ctrl+click "ENTER at market" — places the selected CE/PE × LONG/SHORT at
   *  the live premium. Hidden when not provided. */
  onEnter?: () => void;
  /** Disable ENTER (e.g. no live premium yet). */
  enterDisabled?: boolean;
  /** Stack the layout: controls on top, StrikeBar full-width on its own row. */
  stacked?: boolean;
  /** Days left to expiry — shown as a small badge just before ENTER (stacked). */
  expiryDaysLeft?: number | null;
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
  className,
}: InstrumentBarProps) {
  const [activeSide, setActiveSide] = useState<OptionSide>(side);
  const [activeDirection, setActiveDirection] = useState<TradeDirection>(direction);
  useEffect(() => setActiveSide(side), [side]);
  useEffect(() => setActiveDirection(direction), [direction]);

  // ENTER button is Ctrl-guarded: it only fires on a Ctrl(/Cmd)+click, and
  // lights up green/red (by direction) only while hovered AND Ctrl is held —
  // a clear "armed" cue so a stray click can't place a trade.
  const [enterHover, setEnterHover] = useState(false);
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
  const enterArmed = enterHover && ctrlDown && !enterDisabled;
  const isLong = activeDirection === "LONG";
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
    </>
  );

  const enterBtn = onEnter ? (
    <button
      type="button"
      disabled={enterDisabled}
      onMouseEnter={() => setEnterHover(true)}
      onMouseLeave={() => setEnterHover(false)}
      onClick={(e) => {
        if (!enterDisabled && (e.ctrlKey || e.metaKey)) onEnter();
      }}
      title="Hold Ctrl and click to enter at the live market price"
      className={`shrink-0 px-2 py-0.5 rounded text-[0.5625rem] font-bold border transition-colors ${
        enterDisabled
          ? "opacity-40 cursor-not-allowed border-border/50 text-muted-foreground"
          : enterArmed
            ? isLong
              ? "bg-bullish/25 text-bullish border-bullish/50"
              : "bg-destructive/25 text-destructive border-destructive/50"
            : "border-border/50 text-muted-foreground hover:text-foreground"
      }`}
    >
      ENTER
    </button>
  ) : null;

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
    // Controls on top (ENTER pushed to the right, days-to-expiry just before it);
    // StrikeBar on its own full-width row (so all strikes show).
    return (
      <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
        <div className="flex items-center gap-2">
          {caption}
          <div className="ml-auto flex items-center gap-2">
            {daysBadge}
            {enterBtn}
          </div>
        </div>
        <div className="relative w-full min-w-0">{barEl}</div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      {caption}
      <div className="relative flex-1 min-w-0">{barEl}</div>
      {daysBadge}
      {enterBtn}
    </div>
  );
}
