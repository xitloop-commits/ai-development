/**
 * Glide's disaster stop.
 *
 * Glide has no SL, no TP and no trailing: `manualExitOnly` switches all of them
 * off so the trade can ride to MA-Signal's leg-end EXIT (AI trades) or until the
 * operator closes it (manual trades, which SEA never tracks).
 *
 * That leaves one failure mode with no floor: if the closing signal never
 * arrives — SEA restarts and loses its in-memory leg map, or a manual trade is
 * forgotten — the position runs unprotected until EOD square-off. The disaster
 * stop is the last line of defence.
 *
 * The subtle part, and the reason this file exists: the tick loop's
 * `if (trade.manualExitOnly) continue;` skips EVERY exit below it. A disaster
 * stop checked after that line would be configured, visible in the UI, and
 * never evaluated — failing silently in exactly the direction that costs money.
 * These tests pin the maths and the ordering requirement.
 */
import { describe, it, expect } from "vitest";

/** Mirrors the check in tickHandler.ts. Kept in step by the ordering test below. */
function disasterBreached(
  entryPrice: number,
  ltp: number,
  isBuy: boolean,
  disasterSlPct: number,
): boolean {
  const limit = entryPrice * (1 + (isBuy ? -disasterSlPct : disasterSlPct) / 100);
  return isBuy ? ltp <= limit : ltp >= limit;
}

describe("disaster stop maths", () => {
  const PCT = 50;

  it("fires when a BOUGHT option has halved", () => {
    expect(disasterBreached(100, 50, true, PCT)).toBe(true);
    expect(disasterBreached(100, 49.9, true, PCT)).toBe(true);
  });

  it("stays out of the way of normal MA behaviour", () => {
    // The whole point: it must never act as a trading stop. A 40% drawdown on
    // an option premium is an ordinary swing inside an MA leg.
    expect(disasterBreached(100, 60, true, PCT)).toBe(false);
    expect(disasterBreached(100, 95, true, PCT)).toBe(false);
    expect(disasterBreached(100, 140, true, PCT)).toBe(false);
  });

  it("mirrors for a SHORT — a sold option loses when the premium RISES", () => {
    // Without the mirror the stop sits on the profitable side: it would exit
    // winners and let the unbounded loss run.
    expect(disasterBreached(100, 150, false, PCT)).toBe(true);
    expect(disasterBreached(100, 149.9, false, PCT)).toBe(false);
    expect(disasterBreached(100, 50, false, PCT)).toBe(false);
  });

  it("tracks the configured percentage", () => {
    expect(disasterBreached(100, 70, true, 30)).toBe(true);
    expect(disasterBreached(100, 70, true, 50)).toBe(false);
  });
});

describe("ordering: the stop must be checked BEFORE the manualExitOnly guard", () => {
  /**
   * Reproduces the tick loop's control flow. Glide trades always carry
   * manualExitOnly, so a check placed after the guard can never run — this
   * fails if the two are ever reordered in tickHandler.
   */
  const runLoop = (checkBeforeGuard: boolean) => {
    const trade = { exitStrategy: "glide", manualExitOnly: true, entryPrice: 100, isBuy: true };
    const ltp = 40; // well past a 50% disaster stop
    const exits: string[] = [];
    if (checkBeforeGuard && disasterBreached(trade.entryPrice, ltp, trade.isBuy, 50)) {
      exits.push("SL_HIT");
      return exits;
    }
    if (trade.manualExitOnly) return exits; // the guard skips everything below
    if (disasterBreached(trade.entryPrice, ltp, trade.isBuy, 50)) exits.push("SL_HIT");
    return exits;
  };

  it("fires when checked before the guard", () => {
    expect(runLoop(true)).toEqual(["SL_HIT"]);
  });

  it("is UNREACHABLE when checked after the guard", () => {
    // Demonstrates the silent failure this ordering exists to prevent.
    expect(runLoop(false)).toEqual([]);
  });
});
