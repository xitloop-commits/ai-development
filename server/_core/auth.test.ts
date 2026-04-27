/**
 * Tests for the internal-API auth middleware (B1).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { authMiddleware, _resetAuthForTesting } from "./auth";

const origEnv = { ...process.env };

function makeReq(path: string, headers: Record<string, string> = {}): Request {
  return {
    path,
    method: "POST",
    ip: "127.0.0.1",
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

beforeEach(() => {
  _resetAuthForTesting();
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.REQUIRE_INTERNAL_AUTH;
});

afterEach(() => {
  process.env = { ...origEnv };
  _resetAuthForTesting();
});

describe("authMiddleware (B1)", () => {
  it("/health is always exempt — no token check", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const req = makeReq("/health");
    const { res } = makeRes();
    const next = vi.fn() as NextFunction;
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("/ready is always exempt — no token check", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const req = makeReq("/ready");
    const { res } = makeRes();
    const next = vi.fn() as NextFunction;
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("when INTERNAL_API_SECRET is unset, all requests pass through with a one-shot warning", () => {
    delete process.env.INTERNAL_API_SECRET;
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const req = makeReq("/api/anything");
    const { res } = makeRes();
    const next = vi.fn() as NextFunction;
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("warn-only mode: missing token logs but proceeds (REQUIRE_INTERNAL_AUTH unset)", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    delete process.env.REQUIRE_INTERNAL_AUTH;
    const req = makeReq("/api/broker/token");
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("warn-only mode: wrong token logs but proceeds", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "false";
    const req = makeReq("/api/broker/token", { "x-internal-token": "wrong" });
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("enforced mode: missing token returns 401", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const req = makeReq("/api/broker/token");
    const { res, status, json } = makeRes();
    const next = vi.fn() as NextFunction;
    authMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "missing or invalid X-Internal-Token" });
  });

  it("enforced mode: wrong token returns 401", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const req = makeReq("/api/broker/token", { "x-internal-token": "nope" });
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;
    authMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("enforced mode: matching token passes", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const req = makeReq("/api/broker/token", { "x-internal-token": "topsecret" });
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("token comparison is length-stable (different-length tokens reject without diff loop)", () => {
    process.env.INTERNAL_API_SECRET = "shortsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const req = makeReq("/api/x", { "x-internal-token": "this-is-much-much-longer-than-the-real-secret" });
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;
    authMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});
