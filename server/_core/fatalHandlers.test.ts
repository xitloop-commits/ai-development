/**
 * Tests for fatal-error handlers (B6).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerFatalHandlers,
  _resetFatalHandlersForTesting,
  _getUnhandledRejectionCountForTesting,
} from "./fatalHandlers";

// Stub fetch so the telegram POST never actually fires during tests.
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true });
  _resetFatalHandlersForTesting();
});

afterEach(() => {
  _resetFatalHandlersForTesting();
  delete (global as unknown as { fetch?: typeof fetch }).fetch;
});

describe("registerFatalHandlers (B6)", () => {
  it("attaches uncaughtException + unhandledRejection listeners", () => {
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    registerFatalHandlers();
    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection + 1);
  });

  it("is idempotent — calling twice does NOT double-register", () => {
    registerFatalHandlers();
    const after1 = process.listenerCount("uncaughtException");
    registerFatalHandlers();
    const after2 = process.listenerCount("uncaughtException");
    expect(after2).toBe(after1);
  });

  it("unhandledRejection bumps the counter without exiting", async () => {
    registerFatalHandlers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit should NOT be called for unhandledRejection");
    });

    // Emit a synthetic unhandledRejection event.
    process.emit("unhandledRejection", new Error("oops"), Promise.resolve());
    process.emit("unhandledRejection", "string reason", Promise.resolve());

    expect(_getUnhandledRejectionCountForTesting()).toBe(2);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("uncaughtException schedules an exit(1) but does not exit synchronously", () => {
    vi.useFakeTimers();
    registerFatalHandlers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      // do nothing — don't actually exit the test runner
      return undefined as never;
    });

    process.emit("uncaughtException", new Error("boom"));

    // Synchronous: no exit yet
    expect(exitSpy).not.toHaveBeenCalled();
    // After 10s grace, exit(1) fires
    vi.advanceTimersByTime(10_001);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    vi.useRealTimers();
  });
});
