/**
 * InstrumentBar — the per-instrument bar shown in the TradingDesk instrument
 * column. It owns the instrument-name caption (shown in EVERY state) and the
 * CE/PE + LONG/SHORT toggles (ready state), and picks the right inner bar:
 *
 *   ready  → StrikeBar  (rolling ITM/ATM/OTM strikes + underlying LTP pointer)
 *   open   → TradeBar   (live SL / entry / TSL / LTP / TP)
 *   closed → TradeBar   (frozen snapshot at close time — static, no timers)
 *
 * Layout: `caption | CE/PE | LONG/SHORT | bar`. State cycle:
 * ready → open → closed → ready. Iterate via InstrumentBar.stories.tsx.
 */

import { useEffect, useState } from "react";
import { InstrumentTag } from "./InstrumentTag";
import { StrikeBar, type StrikeBarProps } from "./StrikeBar";
import { TradeBar, type TradeBarProps } from "./TradeBar";

export type InstrumentBarState = "ready" | "open" | "closed";
export type OptionSide = "CE" | "PE";
export type TradeDirection = "LONG" | "SHORT";

export interface InstrumentBarProps {
  state: InstrumentBarState;
  /** Instrument name caption (e.g. "nifty50") — shown on the left in every state. */
  name?: string;
  /** Expiry label shown before the CE/PE toggle (ready state). */
  expiry?: string;
  /** Option side for the ready-state strike scale + the CE/PE toggle. Default CE. */
  side?: OptionSide;
  /** Fired when the user toggles CE/PE. */
  onSideChange?: (side: OptionSide) => void;
  /** Trade direction for the LONG/SHORT toggle. Default LONG. */
  direction?: TradeDirection;
  /** Fired when the user toggles LONG/SHORT. */
  onDirectionChange?: (direction: TradeDirection) => void;
  /** Ready-state strike scale props (required when state === "ready"). */
  strike?: StrikeBarProps;
  /** Open/closed-state trade props (required when state is "open"/"closed").
   *  `frozen` is set automatically from the state, so callers omit it. */
  trade?: Omit<TradeBarProps, "frozen">;
  className?: string;
}

export function InstrumentBar({
  state,
  name,
  expiry,
  side = "CE",
  onSideChange,
  direction = "LONG",
  onDirectionChange,
  strike,
  trade,
  className,
}: InstrumentBarProps) {
  const [activeSide, setActiveSide] = useState<OptionSide>(side);
  const [activeDirection, setActiveDirection] = useState<TradeDirection>(direction);
  // Keep in sync if the parent drives these.
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

  const inner =
    state === "ready"
      ? strike
        ? <StrikeBar {...strike} side={activeSide} />
        : null
      : trade
        ? <TradeBar {...trade} frozen={state === "closed"} />
        : null;

  if (!inner) return null;

  const toggleBtn = "px-1 py-0.5 rounded text-[0.5625rem] font-bold transition-colors";

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      {name && (
        <div className="shrink-0 text-xs">
          <InstrumentTag name={name} />
        </div>
      )}

      {/* Expiry + CE/PE + LONG/SHORT — only while choosing a trade (ready state) */}
      {state === "ready" && (
        <>
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
        </>
      )}

      <div className="relative flex-1 min-w-0">{inner}</div>
    </div>
  );
}
