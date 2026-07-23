/**
 * Withdraw — taking funds back out of a book.
 *
 * Context for the rules below: funding actions apply to the channel the
 * operator is VIEWING. They used to be hardcoded to 'live' on the client, so
 * adding or transferring funds while looking at Paper silently moved money in
 * the real-money book and the paper figure never budged. The channel is now
 * required input on every one of them.
 *
 * These pin the arithmetic. The over-withdrawal guard matters most: without it
 * a pool goes negative, and every downstream size calculation reads from it.
 */
import { describe, it, expect } from "vitest";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Mirrors the withdraw mutation in router.ts. */
function withdraw(
  state: { tradingPool: number; reservePool: number; initialFunding: number },
  amount: number,
  from: "trading" | "reserve",
) {
  const pool = from === "trading" ? state.tradingPool : state.reservePool;
  if (amount > pool) throw new Error(`Cannot withdraw ${amount} from ${from} — it holds ${pool}.`);
  return {
    tradingPool: from === "trading" ? r2(state.tradingPool - amount) : state.tradingPool,
    reservePool: from === "reserve" ? r2(state.reservePool - amount) : state.reservePool,
    initialFunding: Math.max(0, r2(state.initialFunding - amount)),
  };
}

const book = (trading: number, reserve = 0, funding = trading + reserve) => ({
  tradingPool: trading, reservePool: reserve, initialFunding: funding,
});

describe("withdraw arithmetic", () => {
  it("takes from the trading pool and leaves reserve alone", () => {
    const r = withdraw(book(100_000, 25_000), 30_000, "trading");
    expect(r.tradingPool).toBe(70_000);
    expect(r.reservePool).toBe(25_000);
  });

  it("takes from the reserve pool and leaves trading alone", () => {
    const r = withdraw(book(100_000, 25_000), 10_000, "reserve");
    expect(r.tradingPool).toBe(100_000);
    expect(r.reservePool).toBe(15_000);
  });

  it("reduces initialFunding so growth % stays honest", () => {
    // initialFunding is the denominator for growth. Leave it untouched and
    // taking money out would permanently understate performance.
    const r = withdraw(book(100_000), 40_000, "trading");
    expect(r.initialFunding).toBe(60_000);
  });

  it("floors initialFunding at zero when withdrawing profits", () => {
    // Book grew 100k → 150k; taking 120k out is more than was ever put in.
    // A negative denominator would invert the growth sign.
    const r = withdraw({ tradingPool: 150_000, reservePool: 0, initialFunding: 100_000 }, 120_000, "trading");
    expect(r.tradingPool).toBe(30_000);
    expect(r.initialFunding).toBe(0);
  });

  it("handles paise without drift", () => {
    const r = withdraw(book(1_000_000.32), 0.32, "trading");
    expect(r.tradingPool).toBe(1_000_000);
  });
});

describe("over-withdrawal is refused", () => {
  it("throws rather than driving the pool negative", () => {
    expect(() => withdraw(book(50_000), 50_000.01, "trading")).toThrow(/Cannot withdraw/);
  });

  it("refuses against the RIGHT pool, not the total", () => {
    // 100k total across the two pools, but reserve holds only 25k.
    expect(() => withdraw(book(75_000, 25_000), 40_000, "reserve")).toThrow(/Cannot withdraw/);
  });

  it("allows emptying a pool exactly", () => {
    expect(withdraw(book(50_000), 50_000, "trading").tradingPool).toBe(0);
  });

  it("refuses any withdrawal from an empty reserve", () => {
    // Every book currently sits at reserve 0 — injections only ever fed
    // Trading, despite the old UI claiming a 75/25 split.
    expect(() => withdraw(book(100_000, 0), 1, "reserve")).toThrow(/Cannot withdraw/);
  });
});
