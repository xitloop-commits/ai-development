/**
 * Tests for the zod request-validation middleware (B8).
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { validateBody, validateQuery, validateParams } from "./zodMiddleware";

function makeReq(opts: Partial<{ body: any; query: any; params: any }> = {}): Request {
  return {
    body: opts.body ?? {},
    query: opts.query ?? {},
    params: opts.params ?? {},
  } as unknown as Request;
}

function makeRes() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

const sampleSchema = z
  .object({
    instrument: z.string().min(1),
    qty: z.number().int().positive(),
  })
  .strict();

describe("validateBody (B8)", () => {
  it("passes through with parsed body when valid", () => {
    const req = makeReq({ body: { instrument: "NIFTY_50", qty: 50 } });
    const { res } = makeRes();
    const next = vi.fn() as NextFunction;
    validateBody(sampleSchema)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.body).toEqual({ instrument: "NIFTY_50", qty: 50 });
  });

  it("returns 400 with structured issues on missing field", () => {
    const req = makeReq({ body: { instrument: "NIFTY_50" } });
    const { res, status, json } = makeRes();
    const next = vi.fn() as NextFunction;
    validateBody(sampleSchema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalled();
    const body = (json as any).mock.calls[0][0];
    expect(body.error.where).toBe("body");
    expect(body.error.issues.length).toBeGreaterThan(0);
    expect(body.error.issues[0].path).toContain("qty");
  });

  it("returns 400 on type mismatch (string where number expected)", () => {
    const req = makeReq({ body: { instrument: "NIFTY_50", qty: "50" } });
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;
    validateBody(sampleSchema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it("returns 400 on extra fields under .strict()", () => {
    const req = makeReq({
      body: { instrument: "NIFTY_50", qty: 50, sneaky: "x" },
    });
    const { res, status, json } = makeRes();
    const next = vi.fn() as NextFunction;
    validateBody(sampleSchema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    const body = (json as any).mock.calls[0][0];
    // zod's "Unrecognized key" issue
    expect(JSON.stringify(body)).toMatch(/Unrecognized|sneaky/);
  });

  it("returns 400 on out-of-range value", () => {
    const req = makeReq({ body: { instrument: "NIFTY_50", qty: -1 } });
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;
    validateBody(sampleSchema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });
});

describe("validateQuery (B8)", () => {
  const querySchema = z
    .object({
      symbol: z.string().min(1),
      limit: z.coerce.number().int().positive().optional(),
    })
    .strict();

  it("passes when query is valid", () => {
    const req = makeReq({ query: { symbol: "NIFTY", limit: "20" } });
    const { res } = makeRes();
    const next = vi.fn() as NextFunction;
    validateQuery(querySchema)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    // limit coerced from string → number
    expect((req.query as any).limit).toBe(20);
  });

  it("returns 400 with where=query on invalid", () => {
    const req = makeReq({ query: {} });
    const { res, status, json } = makeRes();
    const next = vi.fn() as NextFunction;
    validateQuery(querySchema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    const body = (json as any).mock.calls[0][0];
    expect(body.error.where).toBe("query");
  });
});

describe("validateParams (B8)", () => {
  const paramsSchema = z
    .object({
      key: z.string().min(1),
    })
    .strict();

  it("passes when params are valid", () => {
    const req = makeReq({ params: { key: "NIFTY_50" } });
    const { res } = makeRes();
    const next = vi.fn() as NextFunction;
    validateParams(paramsSchema)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 400 with where=params on missing key", () => {
    const req = makeReq({ params: {} });
    const { res, status, json } = makeRes();
    const next = vi.fn() as NextFunction;
    validateParams(paramsSchema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    const body = (json as any).mock.calls[0][0];
    expect(body.error.where).toBe("params");
  });
});
