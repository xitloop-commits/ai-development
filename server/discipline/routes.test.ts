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
    recordTradeOutcome: vi.fn(async () => undefined),
    getSessionStatus: vi.fn(async (_user: string, channel: string) => ({
      channel,
      date: "2026-04-30",
      sessionHalts: { nse: null, mcx: null },
      capGrace: null,
      activeCooldown: false,
      cooldownEndsAt: null,
      unjournaledCount: 0,
      weeklyReviewDue: false,
      todayPnlPercent: 0,
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

function captureRoute(): {
  app: any;
  pipelineFor: (method: "post" | "get", path: string) => Handler[];
} {
  const captured: Array<{ method: "post" | "get"; path: string; handlers: Handler[] }> = [];
  const app: any = {
    post: vi.fn((path: string, ...rest: Handler[]) => {
      captured.push({ method: "post", path, handlers: rest });
    }),
    get: vi.fn((path: string, ...rest: Handler[]) => {
      captured.push({ method: "get", path, handlers: rest });
    }),
  };
  return {
    app,
    pipelineFor: (method, path) =>
      captured.find((c) => c.method === method && c.path === path)?.handlers ?? [],
  };
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
    const { app, pipelineFor } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, json } = makeRes();
    await runPipeline(pipelineFor("post", "/api/discipline/validateTrade"), makeReq(validBody), res);

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

    const { app, pipelineFor } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, json } = makeRes();
    await runPipeline(pipelineFor("post", "/api/discipline/validateTrade"), makeReq(validBody), res);

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

    const { app, pipelineFor } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, json } = makeRes();
    await runPipeline(pipelineFor("post", "/api/discipline/validateTrade"), makeReq(validBody), res);

    const body = (json as any).mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.stage).toBe("RCA");
    expect(body.decision).toBe("REJECT");
    expect(body.reason).toContain("margin");
  });

  it("server error — handler returns 500 with shape", async () => {
    (disciplineAgent.validateTrade as any).mockRejectedValueOnce(new Error("Mongo down"));

    const { app, pipelineFor } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, status, json } = makeRes();
    await runPipeline(pipelineFor("post", "/api/discipline/validateTrade"), makeReq(validBody), res);

    expect(status).toHaveBeenCalledWith(500);
    const body = (json as any).mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.stage).toBe("ERROR");
    expect(body.error).toContain("Mongo down");
  });

  it("body schema rejection — missing required field returns 400", async () => {
    const { app, pipelineFor } = captureRoute();
    registerDisciplineRoutes(app);
    const incomplete = { ...validBody, executionId: undefined };
    const { res, status, json } = makeRes();
    await runPipeline(pipelineFor("post", "/api/discipline/validateTrade"), makeReq(incomplete as any), res);

    expect(status).toHaveBeenCalledWith(400);
    const body = (json as any).mock.calls[0][0];
    expect(body.error.where).toBe("body");
    expect(disciplineAgent.validateTrade).not.toHaveBeenCalled();
  });

  it("body schema rejection — extra unknown field returns 400 (strict mode)", async () => {
    const { app, pipelineFor } = captureRoute();
    registerDisciplineRoutes(app);
    const extra = { ...validBody, sneaky: "x" };
    const { res, status } = makeRes();
    await runPipeline(pipelineFor("post", "/api/discipline/validateTrade"), makeReq(extra as any), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(disciplineAgent.validateTrade).not.toHaveBeenCalled();
  });
});

// ─── Phase D2 — recordTradeOutcome (REST symmetry with tRPC) ─────

describe("POST /api/discipline/recordTradeOutcome", () => {
  const validOutcome = {
    channel: "ai-paper",
    tradeId: "T-1",
    realizedPnl: -250,
    openingCapital: 100000,
    exitReason: "SL_HIT",
    exitTriggeredBy: "USER",
  };

  it("forwards to disciplineAgent.recordTradeOutcome and returns success", async () => {
    const { app, pipelineFor } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, json } = makeRes();
    await runPipeline(
      pipelineFor("post", "/api/discipline/recordTradeOutcome"),
      makeReq(validOutcome),
      res,
    );

    expect(json).toHaveBeenCalledWith({ success: true });
    expect(disciplineAgent.recordTradeOutcome).toHaveBeenCalledTimes(1);
    expect((disciplineAgent.recordTradeOutcome as any).mock.calls[0][0]).toMatchObject({
      channel: "ai-paper",
      tradeId: "T-1",
      realizedPnl: -250,
      exitReason: "SL_HIT",
    });
  });

  it("rejects missing required field with 400", async () => {
    const { app, pipelineFor } = captureRoute();
    registerDisciplineRoutes(app);
    const incomplete = { ...validOutcome, channel: undefined };
    const { res, status } = makeRes();
    await runPipeline(
      pipelineFor("post", "/api/discipline/recordTradeOutcome"),
      makeReq(incomplete as any),
      res,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(disciplineAgent.recordTradeOutcome).not.toHaveBeenCalled();
  });
});

// ─── Phase D2 — GET /api/discipline/status ───────────────────────

describe("GET /api/discipline/status", () => {
  function makeQueryReq(query: Record<string, string>): Request {
    return { query, header: () => undefined, ip: "127.0.0.1" } as unknown as Request;
  }

  it("returns the session-status snapshot with the requested channel", async () => {
    const { app, pipelineFor } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, json } = makeRes();
    await runPipeline(
      pipelineFor("get", "/api/discipline/status"),
      makeQueryReq({ channel: "ai-paper" }),
      res,
    );

    expect(json).toHaveBeenCalled();
    const body = (json as any).mock.calls[0][0];
    expect(body.channel).toBe("ai-paper");
    expect(body.sessionHalts).toEqual({ nse: null, mcx: null });
    expect(body.activeCooldown).toBe(false);
    expect(disciplineAgent.getSessionStatus).toHaveBeenCalledWith("1", "ai-paper");
  });

  it("rejects missing channel query param with 400", async () => {
    const { app, pipelineFor } = captureRoute();
    registerDisciplineRoutes(app);
    const { res, status } = makeRes();
    await runPipeline(
      pipelineFor("get", "/api/discipline/status"),
      makeQueryReq({}),
      res,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(disciplineAgent.getSessionStatus).not.toHaveBeenCalled();
  });
});
