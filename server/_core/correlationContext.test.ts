/**
 * F6 — correlation context (AsyncLocalStorage).
 *
 * Tests that requestId / tradeId / signalId flow through nested async
 * code without callers having to thread them by hand.
 */
import { describe, it, expect, vi } from "vitest";
import {
  getCorrelationFields,
  runWithCorrelation,
  withTrade,
  withSignal,
  requestIdMiddleware,
} from "./correlationContext";
import type { Request, Response, NextFunction } from "express";

describe("correlationContext", () => {
  it("returns {} when no scope is active", () => {
    expect(getCorrelationFields()).toEqual({});
  });

  it("propagates requestId through nested awaits", async () => {
    let captured: ReturnType<typeof getCorrelationFields> | null = null;
    await runWithCorrelation({ requestId: "r-1" }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      captured = getCorrelationFields();
    });
    expect(captured).toEqual({ requestId: "r-1" });
  });

  it("withTrade merges tradeId onto an outer requestId scope", async () => {
    let captured: ReturnType<typeof getCorrelationFields> | null = null;
    await runWithCorrelation({ requestId: "r-2" }, async () => {
      await withTrade("t-9", async () => {
        captured = getCorrelationFields();
      });
    });
    expect(captured).toEqual({ requestId: "r-2", tradeId: "t-9" });
  });

  it("withSignal merges signalId onto an outer requestId scope", async () => {
    let captured: ReturnType<typeof getCorrelationFields> | null = null;
    await runWithCorrelation({ requestId: "r-3" }, async () => {
      await withSignal("s-42", async () => {
        captured = getCorrelationFields();
      });
    });
    expect(captured).toEqual({ requestId: "r-3", signalId: "s-42" });
  });

  it("does not leak inner scope back to the outer scope", async () => {
    const outer: ReturnType<typeof getCorrelationFields>[] = [];
    await runWithCorrelation({ requestId: "r-4" }, async () => {
      outer.push(getCorrelationFields());
      await withTrade("t-1", async () => {
        // inner scope sees both
      });
      outer.push(getCorrelationFields()); // outer must be unchanged
    });
    expect(outer[0]).toEqual({ requestId: "r-4" });
    expect(outer[1]).toEqual({ requestId: "r-4" });
  });

  it("requestIdMiddleware mints a new id when no upstream header is present", () => {
    const req = { headers: {} } as Request;
    const setHeader = vi.fn();
    const res = { setHeader } as unknown as Response;
    const next = vi.fn(() => {
      const fields = getCorrelationFields();
      expect(typeof fields.requestId).toBe("string");
      expect(fields.requestId!.length).toBeGreaterThanOrEqual(8);
    });
    requestIdMiddleware(req, res, next as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith("x-request-id", expect.any(String));
  });

  it("requestIdMiddleware honours an upstream x-request-id header", () => {
    const req = { headers: { "x-request-id": "upstream-abc" } } as unknown as Request;
    const setHeader = vi.fn();
    const res = { setHeader } as unknown as Response;
    const next = vi.fn(() => {
      expect(getCorrelationFields().requestId).toBe("upstream-abc");
    });
    requestIdMiddleware(req, res, next as NextFunction);
    expect(setHeader).toHaveBeenCalledWith("x-request-id", "upstream-abc");
  });
});
