/**
 * Tests for the graceful-shutdown coordinator (B5).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerShutdownHook,
  runShutdown,
  isShuttingDown,
  _resetShutdownForTesting,
  _getHooksForTesting,
} from "./shutdown";

beforeEach(() => {
  _resetShutdownForTesting();
});

afterEach(() => {
  _resetShutdownForTesting();
});

describe("registerShutdownHook (B5)", () => {
  it("stores hooks and exposes them via _getHooksForTesting", () => {
    registerShutdownHook("a", () => undefined, 100);
    registerShutdownHook("b", () => undefined, 200);
    const hooks = _getHooksForTesting();
    expect(hooks.length).toBe(2);
    expect(hooks.map((h) => h.name)).toEqual(["a", "b"]);
  });

  it("orders hooks by priority ascending (low first, mongo last)", () => {
    registerShutdownHook("mongo", () => undefined, 1000);
    registerShutdownHook("agent", () => undefined, 100);
    registerShutdownHook("ws", () => undefined, 500);
    expect(_getHooksForTesting().map((h) => h.name)).toEqual(["agent", "ws", "mongo"]);
  });

  it("re-registering same name replaces — does not duplicate", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    registerShutdownHook("dup", fn1, 100);
    registerShutdownHook("dup", fn2, 100);
    expect(_getHooksForTesting().length).toBe(1);
  });
});

describe("runShutdown (B5)", () => {
  it("invokes all hooks in priority order", async () => {
    const order: string[] = [];
    registerShutdownHook("mongo", () => { order.push("mongo"); }, 1000);
    registerShutdownHook("agent", () => { order.push("agent"); }, 100);
    registerShutdownHook("ws", () => { order.push("ws"); }, 500);

    await runShutdown("test");
    expect(order).toEqual(["agent", "ws", "mongo"]);
  });

  it("awaits async hooks before moving to the next one", async () => {
    const order: string[] = [];
    registerShutdownHook("first", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("first");
    }, 100);
    registerShutdownHook("second", () => { order.push("second"); }, 200);

    await runShutdown("test");
    expect(order).toEqual(["first", "second"]);
  });

  it("isShuttingDown flips to true once shutdown begins", async () => {
    registerShutdownHook("h", () => {
      expect(isShuttingDown()).toBe(true);
    }, 100);
    expect(isShuttingDown()).toBe(false);
    await runShutdown("test");
    expect(isShuttingDown()).toBe(true);
  });

  it("a hook that throws does NOT block subsequent hooks", async () => {
    const order: string[] = [];
    registerShutdownHook("bad", () => {
      throw new Error("bad hook");
    }, 100);
    registerShutdownHook("good", () => { order.push("good"); }, 200);

    await runShutdown("test");
    expect(order).toEqual(["good"]);
  });

  it("a hook that times out does NOT block the next hook", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    registerShutdownHook("slow", () => new Promise(() => { /* never resolves */ }), 100);
    registerShutdownHook("fast", () => { order.push("fast"); }, 200);

    const promise = runShutdown("test");
    // Per-hook 5s budget elapses for "slow", then "fast" runs.
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;
    expect(order).toEqual(["fast"]);
    vi.useRealTimers();
  });

  it("is idempotent — calling twice returns the same in-flight promise", async () => {
    let calls = 0;
    registerShutdownHook("once", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
    }, 100);

    const a = runShutdown("first");
    const b = runShutdown("second");
    expect(a).toBe(b);
    await a;
    expect(calls).toBe(1);
  });
});
