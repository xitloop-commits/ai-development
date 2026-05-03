/**
 * Tests for fatal-error handlers (B6 + B6-followup wiring B5 shutdown).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerFatalHandlers,
  _resetFatalHandlersForTesting,
  _getUnhandledRejectionCountForTesting,
} from "./fatalHandlers";
import {
  registerShutdownHook,
  _resetShutdownForTesting,
} from "./shutdown";

// Stub fetch so the telegram POST never actually fires during tests.
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true });
  _resetFatalHandlersForTesting();
  _resetShutdownForTesting();
});

afterEach(() => {
  _resetFatalHandlersForTesting();
  _resetShutdownForTesting();
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

  it("uncaughtException invokes graceful-shutdown hooks before exiting", async () => {
    registerFatalHandlers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      // do nothing — don't actually exit the test runner
      return undefined as never;
    });

    const hookCalls: string[] = [];
    registerShutdownHook("agent", () => { hookCalls.push("agent"); }, 100);
    registerShutdownHook("mongo", () => { hookCalls.push("mongo"); }, 1000);

    process.emit("uncaughtException", new Error("boom"));

    // Drain microtasks so runShutdown (kicked off via void) runs to completion.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(hookCalls).toEqual(["agent", "mongo"]);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});
