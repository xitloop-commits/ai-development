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
