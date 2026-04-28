/**
 * Tests for the SEA-facing /api/discipline/validateTrade endpoint.
 *
 * Drives the route handler directly (no Express server boot). Mocks
 * disciplineAgent.validateTrade and rcaMonitor.evaluateTrade so we can
 * exercise every branch of the chain (DA-reject, RCA-reject, happy
 * path, server error) without Mongo or live broker.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

// ─── Mocks (must be hoisted before SUT import) ──────────────────

vi.mock("./index", () => ({
  disciplineAgent: {
    validateTrade: vi.fn(async () => ({
      allowed: true,
      blockedBy: [],
      warnings: [],
      adjustments: [],
      details: {},
    })),
  },
}));

vi.mock("../risk-control", () => ({
  rcaMonitor: {
    evaluateTrade: vi.fn(async () => ({
      decision: "APPROVE",
      reason: undefined,
      submitResult: {
        success: true,
        tradeId: "T-1",
        positionId: "POS-1",
        orderId: "ORD-1",
        status: "FILLED",
      },
    })),
  },
}));

// ─── SUT ─────────────────────────────────────────────────────────

import { registerDisciplineRoutes } from "./routes";
import { disciplineAgent } from "./index";

// ─── Helpers ────────────────────────────────────────────────────

type Handler = (req: Request, res: Response) => Promise<void> | void;

function captureRoute(): { app: any; pipeline: () => Handler[] } {
  const handlers: Handler[] = [];
  const app: any = {
    post: vi.fn((_path: string, ...rest: Handler[]) => {
      // The route is registered with [middleware..., handler] — store all
      handlers.push(...rest);
    }),
  };
  return { app, pipeline: () => handlers };
}

function makeReq(body: Record<string, unknown>): Request {
  return { body, header: () => undefined, ip: "127.0.0.1" } as unknown as Request;
}

function makeRes() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

async function runPipeline(handlers: Handler[], req: Request, res: Response) {
  // Walk middleware → handler. Each accepts (req, res, next).
  for (const h of handlers) {
    let calledNext = false;
    await (h as any)(req, res, () => {
      calledNext = true;
    });
    if (!calledNext) return; // middleware short-circuited (e.g. 400)
  }
}

const validBody = {
  executionId: "EX-1",
  channel: "ai-paper" as const,
  origin: "AI" as const,
  instrument: "NIFTY_50",
  exchange: "NSE" as const,
  transactionType: "BUY" as const,
  optionType: "CE" as const,
  strike: 23300,
  expiry: "2026-05-29",
  contractSecurityId: "12345",
  entryPrice: 100,
  quantity: 75,
  estimatedValue: 7500,
  stopLoss: 90,
  takeProfit: 120,
  capitalPercent: 10,
  currentCapital: 100000,
  currentExposure: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  (disciplineAgent.validateTrade as any).mockResolvedValue({
    allowed: true,
    blockedBy: [],
    warnings: [],
    adjustments: [],
    details: {},
  });
});

// ─── Tests ──────────────────────────────────────────────────────

describe("POST /api/discipline/validateTrade", () => {
  it("happy path — DA pass + RCA approve → 200 with tradeId", async () => {
    const { app, pipeline } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, json } = makeRes();
    await runPipeline(pipeline(), makeReq(validBody), res);

    expect(json).toHaveBeenCalled();
    const body = (json as any).mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.stage).toBe("RCA");
    expect(body.decision).toBe("APPROVE");
    expect(body.tradeId).toBe("T-1");
    expect(disciplineAgent.validateTrade).toHaveBeenCalledTimes(1);
  });

  it("DA reject — chain stops, RCA never called", async () => {
    (disciplineAgent.validateTrade as any).mockResolvedValueOnce({
      allowed: false,
      blockedBy: ["sessionHalted", "preTrade"],
      warnings: [],
      adjustments: [],
      details: {},
    });
    const { rcaMonitor } = await import("../risk-control");

    const { app, pipeline } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, json } = makeRes();
    await runPipeline(pipeline(), makeReq(validBody), res);

    const body = (json as any).mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.stage).toBe("DA");
    expect(body.decision).toBe("REJECT");
    expect(body.blockedBy).toEqual(["sessionHalted", "preTrade"]);
    expect((rcaMonitor.evaluateTrade as any)).not.toHaveBeenCalled();
  });

  it("RCA reject — DA passed, RCA returned REJECT (TEA failure)", async () => {
    const { rcaMonitor } = await import("../risk-control");
    (rcaMonitor.evaluateTrade as any).mockResolvedValueOnce({
      decision: "REJECT",
      reason: "Insufficient margin",
      submitResult: {
        success: false,
        tradeId: "",
        positionId: "",
        orderId: "",
        status: "REJECTED",
        error: "Insufficient margin",
      },
    });

    const { app, pipeline } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, json } = makeRes();
    await runPipeline(pipeline(), makeReq(validBody), res);

    const body = (json as any).mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.stage).toBe("RCA");
    expect(body.decision).toBe("REJECT");
    expect(body.reason).toContain("margin");
  });

  it("server error — handler returns 500 with shape", async () => {
    (disciplineAgent.validateTrade as any).mockRejectedValueOnce(new Error("Mongo down"));

    const { app, pipeline } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, status, json } = makeRes();
    await runPipeline(pipeline(), makeReq(validBody), res);

    expect(status).toHaveBeenCalledWith(500);
    const body = (json as any).mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.stage).toBe("ERROR");
    expect(body.error).toContain("Mongo down");
  });

  it("body schema rejection — missing required field returns 400", async () => {
    const { app, pipeline } = captureRoute();
    registerDisciplineRoutes(app);
    const incomplete = { ...validBody, executionId: undefined };
    const { res, status, json } = makeRes();
    await runPipeline(pipeline(), makeReq(incomplete as any), res);

    expect(status).toHaveBeenCalledWith(400);
    const body = (json as any).mock.calls[0][0];
    expect(body.error.where).toBe("body");
    expect(disciplineAgent.validateTrade).not.toHaveBeenCalled();
  });

  it("body schema rejection — extra unknown field returns 400 (strict mode)", async () => {
    const { app, pipeline } = captureRoute();
    registerDisciplineRoutes(app);
    const extra = { ...validBody, sneaky: "x" };
    const { res, status } = makeRes();
    await runPipeline(pipeline(), makeReq(extra as any), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(disciplineAgent.validateTrade).not.toHaveBeenCalled();
  });
});
