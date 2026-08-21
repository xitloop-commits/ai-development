/**
 * T86 ④ — TradeBar draws SL / TSL / TP markers ONLY when the trade has that
 * real level. Previously slPercent/tpPercent defaulted to 5%/10%, so every bar
 * showed a phantom stop and target even when none was set. These tests lock the
 * gating: a marker's tooltip (Stop loss / TP) is present iff its % prop is
 * given. Entry + LTP are always present.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TradeBar } from "./TradeBar";

const base = { isBuy: true, entryPrice: 100, ltp: 105 };

function stopMarker() {
  return screen.queryByTitle(/^(Stop loss|Trailing stop) /);
}
function tpMarker() {
  return screen.queryByTitle(/^TP /);
}

describe("TradeBar — markers draw only when the real level exists (T86 ④)", () => {
  it("draws both SL and TP when both percentages are given", () => {
    render(<TradeBar {...base} slPercent={5} tpPercent={10} />);
    expect(stopMarker()).not.toBeNull();
    expect(tpMarker()).not.toBeNull();
    expect(screen.queryByTitle(/^Entry /)).not.toBeNull();
  });

  it("draws NO stop marker when slPercent is undefined", () => {
    render(<TradeBar {...base} tpPercent={10} />);
    expect(stopMarker()).toBeNull();     // no phantom 5% SL
    expect(tpMarker()).not.toBeNull();   // real TP still drawn
    expect(screen.queryByTitle(/^Entry /)).not.toBeNull();
  });

  it("draws NO take-profit marker when tpPercent is undefined", () => {
    render(<TradeBar {...base} slPercent={5} />);
    expect(tpMarker()).toBeNull();       // no phantom 10% TP
    expect(stopMarker()).not.toBeNull(); // real SL still drawn
  });

  it("draws neither SL nor TP when the trade has no levels — only Entry + LTP", () => {
    render(<TradeBar {...base} />);
    expect(stopMarker()).toBeNull();
    expect(tpMarker()).toBeNull();
    expect(screen.queryByTitle(/^Entry /)).not.toBeNull();
    expect(screen.queryByTitle(/^LTP /)).not.toBeNull();
  });

  it("labels a trailed-into-profit stop as TSL and still draws it", () => {
    // slPercent negative = stop above entry (trailed into profit).
    render(<TradeBar {...base} slPercent={-3} tpPercent={10} trailingEnabled />);
    expect(screen.queryByTitle(/^Trailing stop /)).not.toBeNull();
  });
});

/**
 * Cooling-window countdown — the mirror of the TSL stopwatch, sitting left of
 * the SL marker. Runway/Anchor hold a deliberately wide stop for coolingSec
 * after entry; the countdown says how long until it tightens.
 */
describe("TradeBar — cooling-window countdown", () => {
  function coolingClock() {
    return screen.queryByTitle(/^Cooling window /);
  }

  it("shows the remaining time while the cooling window is open", () => {
    render(<TradeBar {...base} slPercent={5} coolingEndsAt={Date.now() + 95_000} />);
    const el = coolingClock();
    expect(el).not.toBeNull();
    expect(el).toHaveTextContent("01:35");
  });

  it("does NOT show once the window has lapsed", () => {
    render(<TradeBar {...base} slPercent={5} coolingEndsAt={Date.now() - 1_000} />);
    expect(coolingClock()).toBeNull();
  });

  it("does NOT show when no cooling window is given (Sprint)", () => {
    render(<TradeBar {...base} slPercent={5} />);
    expect(coolingClock()).toBeNull();
  });

  it("does NOT show without a real stop marker to sit beside", () => {
    render(<TradeBar {...base} coolingEndsAt={Date.now() + 60_000} />);
    expect(coolingClock()).toBeNull();
  });

  it("is suppressed on a frozen (closed) bar", () => {
    render(<TradeBar {...base} slPercent={5} coolingEndsAt={Date.now() + 60_000} frozen />);
    expect(coolingClock()).toBeNull();
  });
});

/**
 * A closed trade keeps its bar as a frozen snapshot of how it finished. The
 * markers must still draw — a snapshot with no SL/TP/entry reference tells you
 * nothing about where the exit landed.
 */
describe("TradeBar — frozen snapshot (closed trade)", () => {
  it("still draws SL, TP and entry when frozen", () => {
    render(<TradeBar {...base} slPercent={5} tpPercent={10} frozen />);
    expect(stopMarker()).not.toBeNull();
    expect(tpMarker()).not.toBeNull();
  });

  it("suppresses the cooling countdown once frozen", () => {
    render(<TradeBar {...base} slPercent={5} coolingEndsAt={Date.now() + 60_000} frozen />);
    expect(screen.queryByTitle(/^Cooling window /)).toBeNull();
  });
});
