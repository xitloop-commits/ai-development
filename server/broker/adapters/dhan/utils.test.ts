/**
 * Vitest tests for Dhan Adapter Utilities
 *
 * Tests:
 * - Trading symbol parser (hyphenated, compact, space-separated)
 * - Rate limiter (acquire, stats, per-second throttle)
 * - Limit price calculation (BUY offset, SELL offset, tick rounding)
 * - Bracket price calculation (SL/TP offsets)
 * - Retry wrapper (success, retry on network error, no retry on auth error)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseTradingSymbol,
  RateLimiter,
  calculateLimitPrice,
  calculateBracketPrices,
  withRetry,
  isRetryableError,
} from "./utils";

// ─── parseTradingSymbol ───────────────────────────────────────

describe("parseTradingSymbol", () => {
  it("should parse hyphenated option format: NIFTY-Apr2025-24000-CE", () => {
    const result = parseTradingSymbol("NIFTY-Apr2025-24000-CE");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("NIFTY");
    expect(result!.expiry).toBe("2025-04-01");
    expect(result!.strike).toBe(24000);
    expect(result!.optionType).toBe("CE");
  });

  it("should parse hyphenated PUT option: BANKNIFTY-Mar2025-50000-PE", () => {
    const result = parseTradingSymbol("BANKNIFTY-Mar2025-50000-PE");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("BANKNIFTY");
    expect(result!.expiry).toBe("2025-03-01");
    expect(result!.strike).toBe(50000);
    expect(result!.optionType).toBe("PE");
  });

  it("should parse hyphenated future format: NIFTY-Apr2025-FUT", () => {
    const result = parseTradingSymbol("NIFTY-Apr2025-FUT");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("NIFTY");
    expect(result!.expiry).toBe("2025-04-01");
    expect(result!.strike).toBe(0);
    expect(result!.optionType).toBe("FUT");
  });

  it("should parse compact option format: NIFTY25APR24000CE", () => {
    const result = parseTradingSymbol("NIFTY25APR24000CE");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("NIFTY");
    expect(result!.expiry).toBe("2025-04-01");
    expect(result!.strike).toBe(24000);
    expect(result!.optionType).toBe("CE");
  });

  it("should parse compact future format: NIFTY25APRFUT", () => {
    const result = parseTradingSymbol("NIFTY25APRFUT");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("NIFTY");
    expect(result!.expiry).toBe("2025-04-01");
    expect(result!.strike).toBe(0);
    expect(result!.optionType).toBe("FUT");
  });

  it("should parse space-separated option format: NIFTY 25 APR 24000 CE", () => {
    const result = parseTradingSymbol("NIFTY 25 APR 24000 CE");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("NIFTY");
    expect(result!.expiry).toBe("2025-04-01");
    expect(result!.strike).toBe(24000);
    expect(result!.optionType).toBe("CE");
  });

  it("should parse space-separated future format: NIFTY 25 APR FUT", () => {
    const result = parseTradingSymbol("NIFTY 25 APR FUT");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("NIFTY");
    expect(result!.expiry).toBe("2025-04-01");
    expect(result!.strike).toBe(0);
    expect(result!.optionType).toBe("FUT");
  });

  it("should parse MCX symbols: CRUDEOIL-Apr2025-5000-CE", () => {
    const result = parseTradingSymbol("CRUDEOIL-Apr2025-5000-CE");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("CRUDEOIL");
    expect(result!.strike).toBe(5000);
  });

  it("should return null for unparseable symbols", () => {
    expect(parseTradingSymbol("")).toBeNull();
    expect(parseTradingSymbol("RANDOM_STRING")).toBeNull();
    expect(parseTradingSymbol("12345")).toBeNull();
  });

  it("should handle BANKNIFTY compact format: BANKNIFTY25MAR50000PE", () => {
    const result = parseTradingSymbol("BANKNIFTY25MAR50000PE");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("BANKNIFTY");
    expect(result!.expiry).toBe("2025-03-01");
    expect(result!.strike).toBe(50000);
    expect(result!.optionType).toBe("PE");
  });
});

// ─── RateLimiter ──────────────────────────────────────────────

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(10, 250);
  });

  it("should allow requests under the limit", async () => {
    await limiter.acquire();
    const stats = limiter.getStats();
    expect(stats.lastSecond).toBe(1);
    expect(stats.lastMinute).toBe(1);
  });

  it("should track multiple requests", async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    const stats = limiter.getStats();
    expect(stats.lastSecond).toBeGreaterThanOrEqual(5);
    expect(stats.lastMinute).toBeGreaterThanOrEqual(5);
  });

  it("should reset stats", async () => {
    await limiter.acquire();
    await limiter.acquire();
    limiter.reset();
    const stats = limiter.getStats();
    expect(stats.lastSecond).toBe(0);
    expect(stats.lastMinute).toBe(0);
  });
});

// ─── calculateLimitPrice ──────────────────────────────────────

describe("calculateLimitPrice", () => {
  it("should calculate BUY limit price below LTP", () => {
    // LTP 100, offset 0.5% → 100 - 0.5 = 99.5
    const price = calculateLimitPrice(100, "BUY", 0.5, 0.05);
    expect(price).toBe(99.5);
  });

  it("should calculate SELL limit price above LTP", () => {
    // LTP 100, offset 0.5% → 100 + 0.5 = 100.5
    const price = calculateLimitPrice(100, "SELL", 0.5, 0.05);
    expect(price).toBe(100.5);
  });

  it("should round to tick size", () => {
    // LTP 100.123, offset 0% → should round to nearest tick (0.05)
    const price = calculateLimitPrice(100.123, "BUY", 0, 0.05);
    expect(price).toBeCloseTo(100.1, 2);
  });

  it("should handle zero offset", () => {
    const price = calculateLimitPrice(250, "BUY", 0, 0.05);
    expect(price).toBe(250);
  });

  it("should ensure minimum price of one tick", () => {
    // Very small LTP with large offset
    const price = calculateLimitPrice(0.01, "BUY", 99, 0.05);
    expect(price).toBe(0.05); // minimum tick
  });

  it("should handle large offsets for BUY", () => {
    // LTP 200, offset 2% → 200 - 4 = 196
    const price = calculateLimitPrice(200, "BUY", 2, 0.05);
    expect(price).toBe(196);
  });

  it("should handle large offsets for SELL", () => {
    // LTP 200, offset 2% → 200 + 4 = 204
    const price = calculateLimitPrice(200, "SELL", 2, 0.05);
    expect(price).toBe(204);
  });
});

// ─── calculateBracketPrices ───────────────────────────────────

describe("calculateBracketPrices", () => {
  it("should calculate SL and TP for BUY", () => {
    // Entry 100, SL 1%, TP 2%
    const { stopLoss, target } = calculateBracketPrices(100, "BUY", 1, 2, 0.05);
    expect(stopLoss).toBe(1); // 1% of 100 = 1
    expect(target).toBe(2); // 2% of 100 = 2
  });

  it("should calculate SL and TP for SELL", () => {
    // Entry 500, SL 0.5%, TP 1%
    const { stopLoss, target } = calculateBracketPrices(500, "SELL", 0.5, 1, 0.05);
    expect(stopLoss).toBe(2.5); // 0.5% of 500 = 2.5
    expect(target).toBe(5); // 1% of 500 = 5
  });

  it("should round to tick size", () => {
    // Entry 333, SL 0.3%, TP 0.6%
    const { stopLoss, target } = calculateBracketPrices(333, "BUY", 0.3, 0.6, 0.05);
    // SL: 333 * 0.003 = 0.999 → round to 1.0
    expect(stopLoss).toBe(1);
    // TP: 333 * 0.006 = 1.998 → round to 2.0
    expect(target).toBe(2);
  });

  it("should ensure minimum of one tick", () => {
    const { stopLoss, target } = calculateBracketPrices(1, "BUY", 0.01, 0.01, 0.05);
    expect(stopLoss).toBe(0.05);
    expect(target).toBe(0.05);
  });
});

// ─── withRetry ────────────────────────────────────────────────

describe("withRetry", () => {
  it("should return on first success", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "success";
    });
    expect(result).toBe("success");
    expect(calls).toBe(1);
  });

  it("should retry on failure and succeed", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("timeout error");
        return "success";
      },
      { maxRetries: 2, delayMs: 10, shouldRetry: () => true }
    );
    expect(result).toBe("success");
    expect(calls).toBe(3);
  });

  it("should throw after max retries", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("persistent error");
        },
        { maxRetries: 2, delayMs: 10, shouldRetry: () => true }
      )
    ).rejects.toThrow("persistent error");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("should not retry when shouldRetry returns false", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("auth error");
        },
        { maxRetries: 2, delayMs: 10, shouldRetry: () => false }
      )
    ).rejects.toThrow("auth error");
    expect(calls).toBe(1); // no retries
  });
});

// ─── isRetryableError ─────────────────────────────────────────

describe("isRetryableError", () => {
  it("should return true for timeout errors", () => {
    expect(isRetryableError(new Error("Request timeout"))).toBe(true);
  });

  it("should return true for network errors", () => {
    expect(isRetryableError(new Error("network error"))).toBe(true);
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
  });

  it("should return false for auth errors", () => {
    expect(isRetryableError(new Error("Unauthorized"))).toBe(false);
    expect(isRetryableError(new Error("Token expired"))).toBe(false);
  });

  it("should return false for non-Error objects", () => {
    expect(isRetryableError("string error")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});
