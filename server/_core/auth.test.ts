/**
 * Tests for the internal-API auth middleware (B1) and the bootstrap
 * endpoint (B1-followup).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  authMiddleware,
  registerAuthBootstrapEndpoint,
  _resetAuthForTesting,
} from "./auth";

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

  it("/_auth/bootstrap is exempt — even with enforcement on and no token", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    // The /api prefix is stripped before authMiddleware sees req.path
    // (mounted via app.use("/api", authMiddleware)).
    const req = makeReq("/_auth/bootstrap");
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });
});

// ─── Bootstrap endpoint (B1-followup) ────────────────────────────

function makeBootstrapReq(ip: string): Request {
  return { ip, path: "/api/_auth/bootstrap", method: "GET" } as unknown as Request;
}

function captureRoute(): {
  app: { get: ReturnType<typeof vi.fn> };
  handler: () => (req: Request, res: Response) => void;
} {
  const get = vi.fn();
  let captured: ((req: Request, res: Response) => void) | null = null;
  get.mockImplementation((_path: string, h: any) => {
    captured = h;
  });
  return {
    app: { get },
    handler: () => {
      if (!captured) throw new Error("handler not captured — registerAuthBootstrapEndpoint never called?");
      return captured;
    },
  };
}

describe("registerAuthBootstrapEndpoint (B1-followup)", () => {
  it("returns the secret to a loopback caller (127.0.0.1)", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    const { app, handler } = captureRoute();
    registerAuthBootstrapEndpoint(app as any);
    const req = makeBootstrapReq("127.0.0.1");
    const { res, json, status } = makeRes();
    handler()(req, res);
    expect(status).not.toHaveBeenCalled(); // 200 default
    expect(json).toHaveBeenCalledWith({ secret: "topsecret" });
  });

  it("returns the secret to IPv6 loopback (::1)", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    const { app, handler } = captureRoute();
    registerAuthBootstrapEndpoint(app as any);
    const req = makeBootstrapReq("::1");
    const { res, json } = makeRes();
    handler()(req, res);
    expect(json).toHaveBeenCalledWith({ secret: "topsecret" });
  });

  it("returns 403 to a non-loopback caller (LAN, public, etc.)", () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    const { app, handler } = captureRoute();
    registerAuthBootstrapEndpoint(app as any);
    const req = makeBootstrapReq("192.168.1.42");
    const { res, status, json } = makeRes();
    handler()(req, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: "Forbidden — loopback only" });
  });

  it("returns empty secret when server has none configured (warn-only mode)", () => {
    delete process.env.INTERNAL_API_SECRET;
    const { app, handler } = captureRoute();
    registerAuthBootstrapEndpoint(app as any);
    const req = makeBootstrapReq("127.0.0.1");
    const { res, json } = makeRes();
    handler()(req, res);
    expect(json).toHaveBeenCalledWith({ secret: "" });
  });
});
